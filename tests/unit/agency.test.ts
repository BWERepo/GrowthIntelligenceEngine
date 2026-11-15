import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { mutableDb } from "./mutable-db";
import { effectiveSendCap, QuotaInput, WorkspaceInput } from "@/lib/agency/rules";
import { createWorkspace, overview, setQuotas, setStatus } from "@/lib/pipeline/agency.server";
import { monthRange, recentMonths } from "@/lib/reporting/month";
import { checkSuppression } from "@/lib/actions/suppression.server";

const good = { name: "Acme Dental", slug: "acme-dental", timezone: "America/New_York", ownerEmail: "Owner@Acme.com", monthlyBudgetUsd: 20 };
const user = async (e: string) => (e === "owner@acme.com" ? "user-1" : null);

describe("limits", () => {
  it("never lets a workspace exceed the app-wide cap", () => {
    expect(effectiveSendCap(20, null)).toBe(20);
    expect(effectiveSendCap(20, 5)).toBe(5);
    expect(effectiveSendCap(20, 100)).toBe(20);
    expect(effectiveSendCap(20, 0)).toBe(0);
  });
  it("validates workspace and quota input", () => {
    expect(WorkspaceInput.safeParse({ ...good, slug: "Bad Slug" }).success).toBe(false);
    expect(WorkspaceInput.parse(good).ownerEmail).toBe("owner@acme.com");
    expect(QuotaInput.safeParse({ maxActiveCampaigns: 3, maxMembers: 0, dailySendCap: null }).success).toBe(false);
  });
});

describe("createWorkspace", () => {
  it("builds the whole workspace and records who did it", async () => {
    const db = mutableDb({});
    const r = await createWorkspace(db, good as any, "admin-1", user);
    expect(r.ok).toBe(true);
    expect(db.tables.gie_tenants).toHaveLength(1);
    expect(db.tables.gie_tenant_memberships![0]).toMatchObject({ user_id: "user-1", role: "owner" });
    expect(db.tables.gie_budgets![0]).toMatchObject({ category: "total", period: "month", limit_usd: 20 });
    expect(db.tables.gie_tenant_quotas).toHaveLength(1);
    expect(db.tables.gie_audit_events![0]).toMatchObject({ action: "workspace.create", actor_user_id: "admin-1" });
  });
  it("refuses a reserved address and an owner with no account, creating nothing", async () => {
    const db = mutableDb({});
    expect(await createWorkspace(db, { ...good, slug: "bwe" } as any, "a", user)).toMatchObject({ ok: false });
    expect(await createWorkspace(db, { ...good, ownerEmail: "nobody@x.com" } as any, "a", user)).toMatchObject({ ok: false });
    expect(db.tables.gie_tenants ?? []).toHaveLength(0);
  });
  it("removes a half-built workspace when a step fails", async () => {
    const db = mutableDb({});
    const from = db.from.bind(db);
    db.from = (t: string) => (t === "gie_tenant_memberships" ? { insert: async () => ({ data: null, error: { message: "boom" } }) } : from(t));
    await expect(createWorkspace(db, good as any, "a", user)).rejects.toThrow("boom");
    expect(db.tables.gie_tenants).toHaveLength(0);
  });
});

describe("status, quotas and overview", () => {
  it("will not suspend the owner's own workspace", async () => {
    const db = mutableDb({ gie_tenants: [{ id: "t0", slug: "bwe", status: "active" }] });
    await expect(setStatus(db, "t0", "suspended", "a")).rejects.toThrow(/cannot be suspended/);
  });
  it("suspends and audits a client workspace", async () => {
    const db = mutableDb({ gie_tenants: [{ id: "t1", slug: "acme", status: "active" }] });
    await setStatus(db, "t1", "suspended", "a");
    expect(db.tables.gie_tenants![0].status).toBe("suspended");
    expect(db.tables.gie_audit_events![0]).toMatchObject({ action: "workspace.suspend" });
  });
  it("stores limits and says what needs attention", async () => {
    const db = mutableDb({
      gie_tenants: [{ id: "t1", slug: "acme", name: "Acme", status: "suspended", timezone: "America/New_York" }],
      gie_tenant_memberships: [{ tenant_id: "t1" }],
      gie_campaigns: [{ tenant_id: "t1", status: "active" }],
      gie_job_runs: [{ tenant_id: "t1", job_kind: "discovery", status: "failed", started_at: new Date().toISOString() }],
    });
    await setQuotas(db, "t1", { maxActiveCampaigns: 1, maxMembers: 1, dailySendCap: 4 }, "a");
    const [w] = await overview(db, 20);
    expect(w).toMatchObject({ members: 1, sendCapNow: 4, failedJobs7d: 1 });
    expect(w!.attention.join(" ")).toMatch(/suspended/);
    expect(w!.attention.join(" ")).toMatch(/failed job/);
    expect(w!.attention.join(" ")).toMatch(/campaign limit/);
  });
});

describe("outreach for client workspaces", () => {
  it("cannot be approved until the workspace has its own unsubscribe list", async () => {
    const r = await checkSuppression({ BWE_TENANT_SLUG: "bwe" } as any, "acme", "x@y.com");
    expect(r.clear).toBe(false);
  });
});

describe("months", () => {
  it("covers a tenant-local month", () => {
    const r = monthRange("2026-11", "America/New_York");
    expect(r.from).toBe("2026-11-01T04:00:00.000Z");
    expect(r.to).toBe("2026-12-01T05:00:00.000Z");
    expect(r.lastDate).toBe("2026-11-30");
    expect(() => monthRange("2026-13", "UTC")).toThrow();
  });
  it("lists recent months across a year end", () => {
    expect(recentMonths("2026-02-10", 4)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
  });
});

describe("every server function checks who is asking", () => {
  const dir = "src/lib";
  const files = readdirSync(dir).filter((f) => f.endsWith(".functions.ts"));
  // getWorkspace reads only the caller's own memberships through RLS; getTenantSettings resolves the caller's membership.
  const guards = ["requireTenantRole(", "requirePlatformAdmin(", "resolveTenant("];
  // verifyPin checks the password session itself (requireSession) and then the PIN.
  const own = ["getWorkspace", "verifyPin"];
  it("has files to check", () => expect(files.length).toBeGreaterThan(5));
  for (const f of files) {
    const src = readFileSync(`${dir}/${f}`, "utf8");
    const parts = src.split(/export const (\w+) = createServerFn/).slice(1);
    for (let i = 0; i < parts.length; i += 2) {
      const name = parts[i]!;
      const body = parts[i + 1]!;
      it(`${f}: ${name}`, () => {
        expect(own.includes(name) || guards.some((g) => body.includes(g))).toBe(true);
      });
    }
  }
});
