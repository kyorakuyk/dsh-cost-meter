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
 * @module dsh-cost-meter/resolver
 */

import { resolveScheduled } from './pricing.ts'
import type { PriceResolver, ProviderPricing, Rate, ResolvedPrice } from './types.ts'

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
    const snapshot = options.snapshot?.enabled === true
      ? resolveScheduled(options.snapshot.table, provider, model, atTime)
      : undefined

    if (options.openrouter?.overwrite === true && fetched !== undefined) return priced(fetched, 'openrouter')
    if (options.snapshot?.preferSnapshots === true && snapshot !== undefined) return priced(snapshot.rate, 'snapshot', snapshot)
    if (manual !== undefined) return priced(manual.rate, 'manual', manual)
    if (fetched !== undefined) return priced(fetched, 'openrouter')
    if (snapshot !== undefined) return priced(snapshot.rate, 'snapshot', snapshot)
    return undefined
  }
}

function priced(rate: Rate, source: ResolvedPrice['source'], context?: { window?: string; versionFrom?: number }): ResolvedPrice {
  return {
    rate,
    source,
    ...(context?.window === undefined ? {} : { window: context.window }),
    ...(context?.versionFrom === undefined ? {} : { versionFrom: context.versionFrom }),
  }
}
