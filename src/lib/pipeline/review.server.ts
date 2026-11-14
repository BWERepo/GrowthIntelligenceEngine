// End-of-day review (plan section 10). At the evening time the server builds a
// review from the day's action package; a person corrects what was missed and
// chooses what happens to each unfinished item; finalizing applies those choices,
// stores a provisional plan for the next business day, and locks the review.
// The assessment is written later, by the cron, from recorded facts only.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServerEnv } from "@/lib/env.server";
import { serviceClient } from "@/lib/supabase.server";
import { dayStatus, dueDailyJobs, localMoment, startOfLocalDayUtc } from "@/lib/schedule";
import { maySpend, recordUsage } from "@/lib/spend.server";
import { estimateCostUsd, worstCaseCostUsd, writeAssessment, AssessmentOutput, ASSESSMENT_PROMPT_VERSION } from "@/lib/providers/ai/anthropic.server";
import { rankCandidates } from "@/lib/actions/ranking";
import { checkChoice, hashFacts, isSettled, recommendDisposition, ungroundedNumbers, type Disposition, type ItemKind, type ItemStatus } from "@/lib/review/rules";
import { loadCandidates, loadSchedule } from "./package.server";
import type { TenantRow } from "./discover.server";

type Db = SupabaseClient<any, any, any>;
const must = <T>(r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data;
};

export type ReviewBuild = { status: "created" | "skipped"; reason?: string; items: number };

/** Builds the day's review if it is due and not built yet. `force` skips the time check (never the one-per-date key). */
export async function runEndOfDayReview(db: Db, tenant: TenantRow, now: Date, opts: { force?: boolean } = {}): Promise<ReviewBuild> {
  const schedule = await loadSchedule(db, tenant);
  const local = localMoment(now, tenant.timezone);
  let late = false;
  if (!opts.force) {
    const ran = ((must(await db.from("gie_job_runs").select("local_date").eq("tenant_id", tenant.id).eq("job_kind", "end_of_day_review").eq("local_date", local.date)) ?? []) as Array<{ local_date: string }>).map((r) => ({ job: "end_of_day_review" as const, localDate: r.local_date }));
    const due = dueDailyJobs(now, schedule, ran).find((j) => j.job === "end_of_day_review");
    if (!due) return { status: "skipped", reason: "not due", items: 0 };
    late = due.late;
  }
  const claim = await db
    .from("gie_job_runs")
    .upsert({ tenant_id: tenant.id, job_kind: "end_of_day_review", local_date: local.date, status: "running", late }, { onConflict: "tenant_id,job_kind,local_date", ignoreDuplicates: true })
    .select("id");
  const claimed = (must(claim) ?? []) as Array<{ id: string }>;
  if (!claimed.length) return { status: "skipped", reason: "already built today", items: 0 };
  const runId = claimed[0]!.id;
  try {
    const result = await buildReview(db, tenant.id, local.date, late);
    must(await db.from("gie_job_runs").update({ status: "succeeded", finished_at: new Date().toISOString() }).eq("id", runId).eq("tenant_id", tenant.id));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.from("gie_job_runs").update({ status: "failed", finished_at: new Date().toISOString(), error: message.slice(0, 2000) }).eq("id", runId).eq("tenant_id", tenant.id);
    throw error;
  }
}

type ActionItemRow = { id: string; kind: ItemKind; status: ItemStatus; opportunity_id: string | null; follow_up_id: string | null; prospect_id: string | null; rank: number; recommended_action: string };

