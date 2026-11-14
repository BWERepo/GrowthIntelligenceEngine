// Stores suggestions, records a person's decision, and measures what happened after a
// suggestion was carried out. Nothing here writes to campaigns or any other settings.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServerEnv } from "@/lib/env.server";
import { serviceClient } from "@/lib/supabase.server";
import { localMoment } from "@/lib/schedule";
import type { ScenarioFlag } from "@/lib/growth/metrics";
import { COOLDOWN_DAYS, judgeOutcome, OUTCOME_DAYS, recommend, type CampaignStats, type Metric, type RecommendationDraft } from "@/lib/improve/rules";
import type { TenantRow } from "./discover.server";

type Db = SupabaseClient<any, any, any>;
type Row = Record<string, any>;
const must = <T>(r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data;
};
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const rows = async (q: PromiseLike<{ data: any; error: { message: string } | null }>) => (must(await q) ?? []) as Row[];

/** One recorded measure over [from, to). `campaignId` narrows opportunities and replies to one campaign. */
export async function measure(db: Db, tenantId: string, metric: Metric, campaignId: string | null, from: string, to: string): Promise<number> {
  if (metric === "lead") {
    const r = await db.from("gie_sales_funnel_events").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("stage", "lead").gte("occurred_at", from).lt("occurred_at", to);
    if (r.error) throw new Error(r.error.message);
    return r.count ?? 0;
  }
  if (metric === "opportunity") {
    let q = db.from("gie_opportunities").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).gte("discovered_at", from).lt("discovered_at", to);
    if (campaignId) q = q.eq("campaign_id", campaignId);
    const r = await q;
    if (r.error) throw new Error(r.error.message);
    return r.count ?? 0;
  }
  const replies = await rows(db.from("gie_outreach_replies").select("prospect_id").eq("tenant_id", tenantId).eq("kind", "reply").gte("received_at", from).lt("received_at", to));
  if (!campaignId) return replies.length;
  const campaignOf = await prospectCampaigns(db, tenantId);
  return replies.filter((r) => campaignOf.get(r.prospect_id) === campaignId).length;
}

async function prospectCampaigns(db: Db, tenantId: string): Promise<Map<string, string>> {
  const prospects = await rows(db.from("gie_prospects").select("id, opportunity_id").eq("tenant_id", tenantId));
  const opps = await rows(db.from("gie_opportunities").select("id, campaign_id").eq("tenant_id", tenantId));
  const campaignOfOpp = new Map(opps.map((o) => [o.id, o.campaign_id]));
  return new Map(prospects.filter((p) => p.opportunity_id && campaignOfOpp.has(p.opportunity_id)).map((p) => [p.id, campaignOfOpp.get(p.opportunity_id)]));
}

export async function campaignStats(db: Db, tenantId: string, now: Date): Promise<CampaignStats[]> {
  const from = iso(now.getTime() - 30 * DAY);
  const to = iso(now.getTime());
  const campaigns = await rows(db.from("gie_campaigns").select("id, name, created_at").eq("tenant_id", tenantId).eq("status", "active"));
  if (!campaigns.length) return [];
  const campaignOf = await prospectCampaigns(db, tenantId);
  const opps = await rows(db.from("gie_opportunities").select("campaign_id").eq("tenant_id", tenantId).gte("discovered_at", from).lt("discovered_at", to));
  const sent = await rows(db.from("gie_outreach_drafts").select("prospect_id").eq("tenant_id", tenantId).eq("status", "sent").gte("sent_at", from).lt("sent_at", to));
  const replies = await rows(db.from("gie_outreach_replies").select("prospect_id").eq("tenant_id", tenantId).eq("kind", "reply").gte("received_at", from).lt("received_at", to));
  return campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    ageDays: Math.floor((now.getTime() - Date.parse(c.created_at)) / DAY),
    opportunities: opps.filter((o) => o.campaign_id === c.id).length,
    contacted: sent.filter((s) => campaignOf.get(s.prospect_id) === c.id).length,
    replied: replies.filter((r) => campaignOf.get(r.prospect_id) === c.id).length,
  }));
}

/** The flags from the newest frozen 30-day report (no outside reads needed). */
async function latestFlags(db: Db, tenantId: string): Promise<ScenarioFlag[]> {
  const snap = (must(await db.from("gie_growth_period_snapshots").select("report").eq("tenant_id", tenantId).order("as_of_date", { ascending: false }).limit(1).maybeSingle()) ?? null) as { report: { flags?: ScenarioFlag[] } } | null;
  return snap?.report?.flags ?? [];
}

/** Adds suggestions that are new: not already open, and not decided in the last 30 days. Returns how many were added. */
export async function generateRecommendations(db: Db, tenant: TenantRow, now: Date): Promise<number> {
  const drafts = recommend(await campaignStats(db, tenant.id, now), await latestFlags(db, tenant.id));
  if (!drafts.length) return 0;
  const existing = await rows(db.from("gie_recommendations").select("rule_key, subject_key, status, created_at, decided_at, implemented_at").eq("tenant_id", tenant.id));
  const recent = now.getTime() - COOLDOWN_DAYS * DAY;
  const blocked = (d: RecommendationDraft) =>
    existing.some((e) => e.rule_key === d.ruleKey && e.subject_key === d.subjectKey && (e.status === "proposed" || e.status === "approved" || Date.parse(e.decided_at ?? e.created_at) > recent));
  let added = 0;
  for (const d of drafts.filter((x) => !blocked(x))) {
    const r = await db.from("gie_recommendations").insert({ tenant_id: tenant.id, rule_key: d.ruleKey, subject_key: d.subjectKey, campaign_id: d.campaignId, title: d.title, rationale: d.rationale, evidence: d.evidence, metric: d.metric });
    if (r.error) {
      if (r.error.message.includes("duplicate key")) continue; // raised by a parallel run
      throw new Error(r.error.message);
    }
    added += 1;
  }
  return added;
}

