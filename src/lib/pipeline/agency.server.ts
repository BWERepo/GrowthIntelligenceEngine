// Platform-admin work on client workspaces: create, suspend, set limits, and a monitoring
// overview. Callers must have checked is_platform_admin first (see agency.functions.ts).
import type { SupabaseClient } from "@supabase/supabase-js";
import { budgetViews } from "@/lib/spend.server";
import { effectiveSendCap, QuotaInput, RESERVED_SLUGS, WorkspaceInput } from "@/lib/agency/rules";

type Db = SupabaseClient<any, any, any>;
type Row = Record<string, any>;
const must = <T>(r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data;
};
const DAY = 86_400_000;

export type CreateResult = { ok: true; tenantId: string } | { ok: false; reason: string };

export async function createWorkspace(db: Db, input: WorkspaceInput, actorId: string, lookupUser: (email: string) => Promise<string | null>): Promise<CreateResult> {
  const i = WorkspaceInput.parse(input);
  if (RESERVED_SLUGS.includes(i.slug)) return { ok: false, reason: "That workspace address is reserved." };
  const owner = await lookupUser(i.ownerEmail);
  if (!owner) return { ok: false, reason: "No account exists for that email yet. They need to sign up first, then you can create their workspace." };
  const t = await db.from("gie_tenants").insert({ slug: i.slug, name: i.name, timezone: i.timezone }).select("id").single();
  if (t.error) return { ok: false, reason: t.error.message.includes("duplicate") ? "A workspace with that address already exists." : t.error.message.includes("time zone") ? "That is not a valid time zone." : t.error.message };
  const id = t.data.id as string;
  try {
    must(await db.from("gie_tenant_work_schedules").insert({ tenant_id: id }));
    must(await db.from("gie_budgets").insert({ tenant_id: id, category: "total", period: "month", limit_usd: i.monthlyBudgetUsd, alert_at: [0.5, 0.8] }));
    must(await db.from("gie_tenant_quotas").insert({ tenant_id: id, updated_by: actorId }));
    must(await db.from("gie_tenant_memberships").insert({ tenant_id: id, user_id: owner, role: "owner" }));
    await db.from("gie_audit_events").insert({ tenant_id: id, actor_user_id: actorId, action: "workspace.create", entity_type: "tenant", entity_id: id, after: { slug: i.slug, owner_email: i.ownerEmail, monthly_budget_usd: i.monthlyBudgetUsd } });
  } catch (error) {
    // Do not leave a half-built workspace behind.
    await db.from("gie_tenants").delete().eq("id", id);
    throw error;
  }
  return { ok: true, tenantId: id };
}

export async function setStatus(db: Db, tenantId: string, status: "active" | "suspended", actorId: string): Promise<void> {
  const t = (must(await db.from("gie_tenants").select("slug, status").eq("id", tenantId).maybeSingle()) ?? null) as Row | null;
  if (!t) throw new Error("Not found: that workspace does not exist.");
  if (t.slug === "bwe") throw new Error("Invalid: the owner's own workspace cannot be suspended here.");
  must(await db.from("gie_tenants").update({ status }).eq("id", tenantId));
  await db.from("gie_audit_events").insert({ tenant_id: tenantId, actor_user_id: actorId, action: `workspace.${status === "suspended" ? "suspend" : "reactivate"}`, entity_type: "tenant", entity_id: tenantId, before: { status: t.status }, after: { status } });
}

export async function setQuotas(db: Db, tenantId: string, q: QuotaInput, actorId: string): Promise<void> {
  const v = QuotaInput.parse(q);
  const before = (must(await db.from("gie_tenant_quotas").select("max_active_campaigns, max_members, daily_send_cap").eq("tenant_id", tenantId).maybeSingle()) ?? null) as Row | null;
  must(await db.from("gie_tenant_quotas").upsert({ tenant_id: tenantId, max_active_campaigns: v.maxActiveCampaigns, max_members: v.maxMembers, daily_send_cap: v.dailySendCap, updated_by: actorId, updated_at: new Date().toISOString() }, { onConflict: "tenant_id" }));
  await db.from("gie_audit_events").insert({ tenant_id: tenantId, actor_user_id: actorId, action: "workspace.quotas", entity_type: "tenant", entity_id: tenantId, before, after: v });
}

