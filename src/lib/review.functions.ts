// Server functions for the End-of-Day Review. Reads and a person's corrections use
// the caller's token (RLS and column grants). Building and finalizing are server
// acts: finalizing applies the decisions and locks the review.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./auth-middleware";
import { requireTenantRole, SlugInput } from "./tenant-access.server";
import { serviceClient } from "./supabase.server";
import { hasRole } from "./roles";
import { localMoment } from "./schedule";
import { finalizeReview, runEndOfDayReview, type ChoiceProblem } from "./pipeline/review.server";
import type { Disposition, ItemKind, ItemStatus } from "./review/rules";

const STATUS = z.enum(["not_started", "in_progress", "completed", "deferred", "blocked", "awaiting_response", "cancelled"]);
const DISPOSITION = z.enum(["none", "carry_forward", "reschedule", "lower_priority", "block", "archive", "dismiss"]);
const DateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export type ReviewItemView = {
  id: string; // review item id
  itemId: string;
  rank: number;
  kind: ItemKind;
  businessName: string;
  recommendedAction: string;
  recordedStatus: ItemStatus;
  correctedStatus: ItemStatus | null;
  timesUnfinished: number;
  stale: boolean;
  recommended: Disposition;
  disposition: Disposition | null;
  dispositionDate: string | null;
  note: string | null;
};

export type ReviewView = {
  localDate: string;
  today: string;
  dates: string[];
  review: {
    id: string;
    status: "draft" | "finalized";
    late: boolean;
    hasPackage: boolean;
    finalizedAt: string | null;
    tomorrowDate: string | null;
    tomorrowPlan: Array<{ kind: string; businessName: string; recommendedAction: string }> | null;
  } | null;
  items: ReviewItemView[];
  assessment: { summary: string; wentWell: string[]; needsAttention: string[]; suggestion: string | null; model: string } | null;
  canCorrect: boolean;
  canFinalize: boolean;
};

