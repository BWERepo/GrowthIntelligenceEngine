// Server functions for the Campaigns and Opportunities pages. Reads go through
// the caller's own token (RLS). The service role is used only after the
// caller's tenant role has been checked: for audit rows, provider status and
// the owner's "search now".
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./auth-middleware";
import { requireTenantRole, SlugInput } from "./tenant-access.server";
import { serviceClient } from "./supabase.server";
import { budgetViews, type BudgetView } from "./spend.server";
import { runSearchStage } from "./pipeline/discover.server";
import { hasRole } from "./roles";

// ---------------------------------------------------------------- campaigns

const listOf = (max: number, itemMax: number) =>
  z
    .array(z.string().trim().min(1).max(itemMax))
    .max(max)
    .transform((a) => [...new Set(a)]);

export const CampaignFields = z.object({
  name: z.string().trim().min(1).max(120),
  status: z.enum(["draft", "active", "paused", "archived"]),
  industries: listOf(40, 80),
  locations: listOf(40, 120),
  buyingIntentQueries: listOf(40, 300),
  prospectingQueries: listOf(40, 300),
  maxAgeDays: z.number().int().min(1).max(365),
  dailySearchLimit: z.number().int().min(1).max(200),
  dailyCandidateLimit: z.number().int().min(1).max(200),
});
export type CampaignFields = z.infer<typeof CampaignFields>;

export type Campaign = CampaignFields & { id: string; updatedAt: string };

export type CampaignsPage = {
  campaigns: Campaign[];
  canEdit: boolean;
  canRunSearch: boolean;
  providers: { search: boolean; ai: boolean; pagespeed: boolean; model: string } | null;
  budgets: BudgetView[];
  lastRuns: Array<{ localDate: string; status: string; error: string | null; finishedAt: string | null }>;
  queue: Record<string, number> | null;
};

function toCampaign(r: any): Campaign {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    industries: r.industries ?? [],
    locations: r.locations ?? [],
    buyingIntentQueries: r.buying_intent_queries ?? [],
    prospectingQueries: r.prospecting_queries ?? [],
    maxAgeDays: r.max_age_days,
    dailySearchLimit: r.daily_search_limit,
    dailyCandidateLimit: r.daily_candidate_limit,
    updatedAt: r.updated_at,
  };
}

export const getCampaignsPage = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput }).parse(d))
  .handler(async ({ data, context }): Promise<CampaignsPage> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "viewer");
    const db = context.supabase;
    const isOperator = hasRole(tenant.role, "operator");
    const [campaigns, runs] = await Promise.all([
      db.from("gie_campaigns").select("*").eq("tenant_id", tenant.tenantId).neq("status", "archived").order("created_at"),
      db.from("gie_job_runs").select("local_date, status, error, finished_at").eq("tenant_id", tenant.tenantId).eq("job_kind", "discovery").order("local_date", { ascending: false }).limit(7),
    ]);
    for (const r of [campaigns, runs]) if (r.error) throw new Error(r.error.message);

    let queue: Record<string, number> | null = null;
    let budgets: BudgetView[] = [];
    if (isOperator) {
      // Usage and the queue are readable by operators through RLS; counted here with the caller's token.
      const states = ["pending", "processing", "classified", "rejected", "duplicate", "blocked", "failed"];
      const counts = await Promise.all(
        states.map((s) => db.from("gie_discovery_candidates").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.tenantId).eq("state", s)),
      );
      queue = Object.fromEntries(states.map((s, i) => [s, counts[i]!.count ?? 0]));
      budgets = await budgetViews(db, tenant.tenantId, tenant.timezone);
    }
    const env = context.env;
    return {
      campaigns: (campaigns.data ?? []).map(toCampaign),
      canEdit: isOperator,
      canRunSearch: hasRole(tenant.role, "owner"),
      // Only whether each key is set, never the key.
      providers: isOperator ? { search: !!env.BRAVE_SEARCH_API_KEY, ai: !!env.ANTHROPIC_API_KEY, pagespeed: !!env.PAGESPEED_API_KEY, model: env.GIE_CLASSIFY_MODEL } : null,
      budgets,
      lastRuns: (runs.data ?? []).map((r: any) => ({ localDate: r.local_date, status: r.status, error: r.error, finishedAt: r.finished_at })),
      queue,
    };
  });

