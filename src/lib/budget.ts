// Spending-cap state for one budget (e.g. $50/month total). Phase 2 calls this
// before every paid AI or search request; at "exceeded" nonessential work stops.
export type BudgetState = "ok" | "alert" | "exceeded";

export function budgetStatus(
  spentUsd: number,
  limitUsd: number,
  alertAt: number[] = [0.5, 0.8],
): { state: BudgetState; fraction: number; crossedAlert: number | null; remainingUsd: number } {
  if (!(limitUsd > 0)) return { state: "exceeded", fraction: 1, crossedAlert: null, remainingUsd: 0 };
  const fraction = spentUsd / limitUsd;
  const crossed = [...alertAt].sort((a, b) => a - b).filter((a) => fraction >= a);
  return {
    state: fraction >= 1 ? "exceeded" : crossed.length ? "alert" : "ok",
    fraction,
    crossedAlert: crossed.length ? crossed[crossed.length - 1]! : null,
    remainingUsd: Math.max(0, Math.round((limitUsd - spentUsd) * 100) / 100),
  };
}

/** Whether a request estimated at `estimateUsd` may run without crossing the cap. */
export function canSpend(spentUsd: number, limitUsd: number, estimateUsd: number): boolean {
  return limitUsd > 0 && spentUsd + Math.max(0, estimateUsd) <= limitUsd;
}
