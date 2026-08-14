/**
 * Pure export serialization (M3): cost reports → CSV / JSONL rows.
 *
 * Everything here is a pure function of a {@link CostReport} (or aggregate
 * rows), so exports are unit-testable and share the audit property of the
 * ledger: the exported numbers derive from the same durable fold.
 *
 * @module dsh-cost-meter/export
 */

import type { CostReport, AggregateReport, AggregateSummary } from './types.ts'

/** One exported cost line, flattened for tabular output. */
export interface ExportRow {
  scope: 'session' | 'project' | 'month' | 'day'
  key: string
  provider: string
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  priced: boolean
  priceSource?: string
}

const CSV_HEADER = [
  'scope',
  'key',
  'provider',
  'model',
  'calls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'cost',
  'priced',
  'priceSource',
]

/** Quote a CSV field: wrap in quotes when it contains a delimiter, quote, or newline. */
export function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** Rows for one session's report, one row per (provider, model) entry. */
export function sessionRows(sessionKey: string, report: CostReport): ExportRow[] {
  return report.entries.map((entry) => ({
    scope: 'session' as const,
    key: sessionKey,
    provider: entry.provider,
    model: entry.model,
    calls: entry.calls,
    inputTokens: entry.usage.inputTokens,
    outputTokens: entry.usage.outputTokens,
    cacheReadTokens: entry.usage.cacheReadTokens,
    cacheWriteTokens: entry.usage.cacheWriteTokens,
    cost: entry.cost,
    priced: entry.priced,
    priceSource: entry.priceSource,
  }))
}

/** Rows for one aggregate bucket map (e.g. byProject), one row per bucket. */
export function bucketRows(
  scope: 'project' | 'month' | 'day',
  buckets: Record<string, AggregateSummary>,
): ExportRow[] {
  return Object.entries(buckets).map(([key, summary]) => ({
    scope,
    key,
    provider: '',
    model: '',
    calls: summary.calls,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: summary.cost,
    priced: summary.unpricedCalls === 0,
    priceSource: undefined,
  }))
}

/** One aggregate report → one row per project, month, and day bucket. */
export function aggregateRows(report: AggregateReport): ExportRow[] {
  return [
    ...bucketRows('project', report.byProject),
    ...bucketRows('month', report.byMonth),
    ...bucketRows('day', report.byDay),
  ]
}

/** CSV serialization with a header row. */
export function toCsv(rows: readonly ExportRow[]): string {
  const lines = [CSV_HEADER.map((h) => csvField(h)).join(',')]
  for (const row of rows) {
    lines.push([
      row.scope,
      csvField(row.key),
      csvField(row.provider),
      csvField(row.model),
      String(row.calls),
      String(row.inputTokens),
      String(row.outputTokens),
      String(row.cacheReadTokens),
      String(row.cacheWriteTokens),
      String(row.cost),
      String(row.priced),
      row.priceSource === undefined ? '' : row.priceSource,
    ].join(','))
  }
  return `${lines.join('\n')}\n`
}

/** JSONL serialization, one JSON object per line. */
export function toJsonl(rows: readonly ExportRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length === 0 ? '' : '\n')
}
