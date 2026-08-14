/**
 * Layered price resolution (M2a): manual → openrouter → snapshot.
 *
 * Precedence, highest first:
 *   1. openrouter `overwrite` — fetched prices beat manual prices (opt-in);
 *   2. snapshot `preferSnapshots` — built-in table beats manual prices (debug);
 *   3. manual `pricing` — authoritative (default);
 *   4. openrouter fetched — auto, timestamped;
 *   5. snapshot table — auto, version-stamped;
 *   6. undefined — reported as unpriced, never guessed.
 *
 * Every source resolves at the call's instant (`atTime`), so M4 price
 * versions and peak/off-peak windows apply uniformly across sources.
 *
 * **Outdated-price detection (M4.1)**: when a MANUAL price wins but an
 * automatic source prices the same pair differently, the resolved price is
 * flagged `outdated` with the newer rate — the manual price may be stale, and
 * surfaces (panel, CLI audit) turn that into a visible warning instead of a
 * silent mis-statement. OpenRouter fetch always counts (it is live); the
 * built-in snapshot counts only when it is not flagged stale, so a stale
 * snapshot cannot cry wolf.
 *
 * @module dsh-cost-meter/resolver
 */

import { resolveScheduled, sameRate } from './pricing.ts'
import type { PriceResolver, PriceSource, ProviderPricing, Rate, ResolvedPrice } from './types.ts'

/** OpenRouter source the resolver consults (the feed's lookup). */
export interface OpenRouterResolverSource {
  enabled: boolean
  overwrite: boolean
  lookup(model: string): Rate | undefined
}

/** Snapshot source the resolver consults (the built-in table). */
export interface SnapshotResolverSource {
  enabled: boolean
  preferSnapshots: boolean
  table: Record<string, ProviderPricing>
  /** When true, the snapshot is stale and does not participate in outdated detection. */
  stale?: boolean
}

export interface PriceResolverOptions {
  manual?: Record<string, ProviderPricing>
  openrouter?: OpenRouterResolverSource
  snapshot?: SnapshotResolverSource
}

/** Build the layered resolver over the given sources. */
export function createPriceResolver(options: PriceResolverOptions): PriceResolver {
  return (provider: string, model: string, atTime: number): ResolvedPrice | undefined => {
    const manual = resolveScheduled(options.manual, provider, model, atTime)
    const fetched = options.openrouter?.enabled === true && provider === 'openrouter'
      ? options.openrouter.lookup(model)
      : undefined
    // The snapshot PRICES whenever enabled (stale or not — the stale flag is a
    // freshness warning, not a ban); it only participates in outdated
    // DETECTION while current, so a stale table cannot cry wolf.
    const snapshot = options.snapshot?.enabled === true
      ? resolveScheduled(options.snapshot.table, provider, model, atTime)
      : undefined
    const snapshotCurrent = options.snapshot?.stale !== true ? snapshot : undefined

    if (options.openrouter?.overwrite === true && fetched !== undefined) return priced(fetched, 'openrouter')
    if (options.snapshot?.preferSnapshots === true && snapshot !== undefined) return priced(snapshot.rate, 'snapshot', snapshot)
    if (manual !== undefined) {
      const outdated = detectOutdated(manual.rate, provider, fetched, snapshotCurrent)
      return {
        rate: manual.rate,
        source: 'manual',
        ...(manual.window === undefined ? {} : { window: manual.window }),
        ...(manual.versionFrom === undefined ? {} : { versionFrom: manual.versionFrom }),
        ...outdated,
      }
    }
    if (fetched !== undefined) return priced(fetched, 'openrouter')
    if (snapshot !== undefined) return priced(snapshot.rate, 'snapshot', snapshot)
    return undefined
  }
}

/**
 * Compare an applied manual rate against automatic sources and return the
 * outdated context (or nothing when the manual price still matches the latest
 * known price).
 */
function detectOutdated(
  manualRate: Rate,
  provider: string,
  fetched: Rate | undefined,
  snapshot: { rate: Rate } | undefined,
): { outdated: true; latestRate: Rate; latestSource: 'openrouter' | 'snapshot' } | Record<string, never> {
  if (provider === 'openrouter' && fetched !== undefined && !sameRate(manualRate, fetched)) {
    return { outdated: true, latestRate: fetched, latestSource: 'openrouter' }
  }
  if (snapshot !== undefined && !sameRate(manualRate, snapshot.rate)) {
    return { outdated: true, latestRate: snapshot.rate, latestSource: 'snapshot' }
  }
  return {}
}

function priced(rate: Rate, source: PriceSource, context?: { window?: string; versionFrom?: number }): ResolvedPrice {
  return {
    rate,
    source,
    ...(context?.window === undefined ? {} : { window: context.window }),
    ...(context?.versionFrom === undefined ? {} : { versionFrom: context.versionFrom }),
  }
}