export const saveCampaign = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput, id: z.string().uuid().nullable(), fields: CampaignFields }).parse(d))
  .handler(async ({ data, context }): Promise<{ id: string }> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    const f = data.fields;
    if (f.status === "active" && f.buyingIntentQueries.length + f.prospectingQueries.length === 0) {
      throw new Error("Invalid: an active campaign needs at least one search query.");
    }
    const row = {
      name: f.name,
      status: f.status,
      industries: f.industries,
      locations: f.locations,
      buying_intent_queries: f.buyingIntentQueries,
      prospecting_queries: f.prospectingQueries,
      max_age_days: f.maxAgeDays,
      daily_search_limit: f.dailySearchLimit,
      daily_candidate_limit: f.dailyCandidateLimit,
    };
    const db = context.supabase;
    let before: unknown = null;
    let id = data.id;
    if (id) {
      const prev = await db.from("gie_campaigns").select("*").eq("tenant_id", tenant.tenantId).eq("id", id).maybeSingle();
      if (prev.error) throw new Error(prev.error.message);
      if (!prev.data) throw new Error("Not found: that campaign does not exist in this workspace.");
      before = prev.data;
      const upd = await db.from("gie_campaigns").update(row).eq("tenant_id", tenant.tenantId).eq("id", id).select("id").single();
      if (upd.error) throw new Error(upd.error.message);
    } else {
      const ins = await db.from("gie_campaigns").insert({ ...row, tenant_id: tenant.tenantId, created_by: context.userId }).select("id").single();
      if (ins.error) throw new Error(ins.error.message);
      id = (ins.data as { id: string }).id;
    }
    const audit = await serviceClient(context.env, context.env.GIE_DB_SCHEMA).from("gie_audit_events").insert({
      tenant_id: tenant.tenantId,
      actor_user_id: context.userId,
      action: data.id ? "campaign.update" : "campaign.create",
      entity_type: "campaign",
      entity_id: id,
      before,
      after: row,
    });
    if (audit.error) throw new Error(audit.error.message);
    return { id: id! };
  });

/** Owner only: runs today's searches now instead of waiting for the overnight window. Search only; no AI work. */
export const runSearchNow = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput }).parse(d))
  .handler(async ({ data, context }) => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "owner");
    const svc = serviceClient(context.env, context.env.GIE_DB_SCHEMA);
    const result = await runSearchStage(svc, context.env, { id: tenant.tenantId, slug: tenant.slug, timezone: tenant.timezone }, new Date(), { force: true });
    await svc.from("gie_audit_events").insert({
      tenant_id: tenant.tenantId,
      actor_user_id: context.userId,
      action: "discovery.search_now",
      entity_type: "tenant",
      entity_id: tenant.tenantId,
      after: result,
    });
    return result;
  });

// ---------------------------------------------------------------- opportunities

const STATUSES = ["new", "saved", "pursuing", "dismissed", "converted", "archived"] as const;

export type OpportunityCard = {
  id: string;
  businessName: string;
  websiteUrl: string | null;
  sourceUrl: string;
  signalType: "buying_intent" | "prospecting";
  industry: string | null;
  location: string | null;
  status: (typeof STATUSES)[number];
  dismissReason: string | null;
  discoveredAt: string;
  score: number | null;
  band: string | null;
  components: Array<{ component: string; weight: number; value: number; points: number; explanation: string }>;
  ruleVersion: string | null;
  summary: string | null;
  recommendedAction: string | null;
  quotes: Array<{ field: string; quote: string }>;
  model: string | null;
  pagespeed: { performance: number | null; seo: number | null; accessibility: number | null } | null;
};