export async function buildReview(db: Db, tenantId: string, localDate: string, late: boolean): Promise<ReviewBuild> {
  const pkg = must(await db.from("gie_daily_action_packages").select("id").eq("tenant_id", tenantId).eq("local_date", localDate).maybeSingle()) as { id: string } | null;
  const items = pkg ? ((must(await db.from("gie_daily_action_items").select("id, kind, status, opportunity_id, follow_up_id, prospect_id, rank, recommended_action").eq("tenant_id", tenantId).eq("package_id", pkg.id).order("rank")) ?? []) as ActionItemRow[]) : [];

  // How many earlier packages the same opportunity or follow-up was left unfinished in.
  const oppIds = items.flatMap((i) => (i.opportunity_id ? [i.opportunity_id] : []));
  const fuIds = items.flatMap((i) => (i.follow_up_id ? [i.follow_up_id] : []));
  const earlier: Array<{ id: string; opportunity_id: string | null; follow_up_id: string | null; status: ItemStatus; package_id: string }> = [];
  if (oppIds.length) earlier.push(...((must(await db.from("gie_daily_action_items").select("id, opportunity_id, follow_up_id, status, package_id").eq("tenant_id", tenantId).in("opportunity_id", oppIds)) ?? []) as typeof earlier));
  if (fuIds.length) earlier.push(...((must(await db.from("gie_daily_action_items").select("id, opportunity_id, follow_up_id, status, package_id").eq("tenant_id", tenantId).in("follow_up_id", fuIds)) ?? []) as typeof earlier));
  const before = (i: ActionItemRow) => earlier.filter((e) => e.package_id !== pkg?.id && !isSettled(e.status) && (i.opportunity_id ? e.opportunity_id === i.opportunity_id : e.follow_up_id === i.follow_up_id)).length;

  const review = must(
    await db
      .from("gie_end_of_day_reviews")
      .upsert({ tenant_id: tenantId, local_date: localDate, package_id: pkg?.id ?? null, late }, { onConflict: "tenant_id,local_date", ignoreDuplicates: true })
      .select("id")
      .maybeSingle(),
  ) as { id: string } | null;
  if (!review) return { status: "skipped", reason: "review already exists", items: 0 };

  for (const i of items) {
    const facts = { kind: i.kind, status: i.status, timesUnfinishedBefore: before(i) };
    const rec = recommendDisposition(facts);
    must(
      await db.from("gie_end_of_day_review_items").insert({
        tenant_id: tenantId,
        review_id: review.id,
        item_id: i.id,
        recorded_status: i.status,
        times_unfinished: facts.timesUnfinishedBefore,
        stale: rec.stale,
        recommended_disposition: rec.disposition,
      }),
    );
  }
  return { status: "created", items: items.length };
}

// ---------------------------------------------------------------- finalizing

export type ChoiceProblem = { itemId: string; message: string };
export type FinalizeResult = { ok: true; tomorrow: number } | { ok: false; reason: string; problems?: ChoiceProblem[] };

type ReviewItemRow = {
  id: string;
  item_id: string;
  recorded_status: ItemStatus;
  corrected_status: ItemStatus | null;
  times_unfinished: number;
  disposition: Disposition | null;
  disposition_date: string | null;
  note: string | null;
  applied_at: string | null;
};

export const effectiveStatus = (r: Pick<ReviewItemRow, "recorded_status" | "corrected_status">): ItemStatus => r.corrected_status ?? r.recorded_status;

