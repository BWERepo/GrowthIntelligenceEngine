import { describe, expect, it } from "vitest";
import { judgeOutcome, recommend, type CampaignStats } from "@/lib/improve/rules";
import type { ScenarioFlag } from "@/lib/growth/metrics";

const c = (id: string, over: Partial<CampaignStats> = {}): CampaignStats => ({ id, name: id, ageDays: 60, opportunities: 5, contacted: 0, replied: 0, ...over });

describe("recommend", () => {
  it("says nothing when there is nothing to say", () => {
    expect(recommend([c("a", { contacted: 5 })], [])).toEqual([]);
    expect(recommend([], [])).toEqual([]);
  });
  it("flags many emails and no replies, with the facts", () => {
    const [r] = recommend([c("a", { contacted: 25 })], []);
    expect(r).toMatchObject({ ruleKey: "campaign_no_replies", subjectKey: "a", campaignId: "a", metric: "replied" });
    expect(r!.evidence.map((e) => e.value)).toContain("25");
  });
  it("does not judge a new campaign or a small sample", () => {
    expect(recommend([c("a", { contacted: 25, ageDays: 10, opportunities: 0 })], [])).toEqual([]);
    expect(recommend([c("a", { contacted: 19 })], [])).toEqual([]);
  });
  it("flags a campaign that finds nothing", () => {
    expect(recommend([c("a", { opportunities: 0 })], [])[0]).toMatchObject({ ruleKey: "campaign_finds_nothing", metric: "opportunity" });
  });
  it("flags a campaign replying at twice the rate of the rest, never from tiny numbers", () => {
    const good = c("good", { contacted: 20, replied: 6 });
    const rest = c("rest", { contacted: 40, replied: 4 });
    expect(recommend([good, rest], []).map((r) => r.ruleKey)).toEqual(["campaign_outperforms"]);
    expect(recommend([c("good", { contacted: 20, replied: 2 }), rest], [])).toEqual([]);
    expect(recommend([good, c("rest", { contacted: 5, replied: 0 })], [])).toEqual([]);
    expect(recommend([good], [])).toEqual([]);
  });
  it("turns only raised scenario flags into suggestions, carrying the flag's own words", () => {
    const flags: ScenarioFlag[] = [
      { key: "A", title: "More outreach, no more results", status: "raised", detail: "Contacts rose 40%." },
      { key: "B", title: "x", status: "clear", detail: "" },
      { key: "C", title: "x", status: "not_evaluated", detail: "" },
    ];
    const r = recommend([], flags);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ ruleKey: "growth_flag", subjectKey: "A", campaignId: null, metric: "lead" });
    expect(r[0]!.evidence[0]!.value).toBe("Contacts rose 40%.");
  });
  it("always carries evidence", () => {
    const all = recommend([c("a", { contacted: 25, opportunities: 0 }), c("b", { contacted: 20, replied: 8 })], [{ key: "D", title: "t", status: "raised", detail: "d" }]);
    expect(all.length).toBeGreaterThan(1);
    for (const r of all) expect(r.evidence.length).toBeGreaterThan(0);
  });
});

describe("judgeOutcome", () => {
  it("calls a clear rise improved and a clear fall worse", () => {
    expect(judgeOutcome(10, 20).verdict).toBe("improved");
    expect(judgeOutcome(20, 10).verdict).toBe("worse");
    expect(judgeOutcome(100, 102).verdict).toBe("no_change");
  });
  it("will not call a result from small numbers or a zero baseline", () => {
    expect(judgeOutcome(2, 8).verdict).toBe("insufficient_evidence");
    expect(judgeOutcome(0, 30).verdict).toBe("insufficient_evidence");
  });
  it("never claims the change caused it", () => {
    expect(judgeOutcome(10, 20).note).toMatch(/not proof/);
  });
});
