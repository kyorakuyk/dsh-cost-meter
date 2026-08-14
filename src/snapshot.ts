/**
 * Built-in DeepSeek pricing snapshot (M2a, source: 'snapshot').
 *
 * A static table for the official `deepseek-official` route, used only when a
 * (provider, model) pair has no manual price and the `snapshot.enabled`
 * setting is on. Prices are per one million tokens in USD.
 *
 * The table is a SNAPSHOT, not a live price: DeepSeek has no machine-readable
 * price API, so this table is version-stamped and must be re-verified against
 * the official pricing page before each plugin release. `snapshot.enabled`
 * defaults to false precisely so placeholder/stale numbers are never applied
 * silently — a user opts into the snapshot explicitly.
 *
 * @module dsh-cost-meter/snapshot
 */

import { asRateSpec } from './schedule.ts'
import type { ProviderPricing } from './types.ts'

/** When this snapshot was last verified against official pricing. */
export const SNAPSHOT_DATE = '2026-01-15'

/** Days after {@link SNAPSHOT_DATE} before the snapshot is reported stale. */
export const SNAPSHOT_STALE_AFTER_DAYS = 30

/**
 * Whether the snapshot is stale at a given instant: a snapshot older than
 * `maxAgeDays` is no longer trustworthy (M4) — the panel marks it and asks the
 * user to verify official pricing, because DeepSeek publishes no machine-
 * readable price API and rates can change on short notice.
 * @param now - epoch ms.
 * @param snapshotDate - ISO date the snapshot was verified on.
 * @param maxAgeDays - staleness threshold in days.
 * @returns true when the snapshot is older than the threshold.
 */
export function snapshotStaleAt(now: number, snapshotDate = SNAPSHOT_DATE, maxAgeDays = SNAPSHOT_STALE_AFTER_DAYS): boolean {
  const verified = Date.parse(`${snapshotDate}T00:00:00Z`)
  if (!Number.isFinite(verified)) return true
  return now - verified > maxAgeDays * 86_400_000
}

/**
 * Snapshot table keyed like the manual `pricing` table: provider route →
 * (default / models). Only the official route ships; other providers stay out.
 */
export const DEEPSEEK_SNAPSHOT: Record<string, ProviderPricing> = {
  'deepseek-official': {
    models: {
      // deepseek-v4-flash tier (input / output / cacheRead / cacheWrite).
      'deepseek-v4-flash': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
      // deepseek-v4-pro tier.
      'deepseek-v4-pro': { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
    },
  },
}

/**
 * Whether the snapshot table prices the given provider/model pair.
 * @param provider - provider route key.
 * @param model - model id.
 * @returns the snapshot rate, or undefined when the pair is not snapshotted.
 */
export function snapshotRate(provider: string, model: string): import('./types.ts').Rate | undefined {
  const spec = asRateSpec(DEEPSEEK_SNAPSHOT[provider]?.models?.[model])
  return spec?.rate
}
