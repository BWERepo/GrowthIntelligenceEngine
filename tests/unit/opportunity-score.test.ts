import { describe, expect, it } from "vitest";
import { bandFor, OPPORTUNITY_RULE_VERSION, scoreOpportunity, WEIGHTS, type ScoreInputs } from "@/lib/scoring/opportunity";

const base: ScoreInputs = {
  signalType: "buying_intent",
  intentLevel: "explicit_request",
  industry: "Dental",
  location: "Maryville, TN",
  businessSize: "small",
  offerMatch: "redesign",
  campaignIndustries: ["HVAC", "Dental"],
  campaignLocations: ["Knoxville, TN", "Maryville, TN"],
  ageDays: 2,
  maxAgeDays: 60,
  contact: { emails: 1, phones: 1, hasContactForm: true },
  contactOnOwnSite: true,
  backedClaims: 5,
  totalClaims: 5,
  confidence: 0.9,
};

const parts = (s: ReturnType<typeof scoreOpportunity>) => Object.fromEntries(s.components.map((c) => [c.component, c.value]));

describe("Opportunity Score v1 (golden cases)", () => {
  it("weights add up to 100", () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("explicit request from a small local dental practice, fresh, reachable, fully backed: 99", () => {
    const s = scoreOpportunity(base);
    expect(parts(s)).toEqual({ intent: 1, fit: 1, freshness: 1, reachability: 1, evidence: 0.9 });
    expect(s.score).toBe(99);
    expect(s.band).toBe("very_high");
    expect(s.ruleVersion).toBe(OPPORTUNITY_RULE_VERSION);
  });

  it("prospecting signal: intent capped at 0.3, freshness taken from today's observation", () => {
    const s = scoreOpportunity({ ...base, signalType: "prospecting", intentLevel: "none", ageDays: null, offerMatch: "none", backedClaims: 3, totalClaims: 3 });
    expect(parts(s)).toEqual({ intent: 0, fit: 0.9, freshness: 1, reachability: 1, evidence: 0.9 });
    expect(s.score).toBe(61); // 0 + 27 + 15 + 10 + 9
    expect(s.band).toBe("review");
    const withIntent = scoreOpportunity({ ...base, signalType: "prospecting", intentLevel: "explicit_request" });
    expect(parts(withIntent).intent).toBe(0.3);
  });

  it("strong indirect signal, outside the area, only a contact form, 31 days old: 62", () => {
    const s = scoreOpportunity({
      ...base,
      intentLevel: "strong_indirect",
      location: "Nashville, TN",
      ageDays: 31,
      contact: { emails: 0, phones: 0, hasContactForm: true },
      backedClaims: 3,
      totalClaims: 4,
      confidence: 0.8,
    });
    expect(parts(s)).toEqual({ intent: 0.6, fit: 0.7, freshness: 0.5088, reachability: 0.6, evidence: 0.6 });
    // 21 + 21 + 7.63 + 6 + 6 = 61.63
    expect(s.score).toBe(62);
  });

  it("unknown dates count as 0 freshness for buying intent, never guessed", () => {
    const s = scoreOpportunity({ ...base, ageDays: null });
    expect(parts(s).freshness).toBe(0);
    expect(s.components.find((c) => c.component === "freshness")!.explanation).toMatch(/unknown/);
  });

  it("signals past the campaign's max age score 0 freshness", () => {
    expect(parts(scoreOpportunity({ ...base, ageDays: 60 })).freshness).toBe(0);
    expect(parts(scoreOpportunity({ ...base, ageDays: 400 })).freshness).toBe(0);
  });

  it("contact found on a third-party page does not count as reachable", () => {
    expect(parts(scoreOpportunity({ ...base, contactOnOwnSite: false })).reachability).toBe(0);
  });

  it("nothing known scores 0 and is Low", () => {
    const s = scoreOpportunity({
      ...base,
      intentLevel: "none",
      industry: null,
      location: null,
      businessSize: "unknown",
      offerMatch: "none",
      ageDays: null,
      contact: null,
      backedClaims: 0,
      totalClaims: 0,
      confidence: 0,
    });
    expect(s.score).toBe(0);
    expect(s.band).toBe("low");
  });

  it("is deterministic and clamps bad numbers", () => {
    expect(scoreOpportunity(base)).toEqual(scoreOpportunity(structuredClone(base)));
    const s = scoreOpportunity({ ...base, confidence: Number.NaN, backedClaims: 9, totalClaims: 3 });
    expect(parts(s).evidence).toBe(0);
  });

  it("points never exceed each part's weight", () => {
    for (const c of scoreOpportunity(base).components) expect(c.points).toBeLessThanOrEqual(c.weight);
  });

  it("bands at 85, 70 and 50", () => {
    expect([100, 85, 84, 70, 69, 50, 49, 0].map(bandFor)).toEqual(["very_high", "very_high", "high", "high", "review", "review", "low", "low"]);
  });
});
