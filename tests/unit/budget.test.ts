import { describe, expect, it } from "vitest";
import { budgetStatus, canSpend } from "@/lib/budget";

describe("budgetStatus ($50 monthly cap, alerts at 50% and 80%)", () => {
  it("is ok below the first alert", () => {
    expect(budgetStatus(10, 50).state).toBe("ok");
  });
  it("alerts at $25 and $40", () => {
    expect(budgetStatus(25, 50)).toMatchObject({ state: "alert", crossedAlert: 0.5 });
    expect(budgetStatus(40, 50)).toMatchObject({ state: "alert", crossedAlert: 0.8 });
  });
  it("is exceeded at the cap", () => {
    expect(budgetStatus(50, 50)).toMatchObject({ state: "exceeded", remainingUsd: 0 });
  });
  it("treats a zero or missing cap as exceeded, never unlimited", () => {
    expect(budgetStatus(0, 0).state).toBe("exceeded");
    expect(canSpend(0, 0, 0.01)).toBe(false);
  });
  it("blocks a request that would cross the cap", () => {
    expect(canSpend(49.9, 50, 0.05)).toBe(true);
    expect(canSpend(49.9, 50, 0.2)).toBe(false);
  });
});
