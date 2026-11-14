import { describe, expect, it } from "vitest";
import { mutableDb } from "./mutable-db";
import { decide, generateRecommendations, markImplemented, measureOutcomes } from "@/lib/pipeline/improve.server";

const T = "t1";
const tenant = { id: T, slug: "bwe", timezone: "America/New_York" };
const NOW = new Date("2026-11-20T15:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const world = () =>
  mutableDb({
    gie_campaigns: [{ id: "c1", tenant_id: T, name: "Dental", status: "active", created_at: day(90) }],
    gie_opportunities: [{ id: "o1", tenant_id: T, campaign_id: "c1", discovered_at: day(5) }],
    gie_prospects: [{ id: "p1", tenant_id: T, opportunity_id: "o1" }],
    gie_outreach_drafts: Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, tenant_id: T, prospect_id: "p1", status: "sent", sent_at: day(2 + (i % 20)) })),
    gie_outreach_replies: [],
    gie_growth_period_snapshots: [],
    gie_recommendations: [],
    gie_audit_events: [],
  }, { gie_recommendations: { status: "proposed" } });

describe("recommendation flow", () => {
  it("suggests from recorded results, once, and never changes a campaign", async () => {
    const db = world();
    const campaignsBefore = JSON.stringify(db.tables.gie_campaigns);
    expect(await generateRecommendations(db, tenant, NOW)).toBe(1);
    expect(await generateRecommendations(db, tenant, NOW)).toBe(0);
    expect(db.tables.gie_recommendations).toHaveLength(1);
    expect(db.tables.gie_recommendations![0]).toMatchObject({ rule_key: "campaign_no_replies", status: "proposed" });
    const id = db.tables.gie_recommendations![0].id;
    expect((await decide(db, T, id, "u1", "approve", null, NOW)).ok).toBe(true);
    expect((await markImplemented(db, T, id, "u1", "Rewrote the queries", NOW)).ok).toBe(true);
    expect(JSON.stringify(db.tables.gie_campaigns)).toBe(campaignsBefore);
  });

  it("only lets a proposed suggestion be approved, and an approved one be carried out", async () => {
    const db = world();
    await generateRecommendations(db, tenant, NOW);
    const id = db.tables.gie_recommendations![0].id;
    expect((await markImplemented(db, T, id, "u1", null, NOW)).ok).toBe(false);
    expect((await decide(db, T, id, "u1", "approve", null, NOW)).ok).toBe(true);
    expect((await decide(db, T, id, "u2", "approve", null, NOW)).ok).toBe(false);
    expect(db.tables.gie_recommendations![0]).toMatchObject({ status: "approved", decided_by: "u1" });
    expect(db.tables.gie_audit_events).toHaveLength(1);
  });

  it("does not re-suggest something rejected within 30 days", async () => {
    const db = world();
    await generateRecommendations(db, tenant, NOW);
    await decide(db, T, db.tables.gie_recommendations![0].id, "u1", "reject", "Not now", NOW);
    expect(await generateRecommendations(db, tenant, new Date(NOW.getTime() + 10 * 86_400_000))).toBe(0);
  });

  it("stores the baseline at carry-out and measures the next 30 days once", async () => {
    const db = world();
    db.tables.gie_outreach_replies!.push(...Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, tenant_id: T, prospect_id: "p1", kind: "reply", received_at: day(10) })));
    db.tables.gie_recommendations!.push({ id: "rec1", tenant_id: T, rule_key: "campaign_no_replies", subject_key: "c1", campaign_id: "c1", metric: "replied", status: "approved", evidence: [{}], created_at: day(40) });
    expect((await markImplemented(db, T, "rec1", "u1", null, new Date(day(35)))).ok).toBe(true);
    const rec = db.tables.gie_recommendations![0];
    expect(rec.baseline.value).toBe(0);
    // Before 30 days have passed there is nothing to measure.
    expect(await measureOutcomes(db, tenant, new Date(day(10)))).toBe(0);
    // After: 12 replies landed in the 30 days after carrying it out, but there was no baseline.
    expect(await measureOutcomes(db, tenant, NOW)).toBe(1);
    expect(rec.outcome).toMatchObject({ before: 0, after: 12, verdict: "insufficient_evidence" });
    expect(await measureOutcomes(db, tenant, NOW)).toBe(0);
  });
});