export const getReview = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput, date: DateInput.optional() }).parse(d))
  .handler(async ({ data, context }): Promise<ReviewView> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "viewer");
    const db = context.supabase;
    const today = localMoment(new Date(), tenant.timezone).date;
    const localDate = data.date ?? today;
    const canCorrect = hasRole(tenant.role, "operator");
    const base = { localDate, today, canCorrect, canFinalize: hasRole(tenant.role, "owner") };

    const [rev, dates] = await Promise.all([
      db.from("gie_end_of_day_reviews").select("id, status, late, package_id, finalized_at, tomorrow_date, tomorrow_plan").eq("tenant_id", tenant.tenantId).eq("local_date", localDate).maybeSingle(),
      db.from("gie_end_of_day_reviews").select("local_date").eq("tenant_id", tenant.tenantId).order("local_date", { ascending: false }).limit(14),
    ]);
    if (rev.error) throw new Error(rev.error.message);
    if (dates.error) throw new Error(dates.error.message);
    const dateList = ((dates.data ?? []) as Array<{ local_date: string }>).map((d) => d.local_date);
    if (!rev.data) return { ...base, dates: dateList, review: null, items: [], assessment: null };

    const rows = await db.from("gie_end_of_day_review_items").select("id, item_id, recorded_status, corrected_status, times_unfinished, stale, recommended_disposition, disposition, disposition_date, note").eq("tenant_id", tenant.tenantId).eq("review_id", rev.data.id);
    if (rows.error) throw new Error(rows.error.message);
    const reviewItems = (rows.data ?? []) as any[];
    const actions = reviewItems.length ? await db.from("gie_daily_action_items").select("id, rank, kind, recommended_action, opportunity_id, prospect_id, follow_up_id").eq("tenant_id", tenant.tenantId).in("id", reviewItems.map((r) => r.item_id)) : { data: [], error: null };
    if (actions.error) throw new Error(actions.error.message);
    const acts = (actions.data ?? []) as any[];
    const oppIds = acts.flatMap((a) => (a.opportunity_id ? [a.opportunity_id] : []));
    const prospectIds = acts.flatMap((a) => (a.prospect_id ? [a.prospect_id] : []));
    const [opps, prospects] = await Promise.all([
      oppIds.length ? db.from("gie_opportunities").select("id, business_name").eq("tenant_id", tenant.tenantId).in("id", oppIds) : { data: [], error: null },
      prospectIds.length ? db.from("gie_prospects").select("id, business_name").eq("tenant_id", tenant.tenantId).in("id", prospectIds) : { data: [], error: null },
    ]);
    if (opps.error) throw new Error(opps.error.message);
    if (prospects.error) throw new Error(prospects.error.message);
    const nameOpp = new Map(((opps.data ?? []) as any[]).map((o) => [o.id, o.business_name as string]));
    const nameProspect = new Map(((prospects.data ?? []) as any[]).map((o) => [o.id, o.business_name as string]));
    const actBy = new Map(acts.map((a) => [a.id, a]));

    const asm = await db.from("gie_ai_daily_assessments").select("summary, went_well, needs_attention, suggestion, model").eq("tenant_id", tenant.tenantId).eq("review_id", rev.data.id).maybeSingle();
    if (asm.error) throw new Error(asm.error.message);

    const items = reviewItems
      .map((r): ReviewItemView => {
        const a = actBy.get(r.item_id);
        return {
          id: r.id,
          itemId: r.item_id,
          rank: a?.rank ?? 0,
          kind: a?.kind ?? "opportunity",
          businessName: (a?.opportunity_id && nameOpp.get(a.opportunity_id)) || (a?.prospect_id && nameProspect.get(a.prospect_id)) || "Unknown business",
          recommendedAction: a?.recommended_action ?? "",
          recordedStatus: r.recorded_status,
          correctedStatus: r.corrected_status,
          timesUnfinished: r.times_unfinished,
          stale: r.stale,
          recommended: r.recommended_disposition,
          disposition: r.disposition,
          dispositionDate: r.disposition_date,
          note: r.note,
        };
      })
      .sort((a, b) => a.rank - b.rank);

    return {
      ...base,
      dates: dateList,
      review: { id: rev.data.id, status: rev.data.status, late: rev.data.late, hasPackage: !!rev.data.package_id, finalizedAt: rev.data.finalized_at, tomorrowDate: rev.data.tomorrow_date, tomorrowPlan: rev.data.tomorrow_plan },
      items,
      assessment: asm.data ? { summary: asm.data.summary, wentWell: asm.data.went_well ?? [], needsAttention: asm.data.needs_attention ?? [], suggestion: asm.data.suggestion, model: asm.data.model } : null,
    };
  });

/** A person's correction and decision for one item. The database refuses it once the review is finalized. */
export const saveReviewItem = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) =>
    z
      .object({
        slug: SlugInput,
        reviewItemId: z.string().uuid(),
        correctedStatus: STATUS.nullable(),
        disposition: DISPOSITION.nullable(),
        dispositionDate: DateInput.nullable(),
        note: z.string().trim().max(300).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    const upd = await context.supabase
      .from("gie_end_of_day_review_items")
      .update({ corrected_status: data.correctedStatus, disposition: data.disposition, disposition_date: data.dispositionDate, note: data.note || null })
      .eq("tenant_id", tenant.tenantId)
      .eq("id", data.reviewItemId)
      .select("id");
    if (upd.error) throw new Error(upd.error.message.includes("finalized") ? "This review is finalized and can no longer be changed." : upd.error.message);
    if (!upd.data?.length) throw new Error("Not found: that review item does not exist in this workspace.");
    return { ok: true };
  });

export const finalizeReviewFn = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput, date: DateInput }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true; tomorrow: number } | { ok: false; reason: string; problems?: ChoiceProblem[] }> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "owner");
    const svc = serviceClient(context.env, context.env.GIE_DB_SCHEMA);
    return finalizeReview(svc, { id: tenant.tenantId, slug: tenant.slug, timezone: tenant.timezone }, data.date, context.userId, new Date());
  });

/** Owner only: builds today's review now (without the time check). Still at most one per local date. */
export const buildReviewNow = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput }).parse(d))
  .handler(async ({ data, context }) => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "owner");
    const svc = serviceClient(context.env, context.env.GIE_DB_SCHEMA);
    return runEndOfDayReview(svc, { id: tenant.tenantId, slug: tenant.slug, timezone: tenant.timezone }, new Date(), { force: true });
  });

