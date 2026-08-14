/**
 * Pure pricing resolution and cost arithmetic.
 *
 * Everything here is a pure function of the configured pricing table and a
 * usage record, so the arithmetic is unit-testable without a Cordis context.
 *
 * @module dsh-cost-meter/pricing
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ProviderPricing, Rate } from './types.ts'

/** One million tokens. */
export const TOKENS_PER_UNIT = 1_000_000

/**
 * Resolve the rate for one (provider, model): the model's own entry wins over
 * the route default; a provider with no entry resolves to undefined (unpriced).
 * @param pricing - the configured pricing table.
 * @param provider - provider route key.
 * @param model - model id.
 * @returns the rate, or undefined when the pair has no configured price.
 */
export function resolveRate(
  pricing: Readonly<Record<string, ProviderPricing>> | undefined,
  provider: string,
  model: string,
): Rate | undefined {
  if (pricing === undefined) return undefined
  const entry = pricing[provider]
  if (entry === undefined) return undefined
  const modelRate = entry.models?.[model]
  if (modelRate !== undefined) return modelRate
  return entry.default
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
