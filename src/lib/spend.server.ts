// Spending caps: every paid AI or search call is checked against the tenant's
// budgets first, and recorded in gie_usage_events after. At the cap, discovery
// stops (daily actions and follow-ups, from Phase 3, keep working).
import type { SupabaseClient } from "@supabase/supabase-js";
import { budgetStatus, canSpend, type BudgetState } from "./budget";
import { startOfLocalDayUtc, startOfLocalMonthUtc, localMoment } from "./schedule";

type Db = SupabaseClient<any, any, any>;
export type SpendCategory = "ai" | "search" | "other";

type BudgetRow = { category: "total" | "ai" | "search"; period: "day" | "month"; limit_usd: string | number; alert_at: Array<string | number> | null };

export type BudgetView = { category: string; period: string; limitUsd: number; spentUsd: number; state: BudgetState; fraction: number; alertAt: number[] };

async function sumSince(db: Db, tenantId: string, since: Date, category?: SpendCategory): Promise<number> {
  let total = 0;
  const pageSize = 1000;
  for (let from = 0; from < 50_000; from += pageSize) {
    let q = db.from("gie_usage_events").select("cost_usd").eq("tenant_id", tenantId).gte("occurred_at", since.toISOString());
    if (category) q = q.eq("category", category);
    const { data, error } = await q.order("occurred_at").range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) total += Number(r.cost_usd) || 0;
    if (!data || data.length < pageSize) break;
  }
  return Math.round(total * 1_000_000) / 1_000_000;
}

/** Every budget of the tenant with what has been spent against it so far this day / month (tenant-local). */
export async function budgetViews(db: Db, tenantId: string, timezone: string, now = new Date()): Promise<BudgetView[]> {
  const { data, error } = await db.from("gie_budgets").select("category, period, limit_usd, alert_at").eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);
  const dayStart = startOfLocalDayUtc(localMoment(now, timezone).date, timezone);
  const monthStart = startOfLocalMonthUtc(now, timezone);
  return Promise.all(
    ((data ?? []) as BudgetRow[]).map(async (b) => {
      const spent = await sumSince(db, tenantId, b.period === "day" ? dayStart : monthStart, b.category === "total" ? undefined : b.category);
      const limit = Number(b.limit_usd);
      const alertAt = (b.alert_at ?? []).map(Number);
      const s = budgetStatus(spent, limit, alertAt);
      return { category: b.category, period: b.period, limitUsd: limit, spentUsd: spent, state: s.state, fraction: s.fraction, alertAt };
    }),
  );
}

/**
 * Whether a call in `category` estimated at `estimateUsd` fits every budget
 * that applies to it. With no budget rows at all, nothing is allowed: a tenant
 * without a cap never spends by accident.
 */
export async function maySpend(db: Db, tenantId: string, timezone: string, category: SpendCategory, estimateUsd: number, now = new Date()) {
  const views = await budgetViews(db, tenantId, timezone, now);
  const applicable = views.filter((v) => v.category === "total" || v.category === category);
  if (!applicable.length) return { allowed: false as const, reason: "No spending cap is set for this workspace." };
  const blocking = applicable.find((v) => !canSpend(v.spentUsd, v.limitUsd, estimateUsd));
  if (blocking) {
    return { allowed: false as const, reason: `The ${blocking.period === "day" ? "daily" : "monthly"} ${blocking.category} cap of $${blocking.limitUsd.toFixed(2)} would be exceeded.` };
  }
  return { allowed: true as const };
}

export type UsageRecord = {
  tenantId: string;
  category: SpendCategory;
  provider: string;
  operation: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  units?: number;
  costUsd: number;
  isEstimate?: boolean;
  requestId?: string | null;
  idempotencyKey: string;
};

/** Records one paid (or free) call. The idempotency key makes a retried write a no-op. */
export async function recordUsage(db: Db, u: UsageRecord): Promise<void> {
  const { error } = await db.from("gie_usage_events").upsert(
    {
      tenant_id: u.tenantId,
      category: u.category,
      provider: u.provider,
      operation: u.operation,
      model: u.model ?? null,
      input_tokens: u.inputTokens ?? null,
      output_tokens: u.outputTokens ?? null,
      units: u.units ?? 1,
      cost_usd: Math.max(0, u.costUsd),
      is_estimate: u.isEstimate ?? true,
      request_id: u.requestId ?? null,
      idempotency_key: u.idempotencyKey.slice(0, 200),
    },
    { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);
}
