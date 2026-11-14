// Daily Effectiveness Score for the screens. A finalized day's stored score is
// read as it was written; an unfinished day gets a provisional score computed on
// request. Viewers may read it (it is derived from the workspace's own records).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./auth-middleware";
import { requireTenantRole, SlugInput } from "./tenant-access.server";
import { serviceClient } from "./supabase.server";
import { dayStatus, localMoment } from "./schedule";
import { COMPONENT_LABEL, type ComponentKey } from "./scoring/effectiveness";
import { loadSchedule } from "./pipeline/package.server";
import { provisionalScore } from "./pipeline/effectiveness.server";

export type ScoreComponentView = { key: ComponentKey; label: string; weight: number; measured: boolean; points: number | null; explanation: string; earnedBy: Array<{ eventType: string; points: number }> };
export type EffectivenessView = {
  localDate: string;
  today: string;
  /** stored: finalized and permanent. provisional: computed now from what is recorded so far. none: non-business day. */
  state: "stored" | "provisional" | "none";
  ruleVersion: string | null;
  available: boolean;
  score: number | null;
  band: string | null;
  completeness: number;
  reason: string | null;
  components: ScoreComponentView[];
  history: Array<{ localDate: string; available: boolean; score: number | null; band: string | null; completeness: number }>;
};

const weekday = (d: string) => ((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

export const getEffectiveness = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(d))
  .handler(async ({ data, context }): Promise<EffectivenessView> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "viewer");
    const db = context.supabase;
    const today = localMoment(new Date(), tenant.timezone).date;
    const localDate = data.date ?? today;
    const row = { id: tenant.tenantId, slug: tenant.slug, timezone: tenant.timezone };

    const hist = await db.from("gie_daily_effectiveness_scores").select("local_date, available, score, band, completeness").eq("tenant_id", tenant.tenantId).order("local_date", { ascending: false }).limit(14);
    if (hist.error) throw new Error(hist.error.message);
    const history = ((hist.data ?? []) as any[]).map((h) => ({ localDate: h.local_date, available: h.available, score: h.score, band: h.band, completeness: h.completeness }));
    const base = { localDate, today, history };

    const stored = await db.from("gie_daily_effectiveness_scores").select("id, rule_version, available, score, band, completeness, unavailable_reason").eq("tenant_id", tenant.tenantId).eq("local_date", localDate).maybeSingle();
    if (stored.error) throw new Error(stored.error.message);
    if (stored.data) {
      const [comps, events] = await Promise.all([
        db.from("gie_effectiveness_score_components").select("component, weight, measured, points, explanation").eq("tenant_id", tenant.tenantId).eq("score_id", stored.data.id),
        db.from("gie_effectiveness_score_events").select("component, event_type, points").eq("tenant_id", tenant.tenantId).eq("score_id", stored.data.id),
      ]);
      if (comps.error) throw new Error(comps.error.message);
      if (events.error) throw new Error(events.error.message);
      const order = Object.keys(COMPONENT_LABEL);
      return {
        ...base,
        state: "stored",
        ruleVersion: stored.data.rule_version,
        available: stored.data.available,
        score: stored.data.score,
        band: stored.data.band,
        completeness: stored.data.completeness,
        reason: stored.data.unavailable_reason,
        components: ((comps.data ?? []) as any[])
          .sort((a, b) => order.indexOf(a.component) - order.indexOf(b.component))
          .map((c) => ({ key: c.component, label: COMPONENT_LABEL[c.component as ComponentKey], weight: c.weight, measured: c.measured, points: c.points === null ? null : Number(c.points), explanation: c.explanation, earnedBy: ((events.data ?? []) as any[]).filter((e) => e.component === c.component).map((e) => ({ eventType: e.event_type, points: Number(e.points) })) })),
      };
    }

    const svc = serviceClient(context.env, context.env.GIE_DB_SCHEMA);
    const schedule = await loadSchedule(svc, row);
    if (dayStatus({ date: localDate, isoWeekday: weekday(localDate), minutes: 0 }, schedule) !== "business_day") {
      return { ...base, state: "none", ruleVersion: null, available: false, score: null, band: null, completeness: 0, reason: "Non-business day: no score is given.", components: [] };
    }
    const { score, ruleVersion } = await provisionalScore(svc, row, localDate);
    return {
      ...base,
      state: "provisional",
      ruleVersion,
      available: score.available,
      score: score.score,
      band: score.band,
      completeness: score.completeness,
      reason: score.reason,
      components: score.components.map((c) => ({ key: c.key, label: COMPONENT_LABEL[c.key], weight: c.weight, measured: c.measured, points: c.points, explanation: c.explanation, earnedBy: c.evidence.map((e) => ({ eventType: e.eventType, points: e.points })) })),
    };
  });
