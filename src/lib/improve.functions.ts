// Suggestions for the screens. Anyone in the workspace can read them; an operator approves or
// rejects and says when one was carried out. None of this changes a campaign or any setting.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./auth-middleware";
import { requireTenantRole, SlugInput } from "./tenant-access.server";
import { serviceClient } from "./supabase.server";
import { decide, markImplemented, type DecisionResult } from "./pipeline/improve.server";
import type { Evidence, Outcome } from "./improve/rules";

export type RecommendationView = {
  id: string;
  title: string;
  rationale: string;
  evidence: Evidence[];
  status: "proposed" | "approved" | "rejected" | "implemented";
  campaignName: string | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  implementedAt: string | null;
  baseline: number | null;
  outcome: Outcome | null;
  outcomeDueAt: string | null;
};

export const getRecommendations = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput }).parse(d))
  .handler(async ({ data, context }): Promise<{ items: RecommendationView[]; canDecide: boolean }> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "viewer");
    const db = context.supabase;
    const [recs, camps] = await Promise.all([
      db.from("gie_recommendations").select("*").eq("tenant_id", tenant.tenantId).order("created_at", { ascending: false }).limit(100),
      db.from("gie_campaigns").select("id, name").eq("tenant_id", tenant.tenantId),
    ]);
    if (recs.error) throw new Error(recs.error.message);
    if (camps.error) throw new Error(camps.error.message);
    const names = new Map(((camps.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]));
    const items = ((recs.data ?? []) as any[]).map((r): RecommendationView => ({
      id: r.id,
      title: r.title,
      rationale: r.rationale,
      evidence: r.evidence,
      status: r.status,
      campaignName: r.campaign_id ? (names.get(r.campaign_id) ?? null) : null,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      decisionNote: r.decision_note,
      implementedAt: r.implemented_at,
      baseline: r.baseline ? Number(r.baseline.value) : null,
      outcome: r.outcome,
      outcomeDueAt: r.implemented_at && !r.outcome ? new Date(Date.parse(r.implemented_at) + 30 * 86_400_000).toISOString() : null,
    }));
    return { items, canDecide: tenant.role !== "viewer" };
  });

const Input = z.object({ slug: SlugInput, id: z.string().uuid(), note: z.string().trim().max(500).optional() });

export const decideRecommendation = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => Input.extend({ action: z.enum(["approve", "reject"]) }).parse(d))
  .handler(async ({ data, context }): Promise<DecisionResult> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    return decide(serviceClient(context.env, context.env.GIE_DB_SCHEMA), tenant.tenantId, data.id, context.userId, data.action, data.note || null, new Date());
  });

export const implementRecommendation = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => Input.parse(d))
  .handler(async ({ data, context }): Promise<DecisionResult> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    return markImplemented(serviceClient(context.env, context.env.GIE_DB_SCHEMA), tenant.tenantId, data.id, context.userId, data.note || null, new Date());
  });
