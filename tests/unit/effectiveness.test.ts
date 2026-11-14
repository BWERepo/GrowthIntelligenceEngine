import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, scoreDay, type DayInputs } from "@/lib/scoring/effectiveness";

const base: DayInputs = { hasPackage: true, items: [], contacts: [], followUps: [], replies: [], outcomesTracked: false };
const item = (id: string, importance: number, status: string, kind: "opportunity" | "follow_up" = "opportunity", managed = status !== "not_started") => ({ id, kind, importance, status, managed });
const contact = (id: string, over: Partial<DayInputs["contacts"][number]> = {}) => ({ draftId: id, verified: true, validatorPassed: true, editedByPerson: true, notDuplicate: true, ...over });
const comp = (s: ReturnType<typeof scoreDay>, k: string) => s.components.find((c) => c.key === k)!;

describe("Daily Effectiveness Score v1", () => {
  it("is unavailable, not zero, when too little can be measured", () => {
    const s = scoreDay({ ...base, items: [item("a", 8, "not_started")] });
    expect(s).toMatchObject({ available: false, score: null, band: null, completeness: 20 });
    expect(s.reason).toMatch(/Insufficient verified activity data/);
  });
  it("is unavailable when no package was built", () => {
    expect(scoreDay({ ...base, hasPackage: false }).reason).toMatch(/No action package/);
  });
  it("leaves out unmeasured components and says how complete the score is", () => {
    const s = scoreDay({ ...base, items: [item("a", 8, "completed"), item("b", 2, "not_started")], contacts: [contact("d1")], followUps: [{ id: "f1", onTime: true }] });
    // Measured: action quality 25, follow-up 15, priority 10, opportunity mgmt 10 = 60.
    expect(s.completeness).toBe(60);
    expect(comp(s, "business_outcomes").measured).toBe(false);
    expect(comp(s, "action_quality").points).toBe(25);
    expect(comp(s, "follow_up_discipline").points).toBe(15);
    expect(comp(s, "priority_execution").points).toBe(8); // 8 of 10 importance
    expect(comp(s, "opportunity_management").points).toBe(5); // 1 of 2 managed
    expect(s.score).toBe(Math.round((53 / 60) * 100)); // 88
    expect(s.band).toBe("Highly Effective");
  });
  it("scores each email on four checks and gives partial credit", () => {
    const s = scoreDay({ ...base, items: [item("a", 5, "completed")], followUps: [{ id: "f", onTime: false }], contacts: [contact("d1"), contact("d2", { editedByPerson: false, notDuplicate: false })] });
    // d1 = 1.0, d2 = 0.6 -> average 0.8 -> 20 of 25.
    expect(comp(s, "action_quality").points).toBe(20);
    expect(comp(s, "action_quality").evidence.map((e) => e.points)).toEqual([12.5, 7.5]);
  });
  it("counts replies with follow-ups and ignores a day with neither due", () => {
    const s = scoreDay({ ...base, items: [item("a", 5, "completed")], contacts: [contact("d")], followUps: [{ id: "f", onTime: true }], replies: [{ id: "r", handledInTime: false }] });
    expect(comp(s, "follow_up_discipline").points).toBe(7.5);
    expect(comp(scoreDay({ ...base, items: [item("a", 5, "completed")] }), "follow_up_discipline").measured).toBe(false);
  });
  it("records which events earned which points, and the points add up", () => {
    const s = scoreDay({ ...base, items: [item("a", 6, "completed"), item("b", 4, "completed")], contacts: [contact("d")], followUps: [{ id: "f", onTime: true }] });
    for (const c of s.components.filter((x) => x.measured)) expect(c.evidence.reduce((n, e) => n + e.points, 0)).toBeCloseTo(c.points!, 1);
    expect(comp(s, "priority_execution").evidence.map((e) => e.sourceId)).toEqual(["a", "b"]);
  });
  it("is deterministic and bounded 0-100", () => {
    const input = { ...base, items: [item("a", 9, "completed")], contacts: [contact("d")], followUps: [{ id: "f", onTime: true }] };
    expect(scoreDay(input)).toEqual(scoreDay(structuredClone(input)));
    expect(scoreDay(input).score).toBeLessThanOrEqual(100);
    const worst = scoreDay({ ...base, items: [item("a", 9, "not_started", "opportunity", false)], contacts: [contact("d", { verified: false, validatorPassed: false, editedByPerson: false, notDuplicate: false })], followUps: [{ id: "f", onTime: false }] });
    expect(worst).toMatchObject({ available: true, score: 0, band: "Low" });
  });
  it("maps the band edges", () => {
    const at = (n: number) => DEFAULT_RULES.bands.find((b) => n >= b.min)!.label;
    expect([at(90), at(89), at(75), at(60), at(59), at(40), at(39)]).toEqual(["Exceptional", "Highly Effective", "Highly Effective", "Productive", "Needs Improvement", "Needs Improvement", "Low"]);
  });
});