export const getOpportunities = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .validator((d: unknown) =>
    z
      .object({
        slug: SlugInput,
        status: z.enum(["open", ...STATUSES]).default("open"),
        signal: z.enum(["all", "buying_intent", "prospecting"]).default("all"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<{ items: OpportunityCard[]; canAct: boolean }> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "viewer");
    const db = context.supabase;
    let q = db
      .from("gie_opportunities")
      .select("id, business_name, website_url, source_url, signal_type, industry, location, status, dismiss_reason, discovered_at, latest_score, latest_band")
      .eq("tenant_id", tenant.tenantId);
    q = data.status === "open" ? q.in("status", ["new", "saved", "pursuing"]) : q.eq("status", data.status);
    if (data.signal !== "all") q = q.eq("signal_type", data.signal);
    const opps = await q.order("latest_score", { ascending: false, nullsFirst: false }).order("discovered_at", { ascending: false }).limit(100);
    if (opps.error) throw new Error(opps.error.message);
    const rows = (opps.data ?? []) as any[];
    const ids = rows.map((r) => r.id);
    if (!ids.length) return { items: [], canAct: hasRole(tenant.role, "operator") };

    const [scores, classes, speeds] = await Promise.all([
      db.from("gie_opportunity_scores").select("id, opportunity_id, rule_version, created_at, gie_opportunity_score_components(component, weight, value, points, explanation)").eq("tenant_id", tenant.tenantId).in("opportunity_id", ids).order("created_at", { ascending: false }),
      db.from("gie_opportunity_classifications").select("opportunity_id, model, output, evidence_checked, created_at").eq("tenant_id", tenant.tenantId).eq("outcome", "accepted").in("opportunity_id", ids).order("created_at", { ascending: false }),
      db.from("gie_sources").select("normalized_url, metrics, fetched_at").eq("tenant_id", tenant.tenantId).eq("source_type", "pagespeed").in("normalized_url", rows.map((r) => r.website_url).filter(Boolean)).order("fetched_at", { ascending: false }),
    ]);
    for (const r of [scores, classes, speeds]) if (r.error) throw new Error(r.error.message);
    const latest = <T extends Record<string, any>>(list: T[], key: string) => {
      const m = new Map<string, T>();
      for (const item of list) if (!m.has(item[key])) m.set(item[key], item);
      return m;
    };
    const scoreBy = latest((scores.data ?? []) as any[], "opportunity_id");
    const classBy = latest((classes.data ?? []) as any[], "opportunity_id");
    const speedBy = latest((speeds.data ?? []) as any[], "normalized_url");
    const order = ["intent", "fit", "freshness", "reachability", "evidence"];

    return {
      canAct: hasRole(tenant.role, "operator"),
      items: rows.map((r) => {
        const s = scoreBy.get(r.id);
        const c = classBy.get(r.id);
        const p = r.website_url ? speedBy.get(r.website_url) : undefined;
        const quotes = ((c?.evidence_checked?.quotes ?? []) as Array<{ field: string; quote: string; found: boolean }>).filter((x) => x.found).map(({ field, quote }) => ({ field, quote }));
        return {
          id: r.id,
          businessName: r.business_name,
          websiteUrl: r.website_url,
          sourceUrl: r.source_url,
          signalType: r.signal_type,
          industry: r.industry,
          location: r.location,
          status: r.status,
          dismissReason: r.dismiss_reason,
          discoveredAt: r.discovered_at,
          score: r.latest_score,
          band: r.latest_band,
          ruleVersion: s?.rule_version ?? null,
          components: ((s?.gie_opportunity_score_components ?? []) as any[])
            .map((x) => ({ component: x.component, weight: x.weight, value: Number(x.value), points: Number(x.points), explanation: x.explanation }))
            .sort((a, b) => order.indexOf(a.component) - order.indexOf(b.component)),
          summary: c?.output?.summary ?? null,
          recommendedAction: c?.output?.recommended_action ?? null,
          quotes,
          model: c?.model ?? null,
          pagespeed: p?.metrics ? { performance: p.metrics.performance ?? null, seo: p.metrics.seo ?? null, accessibility: p.metrics.accessibility ?? null } : null,
        };
      }),
    };
  });

export const setOpportunityStatus = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) =>
    z
      .object({
        slug: SlugInput,
        id: z.string().uuid(),
        // "converted" is set by Phase 3's "Convert to lead", not by hand here.
        status: z.enum(["new", "saved", "pursuing", "dismissed", "archived"]),
        reason: z.string().trim().max(300).optional(),
      })
      .refine((d) => d.status !== "dismissed" || !!d.reason, { message: "Invalid: say why it is dismissed." })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    const db = context.supabase;
    const prev = await db.from("gie_opportunities").select("status, dismiss_reason").eq("tenant_id", tenant.tenantId).eq("id", data.id).maybeSingle();
    if (prev.error) throw new Error(prev.error.message);
    if (!prev.data) throw new Error("Not found: that opportunity does not exist in this workspace.");
    const patch = {
      status: data.status,
      dismiss_reason: data.status === "dismissed" ? data.reason! : null,
      status_changed_at: new Date().toISOString(),
      status_changed_by: context.userId,
    };
    const upd = await db.from("gie_opportunities").update(patch).eq("tenant_id", tenant.tenantId).eq("id", data.id).select("id");
    if (upd.error) throw new Error(upd.error.message);
    if (!upd.data?.length) throw new Error("Forbidden: the change was not allowed.");
    const audit = await serviceClient(context.env, context.env.GIE_DB_SCHEMA).from("gie_audit_events").insert({
      tenant_id: tenant.tenantId,
      actor_user_id: context.userId,
      action: "opportunity.status",
      entity_type: "opportunity",
      entity_id: data.id,
      before: prev.data,
      after: { status: patch.status, dismiss_reason: patch.dismiss_reason },
    });
    if (audit.error) throw new Error(audit.error.message);
    return { ok: true };
  });
