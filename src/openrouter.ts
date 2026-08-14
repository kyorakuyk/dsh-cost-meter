/**
 * OpenRouter price feed (M2a, source: 'openrouter').
 *
 * Fetches the free public model listing (`GET https://openrouter.ai/api/v1/models`),
 * maps each model's `pricing` object (USD per 1M tokens, string-typed) into a
 * {@link Rate}, and caches the result. Reads are synchronous from memory (the
 * fold is a pure sync replay); refresh is asynchronous and lazy — a stale
 * cache triggers a background refresh while serving the old prices, and a
 * failed refresh keeps the old cache (never fails the fold, never guesses).
 *
 * The fetch implementation, clock, and persistence are injectable so unit
 * tests run keyless and offline.
 *
 * @module dsh-cost-meter/openrouter
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Rate } from './types.ts'

/** The public, keyless OpenRouter model listing. */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

/** Cache artifact written under the DSH home costs directory. */
export const DEFAULT_CACHE_FILE = 'pricing.openrouter.json'

/** Minimal fetch surface so tests can fake it without constructing a Response. */
export interface FetchLike {
  (url: string): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>
}

/** Durable cache artifact. */
export interface OpenRouterCache {
  /** Epoch ms the cache was fetched. */
  fetchedAt: number
  source: 'openrouter'
  /** Model id → rate, in the listing order. */
  models: Record<string, Rate>
}

export interface OpenRouterPriceFeedOptions {
  /** Cache file path; undefined = memory-only (tests). */
  cachePath?: string
  /** Cache freshness window in hours. */
  refreshHours: number
  /** Injectable fetch; defaults to the global fetch. */
  fetchImpl?: FetchLike
  /** Injectable clock; defaults to Date.now. */
  now?: () => number
  /** Error sink; defaults to console.warn. */
  onError?: (error: unknown) => void
  /** Pre-seeded cache for tests. */
  initialCache?: OpenRouterCache
}

/**
 * Parse the OpenRouter listing payload into a model-id → rate map. Prices are
 * strings; entries without finite input/output are skipped.
 * @param payload - the JSON body of GET /api/v1/models.
 * @returns model rates, stable by listing order.
 */
export function parseOpenRouterListing(payload: unknown): Record<string, Rate> {
  const result: Record<string, Rate> = {}
  const data = (payload as { data?: unknown })?.data
  if (!Array.isArray(data)) return result
  for (const entry of data) {
    const model = (entry as { id?: unknown })?.id
    const pricing = (entry as { pricing?: unknown })?.pricing
    if (typeof model !== 'string' || model.length === 0 || typeof pricing !== 'object' || pricing === null) continue
    const p = pricing as Record<string, unknown>
    const input = Number.parseFloat(String(p.prompt))
    const output = Number.parseFloat(String(p.completion))
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue
    result[model] = {
      input,
      output,
      ...readOptionalRate(p.input_cache_read, 'cacheRead'),
      ...readOptionalRate(p.input_cache_write, 'cacheWrite'),
    }
  }
  return result
}

/** Build a single optional rate field only from finite present values. */
function readOptionalRate(
  value: unknown,
  field: 'cacheRead' | 'cacheWrite',
): Partial<Rate> | Record<string, never> {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? { [field]: parsed } : {}
}

/** Validate a loaded cache artifact; undefined means absent or unusable. */
function validateCache(value: unknown): OpenRouterCache | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Partial<OpenRouterCache>
  if (v.source !== 'openrouter' || typeof v.fetchedAt !== 'number' || !Number.isFinite(v.fetchedAt)) return undefined
  if (typeof v.models !== 'object' || v.models === null) return undefined
  return { fetchedAt: v.fetchedAt, source: 'openrouter', models: { ...v.models } }
}

/** One in-memory feed with lazy async refresh. */
export class OpenRouterPriceFeed {
  private cache: OpenRouterCache | undefined
  private refreshing: Promise<OpenRouterCache | undefined> | undefined
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly onError: (error: unknown) => void

  constructor(private readonly options: OpenRouterPriceFeedOptions) {
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike)
    this.now = options.now ?? (() => Date.now())
    this.onError = options.onError ?? ((error) => console.warn('[dsh-cost-meter] openrouter refresh failed:', error))
    this.cache = options.initialCache ?? this.load()
  }

  /** The current rate for one model, or undefined when absent/stale-with-no-cache. */
  lookup(model: string): Rate | undefined {
    if (this.cache !== undefined && this.isStale()) void this.refresh()
    return this.cache?.models[model]
  }

  /** Whether the cache is older than the configured freshness window. */
  isStale(): boolean {
    if (this.cache === undefined) return true
    return this.now() - this.cache.fetchedAt > this.options.refreshHours * 3_600_000
  }

  /**
   * Fetch and replace the cache. Concurrent calls share one in-flight refresh;
   * a failure keeps the previous cache and reports through the error sink.
   * @returns the refreshed cache, or undefined on failure.
   */
  async refresh(): Promise<OpenRouterCache | undefined> {
    if (this.refreshing !== undefined) return this.refreshing
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async doRefresh(): Promise<OpenRouterCache | undefined> {
    try {
      const response = await this.fetchImpl(OPENROUTER_MODELS_URL)
      if (!response.ok) throw new Error(`openrouter listing returned HTTP ${response.status}`)
      const models = parseOpenRouterListing(await response.json())
      const cache: OpenRouterCache = { fetchedAt: this.now(), source: 'openrouter', models }
      if (this.options.cachePath !== undefined) this.write(cache)
      this.cache = cache
      return cache
    } catch (error) {
      this.onError(error)
      return undefined
    }
  }

  /** Synchronous best-effort load from the configured cache file. */
  private load(): OpenRouterCache | undefined {
    if (this.options.cachePath === undefined) return undefined
    try {
      const raw = readFileSync(this.options.cachePath, 'utf8')
      return validateCache(JSON.parse(raw))
    } catch {
      return undefined // absent or corrupt: treated as no cache; next refresh rebuilds it
    }
  }

  private write(cache: OpenRouterCache): void {
    if (this.options.cachePath === undefined) return
    mkdirSync(dirname(this.options.cachePath), { recursive: true })
    writeFileSync(this.options.cachePath, JSON.stringify(cache, null, 2), 'utf8')
  }
}
