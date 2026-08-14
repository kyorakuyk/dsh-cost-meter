/**
 * Session-log replay into a cost ledger.
 *
 * The ledger is a pure fold over the durable session log: `request/header`
 * events set the attribution (provider/model) for the calls that follow, and
 * `assistant/message` events carrying provider `usage` are priced against the
 * resolved rate. Nothing here touches the network or the service layer, so the
 * fold is fully unit-testable and the ledger is reconstructable from the log
 * alone — the audit property the design requires.
 *
 * @module dsh-cost-meter/ledger
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { costOf } from './pricing.ts'
import type { CostEntry, CostReport, EntryUsage, PriceResolver, UnpricedEntry } from './types.ts'

/** Mutable fold state for one session. */
export interface LedgerState {
  /** Events already folded; replay resumes from here on the next sync. */
  consumedEvents: number
  /** Attribution from the latest `request/header`, undefined before the first. */
  provider: string | undefined
  model: string | undefined
  /** (provider, model) → accumulated entry. */
  entries: Map<string, CostEntry>
  /** (provider, model) → unpriced calls. */
  unpriced: Map<string, UnpricedEntry>
  /** USD total over every priced call. */
  totalCost: number
}

const KEY_SEPARATOR = '\u0000'

function key(provider: string, model: string): string {
  return `${provider}${KEY_SEPARATOR}${model}`
}

/** Fresh empty fold state. */
export function createLedgerState(): LedgerState {
  return {
    consumedEvents: 0,
    provider: undefined,
    model: undefined,
    entries: new Map(),
    unpriced: new Map(),
    totalCost: 0,
  }
}

/**
 * Fold one session event into the ledger.
 * @param state - ledger state to mutate.
 * @param event - the next durable event.
 * @param resolve - layered price resolution consulted per priced call, so a
 *   hot-reloaded table or a refreshed feed reaches the next fold without restart.
 */
export function foldEvent(
  state: LedgerState,
  event: SessionEvent,
  resolve: PriceResolver,
): void {
  switch (event.type) {
    case 'request/header': {
      const config = event.data.header.config
      state.provider = config.provider
      state.model = config.model
      break
    }
    case 'assistant/message': {
      const usage = event.data.usage
      if (usage === undefined) break
      const provider = state.provider
      const model = state.model
      // Usage before any request header is not attributable to a route; the
      // session log never produces it (headers precede steps), but a replay of
      // a malformed log must not invent an attribution.
      if (provider === undefined || model === undefined) break
      foldUsage(state, provider, model, usage, resolve)
      break
    }
    default:
      break
  }
}

/** Price one usage record into the matching entry, or record it as unpriced. */
function foldUsage(
  state: LedgerState,
  provider: string,
  model: string,
  usage: TokenUsage,
  resolve: PriceResolver,
): void {
  const k = key(provider, model)
  let entry = state.entries.get(k)
  if (entry === undefined) {
    entry = {
      provider,
      model,
      calls: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: 0,
      priced: false,
    }
    state.entries.set(k, entry)
  }
  entry.calls += 1
  entry.usage.inputTokens += usage.inputTokens
  entry.usage.outputTokens += usage.outputTokens
  entry.usage.cacheReadTokens += usage.cacheReadTokens ?? 0
  entry.usage.cacheWriteTokens += usage.cacheWriteTokens ?? 0

  const resolved = resolve(provider, model)
  if (resolved !== undefined) {
    entry.cost += costOf(usage, resolved.rate)
    entry.priced = true
    entry.priceSource = resolved.source
    state.totalCost += costOf(usage, resolved.rate)
    return
  }
  let unpriced = state.unpriced.get(k)
  if (unpriced === undefined) {
    unpriced = { provider, model, calls: 0 }
    state.unpriced.set(k, unpriced)
  }
  unpriced.calls += 1
}

/** Stable ordering for report output: provider, then model. */
function byProviderModel(a: { provider: string; model: string }, b: { provider: string; model: string }): number {
  return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0
}

/** Clone an entry so the report is detached from the live fold state. */
function cloneEntry(entry: CostEntry): CostEntry {
  return {
    provider: entry.provider,
    model: entry.model,
    calls: entry.calls,
    usage: { ...entry.usage },
    cost: entry.cost,
    priced: entry.priced,
    ...(entry.priceSource === undefined ? {} : { priceSource: entry.priceSource }),
  }
}

/**
 * Assert the fold invariant: the running total equals the sum of priced entry
 * costs. Called by {@link toReport} so a fold bug fails loud at read time.
 * @param state - ledger state to verify.
 * @throws Error naming the mismatch.
 */
export function assertLedgerConsistent(state: LedgerState): void {
  let sum = 0
  for (const entry of state.entries.values()) {
    if (entry.priced) sum += entry.cost
  }
  if (Math.abs(sum - state.totalCost) > 1e-9) {
    throw new Error(
      `dsh-cost-meter: ledger invariant violated — priced entry costs sum to ${sum}, totalCost is ${state.totalCost}`,
    )
  }
}

/**
 * Detached immutable-by-convention report over the current fold state.
 * @param state - ledger state.
 * @returns a fresh snapshot with stable ordering.
 */
export function toReport(state: LedgerState): CostReport {
  assertLedgerConsistent(state)
  const entries = [...state.entries.values()].sort(byProviderModel).map(cloneEntry)
  const unpriced = [...state.unpriced.values()].sort(byProviderModel).map((u) => ({ ...u }))
  return { totalCost: state.totalCost, entries, unpriced }
}
