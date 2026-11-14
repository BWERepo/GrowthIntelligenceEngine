import { describe, expect, it } from "vitest";
import { buildReport, compare, periodsFor, type FunnelEvent, type RevenueEvent, type Stage } from "@/lib/growth/metrics";

const TZ = "America/New_York";
const TODAY = "2026-11-19";

let n = 0;
const ev = (stage: Stage, occurredAt: string, extra: Partial<FunnelEvent> = {}): FunnelEvent => ({ stage, sourceTable: "t", sourceId: `s${++n}`, occurredAt, prospectId: null, attribution: "unknown", confidence: "none", ...extra });
const many = (stage: Stage, count: number, at: string) => Array.from({ length: count }, () => ev(stage, at));
const CUR = "2026-11-10T15:00:00Z";
const PREV = "2026-10-05T15:00:00Z";
const report = (funnel: FunnelEvent[], over: Partial<Parameters<typeof buildReport>[0]> = {}) => buildReport({ today: TODAY, timezone: TZ, funnel, revenue: [], bweConnected: true, visits: null, effectiveness: null, ...over });
const row = (r: ReturnType<typeof report>, key: string) => r.metrics.find((m) => m.key === key)!;

describe("periods", () => {
  it("ends yesterday and the previous period is the 30 days before", () => {
    const p = periodsFor(TODAY);
    expect(p.current).toEqual({ from: "2026-10-20", to: "2026-11-18" });
    expect(p.previous).toEqual({ from: "2026-09-20", to: "2026-10-19" });
  });
});

describe("compare", () => {
  it("gives no percent without a baseline", () => {
    const c = compare(15, 0);
    expect(c.percent).toBeNull();
    expect(c.note).toBe("n/a: no baseline");
    expect(c.trend).toBe("insufficient");
  });
  it("shows counts only below the minimum in either period", () => {
    expect(compare(20, 9).percent).toBeNull();
    expect(compare(9, 20)).toMatchObject({ percent: null, trend: "insufficient", note: "Insufficient evidence" });
  });
  it("computes a percent and calls small moves flat", () => {
    expect(compare(15, 10)).toMatchObject({ percent: 50, trend: "up" });
    expect(compare(10, 20)).toMatchObject({ percent: -50, trend: "down" });
    expect(compare(102, 100).trend).toBe("flat");
  });
  it("judges revenue by its payments, not its dollars", () => {
    expect(compare(900000, 800000, { evidence: { current: 3, previous: 2 } }).trend).toBe("insufficient");
  });
});

describe("report", () => {
  it("counts an event once even if it is handed over twice", () => {
    const e = ev("lead", CUR);
    const r = report([e, { ...e }]);
    expect(row(r, "lead").comparison!.current).toBe(1);
    const pay: RevenueEvent = { paymentId: "p1", paidAt: CUR, amountCents: 5000, currency: "usd", prospectId: null, attribution: "unknown", confidence: "none" };
    expect(report([], { revenue: [pay, { ...pay }] }).revenue!.totalCents.current).toBe(5000);
  });

  it("puts an event on its tenant-local date", () => {
    // 03:30Z on Oct 20 is 23:30 on Oct 19 in New York, so it belongs to the previous period. 22:00 on the 18th in New York is still the last day of the period; 01:00 on the 19th is not in it.
    const r = report([ev("lead", "2026-11-19T03:00:00Z"), ev("lead", "2026-11-19T06:00:00Z"), ev("lead", "2026-10-20T03:30:00Z")]);
    expect(row(r, "lead").comparison!.current).toBe(1);
    expect(row(r, "lead").comparison!.previous).toBe(1);
  });

  it("separates event-date results from the cohort of prospects pursued in the window", () => {
    const funnel = [
      ev("pursued", CUR, { prospectId: "new" }),
      ev("contacted", CUR, { prospectId: "new" }),
      ev("customer", CUR, { prospectId: "new" }),
      ev("pursued", PREV, { prospectId: "old" }),
      ev("customer", CUR, { prospectId: "old" }),
    ];
    const r = report(funnel);
    expect(row(r, "customer").comparison!.current).toBe(2);
    expect(r.cohort).toMatchObject({ size: 1, contacted: 1, customers: 1, sufficient: false });
  });

  it("shows unconnected stages as not measured, never as zero", () => {
    const r = report([ev("contacted", CUR)], { bweConnected: false });
    expect(row(r, "lead")).toMatchObject({ measured: false, comparison: null });
    expect(row(r, "revenue")).toMatchObject({ measured: false, comparison: null });
    expect(row(r, "contacted").measured).toBe(true);
    expect(r.revenue).toBeNull();
    expect(r.caveats.join(" ")).toMatch(/no business-data connection/);
  });

  it("keeps other currencies out of revenue and splits linked from unknown", () => {
    const base = { paidAt: CUR, prospectId: null, attribution: "unknown", confidence: "none" } as const;
    const r = report([], {
      revenue: [
        { ...base, paymentId: "a", amountCents: 10000, currency: "usd" },
        { ...base, paymentId: "b", amountCents: 7000, currency: "usd", prospectId: "p", attribution: "first_touch", confidence: "high" },
        { ...base, paymentId: "c", amountCents: 99999, currency: "eur" },
      ],
    });
    expect(r.revenue).toMatchObject({ totalCents: { current: 17000 }, attributedCents: { current: 7000 }, highConfidenceCents: { current: 7000 }, unattributedCents: { current: 10000 }, otherCurrencyPayments: 1 });
  });

  it("computes stage conversion only against a real denominator", () => {
    const r = report([...many("contacted", 4, CUR), ...many("replied", 1, CUR)]);
    const c = r.conversions.find((x) => x.from === "contacted")!;
    expect(c.current).toEqual({ numerator: 1, denominator: 4, rate: 25 });
    expect(c.previous.rate).toBeNull();
  });
});

describe("scenario flags", () => {
  const status = (r: ReturnType<typeof report>, k: string) => r.flags.find((f) => f.key === k)!.status;
  it("does not judge small samples", () => {
    const r = report([...many("contacted", 3, CUR), ...many("contacted", 2, PREV)]);
    expect(r.flags.map((f) => f.status)).toEqual(["not_evaluated", "not_evaluated", "not_evaluated", "not_evaluated"]);
  });
  it("A: more outreach with no more results", () => {
    const f = [...many("contacted", 30, CUR), ...many("contacted", 20, PREV), ...many("lead", 10, CUR), ...many("lead", 12, PREV)];
    expect(status(report(f), "A")).toBe("raised");
  });
  it("B: results up without more outreach", () => {
    const f = [...many("contacted", 20, CUR), ...many("contacted", 20, PREV), ...many("lead", 20, CUR), ...many("lead", 10, PREV)];
    const r = report(f);
    expect(status(r, "B")).toBe("raised");
    expect(status(r, "A")).toBe("clear");
  });
  it("C: more visitors, no more enquiries", () => {
    const f = [...many("lead", 10, CUR), ...many("lead", 10, PREV)];
    const r = report(f, { visits: { current: 300, previous: 200 } });
    expect(status(r, "C")).toBe("raised");
  });
  it("D: high effectiveness scores while results fall", () => {
    const f = [...many("lead", 10, CUR), ...many("lead", 20, PREV)];
    const eff = { current: { days: 15, average: 82 }, previous: { days: 15, average: 70 } };
    expect(status(report(f, { effectiveness: eff }), "D")).toBe("raised");
    expect(status(report(f, { effectiveness: { ...eff, current: { days: 3, average: 90 } } }), "D")).toBe("not_evaluated");
  });
});
