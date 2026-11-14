import { describe, expect, it } from "vitest";
import { mutableDb } from "./mutable-db";
import { freezeSnapshot, loadReport, syncOutcomes } from "@/lib/pipeline/growth.server";

const T = "t1";
const tenant = { id: T, slug: "bwe", timezone: "America/New_York" };
const NOW = new Date("2026-11-19T15:00:00Z");

const gie = () =>
  mutableDb({
    gie_prospects: [{ id: "p1", tenant_id: T, contact_email: "owner@shop.com", bwe_lead_id: "L1", created_at: "2026-11-01T12:00:00Z" }],
    gie_outreach_drafts: [{ id: "d1", tenant_id: T, prospect_id: "p1", status: "sent", sent_at: "2026-11-02T12:00:00Z" }],
    gie_outreach_replies: [{ id: "r1", tenant_id: T, prospect_id: "p1", kind: "reply", received_at: "2026-11-03T12:00:00Z" }, { id: "r2", tenant_id: T, prospect_id: "p1", kind: "bounce", received_at: "2026-11-03T13:00:00Z" }],
    gie_opportunities: [{ id: "o1", tenant_id: T, discovered_at: "2026-10-30T12:00:00Z" }],
  });
const bwe = () =>
  mutableDb({
    leads: [{ id: "L1", email: "owner@shop.com", created_at: "2026-11-05T12:00:00Z" }, { id: "L9", email: "stranger@else.com", created_at: "2026-11-06T12:00:00Z" }],
    onboardings: [{ owner_id: "u1", client_email: "Owner@shop.com", created_at: "2026-11-07T12:00:00Z" }],
    meetings: [{ id: "m1", owner_id: "u1", meeting_date: "2026-11-08" }],
    client_proposal_sends: [{ id: "ps1", owner_id: "u1", sent_at: "2026-11-09T12:00:00Z" }],
    client_agreements: [{ id: "ag1", owner_id: "u1", status: "signed", signed_at: "2026-11-10T12:00:00Z" }, { id: "ag2", owner_id: "u1", status: "pending", signed_at: null }],
    payments: [
      { id: "pay1", owner_id: "u1", kind: "deposit", amount_cents: 50000, currency: "USD", status: "paid", paid_at: "2026-11-11T12:00:00Z" },
      { id: "pay2", owner_id: "u1", kind: "balance", amount_cents: 150000, currency: "usd", status: "paid", paid_at: "2026-11-12T12:00:00Z" },
      { id: "pay3", owner_id: "u2", kind: "deposit", amount_cents: 20000, currency: "usd", status: "pending", paid_at: null },
    ],
  });

describe("syncOutcomes", () => {
  it("records the workspace's own events without BWE", async () => {
    const db = gie();
    const r = await syncOutcomes(db, null, tenant, NOW);
    expect(r).toEqual({ events: 4, revenue: 0, bwe: false });
    expect(db.tables.gie_sales_funnel_events!.map((e: any) => e.stage).sort()).toEqual(["contacted", "opportunity", "pursued", "replied"]);
  });

  it("records BWE outcomes once, links them honestly, and is safe to run twice", async () => {
    const db = gie();
    const b = bwe();
    await syncOutcomes(db, b, tenant, NOW);
    await syncOutcomes(db, b, tenant, NOW);
    const events = db.tables.gie_sales_funnel_events! as any[];
    const of = (stage: string) => events.filter((e) => e.stage === stage);
    expect(of("lead")).toHaveLength(2);
    expect(of("meeting")).toHaveLength(1);
    expect(of("proposal")).toHaveLength(1);
    expect(of("agreement")).toHaveLength(1);
    expect(of("deposit")).toHaveLength(1);
    // Two paid payments, one customer.
    expect(of("customer")).toHaveLength(1);
    expect(of("customer")[0].occurred_at).toBe("2026-11-11T12:00:00Z");
    expect(db.tables.gie_revenue_events).toHaveLength(2);
    expect(events).toHaveLength(4 + 7);

    const linked = of("lead").find((e) => e.source_id === "L1");
    expect(linked).toMatchObject({ prospect_id: "p1", attribution: "first_touch", attribution_confidence: "high" });
    expect(of("lead").find((e) => e.source_id === "L9")).toMatchObject({ prospect_id: null, attribution: "unknown", attribution_confidence: "none", attribution_basis: null });
    expect(of("customer")[0]).toMatchObject({ prospect_id: "p1", attribution_confidence: "medium" });
    expect(db.tables.gie_revenue_events!.every((r: any) => r.prospect_id === "p1" && r.currency === "usd")).toBe(true);
  });

  it("never writes to BWE", async () => {
    const b = bwe();
    const before = JSON.stringify(b.tables);
    await syncOutcomes(gie(), b, tenant, NOW);
    expect(JSON.stringify(b.tables)).toBe(before);
  });
});

describe("loadReport and freezeSnapshot", () => {
  it("builds the report from recorded events and freezes it once per day", async () => {
    const db = gie();
    await syncOutcomes(db, bwe(), tenant, NOW);
    const report = await loadReport(db, tenant, NOW, { bweConnected: true, visits: null });
    const m = (k: string) => report.metrics.find((x) => x.key === k)!.comparison!;
    expect(m("lead").current).toBe(2);
    expect(m("customer").current).toBe(1);
    expect(m("revenue").current).toBe(200000);
    expect(m("revenue").trend).toBe("insufficient");
    expect(report.revenue!.attributedCents.current).toBe(200000);
    expect(report.asOfDate).toBe("2026-11-18");

    expect(await freezeSnapshot(db, tenant, report)).toBe(true);
    expect(await freezeSnapshot(db, tenant, report)).toBe(false);
    expect(db.tables.gie_growth_period_snapshots).toHaveLength(1);
  });
});
