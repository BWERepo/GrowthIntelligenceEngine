// Morning package (plan section 10): at the workspace's morning time on a
// business day, collect due follow-ups and open opportunities, rank them, keep
// at most five, and prepare a draft for each top opportunity that has a public
// email. One package per tenant-local date: the (tenant, local_date) key means
// a second run does nothing.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServerEnv } from "@/lib/env.server";
import { serviceClient } from "@/lib/supabase.server";
import { dueDailyJobs, localMoment, type WorkSchedule } from "@/lib/schedule";
import { maySpend, recordUsage } from "@/lib/spend.server";
import { hostOf } from "@/lib/discovery/url";
import {
  buildDraftPrompt,
  draftOutreach,
  DraftOutput,
  DRAFT_PROMPT_VERSION,
  MAILING_ADDRESS_MARKER,
  UNSUBSCRIBE_MARKER,
  estimateCostUsd,
  worstCaseCostUsd,
} from "@/lib/providers/ai/anthropic.server";
import { validateDraft } from "@/lib/actions/draft-validator";
import { rankCandidates, RANKING_VERSION, STALE_AFTER_CARRIES, type FollowUpCandidate, type OpportunityCandidate } from "@/lib/actions/ranking";
import type { TenantRow } from "./discover.server";

type Db = SupabaseClient<any, any, any>;

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

export type PackageResult = { status: "created" | "skipped"; reason?: string; items: number; drafts: number };

/** Builds today's package if it is due and not built yet. `force` skips the time check (never the one-per-date key). */
export async function runMorningPackage(db: Db, env: ServerEnv, tenant: TenantRow, now: Date, opts: { force?: boolean } = {}): Promise<PackageResult> {
  const schedule = await loadSchedule(db, tenant);
  const local = localMoment(now, tenant.timezone);

  let late = false;
  if (!opts.force) {
    const ran = ((must(await db.from("gie_job_runs").select("local_date").eq("tenant_id", tenant.id).eq("job_kind", "morning_package").eq("local_date", local.date)) ?? []) as Array<{ local_date: string }>).map((r) => ({ job: "morning_package" as const, localDate: r.local_date }));
    const due = dueDailyJobs(now, schedule, ran).find((j) => j.job === "morning_package");
    if (!due) return { status: "skipped", reason: "not due", items: 0, drafts: 0 };
    late = due.late;
  }

  // Claim the day: only the inserter proceeds.
  const claim = await db
    .from("gie_job_runs")
    .upsert({ tenant_id: tenant.id, job_kind: "morning_package", local_date: local.date, status: "running", late }, { onConflict: "tenant_id,job_kind,local_date", ignoreDuplicates: true })
    .select("id");
  const claimed = (must(claim) ?? []) as Array<{ id: string }>;
  if (!claimed.length) return { status: "skipped", reason: "already built today", items: 0, drafts: 0 };
  const runId = claimed[0]!.id;

  try {
    const result = await buildPackage(db, env, tenant, local.date, late, now);
    must(await db.from("gie_job_runs").update({ status: "succeeded", finished_at: new Date().toISOString() }).eq("id", runId).eq("tenant_id", tenant.id));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.from("gie_job_runs").update({ status: "failed", finished_at: new Date().toISOString(), error: message.slice(0, 2000) }).eq("id", runId).eq("tenant_id", tenant.id);
    throw error;
  }
}

