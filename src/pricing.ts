/**
 * Pure pricing resolution and cost arithmetic.
 *
 * Everything here is a pure function of the configured pricing table, a usage
 * record, and (M4) the instant a call happened, so the arithmetic is
 * unit-testable without a Cordis context and past logs repricate identically
 * as long as the price history is append-only.
 *
 * @module dsh-cost-meter/pricing
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { asRateSpec, resolveSpecAt, type ScheduledRate } from './schedule.ts'
import type { ProviderPricing, Rate } from './types.ts'

/** One million tokens. */
export const TOKENS_PER_UNIT = 1_000_000

/**
 * Resolve the scheduled rate for one (provider, model) at an instant: the
 * model's own spec wins over the route default; a provider with no entry
 * resolves to undefined (unpriced). Includes the window/version context that
 * produced the rate, so callers can surface peak/off-peak and price versions.
 * @param pricing - the configured pricing table.
 * @param provider - provider route key.
 * @param model - model id.
 * @param atTime - epoch ms of the call being priced.
 * @returns the scheduled rate plus context, or undefined when the pair has no
 *   price applicable at `atTime`.
 */
export function resolveScheduled(
  pricing: Readonly<Record<string, ProviderPricing>> | undefined,
  provider: string,
  model: string,
  atTime: number,
): ScheduledRate | undefined {
  if (pricing === undefined) return undefined
  const entry = pricing[provider]
  if (entry === undefined) return undefined
  const modelSpec = asRateSpec(entry.models?.[model])
  if (modelSpec !== undefined) return resolveSpecAt(modelSpec, atTime)
  return resolveSpecAt(asRateSpec(entry.default), atTime)
}

/**
 * The rate half of {@link resolveScheduled}, for callers that ignore context.
 * @param pricing - the configured pricing table.
 * @param provider - provider route key.
 * @param model - model id.
 * @param atTime - epoch ms of the call being priced.
 * @returns the rate applicable at `atTime`, or undefined when unpriced.
 */
export function resolveRate(
  pricing: Readonly<Record<string, ProviderPricing>> | undefined,
  provider: string,
  model: string,
  atTime: number,
): Rate | undefined {
  return resolveScheduled(pricing, provider, model, atTime)?.rate
}

/**
 * USD cost of one usage record at a rate. Cache buckets default to the input
 * rate when the rate does not name them, because cache-hit and cache-write
 * pricing is the common deviation and a silent zero would undercharge.
 * @param usage - provider-reported disjoint token buckets.
 * @param rate - the resolved rate.
 * @returns cost in USD.
 */
export function costOf(usage: TokenUsage, rate: Rate): number {
  const input = usage.inputTokens / TOKENS_PER_UNIT * rate.input
  const output = usage.outputTokens / TOKENS_PER_UNIT * rate.output
  const cacheRead = (usage.cacheReadTokens ?? 0) / TOKENS_PER_UNIT * (rate.cacheRead ?? rate.input)
  const cacheWrite = (usage.cacheWriteTokens ?? 0) / TOKENS_PER_UNIT * (rate.cacheWrite ?? rate.input)
  return input + output + cacheRead + cacheWrite
}