export async function finalizeReview(db: Db, tenant: TenantRow, localDate: string, userId: string, now: Date): Promise<FinalizeResult> {
  const review = must(await db.from("gie_end_of_day_reviews").select("id, status, finalizing_at").eq("tenant_id", tenant.id).eq("local_date", localDate).maybeSingle()) as { id: string; status: string; finalizing_at: string | null } | null;
  if (!review) return { ok: false, reason: "There is no review for that day." };
  if (review.status === "finalized") return { ok: false, reason: "This review is already finalized." };

  const rows = (must(await db.from("gie_end_of_day_review_items").select("id, item_id, recorded_status, corrected_status, times_unfinished, disposition, disposition_date, note, applied_at").eq("tenant_id", tenant.id).eq("review_id", review.id)) ?? []) as ReviewItemRow[];
  const actions = (must(await db.from("gie_daily_action_items").select("id, kind, status, opportunity_id, follow_up_id, prospect_id, rank, recommended_action").eq("tenant_id", tenant.id).in("id", rows.map((r) => r.item_id))) ?? []) as ActionItemRow[];
  const actionBy = new Map(actions.map((a) => [a.id, a]));
  const today = localMoment(now, tenant.timezone).date;

  // Check every choice first; nothing changes until all of them are acceptable.
  const problems: ChoiceProblem[] = [];
  const resolved = rows.map((r) => {
    const a = actionBy.get(r.item_id)!;
    const status = effectiveStatus(r);
    const facts = { kind: a.kind, status, timesUnfinishedBefore: r.times_unfinished };
    const disposition: Disposition | null = isSettled(status) ? "none" : r.disposition;
    const problem = checkChoice(facts, disposition, r.disposition_date, r.note, today);
    if (problem) problems.push({ itemId: r.item_id, message: problem });
    return { r, a, status, disposition: disposition ?? "none" };
  });
  if (problems.length) return { ok: false, reason: "Some items still need a decision.", problems };

  // Claim: only one caller applies the decisions.
  const claim = must(await db.from("gie_end_of_day_reviews").update({ finalizing_at: now.toISOString() }).eq("tenant_id", tenant.id).eq("id", review.id).eq("status", "draft").is("finalizing_at", null).select("id")) as Array<{ id: string }> | null;
  if (!claim?.length) return { ok: false, reason: "This review is already being finalized." };

  try {
    for (const { r, a, status, disposition } of resolved) {
      if (r.applied_at) continue;
      if (r.corrected_status && r.corrected_status !== r.recorded_status) {
        must(await db.from("gie_daily_action_items").update({ status: r.corrected_status }).eq("tenant_id", tenant.id).eq("id", a.id));
        must(await db.from("gie_daily_action_events").insert({ tenant_id: tenant.id, item_id: a.id, actor_user_id: userId, event_type: "review_corrected", from_status: r.recorded_status, to_status: r.corrected_status, detail: { source: "end_of_day", localDate } }));
      }
      if (disposition !== "none") await applyDisposition(db, tenant.id, a, disposition, r.disposition_date, r.note, userId, now);
      must(await db.from("gie_end_of_day_review_items").update({ disposition, applied_at: now.toISOString() }).eq("tenant_id", tenant.id).eq("id", r.id));
    }

    // A provisional plan for the next business day, from what is true now. The morning package rebuilds it.
    const schedule = await loadSchedule(db, tenant);
    let tomorrowDate = localDate;
    for (let n = 1; n <= 14; n++) {
      const d = new Date(Date.parse(`${localDate}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
      const dow = ((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
      if (dayStatus({ date: d, isoWeekday: dow, minutes: 0 }, schedule) === "business_day") {
        tomorrowDate = d;
        break;
      }
    }
    const { followUps, candidates } = await loadCandidates(db, tenant.id, tomorrowDate);
    const plan = rankCandidates(tomorrowDate, followUps, candidates).map((p) => ({ kind: p.kind, businessName: p.businessName, recommendedAction: p.recommendedAction, rankScore: p.rankScore }));
    must(await db.from("gie_end_of_day_reviews").update({ status: "finalized", finalized_by: userId, finalized_at: now.toISOString(), tomorrow_plan: plan, tomorrow_date: tomorrowDate }).eq("tenant_id", tenant.id).eq("id", review.id));
    await db.from("gie_audit_events").insert({ tenant_id: tenant.id, actor_user_id: userId, action: "review.finalize", entity_type: "end_of_day_review", entity_id: review.id, after: { localDate, items: rows.length } });
    return { ok: true, tomorrow: plan.length };
  } catch (error) {
    // Let the person try again; items already applied are skipped (applied_at).
    await db.from("gie_end_of_day_reviews").update({ finalizing_at: null }).eq("tenant_id", tenant.id).eq("id", review.id).eq("status", "draft");
    throw error;
  }
}

async function applyDisposition(db: Db, tenantId: string, a: ActionItemRow, d: Disposition, date: string | null, note: string | null, userId: string, now: Date): Promise<void> {
  const at = now.toISOString();
  if (a.kind === "opportunity" && a.opportunity_id) {
    const opp = a.opportunity_id;
    if (d === "reschedule" || d === "block") must(await db.from("gie_opportunities").update({ hold_until: date, hold_reason: d === "block" ? "blocked" : "rescheduled" }).eq("tenant_id", tenantId).eq("id", opp));
    else if (d === "lower_priority") {
      const cur = must(await db.from("gie_opportunities").select("priority_multiplier").eq("tenant_id", tenantId).eq("id", opp).single()) as { priority_multiplier: string | number };
      must(await db.from("gie_opportunities").update({ priority_multiplier: Math.max(0.1, Math.round(Number(cur.priority_multiplier) * 50) / 100) }).eq("tenant_id", tenantId).eq("id", opp));
    } else if (d === "archive") must(await db.from("gie_opportunities").update({ status: "archived", status_changed_at: at, status_changed_by: userId }).eq("tenant_id", tenantId).eq("id", opp));
    else if (d === "dismiss") must(await db.from("gie_opportunities").update({ status: "dismissed", dismiss_reason: (note ?? "").slice(0, 300), status_changed_at: at, status_changed_by: userId }).eq("tenant_id", tenantId).eq("id", opp));
  } else if (a.kind === "follow_up" && a.follow_up_id) {
    const fu = a.follow_up_id;
    if (d === "reschedule") must(await db.from("gie_follow_up_tasks").update({ due_date: date }).eq("tenant_id", tenantId).eq("id", fu));
    else if (d === "archive" || d === "dismiss") must(await db.from("gie_follow_up_tasks").update({ status: "cancelled" }).eq("tenant_id", tenantId).eq("id", fu));
  }
  must(await db.from("gie_daily_action_events").insert({ tenant_id: tenantId, item_id: a.id, actor_user_id: userId, event_type: "disposition_applied", detail: { disposition: d, date, note } }));
}

// ---------------------------------------------------------------- assessment

/** The recorded facts an assessment may use. Pure data, no free text from outside apart from names and the person's own notes. */
export async function assessmentFacts(db: Db, tenant: TenantRow, review: { id: string; local_date: string; package_id: string | null; tomorrow_plan: unknown[] | null }) {
  const rows = (must(await db.from("gie_end_of_day_review_items").select("item_id, recorded_status, corrected_status, times_unfinished, stale, disposition, disposition_date, note").eq("tenant_id", tenant.id).eq("review_id", review.id)) ?? []) as Array<ReviewItemRow & { stale: boolean }>;
  const actions = rows.length ? ((must(await db.from("gie_daily_action_items").select("id, rank, kind, recommended_action").eq("tenant_id", tenant.id).in("id", rows.map((r) => r.item_id))) ?? []) as Array<{ id: string; rank: number; kind: string; recommended_action: string }>) : [];
  const aBy = new Map(actions.map((a) => [a.id, a]));
  const from = startOfLocalDayUtc(review.local_date, tenant.timezone).toISOString();
  const to = new Date(startOfLocalDayUtc(review.local_date, tenant.timezone).getTime() + 86_400_000).toISOString();
  const countIn = async (table: string, col: string, extra: (q: any) => any = (q) => q) => {
    const r = await extra(db.from(table).select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).gte(col, from).lt(col, to));
    if (r.error) throw new Error(r.error.message);
    return r.count ?? 0;
  };
  const [sent, replies, followUpsDone] = await Promise.all([
    countIn("gie_outreach_drafts", "sent_at"),
    countIn("gie_outreach_replies", "received_at", (q) => q.eq("kind", "reply")),
    countIn("gie_follow_up_tasks", "completed_at"),
  ]);
  const status = (r: ReviewItemRow) => effectiveStatus(r);
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[status(r)] = (byStatus[status(r)] ?? 0) + 1;
  return {
    localDate: review.local_date,
    dataComplete: !!review.package_id,
    plannedItems: rows.length,
    itemsByFinalStatus: byStatus,
    itemsCorrectedByPerson: rows.filter((r) => r.corrected_status && r.corrected_status !== r.recorded_status).length,
    emailsSentToday: sent,
    repliesReceivedToday: replies,
    followUpsCompletedToday: followUpsDone,
    staleItems: rows.filter((r) => r.stale).length,
    plannedForNextBusinessDay: review.tomorrow_plan?.length ?? 0,
    items: rows
      .sort((a, b) => (aBy.get(a.item_id)?.rank ?? 9) - (aBy.get(b.item_id)?.rank ?? 9))
      .map((r) => ({ rank: aBy.get(r.item_id)?.rank ?? 0, kind: aBy.get(r.item_id)?.kind ?? "", action: aBy.get(r.item_id)?.recommended_action ?? "", recordedStatus: r.recorded_status, finalStatus: status(r), decision: r.disposition ?? "none", decisionDate: r.disposition_date, personNote: r.note })),
  };
}

const MAX_ASSESSMENT_ATTEMPTS = 3;

/** Writes the assessment for finalized reviews that have none. Stores nothing the record does not support. */
export async function runAssessments(db: Db, env: ServerEnv, tenant: TenantRow, now: Date, write: typeof writeAssessment = writeAssessment): Promise<string[]> {
  const log: string[] = [];
  if (!env.ANTHROPIC_API_KEY) return log;
  const reviews = (must(await db.from("gie_end_of_day_reviews").select("id, local_date, package_id, tomorrow_plan").eq("tenant_id", tenant.id).eq("status", "finalized").order("local_date", { ascending: false }).limit(5)) ?? []) as Array<{ id: string; local_date: string; package_id: string | null; tomorrow_plan: unknown[] | null }>;
  const done = new Set(((must(await db.from("gie_ai_daily_assessments").select("review_id").eq("tenant_id", tenant.id).in("review_id", reviews.map((r) => r.id))) ?? []) as Array<{ review_id: string }>).map((a) => a.review_id));
  for (const review of reviews.filter((r) => !done.has(r.id)).slice(0, 2)) {
    const tried = await db.from("gie_usage_events").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("operation", "assessment").like("idempotency_key", `assessment:${review.id}:%`);
    if (tried.error) throw new Error(tried.error.message);
    const attempts = tried.count ?? 0;
    if (attempts >= MAX_ASSESSMENT_ATTEMPTS) continue;
    const facts = await assessmentFacts(db, tenant, review);
    const budget = await maySpend(db, tenant.id, tenant.timezone, "ai", worstCaseCostUsd("claude-opus-5-5", JSON.stringify(facts).length + 1_500, 2_000), now);
    if (!budget.allowed) {
      log.push(`assessment held back: budget (${review.local_date})`);
      continue;
    }
    const result = await write(env.ANTHROPIC_API_KEY, facts);
    if (result.kind === "error") {
      log.push(`assessment failed: ${result.detail}`);
      continue;
    }
    const cost = estimateCostUsd(result.model, result.inputTokens, result.outputTokens);
    await recordUsage(db, { tenantId: tenant.id, category: "ai", provider: "anthropic", operation: "assessment", model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: cost, requestId: result.requestId, idempotencyKey: `assessment:${review.id}:${attempts + 1}` });
    const parsed = AssessmentOutput.safeParse(result.output);
    if (!parsed.success) {
      log.push("assessment rejected: unreadable output");
      continue;
    }
    const o = parsed.data;
    const text = [o.summary, ...o.went_well, ...o.needs_attention, o.suggestion].join("\n");
    const bad = ungroundedNumbers(text, facts);
    if (bad.length) {
      log.push(`assessment rejected: numbers not in the record (${bad.join(", ")})`);
      continue;
    }
    must(
      await db.from("gie_ai_daily_assessments").insert({
        tenant_id: tenant.id,
        review_id: review.id,
        summary: o.summary.slice(0, 2000),
        went_well: o.went_well.slice(0, 3),
        needs_attention: o.needs_attention.slice(0, 3),
        suggestion: o.suggestion.slice(0, 500) || null,
        model: result.model,
        prompt_version: ASSESSMENT_PROMPT_VERSION,
        inputs_hash: await hashFacts(facts),
        cost_usd: cost,
      }),
    );
    log.push(`assessment written (${review.local_date})`);
  }
  return log;
}

/** Cron entry: build due reviews, then write missing assessments. */
export async function runReviewTick(env: ServerEnv, now = new Date()): Promise<Array<{ tenant: string; step: string; detail: string }>> {
  const db = serviceClient(env, env.GIE_DB_SCHEMA);
  const tenants = (must(await db.from("gie_tenants").select("id, slug, timezone").eq("status", "active")) ?? []) as TenantRow[];
  const log: Array<{ tenant: string; step: string; detail: string }> = [];
  for (const tenant of tenants) {
    try {
      const r = await runEndOfDayReview(db, tenant, now);
      if (r.status === "created") log.push({ tenant: tenant.slug, step: "review", detail: `${r.items} items` });
      for (const d of await runAssessments(db, env, tenant, now)) log.push({ tenant: tenant.slug, step: "review", detail: d });
    } catch (error) {
      log.push({ tenant: tenant.slug, step: "review", detail: `failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return log;
}

