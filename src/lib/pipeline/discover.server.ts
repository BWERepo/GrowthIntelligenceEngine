// Discovery pipeline (plan section 5.3):
//   overnight: campaign queries -> search -> candidates (queue)
//   every tick: a few candidates -> polite fetch -> AI classification (checked)
//               -> Opportunity Score (code) -> gie_opportunities
// Runs from the Worker's cron (tasks/dispatch.ts) with the service role, so
// every query here filters by tenant_id explicitly. Never runs inside a
// person's request except the owner's "search now", which does no AI work.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServerEnv } from "@/lib/env.server";
import { serviceClient } from "@/lib/supabase.server";
import { dayStatus, inDiscoveryWindow, localMoment, type WorkSchedule } from "@/lib/schedule";
import { maySpend, recordUsage } from "@/lib/spend.server";
import { braveSearch } from "@/lib/providers/search/brave.server";
import type { SearchProvider } from "@/lib/providers/search/types";
import { pickLinksToCheck, summarizeLinks, type LinkResult } from "@/lib/discovery/linkcheck";
import { runPageSpeed } from "@/lib/providers/pagespeed.server";
import { classifyPage, estimateCostUsd, worstCaseCostUsd } from "@/lib/providers/ai/anthropic.server";
import { createPoliteFetcher } from "@/lib/discovery/fetch.server";
import { candidatesFromResults, planQueries } from "@/lib/discovery/queries";
import {
  buildUserPrompt,
  checkClassification,
  CLASSIFICATION_PROMPT_VERSION,
  CLASSIFICATION_SCHEMA_VERSION,
  MAX_PAGE_CHARS,
  type ClassificationOutput,
} from "@/lib/discovery/classification";
import { dedupeKey, hostOf, normalizeUrl } from "@/lib/discovery/url";
import { daysBetween, scoreOpportunity, type ScoreInputs, type SiteWeakness } from "@/lib/scoring/opportunity";

type Db = SupabaseClient<any, any, any>;

export type TenantRow = { id: string; slug: string; timezone: string };

export type CampaignRow = {
  id: string;
  tenant_id: string;
  name: string;
  status: string;
  industries: string[];
  locations: string[];
  buying_intent_queries: string[];
  prospecting_queries: string[];
  max_age_days: number;
  daily_search_limit: number;
  daily_candidate_limit: number;
};

type CandidateRow = {
  id: string;
  tenant_id: string;
  campaign_id: string;
  signal_type: "buying_intent" | "prospecting";
  url: string;
  normalized_url: string;
  title: string | null;
  published_at: string | null;
  attempts: number;
  local_date: string;
};

export type StepLog = { tenant: string; step: string; detail: string };

function must<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

async function loadSchedule(db: Db, tenant: TenantRow): Promise<WorkSchedule> {
  const [s, c] = await Promise.all([
    db.from("gie_tenant_work_schedules").select("working_days, morning_time, evening_time").eq("tenant_id", tenant.id).maybeSingle(),
    db.from("gie_business_calendar").select("closed_on").eq("tenant_id", tenant.id),
  ]);
  const sched = must(s) as { working_days: number[]; morning_time: string; evening_time: string } | null;
  return {
    timezone: tenant.timezone,
    workingDays: sched?.working_days ?? [1, 2, 3, 4, 5],
    morningTime: sched?.morning_time ?? "08:00",
    eveningTime: sched?.evening_time ?? "17:00",
    closedDates: ((must(c) ?? []) as Array<{ closed_on: string }>).map((r) => r.closed_on),
  };
}

async function activeCampaigns(db: Db, tenantId: string): Promise<CampaignRow[]> {
  return (must(await db.from("gie_campaigns").select("*").eq("tenant_id", tenantId).eq("status", "active").order("created_at")) ?? []) as CampaignRow[];
}

// ---------------------------------------------------------------- search stage

export type SearchStageResult = { status: "ran" | "skipped"; reason?: string; queries: number; newCandidates: number };

