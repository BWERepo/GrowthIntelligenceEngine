// Records business outcomes as funnel and revenue events (each keyed by its source row,
// so syncing twice never counts twice), builds the 30-day report from them, and freezes
// one report per day. BWE's tables are only read, and only for the BWE workspace.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServerEnv } from "@/lib/env.server";
import { bweReader } from "@/lib/bwe-source.server";
import { serviceClient } from "@/lib/supabase.server";
import { localMoment, startOfLocalDayUtc } from "@/lib/schedule";
import { attributeTo, makeLinker, normEmail, UNKNOWN, type Attributed, type LeadRef, type ProspectRef } from "@/lib/growth/attribution";
import { buildReport, MIN_EVENTS, periodsFor, shiftDate, WINDOW_DAYS, type Attribution, type Confidence, type FunnelEvent, type GrowthReport, type RevenueEvent, type Stage } from "@/lib/growth/metrics";
import type { TenantRow } from "./discover.server";

type Db = SupabaseClient<any, any, any>;
type Row = Record<string, any>;
const must = <T>(r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data;
};

/** How far back outcomes are recorded: both periods plus a month so cohorts can reach later stages. */
export const LOOKBACK_DAYS = WINDOW_DAYS * 3;
const PAGE = 1000;

/** All rows of a query, a page at a time. `build` must return a fresh query each call. */
async function all(build: () => any): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = (must(await build().range(from, from + PAGE - 1)) ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const cutoffIso = (now: Date, timezone: string, days = LOOKBACK_DAYS) => startOfLocalDayUtc(shiftDate(localMoment(now, timezone).date, -days), timezone).toISOString();

type NewFunnel = { stage: Stage; source_table: string; source_id: string; occurred_at: string } & { prospect_id: string | null; attribution: Attribution; attribution_confidence: Confidence; attribution_basis: string | null };
const fe = (stage: Stage, table: string, id: string, at: string, a: Attributed = UNKNOWN, prospectId: string | null = a.prospectId): NewFunnel => ({
  stage,
  source_table: table,
  source_id: id,
  occurred_at: at,
  prospect_id: prospectId,
  attribution: a.attribution,
  attribution_confidence: a.confidence,
  attribution_basis: a.basis,
});

async function write(db: Db, table: string, tenantId: string, rows: Array<Row>, onConflict: string, refresh: boolean): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ tenant_id: tenantId, ...r }));
    // Outcomes from BWE refresh their attribution when a link appears later; everything else is left as recorded.
    must(await db.from(table).upsert(chunk, { onConflict, ignoreDuplicates: !refresh }));
  }
}

export type SyncResult = { events: number; revenue: number; bwe: boolean };

