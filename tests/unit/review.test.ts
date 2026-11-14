import { describe, expect, it } from "vitest";
import { mutableDb } from "./mutable-db";
import { buildReview, finalizeReview, runAssessments, runEndOfDayReview } from "@/lib/pipeline/review.server";

const T = "t1";
const tenant = { id: T, slug: "bwe", timezone: "America/New_York" };
// 17:30 on Monday 2026-11-16 in New York.
const evening = new Date("2026-11-16T22:30:00Z");

function world() {
  return mutableDb({
    gie_daily_action_packages: [
      { id: "pk0", tenant_id: T, local_date: "2026-11-13" },
      { id: "pk1", tenant_id: T, local_date: "2026-11-16" },
    ],
    gie_daily_action_items: [
      // o1 was left unfinished on Friday and again today: second time.
      { id: "i0", tenant_id: T, package_id: "pk0", rank: 1, kind: "opportunity", opportunity_id: "o1", follow_up_id: null, prospect_id: null, status: "not_started", recommended_action: "old" },
      { id: "i1", tenant_id: T, package_id: "pk1", rank: 1, kind: "opportunity", opportunity_id: "o1", follow_up_id: null, prospect_id: null, status: "not_started", recommended_action: "Review Alpha" },
      { id: "i2", tenant_id: T, package_id: "pk1", rank: 2, kind: "opportunity", opportunity_id: "o2", follow_up_id: null, prospect_id: null, status: "completed", recommended_action: "Review Beta" },
      { id: "i3", tenant_id: T, package_id: "pk1", rank: 3, kind: "follow_up", opportunity_id: null, follow_up_id: "f1", prospect_id: "p1", status: "in_progress", recommended_action: "Follow up with Gamma" },
      { id: "i4", tenant_id: T, package_id: "pk1", rank: 4, kind: "opportunity", opportunity_id: "o4", follow_up_id: null, prospect_id: null, status: "not_started", recommended_action: "Review Delta" },
    ],
    gie_opportunities: [
      { id: "o1", tenant_id: T, business_name: "Alpha", status: "new", latest_score: 80, source_id: "s1", signal_type: "prospecting", website_url: null, hold_until: null, priority_multiplier: 1 },
      { id: "o2", tenant_id: T, business_name: "Beta", status: "new", latest_score: 70, source_id: "s1", signal_type: "prospecting", website_url: null, hold_until: null, priority_multiplier: 1 },
      { id: "o4", tenant_id: T, business_name: "Delta", status: "new", latest_score: 60, source_id: "s1", signal_type: "prospecting", website_url: null, hold_until: null, priority_multiplier: 0.8 },
    ],
    gie_follow_up_tasks: [{ id: "f1", tenant_id: T, prospect_id: "p1", due_date: "2026-11-16", status: "open" }],
    gie_prospects: [{ id: "p1", tenant_id: T, business_name: "Gamma", do_not_contact: false }],
    gie_sources: [{ id: "s1", tenant_id: T, contact: null }],
    gie_daily_action_events: [],
    gie_audit_events: [],
    gie_job_runs: [],
    gie_end_of_day_reviews: [],
    gie_end_of_day_review_items: [],
    gie_ai_daily_assessments: [],
    gie_usage_events: [],
    gie_outreach_drafts: [],
    gie_outreach_replies: [],
    gie_budgets: [{ tenant_id: T, category: "total", period: "month", limit_usd: "50", alert_at: ["0.5", "0.8"] }],
  }, { gie_end_of_day_reviews: { status: "draft", finalizing_at: null } });
}

const items = (db: any) => db.tables.gie_end_of_day_review_items as any[];
const choose = (db: any, itemId: string, patch: Record<string, unknown>) => Object.assign(items(db).find((r) => r.item_id === itemId), patch);