/**
 * Runs today's searches for every active campaign of the tenant, once per
 * tenant-local day: the gie_job_runs row (tenant, 'discovery', local date) is
 * claimed first and a second claim does nothing.
 */
export async function runSearchStage(
  db: Db,
  env: ServerEnv,
  tenant: TenantRow,
  now: Date,
  opts: { provider?: SearchProvider; force?: boolean } = {},
): Promise<SearchStageResult> {
  const schedule = await loadSchedule(db, tenant);
  const local = localMoment(now, tenant.timezone);
  if (!opts.force) {
    if (dayStatus(local, schedule) !== "business_day") return { status: "skipped", reason: "not a business day", queries: 0, newCandidates: 0 };
    if (!inDiscoveryWindow(now, tenant.timezone)) return { status: "skipped", reason: "outside the overnight window", queries: 0, newCandidates: 0 };
  }
  const campaigns = await activeCampaigns(db, tenant.id);
  if (!campaigns.length) return { status: "skipped", reason: "no active campaign", queries: 0, newCandidates: 0 };
  const provider = opts.provider ?? (env.BRAVE_SEARCH_API_KEY ? braveSearch(env.BRAVE_SEARCH_API_KEY) : null);
  if (!provider) return { status: "skipped", reason: "BRAVE_SEARCH_API_KEY is not set", queries: 0, newCandidates: 0 };

  const claim = await db
    .from("gie_job_runs")
    .upsert({ tenant_id: tenant.id, job_kind: "discovery", local_date: local.date, status: "running" }, { onConflict: "tenant_id,job_kind,local_date", ignoreDuplicates: true })
    .select("id");
  const claimed = (must(claim) ?? []) as Array<{ id: string }>;
  if (!claimed.length) return { status: "skipped", reason: "already ran today", queries: 0, newCandidates: 0 };
  const runId = claimed[0]!.id;

  let queries = 0;
  let newCandidates = 0;
  let stopReason: string | null = null;
  try {
    outer: for (const campaign of campaigns) {
      let campaignNew = 0;
      const plan = planQueries({
        buyingIntentQueries: campaign.buying_intent_queries,
        prospectingQueries: campaign.prospecting_queries,
        locations: campaign.locations,
        dailySearchLimit: campaign.daily_search_limit,
      });
      for (const q of plan) {
        if (campaignNew >= campaign.daily_candidate_limit) break;
        const budget = await maySpend(db, tenant.id, tenant.timezone, "search", provider.costPerQueryUsd, now);
        if (!budget.allowed) {
          stopReason = budget.reason;
          break outer;
        }
        const response = await provider.search(q.query, { count: 20 });
        queries++;
        await recordUsage(db, {
          tenantId: tenant.id,
          category: "search",
          provider: provider.name,
          operation: "web_search",
          costUsd: provider.costPerQueryUsd,
          requestId: response.requestId,
          idempotencyKey: `search:${campaign.id}:${local.date}:${q.signalType}:${q.query}`,
        });
        const drafts = candidatesFromResults(response.results).slice(0, Math.max(0, campaign.daily_candidate_limit - campaignNew));
        if (!drafts.length) continue;
        const rows = drafts.map((d) => ({
          tenant_id: tenant.id,
          campaign_id: campaign.id,
          signal_type: q.signalType,
          query: q.query.slice(0, 400),
          provider: provider.name,
          url: d.url.slice(0, 2048),
          normalized_url: d.normalizedUrl.slice(0, 2048),
          title: d.title,
          snippet: d.snippet,
          published_at: d.publishedAt?.toISOString() ?? null,
          local_date: local.date,
        }));
        // A page already queued (by any query, on any day) is not queued again.
        const inserted = (must(await db.from("gie_discovery_candidates").upsert(rows, { onConflict: "tenant_id,normalized_url", ignoreDuplicates: true }).select("id")) ?? []) as unknown[];
        campaignNew += inserted.length;
        newCandidates += inserted.length;
      }
    }
    must(
      await db
        .from("gie_job_runs")
        .update({ status: "succeeded", finished_at: new Date().toISOString(), error: stopReason ? `Stopped early: ${stopReason}` : null })
        .eq("id", runId)
        .eq("tenant_id", tenant.id),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.from("gie_job_runs").update({ status: "failed", finished_at: new Date().toISOString(), error: message.slice(0, 2000) }).eq("id", runId).eq("tenant_id", tenant.id);
    throw error;
  }
  return { status: "ran", reason: stopReason ?? undefined, queries, newCandidates };
}

// ---------------------------------------------------------------- classification stage

export type ClassifyStageResult = { processed: number; opportunities: number; stopped?: string };

async function setCandidate(db: Db, c: CandidateRow, patch: Record<string, unknown>) {
  must(await db.from("gie_discovery_candidates").update(patch).eq("id", c.id).eq("tenant_id", c.tenant_id));
}

function scoreInputsFor(
  value: ClassificationOutput,
  evidenceFound: number,
  campaign: CampaignRow,
  candidate: CandidateRow,
  contact: { emails: string[]; phones: string[]; hasContactForm: boolean },
  contactOnOwnSite: boolean,
  now: Date,
): ScoreInputs {
  const claims = [
    value.business_name != null,
    value.industry != null && value.industry.toLowerCase() !== "other",
    value.location != null,
    value.intent_level !== "none",
    value.published_date != null,
  ].filter(Boolean).length;
  const published = value.published_date ? new Date(`${value.published_date}T12:00:00Z`) : candidate.published_at ? new Date(candidate.published_at) : null;
  const age = published && !Number.isNaN(published.getTime()) ? daysBetween(published, now) : null;
  return {
    signalType: candidate.signal_type,
    intentLevel: value.intent_level,
    industry: value.industry,
    location: value.location,
    businessSize: value.business_size,
    offerMatch: value.offer_match,
    campaignIndustries: campaign.industries,
    campaignLocations: campaign.locations,
    ageDays: age !== null && age >= 0 ? age : null,
    maxAgeDays: campaign.max_age_days,
    contact: { emails: contact.emails.length, phones: contact.phones.length, hasContactForm: contact.hasContactForm },
    contactOnOwnSite,
    backedClaims: Math.min(evidenceFound, claims),
    totalClaims: claims,
    confidence: value.confidence,
  };
}

/**
 * Prospecting: PageSpeed (free) and a check of the pages linked from the
 * homepage (only 404/410 counts as broken). Stores what was measured as
 * sources and returns it for the score. A failed measurement is not fatal and
 * is never counted as a weakness; null when nothing could be measured.
 */
async function measureSite(
  db: Db,
  env: ServerEnv,
  fetcher: ReturnType<typeof createPoliteFetcher>,
  tenantId: string,
  candidateId: string,
  website: string,
): Promise<SiteWeakness | null> {
  let measured = false;
  const weakness: SiteWeakness = { mobilePerformance: null, mobileSeo: null, brokenLinks: 0, linksChecked: 0, https: null };
  const host = hostOf(website) ?? "unknown";
  if (env.PAGESPEED_API_KEY) {
    try {
      const metrics = await runPageSpeed(env.PAGESPEED_API_KEY, website);
      must(await db.from("gie_sources").insert({ tenant_id: tenantId, source_type: "pagespeed", normalized_url: website, host, fetched_at: new Date().toISOString(), robots_allowed: true, metrics }));
      await recordUsage(db, { tenantId, category: "other", provider: "pagespeed", operation: "runPagespeed", costUsd: 0, isEstimate: false, idempotencyKey: `pagespeed:${candidateId}` });
      weakness.mobilePerformance = metrics.performance;
      weakness.mobileSeo = metrics.seo;
      measured = true;
    } catch (error) {
      console.warn("[discovery] pagespeed failed", error instanceof Error ? error.message : error);
    }
  }
  try {
    const home = await fetcher.fetchPage(website);
    if (home.ok) {
      weakness.https = home.finalUrl.startsWith("https:");
      measured = true;
      const results: LinkResult[] = [];
      for (const link of pickLinksToCheck(home.links, home.finalUrl)) {
        const r = await fetcher.fetchPage(link);
        results.push({ url: link, status: r.status });
      }
      if (results.length) {
        const summary = summarizeLinks(results);
        must(await db.from("gie_sources").insert({ tenant_id: tenantId, source_type: "link_check", normalized_url: website, host, fetched_at: new Date().toISOString(), robots_allowed: true, metrics: summary }));
        weakness.brokenLinks = summary.broken.length;
        weakness.linksChecked = summary.checked;
      }
    }
  } catch (error) {
    console.warn("[discovery] link check failed", error instanceof Error ? error.message : error);
  }
  return measured ? weakness : null;
}

/** Classifies up to `limit` queued candidates of one tenant. */
export async function runClassifyStage(
  db: Db,
  env: ServerEnv,
  tenant: TenantRow,
  now: Date,
  limit = 3,
  fetcher = createPoliteFetcher(),
): Promise<ClassifyStageResult> {
  if (!env.ANTHROPIC_API_KEY) return { processed: 0, opportunities: 0, stopped: "ANTHROPIC_API_KEY is not set" };
  const model = env.GIE_CLASSIFY_MODEL;
  // Check before claiming, so a tenant at its cap does not churn the queue.
  const pre = await maySpend(db, tenant.id, tenant.timezone, "ai", worstCaseCostUsd(model, MAX_PAGE_CHARS), now);
  if (!pre.allowed) return { processed: 0, opportunities: 0, stopped: pre.reason };

  const claimed = (must(await db.rpc("claim_discovery_candidates", { _tenant_id: tenant.id, _limit: limit })) ?? []) as CandidateRow[];
  const campaigns = new Map<string, CampaignRow>();
  let processed = 0;
  let opportunities = 0;
  for (let i = 0; i < claimed.length; i++) {
    const c = claimed[i]!;
    let campaign = campaigns.get(c.campaign_id);
    if (!campaign) {
      campaign = must(await db.from("gie_campaigns").select("*").eq("tenant_id", tenant.id).eq("id", c.campaign_id).single()) as CampaignRow;
      campaigns.set(c.campaign_id, campaign);
    }
    if (campaign.status !== "active") {
      await setCandidate(db, c, { state: "pending", attempts: Math.max(0, c.attempts - 1), claimed_at: null });
      continue;
    }

    // 1. Fetch the page, obeying robots.txt.
    const page = await fetcher.fetchPage(c.url);
    if (!page.ok) {
      const blocked = page.reason === "robots" || page.reason === "not_public";
      await setCandidate(db, c, {
        state: blocked ? "blocked" : c.attempts >= 3 || page.reason === "not_html" || page.reason === "too_large" ? "failed" : "pending",
        reason: `Fetch: ${page.reason}${page.status ? ` (HTTP ${page.status})` : ""}`,
      });
      processed++;
      continue;
    }
    const finalNormalized = normalizeUrl(page.finalUrl) ?? c.normalized_url;
    const pageHost = hostOf(page.finalUrl);

    // 2. Skip the AI call when this business is already an opportunity (same website).
    if (pageHost) {
      const existing = must(await db.from("gie_opportunities").select("id").eq("tenant_id", tenant.id).eq("dedupe_key", `site:${pageHost}`).maybeSingle()) as { id: string } | null;
      if (existing) {
        await setCandidate(db, c, { state: "duplicate", reason: "Same website as an existing opportunity.", opportunity_id: existing.id });
        processed++;
        continue;
      }
    }

    const sourceText = page.text.slice(0, 60_000);
    const source = must(
      await db
        .from("gie_sources")
        .insert({
          tenant_id: tenant.id,
          source_type: "web_page",
          normalized_url: finalNormalized,
          host: pageHost ?? "unknown",
          fetched_at: new Date().toISOString(),
          http_status: page.status,
          robots_allowed: true,
          content_hash: page.contentHash,
          content_text: sourceText,
          content_truncated: page.text.length > MAX_PAGE_CHARS,
          contact: page.contact,
        })
        .select("id")
        .single(),
    ) as { id: string };

    // 3. Budget check for this exact prompt, then classify.
    const prompt = buildUserPrompt(
      { signalType: c.signal_type, industries: campaign.industries, locations: campaign.locations },
      { url: page.finalUrl, title: page.title, text: page.text },
    );
    const budget = await maySpend(db, tenant.id, tenant.timezone, "ai", worstCaseCostUsd(model, prompt.length), now);
    if (!budget.allowed) {
      // Hand this and the rest back untouched; they wait for the next month or a higher cap.
      for (const rest of claimed.slice(i)) await setCandidate(db, rest, { state: "pending", attempts: Math.max(0, rest.attempts - 1), claimed_at: null });
      return { processed, opportunities, stopped: budget.reason };
    }
    const result = await classifyPage(env.ANTHROPIC_API_KEY, model, prompt);
    if (result.kind === "error") {
      await setCandidate(db, c, { state: result.retryable && c.attempts < 3 ? "pending" : "failed", reason: `Classification: ${result.detail}` });
      processed++;
      if (!result.retryable) return { processed, opportunities, stopped: result.detail };
      continue;
    }
    const cost = estimateCostUsd(result.model, result.inputTokens, result.outputTokens);
    await recordUsage(db, {
      tenantId: tenant.id,
      category: "ai",
      provider: "anthropic",
      operation: "classify",
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: cost,
      requestId: result.requestId,
      idempotencyKey: `classify:${c.id}:${c.attempts}`,
    });

    const base = {
      tenant_id: tenant.id,
      candidate_id: c.id,
      source_id: source.id,
      schema_version: CLASSIFICATION_SCHEMA_VERSION,
      prompt_version: CLASSIFICATION_PROMPT_VERSION,
      model: result.model,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      cost_usd: cost,
      request_id: result.requestId,
    };
    if (result.kind === "refused") {
      must(await db.from("gie_opportunity_classifications").insert({ ...base, outcome: "refused", output: { detail: result.detail } }));
      await setCandidate(db, c, { state: "rejected", reason: "The model declined to classify this page." });
      processed++;
      continue;
    }

    // 4. Check the answer: schema, word-for-word quotes, the claimed website.
    const checked = checkClassification(result.output, { url: page.finalUrl, text: page.text, links: page.links });
    if (!checked.ok) {
      must(
        await db.from("gie_opportunity_classifications").insert({
          ...base,
          outcome: checked.outcome,
          output: (result.output as object | null) ?? null,
          evidence_checked: { reason: checked.reason, quotes: checked.evidence ?? [] },
        }),
      );
      await setCandidate(db, c, { state: "rejected", reason: checked.reason.slice(0, 500) });
      processed++;
      continue;
    }
    const value = checked.value;
    const classification = must(
      await db
        .from("gie_opportunity_classifications")
        .insert({ ...base, outcome: "accepted", output: value, evidence_checked: { quotes: checked.evidence, notes: checked.notes } })
        .select("id")
        .single(),
    ) as { id: string };

    // 5. One opportunity per business: a second page about the same business is a duplicate.
    const website = checked.websiteVerified && value.business_website_url ? normalizeUrl(value.business_website_url) : null;
    const key = dedupeKey(website, page.finalUrl);
    if (!key) {
      await setCandidate(db, c, { state: "rejected", reason: "No usable URL for duplicate checking." });
      processed++;
      continue;
    }
    const dup = must(await db.from("gie_opportunities").select("id").eq("tenant_id", tenant.id).eq("dedupe_key", key).maybeSingle()) as { id: string } | null;
    if (dup) {
      await setCandidate(db, c, { state: "duplicate", reason: "Same business as an existing opportunity.", opportunity_id: dup.id });
      processed++;
      continue;
    }

    // 6. Prospecting: measure the business's own website first, so the score can use what was measured.
    const siteWeakness = c.signal_type === "prospecting" && website ? await measureSite(db, env, fetcher, tenant.id, c.id, website) : null;

    // 7. Score in code, store the opportunity, the score and its parts.
    const contactOnOwnSite = !!website && hostOf(website) === pageHost;
    const inputs = { ...scoreInputsFor(value, checked.evidence.filter((e) => e.found).length, campaign, c, page.contact, contactOnOwnSite, now), siteWeakness };
    const score = scoreOpportunity(inputs);
    const inserted = await db
      .from("gie_opportunities")
      .insert({
        tenant_id: tenant.id,
        campaign_id: campaign.id,
        source_id: source.id,
        signal_type: c.signal_type,
        business_name: value.business_name!.slice(0, 200),
        website_url: website,
        source_url: page.finalUrl.slice(0, 2048),
        industry: value.industry,
        location: value.location,
        discovered_at: now.toISOString(),
        dedupe_key: key,
        latest_score: score.score,
        latest_band: score.band,
      })
      .select("id")
      .single();
    if (inserted.error) {
      // Lost a race with another run for the same business: treat as duplicate.
      if (/duplicate key/i.test(inserted.error.message)) {
        await setCandidate(db, c, { state: "duplicate", reason: "Same business as an existing opportunity." });
        processed++;
        continue;
      }
      throw new Error(inserted.error.message);
    }
    const opp = inserted.data as { id: string };
    must(await db.from("gie_opportunity_classifications").update({ opportunity_id: opp.id }).eq("id", classification.id).eq("tenant_id", tenant.id));
    const scoreRow = must(
      await db
        .from("gie_opportunity_scores")
        .insert({ tenant_id: tenant.id, opportunity_id: opp.id, classification_id: classification.id, rule_version: score.ruleVersion, score: score.score, band: score.band, inputs })
        .select("id")
        .single(),
    ) as { id: string };
    must(
      await db.from("gie_opportunity_score_components").insert(
        score.components.map((p) => ({ tenant_id: tenant.id, score_id: scoreRow.id, component: p.component, weight: p.weight, value: p.value, points: p.points, explanation: p.explanation })),
      ),
    );
    await setCandidate(db, c, { state: "classified", reason: null, opportunity_id: opp.id });
    processed++;
    opportunities++;

  }
  return { processed, opportunities };
}

// ---------------------------------------------------------------- dispatcher entry

/** One cron tick: for every active tenant, the overnight search (once a day) and a slice of classification. */
export async function runDiscoveryTick(env: ServerEnv, now = new Date()): Promise<StepLog[]> {
  const db = serviceClient(env, env.GIE_DB_SCHEMA);
  const tenants = (must(await db.from("gie_tenants").select("id, slug, timezone").eq("status", "active")) ?? []) as TenantRow[];
  const log: StepLog[] = [];
  for (const tenant of tenants) {
    try {
      const s = await runSearchStage(db, env, tenant, now);
      log.push({ tenant: tenant.slug, step: "search", detail: s.status === "ran" ? `${s.queries} queries, ${s.newCandidates} new candidates${s.reason ? `; ${s.reason}` : ""}` : `skipped: ${s.reason}` });
    } catch (error) {
      log.push({ tenant: tenant.slug, step: "search", detail: `failed: ${error instanceof Error ? error.message : String(error)}` });
    }
    try {
      const c = await runClassifyStage(db, env, tenant, now);
      log.push({ tenant: tenant.slug, step: "classify", detail: `${c.processed} processed, ${c.opportunities} new opportunities${c.stopped ? `; stopped: ${c.stopped}` : ""}` });
    } catch (error) {
      log.push({ tenant: tenant.slug, step: "classify", detail: `failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return log;
}
