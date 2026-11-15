import { describe, expect, it } from "vitest";
import { MAX_ITEMS, rankCandidates, type FollowUpCandidate, type OpportunityCandidate } from "@/lib/actions/ranking";

const opp = (id: string, score: number, over: Partial<OpportunityCandidate> = {}): OpportunityCandidate => ({
  kind: "opportunity", opportunityId: id, businessName: `Biz ${id}`, status: "new", score, signalType: "buying_intent",
  urgency: "medium", hasEmail: true, alreadyInTodaysPackage: false, doNotContact: false, timesCarried: 0, ...over,
});
const fu = (id: string, dueDate: string, over: Partial<FollowUpCandidate> = {}): FollowUpCandidate => ({
  kind: "follow_up", followUpId: id, prospectId: `p-${id}`, businessName: `Prospect ${id}`, dueDate, doNotContact: false, ...over,
});
const TODAY = "2026-11-16";

describe("morning ranking", () => {
  it("never returns more than five items", () => {
    const many = Array.from({ length: 12 }, (_, i) => opp(String(i), 50 + i));
    expect(rankCandidates(TODAY, [], many)).toHaveLength(MAX_ITEMS);
  });
  it("returns fewer when fewer verified items exist, and nothing when none do", () => {
    expect(rankCandidates(TODAY, [], [opp("a", 80)])).toHaveLength(1);
    expect(rankCandidates(TODAY, [], [])).toEqual([]);
  });
  it("puts due follow-ups above every opportunity, most overdue first", () => {
    const r = rankCandidates(TODAY, [fu("1", "2026-11-16"), fu("2", "2026-11-12")], [opp("a", 99)]);
    expect(r.map((i) => i.followUpId ?? i.opportunityId)).toEqual(["2", "1", "a"]);
    expect(r[0]!.recommendedAction).toMatch(/4 days overdue/);
  });
  it("ignores follow-ups not yet due and anyone marked do-not-contact", () => {
    const r = rankCandidates(TODAY, [fu("1", "2026-11-20"), fu("2", "2026-11-10", { doNotContact: true })], [opp("a", 60, { doNotContact: true })]);
    expect(r).toEqual([]);
  });
  it("ranks by score x urgency / effort, and a reachable lead beats an unreachable one of equal score", () => {
    const r = rankCandidates(TODAY, [], [opp("slow", 70, { hasEmail: false }), opp("fast", 70), opp("urgent", 70, { urgency: "high" })]);
    expect(r.map((i) => i.opportunityId)).toEqual(["urgent", "fast", "slow"]);
  });
  it("leaves out opportunities already in today's package and stale ones carried three times", () => {
    const r = rankCandidates(TODAY, [], [opp("a", 90, { alreadyInTodaysPackage: true }), opp("b", 90, { timesCarried: 3 }), opp("c", 40)]);
    expect(r.map((i) => i.opportunityId)).toEqual(["c"]);
  });
  it("is deterministic: ties break by name", () => {
    const a = rankCandidates(TODAY, [], [opp("2", 60), opp("1", 60)]);
    expect(a.map((i) => i.opportunityId)).toEqual(["1", "2"]);
  });
  it("describes prospecting signals without implying a request", () => {
    const r = rankCandidates(TODAY, [], [opp("p", 60, { signalType: "prospecting" })]);
    expect(r[0]!.recommendedAction).toMatch(/may benefit/);
    expect(r[0]!.recommendedAction).not.toMatch(/asked/);
  });
});

describe("daily focus", () => {
  const mix = [opp("asked", 60, { signalType: "buying_intent", hasEmail: false }), opp("easy", 60, { signalType: "prospecting", hasEmail: true })];
  it("balanced is the original order", () => {
    expect(rankCandidates(TODAY, [], mix).map((r) => r.businessName)).toEqual(rankCandidates(TODAY, [], mix, "balanced").map((r) => r.businessName));
  });
  it("new_business puts businesses that asked for help first", () => {
    expect(rankCandidates(TODAY, [], mix, "new_business")[0]!.opportunityId).toBe("asked");
  });
  it("quick_wins puts the low-effort item first", () => {
    expect(rankCandidates(TODAY, [], mix, "quick_wins")[0]!.opportunityId).toBe("easy");
  });
  it("short_day plans three items and still lists due follow-ups first", () => {
    const many = Array.from({ length: 8 }, (_, i) => opp(`o${i}`, 90 - i));
    const r = rankCandidates(TODAY, [fu("1", "2026-11-10")], many, "short_day");
    expect(r).toHaveLength(3);
    expect(r[0]!.kind).toBe("follow_up");
  });
});
