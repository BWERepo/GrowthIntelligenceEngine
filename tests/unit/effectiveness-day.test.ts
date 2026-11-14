import { describe, expect, it } from "vitest";
import { mutableDb } from "./mutable-db";
import { loadDayInputs, provisionalScore, runScores, storeScore } from "@/lib/pipeline/effectiveness.server";

const T = "t1";
const tenant = { id: T, slug: "bwe", timezone: "America/New_York" };
const D = "2026-11-17"; // Tuesday; the previous business day is Monday 2026-11-16

function world() {
  return mutableDb(
    {
      gie_daily_action_packages: [{ id: "pk1", tenant_id: T, local_date: D }],
      gie_daily_action_items: [
        { id: "i1", tenant_id: T, package_id: "pk1", kind: "opportunity", importance: 8, status: "completed", follow_up_id: null },
        { id: "i2", tenant_id: T, package_id: "pk1", kind: "opportunity", importance: 2, status: "not_started", follow_up_id: null },
        { id: "i3", tenant_id: T, package_id: "pk1", kind: "follow_up", importance: 9, status: "awaiting_response", follow_up_id: "f_wait" },
      ],
      gie_end_of_day_reviews: [{ id: "rv1", tenant_id: T, local_date: D, status: "finalized" }],
      gie_end_of_day_review_items: [{ tenant_id: T, review_id: "rv1", item_id: "i2", disposition: "carry_forward" }],
      gie_outreach_drafts: [
        { id: "dA", tenant_id: T, prospect_id: "p1", edited_by_person: true, validation: { ok: true }, sent_at: "2026-11-17T15:00:00Z" },
        { id: "dB", tenant_id: T, prospect_id: "p2", edited_by_person: false, validation: { ok: false }, sent_at: "2026-11-17T16:00:00Z" },
        { id: "eB", tenant_id: T, prospect_id: "p2", edited_by_person: false, validation: { ok: true }, sent_at: "2026-11-10T16:00:00Z" },
      ],
      gie_prospects: [
        { id: "p1", tenant_id: T, opportunity_id: "o1" },
        { id: "p2", tenant_id: T, opportunity_id: "o2" },
      ],
      gie_follow_up_tasks: [
        { id: "f1", tenant_id: T, due_date: D, status: "done", completed_at: "2026-11-17T14:00:00Z" },
        { id: "f2", tenant_id: T, due_date: D, status: "open", completed_at: null },
        { id: "f_wait", tenant_id: T, due_date: D, status: "open", completed_at: null },
        { id: "f3", tenant_id: T, due_date: D, status: "cancelled", completed_at: null },
        { id: "f_late", tenant_id: T, due_date: D, status: "done", completed_at: "2026-11-18T14:00:00Z" },
      ],
      gie_outreach_replies: [
        { id: "r1", tenant_id: T, kind: "reply", received_at: "2026-11-16T15:00:00Z", handled_at: "2026-11-17T15:00:00Z" },
        { id: "r2", tenant_id: T, kind: "reply", received_at: "2026-11-16T16:00:00Z", handled_at: "2026-11-18T15:00:00Z" },
        { id: "r3", tenant_id: T, kind: "auto_reply", received_at: "2026-11-16T17:00:00Z", handled_at: null },
        { id: "r4", tenant_id: T, kind: "reply", received_at: "2026-11-13T17:00:00Z", handled_at: null },
      ],
      gie_effectiveness_scoring_rules: [],
      gie_daily_effectiveness_scores: [],
      gie_effectiveness_score_components: [],
      gie_effectiveness_score_events: [],
    },
    {},
  );
}

