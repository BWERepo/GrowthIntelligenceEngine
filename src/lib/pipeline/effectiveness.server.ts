// Gathers a day's recorded facts and scores them (src/lib/scoring/effectiveness.ts).
// A finalized day's score is stored once, with its rules, components and the
// events that earned the points. Unfinished days are scored on request, not stored.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { dayStatus, startOfLocalDayUtc } from "@/lib/schedule";
import { DEFAULT_RULES, RULE_VERSION, scoreDay, type DayInputs, type DayScore, type Rules } from "@/lib/scoring/effectiveness";
import { loadSchedule } from "./package.server";
import type { TenantRow } from "./discover.server";

type Db = SupabaseClient<any, any, any>;
const must = <T>(r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data;
};

const RulesSchema = z.object({
  version: z.string(),
  weights: z.object({ business_outcomes: z.number(), action_quality: z.number(), follow_up_discipline: z.number(), priority_execution: z.number(), opportunity_management: z.number() }),
  minCompleteness: z.number().min(0).max(1),
  contactChecks: z.object({ verified: z.number(), validatorPassed: z.number(), editedByPerson: z.number(), notDuplicate: z.number() }),
  bands: z.array(z.object({ min: z.number(), label: z.string() })).min(1),
});

/** The active rule set for the workspace; the built-in v1 is stored the first time it is needed. */
export async function activeRules(db: Db, tenantId: string): Promise<Rules> {
  const row = must(await db.from("gie_effectiveness_scoring_rules").select("rules").eq("tenant_id", tenantId).eq("active", true).order("created_at", { ascending: false }).limit(1).maybeSingle()) as { rules: unknown } | null;
  if (row) {
    const parsed = RulesSchema.safeParse(row.rules);
    if (parsed.success) return parsed.data;
    throw new Error("The stored scoring rules are not valid.");
  }
  await db.from("gie_effectiveness_scoring_rules").upsert({ tenant_id: tenantId, version: RULE_VERSION, rules: DEFAULT_RULES }, { onConflict: "tenant_id,version", ignoreDuplicates: true });
  return DEFAULT_RULES;
}