describe("building the review", () => {
  it("lists the day's items with their recorded status, prior unfinished count and a recommendation", async () => {
    const db = world();
    expect(await buildReview(db, T, "2026-11-16", false)).toEqual({ status: "created", items: 4 });
    const by = (id: string) => items(db).find((r) => r.item_id === id);
    expect(by("i1")).toMatchObject({ recorded_status: "not_started", times_unfinished: 1, recommended_disposition: "carry_forward", stale: false });
    expect(by("i2")).toMatchObject({ recommended_disposition: "none" });
    expect(by("i3")).toMatchObject({ recorded_status: "in_progress", recommended_disposition: "carry_forward" });
  });
  it("is built once per local date, at the evening time only, and not before", async () => {
    const db = world();
    const tz = { ...tenant };
    expect((await runEndOfDayReview(db, tz, new Date("2026-11-16T20:00:00Z"))).reason).toBe("not due"); // 15:00 local
    expect((await runEndOfDayReview(db, tz, evening)).status).toBe("created");
    expect((await runEndOfDayReview(db, tz, evening)).status).toBe("skipped"); // the day is claimed
    expect(db.tables.gie_end_of_day_reviews).toHaveLength(1);
    expect(items(db)).toHaveLength(4);
  });
  it("still records a review when no package was built, with nothing planned", async () => {
    const db = world();
    db.tables.gie_daily_action_packages.length = 0;
    expect(await buildReview(db, T, "2026-11-16", false)).toEqual({ status: "created", items: 0 });
    expect(db.tables.gie_end_of_day_reviews[0].package_id).toBeNull();
  });
});

describe("finalizing", () => {
  async function ready() {
    const db = world();
    await buildReview(db, T, "2026-11-16", false);
    return db;
  }
  it("refuses until every unfinished item has an acceptable decision, and changes nothing meanwhile", async () => {
    const db = await ready();
    choose(db, "i1", { disposition: "dismiss", note: "  " });
    choose(db, "i3", { disposition: "reschedule", disposition_date: null });
    choose(db, "i4", { disposition: "carry_forward" });
    const r = await finalizeReview(db, tenant, "2026-11-16", "u1", evening);
    expect(r).toMatchObject({ ok: false });
    expect((r as any).problems.map((p: any) => p.itemId).sort()).toEqual(["i1", "i3"]);
    expect(db.tables.gie_end_of_day_reviews[0].status).toBe("draft");
    expect(db.tables.gie_opportunities[0].status).toBe("new");
  });

  it("applies each decision once, corrects statuses, stores tomorrow's plan, and locks", async () => {
    const db = await ready();
    choose(db, "i1", { disposition: "dismiss", note: "Not a fit" });
    choose(db, "i3", { disposition: "reschedule", disposition_date: "2026-11-20", corrected_status: "completed" }); // person says it was done
    choose(db, "i4", { disposition: "lower_priority" });
    const r = await finalizeReview(db, tenant, "2026-11-16", "u1", evening);
    expect(r).toMatchObject({ ok: true });
    const opp = (id: string) => db.tables.gie_opportunities.find((o: any) => o.id === id);
    expect(opp("o1")).toMatchObject({ status: "dismissed", dismiss_reason: "Not a fit" });
    expect(opp("o4").priority_multiplier).toBe(0.4);
    // The corrected status is recorded, with an event, and a completed item needs no decision.
    expect(db.tables.gie_daily_action_items.find((i: any) => i.id === "i3").status).toBe("completed");
    expect(items(db).find((x) => x.item_id === "i3").disposition).toBe("none");
    expect(db.tables.gie_daily_action_events.map((e: any) => e.event_type).sort()).toEqual(["disposition_applied", "disposition_applied", "review_corrected"]);
    const rev = db.tables.gie_end_of_day_reviews[0];
    expect(rev).toMatchObject({ status: "finalized", finalized_by: "u1", tomorrow_date: "2026-11-17" });
    expect(Array.isArray(rev.tomorrow_plan)).toBe(true);
    expect(items(db).every((x) => x.applied_at)).toBe(true);

    // A second finalize does nothing more.
    expect(await finalizeReview(db, tenant, "2026-11-16", "u1", evening)).toEqual({ ok: false, reason: "This review is already finalized." });
    expect(opp("o4").priority_multiplier).toBe(0.4);
  });

  it("holds an opportunity until the chosen date and moves a follow-up's due date", async () => {
    const db = await ready();
    choose(db, "i1", { disposition: "block", disposition_date: "2026-12-01" });
    choose(db, "i3", { disposition: "reschedule", disposition_date: "2026-11-20" });
    choose(db, "i4", { disposition: "archive" });
    await finalizeReview(db, tenant, "2026-11-16", "u1", evening);
    expect(db.tables.gie_opportunities.find((o: any) => o.id === "o1")).toMatchObject({ hold_until: "2026-12-01", hold_reason: "blocked" });
    expect(db.tables.gie_follow_up_tasks[0].due_date).toBe("2026-11-20");
    expect(db.tables.gie_opportunities.find((o: any) => o.id === "o4").status).toBe("archived");
    const plan = db.tables.gie_end_of_day_reviews[0].tomorrow_plan as any[];
    // Alpha is held and Delta archived; only Beta (still open) remains.
    expect(plan.map((p) => p.businessName)).toEqual(["Beta"]);
  });

  it("skips Friday-to-Saturday: the next plan is for Monday", async () => {
    const db = await ready();
    db.tables.gie_daily_action_packages[1].local_date = "2026-11-20";
    db.tables.gie_end_of_day_reviews.length = 0;
    items(db).length = 0;
    await buildReview(db, T, "2026-11-20", false);
    for (const r of items(db)) Object.assign(r, { disposition: r.recommended_disposition === "none" ? "none" : "carry_forward" });
    await finalizeReview(db, tenant, "2026-11-20", "u1", new Date("2026-11-20T22:30:00Z"));
    expect(db.tables.gie_end_of_day_reviews[0].tomorrow_date).toBe("2026-11-23");
  });
});