describe("gathering a day's facts", () => {
  it("takes only that day's records, with the right checks on each", async () => {
    const i = await loadDayInputs(world(), tenant, D);
    expect(i.hasPackage).toBe(true);
    expect(i.items.map((x) => [x.id, x.managed])).toEqual([["i1", true], ["i2", false], ["i3", true]]);
    expect(i.contacts).toEqual([
      { draftId: "dA", verified: true, validatorPassed: true, editedByPerson: true, notDuplicate: true },
      { draftId: "dB", verified: true, validatorPassed: false, editedByPerson: false, notDuplicate: false },
    ]);
    // f_wait is waiting on someone else and f3 was cancelled; f_late was done a day late.
    expect(i.followUps).toEqual([{ id: "f1", onTime: true }, { id: "f2", onTime: false }, { id: "f_late", onTime: false }]);
    // Only replies received on the previous business day; the automatic reply is not a reply.
    expect(i.replies).toEqual([{ id: "r1", handledInTime: true }, { id: "r2", handledInTime: false }]);
  });

  it("looks back past a weekend for the previous business day", async () => {
    const db = world();
    db.tables.gie_outreach_replies.push({ id: "r5", tenant_id: T, kind: "reply", received_at: "2026-11-20T15:00:00Z", handled_at: "2026-11-23T15:00:00Z" });
    const i = await loadDayInputs(db, tenant, "2026-11-23"); // Monday: previous business day is Friday the 20th
    expect(i.replies).toEqual([{ id: "r5", handledInTime: true }]);
    expect(i.hasPackage).toBe(false);
  });
});

describe("storing the score", () => {
  it("stores the finalized day once, with rules, components and the events behind the points", async () => {
    const db = world();
    expect(await storeScore(db, tenant, { id: "rv1", local_date: D })).toBe(true);
    const s = db.tables.gie_daily_effectiveness_scores[0];
    expect(s).toMatchObject({ local_date: D, rule_version: "des-v1", available: true, review_id: "rv1" });
    expect(s.rules.weights.action_quality).toBe(25);
    expect(db.tables.gie_effectiveness_score_components).toHaveLength(5);
    const outcomes = db.tables.gie_effectiveness_score_components.find((c: any) => c.component === "business_outcomes");
    expect(outcomes).toMatchObject({ measured: false, points: null });
    const evidence = db.tables.gie_effectiveness_score_events as any[];
    expect(evidence.some((e) => e.source_table === "gie_outreach_drafts" && e.source_id === "dA")).toBe(true);
    expect(evidence.some((e) => e.source_table === "gie_outreach_replies" && e.source_id === "r1")).toBe(true);
    expect(evidence.some((e) => e.source_id === "r2")).toBe(false);

    // Never rewritten: a second run (even after records change) does nothing.
    db.tables.gie_follow_up_tasks[1].status = "done";
    expect(await storeScore(db, tenant, { id: "rv1", local_date: D })).toBe(false);
    expect(db.tables.gie_daily_effectiveness_scores).toHaveLength(1);
    expect(db.tables.gie_effectiveness_score_components).toHaveLength(5);
  });

  it("stores 'unavailable' with its reason, never a zero", async () => {
    const db = world();
    db.tables.gie_outreach_drafts.length = 0;
    db.tables.gie_follow_up_tasks.length = 0;
    db.tables.gie_outreach_replies.length = 0;
    await storeScore(db, tenant, { id: "rv1", local_date: D });
    expect(db.tables.gie_daily_effectiveness_scores[0]).toMatchObject({ available: false, score: null, band: null, completeness: 20 });
    expect(db.tables.gie_daily_effectiveness_scores[0].unavailable_reason).toMatch(/Insufficient verified activity data/);
  });

  it("scores only finalized reviews that have no score yet", async () => {
    const db = world();
    db.tables.gie_end_of_day_reviews.push({ id: "rv2", tenant_id: T, local_date: "2026-11-16", status: "draft" });
    expect(await runScores(db, tenant)).toEqual([`score stored (${D})`]);
    expect(await runScores(db, tenant)).toEqual([]);
  });

  it("gives a provisional score without storing anything, and saves the v1 rules the first time", async () => {
    const db = world();
    const { score, ruleVersion } = await provisionalScore(db, tenant, D);
    expect(ruleVersion).toBe("des-v1");
    expect(score.available).toBe(true);
    expect(db.tables.gie_daily_effectiveness_scores).toHaveLength(0);
    expect(db.tables.gie_effectiveness_scoring_rules).toHaveLength(1);
  });
});