async function buildPackage(db: Db, env: ServerEnv, tenant: TenantRow, localDate: string, late: boolean, now: Date): Promise<PackageResult> {
  // Follow-ups due today or earlier, on prospects we may still contact.
  const fuRows = (must(await db.from("gie_follow_up_tasks").select("id, prospect_id, due_date").eq("tenant_id", tenant.id).eq("status", "open").lte("due_date", localDate)) ?? []) as Array<{ id: string; prospect_id: string; due_date: string }>;
  const prospectIds = [...new Set(fuRows.map((f) => f.prospect_id))];
  const prospects = prospectIds.length
    ? ((must(await db.from("gie_prospects").select("id, business_name, do_not_contact").eq("tenant_id", tenant.id).in("id", prospectIds)) ?? []) as Array<{ id: string; business_name: string; do_not_contact: boolean }>)
    : [];
  const pById = new Map(prospects.map((p) => [p.id, p]));
  const followUps: FollowUpCandidate[] = fuRows.flatMap((f) => {
    const p = pById.get(f.prospect_id);
    return p ? [{ kind: "follow_up" as const, followUpId: f.id, prospectId: f.prospect_id, businessName: p.business_name, dueDate: f.due_date, doNotContact: p.do_not_contact }] : [];
  });

  // Open opportunities, best first, with what we know about reaching them.
  const opps = (must(
    await db
      .from("gie_opportunities")
      .select("id, business_name, website_url, signal_type, status, latest_score, source_id")
      .eq("tenant_id", tenant.id)
      .in("status", ["new", "saved", "pursuing"])
      .not("latest_score", "is", null)
      .order("latest_score", { ascending: false })
      .limit(50),
  ) ?? []) as Array<{ id: string; business_name: string; website_url: string | null; signal_type: "buying_intent" | "prospecting"; status: "new" | "saved" | "pursuing"; latest_score: number; source_id: string }>;
  const oppIds = opps.map((o) => o.id);

  const [sources, carried, prospectsByOpp] = await Promise.all([
    opps.length ? db.from("gie_sources").select("id, contact").eq("tenant_id", tenant.id).in("id", opps.map((o) => o.source_id)) : { data: [], error: null },
    oppIds.length ? db.from("gie_daily_action_items").select("opportunity_id, status").eq("tenant_id", tenant.id).in("opportunity_id", oppIds) : { data: [], error: null },
    oppIds.length ? db.from("gie_prospects").select("opportunity_id, do_not_contact").eq("tenant_id", tenant.id).in("opportunity_id", oppIds) : { data: [], error: null },
  ]);
  const contactBySource = new Map(((must(sources as any) ?? []) as Array<{ id: string; contact: { emails?: string[] } | null }>).map((s) => [s.id, s.contact?.emails?.[0] ?? null]));
  const carries = new Map<string, number>();
  for (const it of (must(carried as any) ?? []) as Array<{ opportunity_id: string; status: string }>) {
    if (it.status !== "completed" && it.status !== "awaiting_response") carries.set(it.opportunity_id, (carries.get(it.opportunity_id) ?? 0) + 1);
  }
  const dnc = new Set(((must(prospectsByOpp as any) ?? []) as Array<{ opportunity_id: string; do_not_contact: boolean }>).filter((p) => p.do_not_contact).map((p) => p.opportunity_id));

  const urgencyRows = oppIds.length
    ? ((must(await db.from("gie_opportunity_classifications").select("opportunity_id, output").eq("tenant_id", tenant.id).eq("outcome", "accepted").in("opportunity_id", oppIds)) ?? []) as Array<{ opportunity_id: string; output: { urgency?: string } | null }>)
    : [];
  const urgencyBy = new Map(urgencyRows.map((r) => [r.opportunity_id, (r.output?.urgency as OpportunityCandidate["urgency"]) ?? "unknown"]));

  const candidates: OpportunityCandidate[] = opps.map((o) => ({
    kind: "opportunity",
    opportunityId: o.id,
    businessName: o.business_name,
    status: o.status,
    score: o.latest_score,
    signalType: o.signal_type,
    urgency: urgencyBy.get(o.id) ?? "unknown",
    hasEmail: !!o.website_url && !!contactBySource.get(o.source_id),
    alreadyInTodaysPackage: false,
    doNotContact: dnc.has(o.id),
    timesCarried: carries.get(o.id) ?? 0,
  }));

  const ranked = rankCandidates(localDate, followUps, candidates);
  if (!ranked.length) {
    // Still record an (empty) package: "no verified items today" is a fact, and the date is then claimed.
    must(await db.from("gie_daily_action_packages").upsert({ tenant_id: tenant.id, local_date: localDate, late, ranking_version: RANKING_VERSION }, { onConflict: "tenant_id,local_date", ignoreDuplicates: true }));
    return { status: "created", items: 0, drafts: 0 };
  }

  const pkg = must(
    await db.from("gie_daily_action_packages").upsert({ tenant_id: tenant.id, local_date: localDate, late, ranking_version: RANKING_VERSION }, { onConflict: "tenant_id,local_date" }).select("id").single(),
  ) as { id: string };
  const existing = ((must(await db.from("gie_daily_action_items").select("id").eq("tenant_id", tenant.id).eq("package_id", pkg.id)) ?? []) as unknown[]).length;
  if (existing) return { status: "skipped", reason: "package already has items", items: 0, drafts: 0 };

  let drafts = 0;
  const emailByOpp = new Map(opps.map((o) => [o.id, contactBySource.get(o.source_id) ?? null]));
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i]!;
    const item = must(
      await db
        .from("gie_daily_action_items")
        .insert({
          tenant_id: tenant.id,
          package_id: pkg.id,
          rank: i + 1,
          kind: r.kind,
          opportunity_id: r.opportunityId ?? null,
          follow_up_id: r.followUpId ?? null,
          prospect_id: r.prospectId ?? null,
          recommended_action: r.recommendedAction,
          effort: r.effort,
          importance: r.importance,
          rank_score: r.rankScore,
        })
        .select("id")
        .single(),
    ) as { id: string };
    must(await db.from("gie_daily_action_events").insert({ tenant_id: tenant.id, item_id: item.id, event_type: "created", to_status: "not_started", detail: { rank: i + 1, rankScore: r.rankScore } }));

    // Draft only for the top opportunities that have a public email (cost control, plan section 10).
    if (r.kind === "opportunity" && r.opportunityId && emailByOpp.get(r.opportunityId) && env.ANTHROPIC_API_KEY) {
      try {
        if (await draftFor(db, env, tenant, r.opportunityId, emailByOpp.get(r.opportunityId)!, item.id, now)) drafts++;
      } catch (error) {
        // A failed draft never blocks the package: the person can still act on the opportunity.
        console.warn("[package] draft failed", error instanceof Error ? error.message : error);
      }
    }
  }
  return { status: "created", items: ranked.length, drafts };
}

