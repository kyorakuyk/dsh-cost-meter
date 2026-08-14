/**
 * Pure cost aggregation over sessions (M2b): day / month / project buckets.
 *
 * Bucketing keys are derived from durable facts only — event timestamps for
 * day/month, the session header's working directory for project — so the
 * aggregate is reproducible from the same logs the ledger folds.
 *
 * @module dsh-cost-meter/aggregate
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { costOf } from './pricing.ts'
import type { AggregateReport, AggregateSummary, PriceResolver } from './types.ts'

/** Project bucket key for sessions without a working directory. */
export const NO_PROJECT = '(no project)'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local-timezone YYYY-MM-DD key for an epoch-ms timestamp. */
export function dayKey(time: number): string {
  const d = new Date(time)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local-timezone YYYY-MM key for an epoch-ms timestamp. */
export function monthKey(time: number): string {
  const d = new Date(time)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

function add(bucket: Record<string, AggregateSummary>, key: string, cost: number, unpriced: boolean): void {
  const entry = bucket[key] ?? (bucket[key] = { cost: 0, calls: 0, unpricedCalls: 0 })
  entry.cost += cost
  entry.calls += 1
  if (unpriced) entry.unpricedCalls += 1
}

/**
 * Aggregate priced calls across sessions into day/month/project buckets.
 * Mirrors the ledger fold: `request/header` sets attribution, `assistant/message`
 * with provider usage is the billable unit; unpriced pairs count as calls with
 * zero cost. Sessions whose headers carry no cwd bucket under {@link NO_PROJECT}.
 * @param sessions - sessions to aggregate.
 * @param resolve - layered price resolution (the service's live resolver).
 * @returns a fresh bucketed report.
 */
export function aggregateCosts(sessions: Iterable<Session>, resolve: PriceResolver): AggregateReport {
  const byDay: Record<string, AggregateSummary> = {}
  const byMonth: Record<string, AggregateSummary> = {}
  const byProject: Record<string, AggregateSummary> = {}
  let totalCost = 0
  let totalCalls = 0
  let totalUnpricedCalls = 0

  for (const session of sessions) {
    let provider: string | undefined
    let model: string | undefined
    const project = session.header.cwd ?? NO_PROJECT
    for (const event of session.events) {
      switch (event.type) {
        case 'request/header': {
          const config = event.data.header.config
          provider = config.provider
          model = config.model
          break
        }
        case 'assistant/message': {
          const usage = event.data.usage
          if (usage === undefined || provider === undefined || model === undefined) break
          const resolved = resolve(provider, model)
          const cost = resolved === undefined ? 0 : costOf(usage, resolved.rate)
          const unpriced = resolved === undefined
          const day = dayKey(event.time)
          const month = monthKey(event.time)
          totalCost += cost
          totalCalls += 1
          if (unpriced) totalUnpricedCalls += 1
          add(byDay, day, cost, unpriced)
          add(byMonth, month, cost, unpriced)
          add(byProject, project, cost, unpriced)
          break
        }
        default:
          break
      }
    }
  }

  return { totalCost, totalCalls, totalUnpricedCalls, byDay, byMonth, byProject }
}
