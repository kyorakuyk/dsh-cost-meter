/**
 * Pure budget evaluation (M2b).
 *
 * Given spending standings, configured budgets, and alert thresholds, produce
 * the newly crossed alerts. Idempotency is the caller's `notified` set: each
 * (scope, key, threshold) fires exactly once, so repeated evaluations after
 * further spending emit only the thresholds crossed since the last check.
 *
 * @module dsh-cost-meter/budget
 */

import type { BudgetAlert, BudgetConfig, BudgetScope, BudgetStanding } from './types.ts'

/**
 * Evaluate standings against budgets and emit newly crossed thresholds.
 * @param standings - current spending per scope/key.
 * @param budgets - USD budget per scope; absent scope = not budgeted.
 * @param thresholds - ascending percentages; alerts fire at each crossed level.
 * @param notified - caller-owned idempotency set, mutated with fired crossings.
 * @returns alerts for crossings not already in `notified`.
 */
export function evaluateBudgets(
  standings: readonly BudgetStanding[],
  budgets: BudgetConfig,
  thresholds: readonly number[],
  notified: Set<string>,
): BudgetAlert[] {
  const alerts: BudgetAlert[] = []
  for (const standing of standings) {
    const amount = budgets[standing.scope]
    if (amount === undefined || amount <= 0) continue
    const pct = standing.spent / amount * 100
    for (const threshold of thresholds) {
      if (pct < threshold) continue
      const id = crossingId(standing.scope, standing.key, threshold)
      if (notified.has(id)) continue
      notified.add(id)
      alerts.push({
        scope: standing.scope,
        key: standing.key,
        amount,
        spent: standing.spent,
        pct,
        thresholdPct: threshold,
      })
    }
  }
  return alerts
}

/** Stable id for one (scope, key, threshold) crossing. */
export function crossingId(scope: BudgetScope, key: string, threshold: number): string {
  return `${scope}\u0000${key}\u0000${threshold}`
}

/** Sort ascending and dedupe thresholds, so evaluation order is deterministic. */
export function normalizeThresholds(thresholds: readonly number[] | undefined): number[] {
  const seen = new Set<number>()
  const sorted = [...(thresholds ?? [50, 80, 100])]
    .filter((t) => Number.isFinite(t) && t >= 0 && t <= 100)
    .sort((a, b) => a - b)
  const result: number[] = []
  for (const t of sorted) {
    if (!seen.has(t)) {
      seen.add(t)
      result.push(t)
    }
  }
  return result
}
