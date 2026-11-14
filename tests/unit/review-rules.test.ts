import { describe, expect, it } from "vitest";
import { allowedDispositions, checkChoice, hashFacts, isStale, recommendDisposition, ungroundedNumbers } from "@/lib/review/rules";
import { rankCandidates } from "@/lib/actions/ranking";

const opp = (status: any, before = 0) => ({ kind: "opportunity" as const, status, timesUnfinishedBefore: before });

describe("what to recommend for an item", () => {
  it("has nothing to decide for finished, handed-off or cancelled items", () => {
    for (const s of ["completed", "awaiting_response", "cancelled"]) expect(recommendDisposition(opp(s)).disposition).toBe("none");
  });
  it("carries forward unfinished work, reschedules deferred, blocks blocked", () => {
    expect(recommendDisposition(opp("not_started")).disposition).toBe("carry_forward");
    expect(recommendDisposition(opp("in_progress", 1)).disposition).toBe("carry_forward");
    expect(recommendDisposition(opp("deferred")).disposition).toBe("reschedule");
    expect(recommendDisposition(opp("blocked"))).toMatchObject({ disposition: "block", suggestDays: 14 });
    expect(recommendDisposition({ kind: "follow_up", status: "blocked", timesUnfinishedBefore: 0 }).disposition).toBe("reschedule");
  });
  it("flags the third unfinished appearance as stale instead of recycling it", () => {
    expect(isStale(opp("not_started", 1))).toBe(false);
    expect(recommendDisposition(opp("not_started", 2))).toMatchObject({ disposition: "archive", stale: true });
    // Finishing it today means it is not stale, however many times it was left before.
    expect(isStale(opp("completed", 5))).toBe(false);
  });
  it("offers follow-ups only the choices that make sense", () => {
    expect(allowedDispositions({ kind: "follow_up", status: "not_started", timesUnfinishedBefore: 0 })).toEqual(["carry_forward", "reschedule", "dismiss", "archive"]);
    expect(allowedDispositions(opp("completed"))).toEqual(["none"]);
  });
});

describe("checking a person's choice", () => {
  const f = opp("not_started");
  it("needs a choice, a valid one, a future date where one is needed, and a reason to dismiss", () => {
    expect(checkChoice(f, null, null, null, "2026-11-16")).toMatch(/Choose/);
    expect(checkChoice(f, "none", null, null, "2026-11-16")).toMatch(/not available/);
    expect(checkChoice(f, "reschedule", null, null, "2026-11-16")).toMatch(/date/);
    expect(checkChoice(f, "reschedule", "2026-11-16", null, "2026-11-16")).toMatch(/after today/);
    expect(checkChoice(f, "block", "2026-11-30", null, "2026-11-16")).toBeNull();
    expect(checkChoice(f, "dismiss", null, "  ", "2026-11-16")).toMatch(/reason/);
    expect(checkChoice(f, "dismiss", null, "Not a fit", "2026-11-16")).toBeNull();
    expect(checkChoice(f, "carry_forward", null, null, "2026-11-16")).toBeNull();
  });
});

describe("assessment grounding", () => {
  const facts = { plannedItems: 5, itemsByFinalStatus: { completed: 3, not_started: 2 }, emailsSentToday: 1, items: [{ action: "Follow up with Pat's Shop (2 days overdue)." }] };
  it("accepts numbers that are in the record and rejects the rest", () => {
    expect(ungroundedNumbers("Of 5 planned items, 3 were completed and 1 email went out. Pat's Shop was 2 days overdue.", facts)).toEqual([]);
    expect(ungroundedNumbers("Revenue grew 40% and 7 meetings were held.", facts)).toEqual(["40", "7"]);
  });
  it("hashes the same facts the same way", async () => {
    expect(await hashFacts(facts)).toBe(await hashFacts({ ...facts }));
    expect(await hashFacts(facts)).not.toBe(await hashFacts({ ...facts, plannedItems: 4 }));
  });
});

describe("holds and lowered priority in the ranking", () => {
  const base = { kind: "opportunity" as const, businessName: "A", status: "new" as const, score: 80, signalType: "buying_intent" as const, urgency: "medium" as const, hasEmail: true, alreadyInTodaysPackage: false, doNotContact: false, timesCarried: 0 };
  it("skips an opportunity held beyond the day, and ranks it again once the hold passes", () => {
    expect(rankCandidates("2026-11-17", [], [{ ...base, opportunityId: "o1", holdUntil: "2026-11-20" }])).toHaveLength(0);
    expect(rankCandidates("2026-11-20", [], [{ ...base, opportunityId: "o1", holdUntil: "2026-11-20" }])).toHaveLength(1);
  });
  it("lowers rank by the multiplier", () => {
    const [a, b] = [rankCandidates("2026-11-17", [], [{ ...base, opportunityId: "o1" }])[0]!, rankCandidates("2026-11-17", [], [{ ...base, opportunityId: "o1", priorityMultiplier: 0.5 }])[0]!];
    expect(b.rankScore).toBeCloseTo(a.rankScore / 2, 2);
  });
});
