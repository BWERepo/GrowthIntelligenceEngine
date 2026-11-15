import { describe, expect, it } from "vitest";
import { addQueries, competitorQueries, planQueries, SWITCHING_QUERY_TEMPLATES } from "@/lib/discovery/queries";

describe("switching and competitor searches", () => {
  it("adds templates without duplicating existing lines", () => {
    const out = addQueries(["Need a new web designer {location}"], SWITCHING_QUERY_TEMPLATES);
    expect(out).toHaveLength(SWITCHING_QUERY_TEMPLATES.length);
  });
  it("builds two searches per distinct competitor and ignores blanks", () => {
    expect(competitorQueries([" Wix ", "wix", "", "Squarespace"])).toEqual([
      "alternative to Wix {location}", "leaving Wix for a new website {location}",
      "alternative to Squarespace {location}", "leaving Squarespace for a new website {location}",
    ]);
  });
  it("expands per location and stays within the daily limit", () => {
    const planned = planQueries({ buyingIntentQueries: [...SWITCHING_QUERY_TEMPLATES], prospectingQueries: [], locations: ["Knoxville", "Maryville"], dailySearchLimit: 4 });
    expect(planned).toHaveLength(4);
    expect(planned.every((p) => p.signalType === "buying_intent" && !p.query.includes("{"))).toBe(true);
  });
});