/** Creates the prospect (once per opportunity) and a validated draft. Returns false when it was skipped. */
async function draftFor(db: Db, env: ServerEnv, tenant: TenantRow, opportunityId: string, email: string, itemId: string, now: Date): Promise<boolean> {
  const opp = must(await db.from("gie_opportunities").select("id, business_name, website_url, signal_type").eq("tenant_id", tenant.id).eq("id", opportunityId).single()) as { id: string; business_name: string; website_url: string | null; signal_type: "buying_intent" | "prospecting" };
  const prospect = must(
    await db
      .from("gie_prospects")
      .upsert({ tenant_id: tenant.id, opportunity_id: opp.id, business_name: opp.business_name, website_url: opp.website_url, contact_email: email.toLowerCase(), contact_channel: "email" }, { onConflict: "tenant_id,opportunity_id", ignoreDuplicates: true })
      .select("id")
      .maybeSingle(),
  ) as { id: string } | null;
  const prospectRow = prospect ?? (must(await db.from("gie_prospects").select("id, do_not_contact").eq("tenant_id", tenant.id).eq("opportunity_id", opp.id).single()) as { id: string; do_not_contact?: boolean });
  if ((prospectRow as { do_not_contact?: boolean }).do_not_contact) return false;
  must(await db.from("gie_daily_action_items").update({ prospect_id: prospectRow.id }).eq("tenant_id", tenant.id).eq("id", itemId));

  // Evidence for the draft: the checked classification, the exact quotes, and any PageSpeed result.
  const cls = must(await db.from("gie_opportunity_classifications").select("output, evidence_checked").eq("tenant_id", tenant.id).eq("opportunity_id", opp.id).eq("outcome", "accepted").order("created_at", { ascending: false }).limit(1).maybeSingle()) as { output: { summary?: string } | null; evidence_checked: { quotes?: Array<{ quote: string; found: boolean; field: string }> } | null } | null;
  const speed = opp.website_url
    ? (must(await db.from("gie_sources").select("metrics").eq("tenant_id", tenant.id).eq("source_type", "pagespeed").eq("normalized_url", opp.website_url).order("fetched_at", { ascending: false }).limit(1).maybeSingle()) as { metrics: { performance: number | null; seo: number | null } | null } | null)
    : null;
  const prompt = buildDraftPrompt({
    businessName: opp.business_name,
    websiteUrl: opp.website_url,
    signalType: opp.signal_type,
    summary: cls?.output?.summary ?? null,
    quotes: (cls?.evidence_checked?.quotes ?? []).filter((q) => q.found && (q.field === "intent_quote" || q.field === "industry_quote")).map((q) => q.quote),
    pagespeed: speed?.metrics ? { performance: speed.metrics.performance, seo: speed.metrics.seo } : null,
  });
  const budget = await maySpend(db, tenant.id, tenant.timezone, "ai", worstCaseCostUsd("claude-opus-5-5", prompt.length + 2_000, 3_000), now);
  if (!budget.allowed) return false;

  const result = await draftOutreach(env.ANTHROPIC_API_KEY!, prompt);
  if (result.kind === "error") return false;
  const cost = estimateCostUsd(result.model, result.inputTokens, result.outputTokens);
  await recordUsage(db, { tenantId: tenant.id, category: "ai", provider: "anthropic", operation: "draft", model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost, requestId: result.requestId, idempotencyKey: `draft:${itemId}` });

  const parsed = DraftOutput.safeParse(result.output);
  if (!parsed.success) return false;
  const d = parsed.data;
  const validation = validateDraft({
    subject: d.subject,
    body: d.body,
    followUpBody: d.follow_up_body,
    signalType: opp.signal_type,
    prospect: { businessName: opp.business_name, websiteHost: opp.website_url ? hostOf(opp.website_url) : null },
    unsubscribeMarker: UNSUBSCRIBE_MARKER,
    mailingAddressMarker: MAILING_ADDRESS_MARKER,
  });
  // Replace any earlier open draft for this prospect (one live draft each).
  await db.from("gie_outreach_drafts").update({ status: "discarded" }).eq("tenant_id", tenant.id).eq("prospect_id", prospectRow.id).eq("status", "draft");
  const draft = must(
    await db
      .from("gie_outreach_drafts")
      .insert({ tenant_id: tenant.id, prospect_id: prospectRow.id, channel: "email", subject: d.subject, body: d.body, follow_up_body: d.follow_up_body, validation, model: result.model, prompt_version: DRAFT_PROMPT_VERSION, cost_usd: cost })
      .select("id")
      .single(),
  ) as { id: string };
  must(await db.from("gie_daily_action_events").insert({ tenant_id: tenant.id, item_id: itemId, event_type: "draft_created", detail: { draftId: draft.id, ok: validation.ok, errors: validation.errors.length, warnings: validation.warnings.length } }));
  return true;
}

export { STALE_AFTER_CARRIES };

/** Cron entry: the package for every active tenant whose morning time has passed. */
export async function runPackageTick(env: ServerEnv, now = new Date()): Promise<Array<{ tenant: string; step: string; detail: string }>> {
  const db = serviceClient(env, env.GIE_DB_SCHEMA);
  const tenants = (must(await db.from("gie_tenants").select("id, slug, timezone").eq("status", "active")) ?? []) as TenantRow[];
  const log: Array<{ tenant: string; step: string; detail: string }> = [];
  for (const tenant of tenants) {
    try {
      const r = await runMorningPackage(db, env, tenant, now);
      if (r.status === "created") log.push({ tenant: tenant.slug, step: "package", detail: `${r.items} items, ${r.drafts} drafts` });
    } catch (error) {
      log.push({ tenant: tenant.slug, step: "package", detail: `failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return log;
}
