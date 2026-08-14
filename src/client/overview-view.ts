/**
 * Pure presentation prep for the Web cost panel (M3).
 *
 * Flattens the host `CostOverview` payload into the plain view the panel
 * renders. Pure and React-free, so it is unit-testable in Node.
 *
 * @module dsh-cost-meter/client/overview-view
 */

import type { CostOverview, OutdatedPrice } from '../index.ts'

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

/** One outdated manual price line. */
export interface OutdatedView {
  provider: string
  model: string
  manual: string
  latest: string
  source: string
}

/** The flattened panel view. */
export interface OverviewView {
  totalCost: number
  totalCalls: number
  unpricedCalls: number
  projects: ProjectView[]
  months: { key: string; cost: number }[]
  standings: StandingView[]
  /** Manual prices an automatic source prices differently. */
  outdated: OutdatedView[]
  /** Built-in snapshot freshness. */
  snapshot: { date: string; stale: boolean }
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
    outdated: (payload?.outdated ?? []).map(toOutdatedView),
    snapshot: {
      date: payload?.snapshot?.date ?? '',
      stale: payload?.snapshot?.stale ?? false,
    },
  }
}

function toOutdatedView(price: OutdatedPrice): OutdatedView {
  return {
    provider: price.provider,
    model: price.model,
    manual: formatUsd(price.manualRate.input) + '/' + formatUsd(price.manualRate.output),
    latest: formatUsd(price.latestRate.input) + '/' + formatUsd(price.latestRate.output),
    source: price.latestSource,
  }
}