export type WorkspaceHealth = {
  id: string;
  slug: string;
  name: string;
  status: string;
  members: number;
  quotas: { maxActiveCampaigns: number; maxMembers: number; dailySendCap: number | null };
  activeCampaigns: number;
  sentLast24h: number;
  sendCapNow: number;
  budget: { limitUsd: number; spentUsd: number; state: string } | null;
  failedJobs7d: number;
  lastJob: { kind: string; status: string; at: string } | null;
  /** Plain-language things that need a look. */
  attention: string[];
};

export async function overview(db: Db, appSendCap: number, now = new Date()): Promise<WorkspaceHealth[]> {
  const tenants = (must(await db.from("gie_tenants").select("id, slug, name, status, timezone").order("created_at")) ?? []) as Row[];
  const out: WorkspaceHealth[] = [];
  for (const t of tenants) {
    const [members, quota, campaigns, sent, jobs] = await Promise.all([
      db.from("gie_tenant_memberships").select("id", { count: "exact", head: true }).eq("tenant_id", t.id),
      db.from("gie_tenant_quotas").select("max_active_campaigns, max_members, daily_send_cap").eq("tenant_id", t.id).maybeSingle(),
      db.from("gie_campaigns").select("id", { count: "exact", head: true }).eq("tenant_id", t.id).eq("status", "active"),
      db.from("gie_outreach_drafts").select("id", { count: "exact", head: true }).eq("tenant_id", t.id).gte("sent_at", new Date(now.getTime() - DAY).toISOString()),
      db.from("gie_job_runs").select("job_kind, status, started_at, error").eq("tenant_id", t.id).gte("started_at", new Date(now.getTime() - 7 * DAY).toISOString()).order("started_at", { ascending: false }).limit(200),
    ]);
    for (const r of [members, quota, campaigns, sent, jobs]) if (r.error) throw new Error(r.error.message);
    const budgets = await budgetViews(db, t.id, t.timezone, now);
    const total = budgets.find((b) => b.category === "total" && b.period === "month") ?? null;
    const q = { maxActiveCampaigns: quota.data?.max_active_campaigns ?? 3, maxMembers: quota.data?.max_members ?? 5, dailySendCap: quota.data?.daily_send_cap ?? null };
    const jobRows = (jobs.data ?? []) as Row[];
    const failed = jobRows.filter((j) => j.status === "failed").length;
    const attention: string[] = [];
    if (t.status !== "active") attention.push(`Workspace is ${t.status}.`);
    if (failed) attention.push(`${failed} failed job run(s) in the last 7 days.`);
    if (total && total.state !== "ok") attention.push(`Monthly budget is ${total.state} (${Math.round(total.fraction * 100)}% used).`);
    if ((campaigns.count ?? 0) >= q.maxActiveCampaigns) attention.push("At the active campaign limit.");
    if ((members.count ?? 0) >= q.maxMembers) attention.push("At the team size limit.");
    out.push({
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status,
      members: members.count ?? 0,
      quotas: q,
      activeCampaigns: campaigns.count ?? 0,
      sentLast24h: sent.count ?? 0,
      sendCapNow: effectiveSendCap(appSendCap, q.dailySendCap),
      budget: total ? { limitUsd: total.limitUsd, spentUsd: total.spentUsd, state: total.state } : null,
      failedJobs7d: failed,
      lastJob: jobRows[0] ? { kind: jobRows[0].job_kind, status: jobRows[0].status, at: jobRows[0].started_at } : null,
      attention,
    });
  }
  return out;
}