const DAY = 86_400_000;
const shiftDate = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (d: string) => ((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

export async function loadDayInputs(db: Db, tenant: TenantRow, localDate: string): Promise<DayInputs> {
  const from = startOfLocalDayUtc(localDate, tenant.timezone);
  const to = startOfLocalDayUtc(shiftDate(localDate, 1), tenant.timezone);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const pkg = must(await db.from("gie_daily_action_packages").select("id").eq("tenant_id", tenant.id).eq("local_date", localDate).maybeSingle()) as { id: string } | null;
  const itemRows = pkg ? ((must(await db.from("gie_daily_action_items").select("id, kind, importance, status, follow_up_id").eq("tenant_id", tenant.id).eq("package_id", pkg.id)) ?? []) as Array<{ id: string; kind: "follow_up" | "opportunity"; importance: number; status: string; follow_up_id: string | null }>) : [];

  // Decisions recorded at the end-of-day review (if it exists yet).
  const review = must(await db.from("gie_end_of_day_reviews").select("id").eq("tenant_id", tenant.id).eq("local_date", localDate).maybeSingle()) as { id: string } | null;
  const decisions = review ? ((must(await db.from("gie_end_of_day_review_items").select("item_id, disposition").eq("tenant_id", tenant.id).eq("review_id", review.id)) ?? []) as Array<{ item_id: string; disposition: string | null }>) : [];
  const decided = new Map(decisions.map((d) => [d.item_id, d.disposition]));
  const items = itemRows.map((i) => {
    const d = decided.get(i.id);
    return { id: i.id, kind: i.kind, importance: i.importance, status: i.status, managed: i.status !== "not_started" || (!!d && d !== "none" && d !== "carry_forward") };
  });

  // Emails sent that day, each checked for a verified prospect, a draft that passed, edits, and no repeat contact.
  const sent = (must(await db.from("gie_outreach_drafts").select("id, prospect_id, edited_by_person, validation, sent_at").eq("tenant_id", tenant.id).gte("sent_at", fromIso).lt("sent_at", toIso)) ?? []) as Array<{ id: string; prospect_id: string; edited_by_person: boolean; validation: { ok?: boolean } | null; sent_at: string }>;
  const prospectIds = [...new Set(sent.map((s) => s.prospect_id))];
  const prospects = prospectIds.length ? ((must(await db.from("gie_prospects").select("id, opportunity_id").eq("tenant_id", tenant.id).in("id", prospectIds)) ?? []) as Array<{ id: string; opportunity_id: string | null }>) : [];
  const verified = new Map(prospects.map((p) => [p.id, !!p.opportunity_id]));
  const earlier = prospectIds.length ? ((must(await db.from("gie_outreach_drafts").select("id, prospect_id, sent_at").eq("tenant_id", tenant.id).in("prospect_id", prospectIds).gte("sent_at", new Date(from.getTime() - 30 * DAY).toISOString()).lt("sent_at", toIso)) ?? []) as Array<{ id: string; prospect_id: string; sent_at: string }>) : [];
  const contacts = sent.map((s) => ({
    draftId: s.id,
    verified: verified.get(s.prospect_id) ?? false,
    validatorPassed: s.validation?.ok === true,
    editedByPerson: s.edited_by_person,
    notDuplicate: !earlier.some((e) => e.prospect_id === s.prospect_id && e.id !== s.id && e.sent_at < s.sent_at),
  }));

  // Follow-ups due that day, except ones the person is waiting on someone else for.
  const waiting = new Set(itemRows.filter((i) => i.kind === "follow_up" && i.status === "awaiting_response" && i.follow_up_id).map((i) => i.follow_up_id!));
  const due = (must(await db.from("gie_follow_up_tasks").select("id, status, completed_at").eq("tenant_id", tenant.id).eq("due_date", localDate).in("status", ["open", "done"])) ?? []) as Array<{ id: string; status: string; completed_at: string | null }>;
  const followUps = due.filter((f) => !waiting.has(f.id)).map((f) => ({ id: f.id, onTime: f.status === "done" && !!f.completed_at && f.completed_at < toIso }));

  // Replies whose one-business-day deadline fell on this day: those received on the previous business day.
  const schedule = await loadSchedule(db, tenant);
  let previous: string | null = null;
  for (let n = 1; n <= 14 && !previous; n++) {
    const d = shiftDate(localDate, -n);
    if (dayStatus({ date: d, isoWeekday: weekday(d), minutes: 0 }, schedule) === "business_day") previous = d;
  }
  let replies: DayInputs["replies"] = [];
  if (previous) {
    const rFrom = startOfLocalDayUtc(previous, tenant.timezone).toISOString();
    const rTo = startOfLocalDayUtc(shiftDate(previous, 1), tenant.timezone).toISOString();
    const rows = (must(await db.from("gie_outreach_replies").select("id, handled_at").eq("tenant_id", tenant.id).eq("kind", "reply").gte("received_at", rFrom).lt("received_at", rTo)) ?? []) as Array<{ id: string; handled_at: string | null }>;
    replies = rows.map((r) => ({ id: r.id, handledInTime: !!r.handled_at && r.handled_at < toIso }));
  }

  return { hasPackage: !!pkg, items, contacts, followUps, replies, outcomesTracked: false };
}

/** A score for a day that is not finished (or not stored yet). Not stored. */
export async function provisionalScore(db: Db, tenant: TenantRow, localDate: string): Promise<{ score: DayScore; ruleVersion: string }> {
  const rules = await activeRules(db, tenant.id);
  return { score: scoreDay(await loadDayInputs(db, tenant, localDate), rules), ruleVersion: rules.version };
}

/** Stores the finalized day's score once. Returns false if it was already stored. */
export async function storeScore(db: Db, tenant: TenantRow, review: { id: string; local_date: string }): Promise<boolean> {
  const rules = await activeRules(db, tenant.id);
  const score = scoreDay(await loadDayInputs(db, tenant, review.local_date), rules);
  const row = must(
    await db
      .from("gie_daily_effectiveness_scores")
      .upsert(
        { tenant_id: tenant.id, local_date: review.local_date, review_id: review.id, rule_version: rules.version, rules, available: score.available, score: score.score, band: score.band, completeness: score.completeness, unavailable_reason: score.reason },
        { onConflict: "tenant_id,local_date", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle(),
  ) as { id: string } | null;
  if (!row) return false;
  must(await db.from("gie_effectiveness_score_components").insert(score.components.map((c) => ({ tenant_id: tenant.id, score_id: row.id, component: c.key, weight: c.weight, measured: c.measured, points: c.points, explanation: c.explanation }))));
  const evidence = score.components.flatMap((c) => c.evidence.map((e) => ({ tenant_id: tenant.id, score_id: row.id, component: c.key, event_type: e.eventType, source_table: e.sourceTable, source_id: e.sourceId, points: e.points })));
  if (evidence.length) must(await db.from("gie_effectiveness_score_events").insert(evidence));
  return true;
}

/** Stores scores for finalized reviews that have none. */
export async function runScores(db: Db, tenant: TenantRow): Promise<string[]> {
  const reviews = (must(await db.from("gie_end_of_day_reviews").select("id, local_date").eq("tenant_id", tenant.id).eq("status", "finalized").order("local_date", { ascending: false }).limit(10)) ?? []) as Array<{ id: string; local_date: string }>;
  if (!reviews.length) return [];
  const have = new Set(((must(await db.from("gie_daily_effectiveness_scores").select("local_date").eq("tenant_id", tenant.id).in("local_date", reviews.map((r) => r.local_date))) ?? []) as Array<{ local_date: string }>).map((s) => s.local_date));
  const log: string[] = [];
  for (const r of reviews.filter((x) => !have.has(x.local_date))) {
    if (await storeScore(db, tenant, r)) log.push(`score stored (${r.local_date})`);
  }
  return log;
}