/** Records the workspace's own events (every workspace) and BWE's outcomes (the BWE workspace only). */
export async function syncOutcomes(db: Db, bwe: Db | null, tenant: TenantRow, now: Date): Promise<SyncResult> {
  const since = cutoffIso(now, tenant.timezone);
  const t = tenant.id;

  const prospectRows = await all(() => db.from("gie_prospects").select("id, contact_email, bwe_lead_id, created_at").eq("tenant_id", t).order("id"));
  const sentRows = await all(() => db.from("gie_outreach_drafts").select("id, prospect_id, sent_at").eq("tenant_id", t).eq("status", "sent").not("sent_at", "is", null).order("id"));
  const firstContact = new Map<string, string>();
  for (const s of sentRows) if (!firstContact.has(s.prospect_id) || s.sent_at < firstContact.get(s.prospect_id)!) firstContact.set(s.prospect_id, s.sent_at);
  const prospects: ProspectRef[] = prospectRows.map((p) => ({ id: p.id, contactEmail: p.contact_email, bweLeadId: p.bwe_lead_id, firstContactAt: firstContact.get(p.id) ?? null }));

  const native: NewFunnel[] = [];
  for (const o of await all(() => db.from("gie_opportunities").select("id, discovered_at").eq("tenant_id", t).gte("discovered_at", since).order("id"))) native.push(fe("opportunity", "gie_opportunities", o.id, o.discovered_at));
  for (const p of prospectRows) if (p.created_at >= since) native.push(fe("pursued", "gie_prospects", p.id, p.created_at, UNKNOWN, p.id));
  for (const s of sentRows) if (s.sent_at >= since) native.push(fe("contacted", "gie_outreach_drafts", s.id, s.sent_at, UNKNOWN, s.prospect_id));
  for (const r of await all(() => db.from("gie_outreach_replies").select("id, prospect_id, received_at").eq("tenant_id", t).eq("kind", "reply").gte("received_at", since).order("id"))) native.push(fe("replied", "gie_outreach_replies", r.id, r.received_at, UNKNOWN, r.prospect_id));
  await write(db, "gie_sales_funnel_events", t, native, "tenant_id,stage,source_table,source_id", false);

  if (!bwe) return { events: native.length, revenue: 0, bwe: false };

  // BWE's records, read only.
  const leadRows = await all(() => bwe.from("leads").select("id, email, created_at").order("id"));
  const leads: LeadRef[] = leadRows.map((l) => ({ id: l.id, email: l.email, createdAt: l.created_at }));
  const linker = makeLinker(prospects, leads);
  const onboard = await all(() => bwe.from("onboardings").select("owner_id, client_email, created_at").not("owner_id", "is", null).order("created_at"));
  const ownerEmail = new Map<string, string>();
  for (const o of onboard) if (normEmail(o.client_email)) ownerEmail.set(o.owner_id, o.client_email);
  const viaOwner = (owner: string | null, at: string): Attributed => (owner ? attributeTo(linker.forOwnerEmail(ownerEmail.get(owner) ?? null, at)) : UNKNOWN);

  const events: NewFunnel[] = [];
  for (const l of leads) if (l.createdAt >= since) events.push(fe("lead", "leads", l.id, l.createdAt, attributeTo(linker.forLead(l))));
  for (const m of await all(() => bwe.from("meetings").select("id, owner_id, meeting_date").gte("meeting_date", since.slice(0, 10)).order("id"))) {
    // A meeting has a date but no time; noon UTC keeps it on that date in US time zones.
    const at = `${m.meeting_date}T12:00:00Z`;
    events.push(fe("meeting", "meetings", m.id, at, viaOwner(m.owner_id, at)));
  }
  for (const p of await all(() => bwe.from("client_proposal_sends").select("id, owner_id, sent_at").gte("sent_at", since).order("id"))) events.push(fe("proposal", "client_proposal_sends", p.id, p.sent_at, viaOwner(p.owner_id, p.sent_at)));
  for (const a of await all(() => bwe.from("client_agreements").select("id, owner_id, signed_at").eq("status", "signed").not("signed_at", "is", null).gte("signed_at", since).order("id"))) events.push(fe("agreement", "client_agreements", a.id, a.signed_at, viaOwner(a.owner_id, a.signed_at)));

  const paid = await all(() => bwe.from("payments").select("id, owner_id, kind, amount_cents, currency, paid_at").eq("status", "paid").not("paid_at", "is", null).order("id"));
  const firstPaid = new Map<string, string>();
  for (const p of paid) if (p.owner_id && (!firstPaid.has(p.owner_id) || p.paid_at < firstPaid.get(p.owner_id)!)) firstPaid.set(p.owner_id, p.paid_at);
  const revenue: Row[] = [];
  for (const p of paid) {
    if (p.paid_at < since) continue;
    const a = viaOwner(p.owner_id, p.paid_at);
    if (p.kind === "deposit") events.push(fe("deposit", "payments", p.id, p.paid_at, a));
    if (p.amount_cents > 0) revenue.push({ payment_id: p.id, paid_at: p.paid_at, kind: p.kind, amount_cents: p.amount_cents, currency: String(p.currency ?? "usd").toLowerCase(), prospect_id: a.prospectId, attribution: a.attribution, attribution_confidence: a.confidence, attribution_basis: a.basis });
  }
  // A customer is counted once, on the date of their first paid payment.
  for (const [owner, at] of firstPaid) if (at >= since) events.push(fe("customer", "customers", owner, at, viaOwner(owner, at)));

  await write(db, "gie_sales_funnel_events", t, events, "tenant_id,stage,source_table,source_id", true);
  await write(db, "gie_revenue_events", t, revenue, "tenant_id,payment_id", true);
  return { events: native.length + events.length, revenue: revenue.length, bwe: true };
}

/** Site visits recorded in each period (BWE workspace only). One row is one recorded visit. */
export async function visitCounts(bwe: Db, tenant: TenantRow, today: string): Promise<{ current: number; previous: number } | null> {
  const { current, previous } = periodsFor(today);
  const count = async (p: { from: string; to: string }) => {
    const from = startOfLocalDayUtc(p.from, tenant.timezone).toISOString();
    const to = startOfLocalDayUtc(shiftDate(p.to, 1), tenant.timezone).toISOString();
    const r = await bwe.from("site_visits").select("id", { count: "exact", head: true }).gte("started_at", from).lt("started_at", to);
    if (r.error) throw new Error(r.error.message);
    return r.count ?? 0;
  };
  return { current: await count(current), previous: await count(previous) };
}

