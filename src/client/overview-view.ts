/**
 * Pure presentation prep for the Web cost panel (M3).
 *
 * Flattens the host `CostOverview` payload into the plain view the panel
 * renders. Pure and React-free, so it is unit-testable in Node.
 *
 * @module dsh-cost-meter/client/overview-view
 */

import type { CostOverview } from '../index.ts'

/** One project line. */
export interface ProjectView {
  key: string
  cost: number
  calls: number
}

/** One budget line with progress. */
export interface StandingView {
  scope: string
  key: string
  spent: number
  amount?: number
  pct?: number
}

/** The flattened panel view. */
export interface OverviewView {
  totalCost: number
  totalCalls: number
  unpricedCalls: number
  projects: ProjectView[]
  months: { key: string; cost: number }[]
  standings: StandingView[]
}

/** Format USD with two decimals and a thousands separator. */
export function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Build the panel view from the host payload; tolerates a missing/unusable payload. */
export function toOverviewView(payload: CostOverview | undefined): OverviewView {
  const aggregate = payload?.aggregate
  const projects: ProjectView[] = Object.entries(aggregate?.byProject ?? {})
    .map(([key, summary]) => ({ key, cost: summary.cost, calls: summary.calls }))
    .sort((a, b) => b.cost - a.cost)
  const months = Object.entries(aggregate?.byMonth ?? {})
    .map(([key, summary]) => ({ key, cost: summary.cost }))
    .sort((a, b) => (a.key < b.key ? 1 : -1))
  return {
    totalCost: aggregate?.totalCost ?? 0,
    totalCalls: aggregate?.totalCalls ?? 0,
    unpricedCalls: aggregate?.totalUnpricedCalls ?? 0,
    projects,
    months,
    standings: payload?.standings ?? [],
  }
}