export type DecisionResult = { ok: true } | { ok: false; reason: string };

/** A person approves or rejects a suggestion. Only a proposed one can be decided, once. */
export async function decide(db: Db, tenantId: string, id: string, userId: string, action: "approve" | "reject", note: string | null, now: Date): Promise<DecisionResult> {
  const from = action === "approve" ? ["proposed"] : ["proposed", "approved"];
  const r = await db.from("gie_recommendations").update({ status: action === "approve" ? "approved" : "rejected", decided_by: userId, decided_at: now.toISOString(), decision_note: note }).eq("tenant_id", tenantId).eq("id", id).in("status", from).select("id");
  if (r.error) throw new Error(r.error.message);
  if (!(r.data ?? []).length) return { ok: false, reason: "That suggestion is not waiting for this decision any more." };
  await db.from("gie_audit_events").insert({ tenant_id: tenantId, actor_user_id: userId, action: `recommendation.${action}`, entity_type: "recommendation", entity_id: id, after: { note } });
  return { ok: true };
}

/** A person says they carried an approved suggestion out. The measure's last 30 days become its baseline. */
export async function markImplemented(db: Db, tenantId: string, id: string, userId: string, note: string | null, now: Date): Promise<DecisionResult> {
  const rec = (must(await db.from("gie_recommendations").select("status, metric, campaign_id").eq("tenant_id", tenantId).eq("id", id).maybeSingle()) ?? null) as Row | null;
  if (!rec) throw new Error("Not found: that suggestion does not exist in this workspace.");
  if (rec.status !== "approved") return { ok: false, reason: "Only an approved suggestion can be marked as carried out." };
  const value = await measure(db, tenantId, rec.metric, rec.campaign_id, iso(now.getTime() - OUTCOME_DAYS * DAY), iso(now.getTime()));
  const r = await db.from("gie_recommendations").update({ status: "implemented", implemented_by: userId, implemented_at: now.toISOString(), implementation_note: note, baseline: { value, from: iso(now.getTime() - OUTCOME_DAYS * DAY), to: iso(now.getTime()) } }).eq("tenant_id", tenantId).eq("id", id).eq("status", "approved").select("id");
  if (r.error) throw new Error(r.error.message);
  if (!(r.data ?? []).length) return { ok: false, reason: "That suggestion changed while you were marking it." };
  await db.from("gie_audit_events").insert({ tenant_id: tenantId, actor_user_id: userId, action: "recommendation.implemented", entity_type: "recommendation", entity_id: id, after: { note, baseline: value } });
  return { ok: true };
}

/** Reads the same measure for the 30 days after a suggestion was carried out and stores the result once. */
export async function measureOutcomes(db: Db, tenant: TenantRow, now: Date): Promise<number> {
  const due = await rows(db.from("gie_recommendations").select("id, metric, campaign_id, baseline, implemented_at").eq("tenant_id", tenant.id).eq("status", "implemented").is("outcome", null).lte("implemented_at", iso(now.getTime() - OUTCOME_DAYS * DAY)));
  let n = 0;
  for (const r of due) {
    const start = Date.parse(r.implemented_at);
    const after = await measure(db, tenant.id, r.metric, r.campaign_id, iso(start), iso(start + OUTCOME_DAYS * DAY));
    const outcome = judgeOutcome(Number(r.baseline.value), after);
    const u = await db.from("gie_recommendations").update({ outcome, outcome_at: now.toISOString() }).eq("tenant_id", tenant.id).eq("id", r.id).is("outcome", null).select("id");
    if (u.error) throw new Error(u.error.message);
    n += (u.data ?? []).length;
  }
  return n;
}

export async function runImproveTick(env: ServerEnv, now = new Date()): Promise<Array<{ tenant: string; step: string; detail: string }>> {
  const db = serviceClient(env, env.GIE_DB_SCHEMA);
  const tenants = (must(await db.from("gie_tenants").select("id, slug, timezone").eq("status", "active")) ?? []) as TenantRow[];
  const log: Array<{ tenant: string; step: string; detail: string }> = [];
  for (const tenant of tenants) {
    try {
      // Hourly is plenty; the work is idempotent.
      if (localMoment(now, tenant.timezone).minutes % 60 >= 15) continue;
      const added = await generateRecommendations(db, tenant, now);
      const measured = await measureOutcomes(db, tenant, now);
      if (added) log.push({ tenant: tenant.slug, step: "improve", detail: `${added} new suggestion(s)` });
      if (measured) log.push({ tenant: tenant.slug, step: "improve", detail: `${measured} outcome(s) measured` });
    } catch (error) {
      log.push({ tenant: tenant.slug, step: "improve", detail: `failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return log;
}
