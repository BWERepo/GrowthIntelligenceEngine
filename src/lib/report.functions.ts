// Monthly report for one workspace, built only from recorded data and read as the caller
// (RLS), so a workspace can only ever report on itself.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./auth-middleware";
import { requireTenantRole, SlugInput } from "./tenant-access.server";
import { localMoment } from "./schedule";
import { MONTH, monthRange, recentMonths } from "./reporting/month";

export type MonthlyReport = {
  month: string;
  months: string[];
  workspace: string;
  /** False when this workspace has no connection to business records (leads, payments). */
  businessConnected: boolean;
  outreach: { opportunities: number; prospects: number; emailsSent: number; replies: number };
  results: { leads: number; meetings: number; proposals: number; agreements: number; customers: number; revenueUsdCents: number } | null;
  effectiveness: { daysScored: number; average: number | null };
  suggestions: { raised: number; decided: number; carriedOut: number };
  spendUsd: number;
};

export const getMonthlyReport = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput, month: z.string().regex(MONTH).optional() }).parse(d))
  .handler(async ({ data, context }): Promise<MonthlyReport> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "viewer");
    const db = context.supabase;
    const t = tenant.tenantId;
    const today = localMoment(new Date(), tenant.timezone).date;
    const months = recentMonths(today);
    const month = data.month ?? months[0]!;
    const r = monthRange(month, tenant.timezone);
    const businessConnected = tenant.slug === context.env.BWE_TENANT_SLUG;

    const count = async (table: string, col: string, extra?: (q: any) => any) => {
      let q = db.from(table).select("id", { count: "exact", head: true }).eq("tenant_id", t).gte(col, r.from).lt(col, r.to);
      if (extra) q = extra(q);
      const res = await q;
      if (res.error) throw new Error(res.error.message);
      return res.count ?? 0;
    };
    const stage = (s: string) => count("gie_sales_funnel_events", "occurred_at", (q) => q.eq("stage", s));

    const [opportunities, prospects, emailsSent, replies] = await Promise.all([
      count("gie_opportunities", "discovered_at"),
      count("gie_prospects", "created_at"),
      count("gie_outreach_drafts", "sent_at", (q) => q.eq("status", "sent")),
      count("gie_outreach_replies", "received_at", (q) => q.eq("kind", "reply")),
    ]);
    let results: MonthlyReport["results"] = null;
    if (businessConnected) {
      const [leads, meetings, proposals, agreements, customers] = await Promise.all(["lead", "meeting", "proposal", "agreement", "customer"].map(stage));
      const rev = await db.from("gie_revenue_events").select("amount_cents").eq("tenant_id", t).eq("currency", "usd").gte("paid_at", r.from).lt("paid_at", r.to);
      if (rev.error) throw new Error(rev.error.message);
      results = { leads: leads!, meetings: meetings!, proposals: proposals!, agreements: agreements!, customers: customers!, revenueUsdCents: ((rev.data ?? []) as Array<{ amount_cents: number }>).reduce((s, x) => s + Number(x.amount_cents), 0) };
    }
    const scores = await db.from("gie_daily_effectiveness_scores").select("score").eq("tenant_id", t).eq("available", true).gte("local_date", r.firstDate).lte("local_date", r.lastDate);
    if (scores.error) throw new Error(scores.error.message);
    const sc = (scores.data ?? []) as Array<{ score: number }>;
    const recs = await db.from("gie_recommendations").select("status, created_at, decided_at, implemented_at").eq("tenant_id", t);
    if (recs.error) throw new Error(recs.error.message);
    const within = (iso: string | null) => !!iso && iso >= r.from && iso < r.to;
    const rr = (recs.data ?? []) as Array<{ created_at: string; decided_at: string | null; implemented_at: string | null }>;
    const usage = await db.from("gie_usage_events").select("cost_usd").eq("tenant_id", t).gte("occurred_at", r.from).lt("occurred_at", r.to).limit(50_000);
    if (usage.error) throw new Error(usage.error.message);
    return {
      month,
      months,
      workspace: tenant.name,
      businessConnected,
      outreach: { opportunities, prospects, emailsSent, replies },
      results,
      effectiveness: { daysScored: sc.length, average: sc.length ? Math.round((sc.reduce((s, x) => s + x.score, 0) / sc.length) * 10) / 10 : null },
      suggestions: { raised: rr.filter((x) => within(x.created_at)).length, decided: rr.filter((x) => within(x.decided_at)).length, carriedOut: rr.filter((x) => within(x.implemented_at)).length },
      spendUsd: Math.round(((usage.data ?? []) as Array<{ cost_usd: number }>).reduce((s, x) => s + Number(x.cost_usd), 0) * 100) / 100,
    };
  });