export async function effectivenessAverages(db: Db, tenantId: string, today: string) {
  const { current, previous } = periodsFor(today);
  const rows = (must(await db.from("gie_daily_effectiveness_scores").select("local_date, score").eq("tenant_id", tenantId).eq("available", true).gte("local_date", previous.from).lte("local_date", current.to)) ?? []) as Array<{ local_date: string; score: number }>;
  const avg = (p: { from: string; to: string }) => {
    const r = rows.filter((x) => x.local_date >= p.from && x.local_date <= p.to);
    return { days: r.length, average: r.length ? r.reduce((t, x) => t + x.score, 0) / r.length : null };
  };
  return { current: avg(current), previous: avg(previous) };
}

/** Builds the report from stored events. `db` may be the caller's own client: the events are readable under RLS. */
export async function loadReport(db: Db, tenant: TenantRow, now: Date, ctx: { bweConnected: boolean; visits: { current: number; previous: number } | null }, minEvents = MIN_EVENTS): Promise<GrowthReport> {
  const today = localMoment(now, tenant.timezone).date;
  const { previous } = periodsFor(today);
  const since = startOfLocalDayUtc(previous.from, tenant.timezone).toISOString();
  const [f, r, eff] = await Promise.all([
    all(() => db.from("gie_sales_funnel_events").select("stage, source_table, source_id, occurred_at, prospect_id, attribution, attribution_confidence").eq("tenant_id", tenant.id).gte("occurred_at", since).order("id")),
    all(() => db.from("gie_revenue_events").select("payment_id, paid_at, amount_cents, currency, prospect_id, attribution, attribution_confidence").eq("tenant_id", tenant.id).gte("paid_at", since).order("id")),
    effectivenessAverages(db, tenant.id, today),
  ]);
  const funnel: FunnelEvent[] = f.map((e) => ({ stage: e.stage, sourceTable: e.source_table, sourceId: e.source_id, occurredAt: e.occurred_at, prospectId: e.prospect_id, attribution: e.attribution, confidence: e.attribution_confidence }));
  const revenue: RevenueEvent[] = r.map((e) => ({ paymentId: e.payment_id, paidAt: e.paid_at, amountCents: Number(e.amount_cents), currency: e.currency, prospectId: e.prospect_id, attribution: e.attribution, confidence: e.attribution_confidence }));
  return buildReport({ today, timezone: tenant.timezone, funnel, revenue, bweConnected: ctx.bweConnected, visits: ctx.visits, effectiveness: eff, minEvents });
}

/** Once the new day's figures have settled, freeze yesterday's 30-day report. Returns true when one was written. */
export async function freezeSnapshot(db: Db, tenant: TenantRow, report: GrowthReport): Promise<boolean> {
  const r = await db.from("gie_growth_period_snapshots").upsert({ tenant_id: tenant.id, as_of_date: report.asOfDate, window_days: report.windowDays, min_events: report.minEvents, report }, { onConflict: "tenant_id,as_of_date", ignoreDuplicates: true }).select("id");
  if (r.error) throw new Error(r.error.message);
  return (r.data ?? []).length > 0;
}

/** Local time after which the day's report is frozen, so late-arriving records from yesterday are in it. */
export const FREEZE_AFTER_MINUTES = 6 * 60;

export async function runGrowthTick(env: ServerEnv, now = new Date()): Promise<Array<{ tenant: string; step: string; detail: string }>> {
  const db = serviceClient(env, env.GIE_DB_SCHEMA);
  const tenants = (must(await db.from("gie_tenants").select("id, slug, timezone").eq("status", "active")) ?? []) as TenantRow[];
  const log: Array<{ tenant: string; step: string; detail: string }> = [];
  for (const tenant of tenants) {
    try {
      const isBwe = tenant.slug === env.BWE_TENANT_SLUG;
      const bwe = isBwe ? bweReader(env) : null;
      const local = localMoment(now, tenant.timezone);
      // The sync is cheap and idempotent; run it hourly, not every 15 minutes.
      if (local.minutes % 60 >= 15) continue;
      const s = await syncOutcomes(db, bwe, tenant, now);
      if (local.minutes < FREEZE_AFTER_MINUTES) continue;
      const visits = bwe ? await visitCounts(bwe, tenant, local.date) : null;
      const report = await loadReport(db, tenant, now, { bweConnected: isBwe, visits });
      if (await freezeSnapshot(db, tenant, report)) log.push({ tenant: tenant.slug, step: "growth", detail: `froze the 30-day report for ${report.asOfDate} (${s.events} events recorded)` });
    } catch (error) {
      log.push({ tenant: tenant.slug, step: "growth", detail: `failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return log;
}