describe("the assessment", () => {
  const env: any = { ANTHROPIC_API_KEY: "sk-test-key-0000000000000000" };
  const finalized = async () => {
    const db = world();
    await buildReview(db, T, "2026-11-16", false);
    Object.assign(db.tables.gie_end_of_day_reviews[0], { status: "finalized", tomorrow_plan: [] });
    return db;
  };
  const output = (text: string) => async () => ({ kind: "assessment" as const, output: { summary: text, went_well: [], needs_attention: [], suggestion: "" }, model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 200, requestId: "r1" });

  it("stores a note whose numbers are all in the record, and records the spend once", async () => {
    const db = await finalized();
    db.tables.gie_usage_events.length = 0;
    const log = await runAssessments(db, env, tenant, evening, output("4 items were planned and 1 was completed.") as any);
    expect(log[0]).toMatch(/written/);
    expect(db.tables.gie_ai_daily_assessments).toHaveLength(1);
    expect(db.tables.gie_ai_daily_assessments[0]).toMatchObject({ prompt_version: "assessment-v1", model: "claude-opus-5-5" });
    expect(db.tables.gie_ai_daily_assessments[0].inputs_hash).toMatch(/^[0-9a-f]{64}$/);
    // Already written: no second call.
    expect(await runAssessments(db, env, tenant, evening, (() => { throw new Error("should not be called"); }) as any)).toEqual([]);
  });

  it("rejects a note with numbers that are not in the record, and gives up after three tries", async () => {
    const db = await finalized();
    for (let n = 0; n < 5; n++) await runAssessments(db, env, tenant, evening, output("Revenue grew 40% this week.") as any);
    expect(db.tables.gie_ai_daily_assessments).toHaveLength(0);
    expect(db.tables.gie_usage_events).toHaveLength(3);
  });

  it("does nothing without an API key", async () => {
    const db = await finalized();
    expect(await runAssessments(db, {} as any, tenant, evening, output("x") as any)).toEqual([]);
  });
});
