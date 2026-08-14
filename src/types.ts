/**
 * Public types for dsh-cost-meter.
 *
 * A rate prices one million tokens in USD. Buckets follow the disjoint
 * `TokenUsage` split of `@deepseek-ai/dsh-llm`: `inputTokens` is uncached
 * input only, cached input is reported separately as cache reads/writes.
 *
 * @module dsh-cost-meter/types
 */

/** USD price per one million tokens for one model route. */
export interface Rate {
  /** Uncached input tokens, USD per 1M. */
  input: number
  /** Output tokens, USD per 1M. */
  output: number
  /** Cache-hit input tokens, USD per 1M; defaults to {@link Rate.input} when absent. */
  cacheRead?: number
  /** Cache-write input tokens, USD per 1M; defaults to {@link Rate.input} when absent. */
  cacheWrite?: number
}

/** Pricing for one provider route: a model-level override table and a route default. */
export interface ProviderPricing {
  /** Rate applied to models of this provider without their own entry. */
  default?: Rate
  /** Per-model overrides; a model's own rate wins over the route default. */
  models?: Record<string, Rate>
}

/** Plugin configuration: per-provider pricing table. */
export interface CostMeterConfig {
  /** Provider route key → pricing. A provider with no entry is unpriced. */
  pricing?: Record<string, ProviderPricing>
  /** Automatic pricing sources (M2a). */
  autoPricing?: {
    openrouter?: OpenRouterAutoPricing
  }
  /** DeepSeek built-in snapshot behavior (M2a). */
  snapshot?: SnapshotConfig
  /** USD budget amounts per scope; a scope with no amount is not budgeted (M2b). */
  budgets?: BudgetConfig
  /** Alert thresholds and channels (M2b). */
  notify?: NotifyConfig
}

/** Per-scope budget amounts in USD; absent scope = not budgeted. */
export interface BudgetConfig {
  /** Per-session budget. */
  session?: number
  /** Per-project budget (project = session working directory). */
  project?: number
  /** Per-calendar-month budget. */
  month?: number
}

/** Alert configuration. */
export interface NotifyConfig {
  /** Percentages of the budget at which to alert, ascending (default [50, 80, 100]). */
  thresholdPct?: number[]
  /** Channels: 'event' emits cost-meter/budget-alert, 'log' writes a warning (default both). */
  channel?: string[]
}

/** Budget scope. */
export type BudgetScope = 'session' | 'project' | 'month'

/** One budget threshold crossing. */
export interface BudgetAlert {
  scope: BudgetScope
  /** Session id, project path, or YYYY-MM, depending on scope. */
  key: string
  /** Budget amount in USD. */
  amount: number
  /** Cumulative spent in USD at crossing time. */
  spent: number
  /** spent / amount × 100. */
  pct: number
  /** Which threshold crossed (e.g. 50, 80, 100). */
  thresholdPct: number
}

/** Current spending standing against configured budgets, without alert evaluation. */
export interface BudgetStanding {
  scope: BudgetScope
  key: string
  /** Budget amount when this scope is budgeted. */
  amount?: number
  spent: number
  /** spent / amount × 100 when budgeted. */
  pct?: number
}

/** Lightweight aggregate over priced calls, for overview/budget scopes. */
export interface AggregateSummary {
  cost: number
  calls: number
  unpricedCalls: number
}

/** Bucketed cost aggregate over a set of sessions. */
export interface AggregateReport {
  totalCost: number
  totalCalls: number
  totalUnpricedCalls: number
  /** YYYY-MM-DD → summary, from event timestamps. */
  byDay: Record<string, AggregateSummary>
  /** YYYY-MM → summary, from event timestamps. */
  byMonth: Record<string, AggregateSummary>
  /** Session working directory → summary; '(no project)' for cwd-less sessions. */
  byProject: Record<string, AggregateSummary>
}

/** OpenRouter auto-fetch configuration. */
export interface OpenRouterAutoPricing {
  /** Fetch https://openrouter.ai/api/v1/models and cache prices (default false). */
  enabled?: boolean
  /** Cache freshness window in hours; a stale cache is refreshed lazily (default 24). */
  refreshHours?: number
  /** true = fetched prices override manual prices for the openrouter route (default false). */
  overwrite?: boolean
  /** Cache file path override; defaults to $DSH_HOME/costs/pricing.openrouter.json. */
  cachePath?: string
}

/** DeepSeek built-in snapshot behavior. */
export interface SnapshotConfig {
  /** Use the built-in snapshot for deepseek-official models with no manual price (default false). */
  enabled?: boolean
  /** true = snapshot wins over manual prices for deepseek-official (debugging; default false). */
  preferSnapshots?: boolean
}

/** Where a price came from; surfaces in reports so "authoritative" is distinguishable from "auto". */
export type PriceSource = 'manual' | 'openrouter' | 'snapshot'

/** A resolved rate plus its provenance. */
export interface ResolvedPrice {
  rate: Rate
  source: PriceSource
}

/** Layered price resolution: manual → openrouter → snapshot, in caller-chosen precedence. */
export type PriceResolver = (provider: string, model: string) => ResolvedPrice | undefined

/** Disjoint token buckets accumulated for one (provider, model) pair. */
export interface EntryUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Accumulated cost for one (provider, model) pair in a session. */
export interface CostEntry {
  /** Provider route the calls were attributed to (from the latest request header). */
  provider: string
  /** Model id the calls were attributed to. */
  model: string
  /** Number of assistant messages carrying provider usage for this pair. */
  calls: number
  /** Summed disjoint token buckets. */
  usage: EntryUsage
  /** USD total for this entry; 0 when the pair has no rate. */
  cost: number
  /** false when no rate matched, so a caller can show "unpriced" distinctly from "free". */
  priced: boolean
  /** Provenance of the rate that priced this entry, when priced. */
  priceSource?: PriceSource
}

/** A (provider, model) pair that produced usage but has no configured rate. */
export interface UnpricedEntry {
  provider: string
  model: string
  /** Assistant messages with usage for this pair that could not be priced. */
  calls: number
}

/** Detached snapshot of one session's cost ledger. */
export interface CostReport {
  /** USD total over every priced entry. */
  totalCost: number
  /** Per-(provider, model) entries with usage, in stable provider/model order. */
  entries: CostEntry[]
  /** Calls that hit no configured rate, in stable provider/model order. */
  unpriced: UnpricedEntry[]
}
