import { describe, expect, it } from "vitest";
import { budgetViews, maySpend } from "@/lib/spend.server";
import { fakeDb } from "./fake-db";

const T = "tenant-a";
const now = new Date("2026-11-20T15:00:00Z");
const usage = (cost: number, at: string, category = "ai", tenant = T) => ({ tenant_id: tenant, cost_usd: String(cost), occurred_at: at, category });

describe("spending cap (budget stop)", () => {
  const budgets = [{ tenant_id: T, category: "total", period: "month", limit_usd: "50", alert_at: ["0.5", "0.8"] }];

  it("counts only this tenant's spending in the tenant-local month", async () => {
    const db = fakeDb({
      gie_budgets: budgets,
      gie_usage_events: [
        usage(10, "2026-11-01T05:30:00.000Z"), // Nov 1, 00:30 in New York: counts
        usage(99, "2026-11-01T03:00:00.000Z"), // Oct 31, 23:00 in New York: last month
        usage(5, "2026-11-10T12:00:00.000Z", "search"),
        usage(500, "2026-11-10T12:00:00.000Z", "ai", "tenant-b"), // another tenant
      ],
    });
    const [view] = await budgetViews(db, T, "America/New_York", now);
    expect(view!.spentUsd).toBe(15);
    expect(view!.state).toBe("ok");
  });

  it("allows a call that fits and stops one that would cross the cap", async () => {
    const db = fakeDb({ gie_budgets: budgets, gie_usage_events: [usage(49.9, "2026-11-15T12:00:00.000Z")] });
    expect((await maySpend(db, T, "America/New_York", "ai", 0.05, now)).allowed).toBe(true);
    const stop = await maySpend(db, T, "America/New_York", "ai", 0.2, now);
    expect(stop.allowed).toBe(false);
    expect(stop.allowed ? "" : stop.reason).toMatch(/monthly total cap of \$50.00/);
  });

  it("applies category budgets only to their category", async () => {
    const db = fakeDb({
      gie_budgets: [...budgets, { tenant_id: T, category: "search", period: "day", limit_usd: "1", alert_at: [] }],
      gie_usage_events: [usage(1, "2026-11-20T14:00:00.000Z", "search")],
    });
    expect((await maySpend(db, T, "America/New_York", "search", 0.005, now)).allowed).toBe(false);
    expect((await maySpend(db, T, "America/New_York", "ai", 0.5, now)).allowed).toBe(true);
  });

  it("allows nothing when the tenant has no cap at all", async () => {
    const r = await maySpend(fakeDb({ gie_budgets: [], gie_usage_events: [] }), T, "America/New_York", "ai", 0.01, now);
    expect(r.allowed).toBe(false);
  });
});
