/**
 * dsh-cost-meter — per-session model cost accounting.
 *
 * Registers the singleton `ctx.costMeter` service and the `cost-meter`
 * settings namespace. The service replays each session's durable log (eagerly
 * on `session/event`, lazily on read) and prices every `assistant/message`
 * that carries provider `usage` through a layered resolver — manual `pricing`
 * (authoritative) → OpenRouter auto-fetch → DeepSeek built-in snapshot —
 * exposing a per-(provider, model) cost breakdown per session with the price
 * provenance on every entry.
 *
 * An unlisted pair is reported as `unpriced` rather than guessed; automatic
 * sources are opt-in and version/timestamp-stamped.
 *
 * @module dsh-cost-meter
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls the webServer Context declaration for the overview route.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createLedgerState, foldEvent, toReport, type LedgerState } from './ledger.ts'
import { aggregateCosts } from './aggregate.ts'
import { evaluateBudgets, normalizeThresholds } from './budget.ts'
import { OVERVIEW_ROUTE } from './constants.ts'
import { asRateSpec, validateSpec } from './schedule.ts'
import { OpenRouterPriceFeed, DEFAULT_CACHE_FILE } from './openrouter.ts'
import { createPriceResolver } from './resolver.ts'
import { DEEPSEEK_SNAPSHOT, SNAPSHOT_DATE, SNAPSHOT_STALE_AFTER_DAYS, snapshotStaleAt } from './snapshot.ts'
import type {
  AggregateReport,
  BudgetAlert,
  BudgetConfig,
  BudgetScope,
  BudgetStanding,
  CostMeterConfig,
  CostReport,
  NotifyConfig,
  OpenRouterAutoPricing,
  PriceResolver,
  ProviderPricing,
  Rate,
  RateSpec,
  ResolvedPrice,
  SnapshotConfig,
} from './types.ts'

export type {
  AggregateReport,
  AggregateSummary,
  BudgetAlert,
  BudgetConfig,
  BudgetScope,
  BudgetStanding,
  CostEntry,
  CostMeterConfig,
  CostReport,
  EntryUsage,
  NotifyConfig,
  OpenRouterAutoPricing,
  PriceResolver,
  PriceSource,
  ProviderPricing,
  Rate,
  ResolvedPrice,
  SnapshotConfig,
  UnpricedEntry,
} from './types.ts'
export { costOf, resolveRate, resolveScheduled, TOKENS_PER_UNIT } from './pricing.ts'
export { assertLedgerConsistent, createLedgerState, foldEvent, toReport } from './ledger.ts'
export type { LedgerState } from './ledger.ts'
export { aggregateCosts, dayKey, monthKey, NO_PROJECT } from './aggregate.ts'
export { crossingId, evaluateBudgets, normalizeThresholds } from './budget.ts'
export {
  asRateSpec,
  applicableVersion,
  DEFAULT_TZ,
  inWindow,
  isFlatRate,
  localHHMM,
  matchWindow,
  resolveSpecAt,
  validateSpec,
  validateWindow,
} from './schedule.ts'
export type { ScheduledRate } from './schedule.ts'
export { aggregateRows, bucketRows, csvField, sessionRows, toCsv, toJsonl } from './export.ts'
export type { ExportRow } from './export.ts'
export { createPriceResolver } from './resolver.ts'
export { OpenRouterPriceFeed, parseOpenRouterListing } from './openrouter.ts'
export {
  DEEPSEEK_SNAPSHOT,
  SNAPSHOT_DATE,
  SNAPSHOT_STALE_AFTER_DAYS,
  snapshotStaleAt,
  snapshotRate,
} from './snapshot.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    costMeter: CostMeter
  }

  interface Events {
    /**
     * Emitted once per (scope, key, threshold) budget crossing; listeners
     * (dsh-notification, a future Web panel) surface it without re-evaluating.
     */
    'cost-meter/budget-alert'(alert: BudgetAlert): void

    /**
     * Emitted when an automatic price source changed the effective prices:
     * an OpenRouter refresh that produced a different table, or a settings
     * commit that changed the pricing configuration.
     */
    'cost-meter/price-changed'(change: PriceChange): void
  }
}

/** What changed and why, for `cost-meter/price-changed`. */
export interface PriceChange {
  reason: 'openrouter-refresh' | 'settings'
  /** Provider route affected; 'openrouter' for refreshes, absent for settings-wide changes. */
  provider?: string
}

/** The settings namespace owning the pricing table. */
export const NAMESPACE = settingsNamespace('cost-meter')

export { OVERVIEW_ROUTE } from './constants.ts'

/** Snapshot the Web panel renders: aggregate plus budget standings. */
export interface CostOverview {
  aggregate: AggregateReport
  standings: BudgetStanding[]
  /** Built-in snapshot freshness (M4). */
  snapshot: { date: string; stale: boolean; staleAfterDays: number }
}

const RateSchema = z.object({
  input: z.number().min(0).required(),
  output: z.number().min(0).required(),
  cacheRead: z.number().min(0),
  cacheWrite: z.number().min(0),
})

const RateWindowSchema = z.object({
  from: z.string().required(),
  to: z.string().required(),
  tz: z.string(),
  label: z.string(),
  rate: RateSchema,
})

const RateVersionSchema = z.object({
  effectiveFrom: z.number().min(0).required(),
  effectiveUntil: z.number().min(0),
  rate: RateSchema,
  windows: z.array(RateWindowSchema),
})

const RateSpecSchema = z.object({
  rate: RateSchema,
  windows: z.array(RateWindowSchema),
  history: z.array(RateVersionSchema),
})

const RateLikeSchema = z.union([RateSchema, RateSpecSchema])

const ProviderPricingSchema = z.object({
  default: RateLikeSchema,
  models: z.dict(RateLikeSchema),
})

const OpenRouterAutoPricingSchema = z.object({
  enabled: z.boolean().default(false),
  refreshHours: z.number().min(0.001).default(24),
  overwrite: z.boolean().default(false),
  cachePath: z.string(),
})

const SnapshotConfigSchema = z.object({
  enabled: z.boolean().default(false),
  preferSnapshots: z.boolean().default(false),
})

const BudgetConfigSchema = z.object({
  session: z.number().min(0),
  project: z.number().min(0),
  month: z.number().min(0),
})

const NotifyConfigSchema = z.object({
  thresholdPct: z.array(z.number().min(0).max(100)).default([50, 80, 100]),
  channel: z.array(z.string()).default(['event', 'log']),
})

/** Plugin configuration schema; doubles as the `cost-meter` settings section shape. */
export const Config: z<CostMeterConfig> = z.object({
  pricing: z.dict(ProviderPricingSchema).default({}),
  autoPricing: z.object({ openrouter: OpenRouterAutoPricingSchema }),
  snapshot: SnapshotConfigSchema,
  budgets: BudgetConfigSchema,
  notify: NotifyConfigSchema,
}) as unknown as z<CostMeterConfig>

/** Top-level keys the plugin configuration accepts. */
const CONFIG_KEYS = new Set(['pricing', 'autoPricing', 'snapshot', 'budgets', 'notify'])

/** Fully defaulted internal configuration. */
interface NormalizedConfig {
  pricing: Record<string, ProviderPricing>
  openrouter: { enabled: boolean; refreshHours: number; overwrite: boolean; cachePath: string }
  snapshot: { enabled: boolean; preferSnapshots: boolean }
  budgets: BudgetConfig
  notify: { thresholdPct: number[]; channel: string[] }
}

/** Apply the same defaults the schema materializes, so raw constructor configs behave identically. */
function normalizeConfig(config: CostMeterConfig): NormalizedConfig {
  return {
    pricing: config.pricing ?? {},
    openrouter: {
      enabled: config.autoPricing?.openrouter?.enabled ?? false,
      refreshHours: config.autoPricing?.openrouter?.refreshHours ?? 24,
      overwrite: config.autoPricing?.openrouter?.overwrite ?? false,
      cachePath: config.autoPricing?.openrouter?.cachePath ?? defaultCachePath(),
    },
    snapshot: {
      enabled: config.snapshot?.enabled ?? false,
      preferSnapshots: config.snapshot?.preferSnapshots ?? false,
    },
    budgets: {
      session: config.budgets?.session,
      project: config.budgets?.project,
      month: config.budgets?.month,
    },
    notify: {
      thresholdPct: normalizeThresholds(config.notify?.thresholdPct),
      channel: config.notify?.channel?.length === 0 ? ['event', 'log'] : (config.notify?.channel ?? ['event', 'log']),
    },
  }
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateConfigKeys(config: CostMeterConfig): void {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`CostMeterConfig: unknown key "${key}"`)
  }
}

/** Reject non-finite rates and malformed schedules that a hand-written settings.yaml could smuggle past the schema. */
function validateRatesFinite(pricing: Record<string, ProviderPricing> | undefined): void {
  if (pricing === undefined) return
  for (const [provider, entry] of Object.entries(pricing)) {
    const specs: ReadonlyArray<readonly [string, Rate | RateSpec | undefined]> = [
      ['default', entry.default],
      ...Object.entries(entry.models ?? {}).map(([model, r]) => [`models.${model}`, r] as const),
    ]
    for (const [label, rateLike] of specs) {
      const spec = asRateSpec(rateLike)
      if (spec === undefined) continue
      validateSpec(`${provider}.${label}`, spec)
      const rates: ReadonlyArray<readonly [string, Rate | undefined]> = [
        ['rate', spec.rate],
        ...(spec.windows ?? []).map((w): readonly [string, Rate] => [`windows.${w.from}-${w.to}`, w.rate]),
        ...(spec.history ?? []).flatMap((v): ReadonlyArray<readonly [string, Rate | undefined]> => [
          [`history@${v.effectiveFrom}.rate`, v.rate],
          ...(v.windows ?? []).map((w): readonly [string, Rate] => [`history@${v.effectiveFrom}.windows.${w.from}-${w.to}`, w.rate]),
        ]),
      ]
      for (const [field, rate] of rates) {
        if (rate === undefined) continue
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
          const value = rate[key]
          if (value !== undefined && !Number.isFinite(value)) {
            throw new Error(`CostMeterConfig: ${provider}.${label}.${field}.${key} must be finite`)
          }
        }
      }
    }
  }
}

/** Reject unserviceable auto-pricing/snapshot settings. */
function validateAutoPricing(normalized: NormalizedConfig): void {
  if (!Number.isFinite(normalized.openrouter.refreshHours) || normalized.openrouter.refreshHours <= 0) {
    throw new Error('CostMeterConfig: autoPricing.openrouter.refreshHours must be a positive finite number')
  }
  if (normalized.openrouter.cachePath.length === 0) {
    throw new Error('CostMeterConfig: autoPricing.openrouter.cachePath must be a non-empty string')
  }
}

/** Reject non-finite budget amounts. */
function validateBudgets(budgets: BudgetConfig): void {
  for (const scope of ['session', 'project', 'month'] as const) {
    const amount = budgets[scope]
    if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) {
      throw new Error(`CostMeterConfig: budgets.${scope} must be a non-negative finite number`)
    }
  }
}

/** Default cache location: $DSH_HOME/costs/pricing.openrouter.json, else ~/.dsh/…. */
export function defaultCachePath(): string {
  const home = (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, 'costs', DEFAULT_CACHE_FILE)
}

/** Replay owner: one ledger per observed session, priced through the live layered resolver. */
export class CostMeter extends Service {
  static Config = Config

  private readonly states = new WeakMap<Session, LedgerState>()
  /** Sessions cost-meter has priced; the aggregation/budget universe. */
  private readonly tracked = new Set<Session>()
  /** Fired (scope, key, threshold) crossings; idempotency across evaluations. */
  private readonly notified = new Set<string>()
  private resolver!: PriceResolver
  private feed: OpenRouterPriceFeed | undefined
  private budgets: BudgetConfig = {}
  private thresholds: number[] = [50, 80, 100]
  private channels: string[] = ['event', 'log']
  /** Last committed pricing JSON, for settings-change detection. */
  private lastPricingJson: string | undefined

  constructor(ctx: Context, config: CostMeterConfig = {}) {
    super(ctx, 'costMeter')
    validateConfigKeys(config)
    const initial = normalizeConfig(config)
    validateRatesFinite(initial.pricing)
    validateAutoPricing(initial)
    validateBudgets(initial.budgets)
    this.applyRuntime(initial)
    this.rebuild(initial)
    this.lastPricingJson = JSON.stringify(initial.pricing)

    // The active source is a thunk: the resolved settings scope while one is
    // attached, the composition entry otherwise (SettingsSectionHooks contract).
    let current: () => CostMeterConfig = () => config
    installSettingsSection(ctx, NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {
        try {
          const normalized = normalizeConfig(current())
          validateRatesFinite(normalized.pricing)
          validateAutoPricing(normalized)
          validateBudgets(normalized.budgets)
          const pricingJson = JSON.stringify(normalized.pricing)
          const changed = pricingJson !== this.lastPricingJson
          this.applyRuntime(normalized)
          this.rebuild(normalized)
          this.lastPricingJson = pricingJson
          if (changed) this.ctx.emit('cost-meter/price-changed', { reason: 'settings' })
        } catch (error) {
          // Keep the last good runtime; a bad settings commit must not strand pricing.
          this.ctx.logger.error('dsh-cost-meter: keeping the last good configuration after an invalid settings section')
          this.ctx.logger.error(error)
        }
      },
      validate: (value) => {
        const normalized = normalizeConfig(value)
        validateRatesFinite(normalized.pricing)
        validateAutoPricing(normalized)
        validateBudgets(normalized.budgets)
      },
    })
    this.installOverviewRoute(ctx)
    this.observeSessions()
  }

  /**
   * Serve the Web panel's data through the GUI's own web server. The route is
   * registered only when a `webServer` service is present (i.e. inside the Web
   * profile), and removed with this plugin's fiber.
   */
  private installOverviewRoute(ctx: Context): void {
    ctx.inject(['webServer'], (wctx) => {
      const dispose = wctx.webServer.register({
        kind: 'exact',
        path: OVERVIEW_ROUTE,
        handler: (_req, res) => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(this.overview()))
        },
      })
      wctx.effect(() => dispose)
    })
  }

  /**
   * Current cost report for a session, replayed through its durable tail.
   * @param session - session to fold.
   * @returns detached per-(provider, model) breakdown plus unpriced calls.
   */
  sessionCost(session: Session): CostReport {
    return toReport(this._sync(session))
  }

  /**
   * Layered price for one (provider, model): manual → openrouter → snapshot.
   * @param provider - provider route key.
   * @param model - model id.
   * @returns the resolved rate plus provenance, or undefined when unpriced.
   */
  /**
   * Layered price for one (provider, model) at an instant: manual → openrouter
   * → snapshot, with M4 price versions and peak/off-peak windows applied.
   * @param provider - provider route key.
   * @param model - model id.
   * @param atTime - epoch ms of the call being priced (default now).
   * @returns the resolved rate plus provenance, or undefined when unpriced.
   */
  resolvePrice(provider: string, model: string, atTime: number = Date.now()): ResolvedPrice | undefined {
    return this.resolver(provider, model, atTime)
  }

  /**
   * The rate half of {@link resolvePrice}, for callers that ignore provenance.
   * @param provider - provider route key.
   * @param model - model id.
   * @param atTime - epoch ms of the call being priced (default now).
   * @returns the rate applicable at `atTime`, or undefined when unpriced.
   */
  resolveRate(provider: string, model: string, atTime: number = Date.now()): Rate | undefined {
    return this.resolver(provider, model, atTime)?.rate
  }

  /**
   * Heuristic cost estimate for one message, for surfaces with no provider
   * usage yet. Requires the optional `ctx.tokenMeter` seam (token-meter's
   * four-characters-per-token estimator); the estimate prices the message as
   * input tokens at the resolved route's input rate.
   * @param message - message to price.
   * @param provider - provider route key.
   * @param model - model id.
   * @returns estimated USD, or undefined when the pair is unpriced or token-meter is absent.
   */
  estimateCost(message: Message, provider: string, model: string): number | undefined {
    const resolved = this.resolver(provider, model, Date.now())
    if (resolved === undefined) return undefined
    const meter = this.ctx.get('tokenMeter') as { estimateMessage(message: Message): number } | undefined
    if (meter === undefined) return undefined
    return meter.estimateMessage(message) / 1_000_000 * resolved.rate.input
  }

  /**
   * Force an OpenRouter refresh; emits `cost-meter/price-changed` when the
   * fetched table differs from the previous one.
   * @returns the refreshed cache, or undefined when the feed is unconfigured or the fetch failed.
   */
  async refreshOpenRouter(): Promise<import('./openrouter.ts').OpenRouterCache | undefined> {
    const before = this.feed?.snapshot()
    const cache = await this.feed?.refresh()
    const after = cache
    if (before !== undefined && after !== undefined
      && JSON.stringify(before.models) !== JSON.stringify(after.models)) {
      this.ctx.emit('cost-meter/price-changed', { reason: 'openrouter-refresh', provider: 'openrouter' })
    }
    return cache
  }

  /**
   * Built-in snapshot freshness for surfaces (M4): a snapshot older than
   * `SNAPSHOT_STALE_AFTER_DAYS` is flagged stale so the UI can ask for a
   * manual re-verification.
   * @returns the snapshot's verification date and staleness.
   */
  snapshotStatus(): { date: string; stale: boolean; staleAfterDays: number } {
    return {
      date: SNAPSHOT_DATE,
      stale: snapshotStaleAt(Date.now()),
      staleAfterDays: SNAPSHOT_STALE_AFTER_DAYS,
    }
  }

  /**
   * Bucketed cost aggregate over the given sessions (day / month / project).
   * @param sessions - sessions to aggregate.
   * @returns a fresh report priced with the live resolver.
   */
  aggregateCost(sessions: Iterable<Session>): AggregateReport {
    return aggregateCosts(sessions, this.resolver)
  }

  /**
   * Current spending standing against configured budgets, without evaluating
   * or emitting alerts. Sessions outside `tracked` (never priced) are absent.
   * @returns standings for every scope/key with spending.
   */
  budgetStatus(): BudgetStanding[] {
    return this.buildStandings()
  }

  /**
   * One snapshot for the Web panel: aggregate over the tracked universe plus
   * budget standings. Pure read; never emits alerts.
   * @returns the overview payload.
   */
  overview(): CostOverview {
    return {
      aggregate: aggregateCosts(this.tracked, this.resolver),
      standings: this.buildStandings(),
      snapshot: this.snapshotStatus(),
    }
  }

  /**
   * Evaluate budgets over every tracked session and emit newly crossed
   * thresholds. Idempotent: each (scope, key, threshold) fires once. Runs
   * automatically at `turn/end` and is available for on-demand checks.
   * @returns the alerts emitted by this evaluation.
   */
  evaluateBudgets(): BudgetAlert[] {
    const alerts = evaluateBudgets(this.buildStandings(), this.budgets, this.thresholds, this.notified)
    for (const alert of alerts) {
      if (this.channels.includes('event')) this.ctx.emit('cost-meter/budget-alert', alert)
      if (this.channels.includes('log')) {
        this.ctx.logger.warn(`[dsh-cost-meter] budget alert ${alert.scope} ${alert.key}: ${alert.pct.toFixed(1)}% of $${alert.amount}`)
      }
    }
    return alerts
  }

  /** Current spending per session / project / month over the tracked universe. */
  private buildStandings(): BudgetStanding[] {
    const standings: BudgetStanding[] = []
    const aggregate = aggregateCosts(this.tracked, this.resolver)
    for (const session of this.tracked) {
      standings.push({ scope: 'session', key: String(session.id), spent: this._sync(session).totalCost })
    }
    for (const [project, summary] of Object.entries(aggregate.byProject)) {
      standings.push({ scope: 'project', key: project, spent: summary.cost })
    }
    for (const [month, summary] of Object.entries(aggregate.byMonth)) {
      standings.push({ scope: 'month', key: month, spent: summary.cost })
    }
    // Annotate budgeted scopes with their amount and percentage.
    return standings.map((standing) => {
      const amount = this.budgets[standing.scope]
      if (amount === undefined) return standing
      return { ...standing, amount, pct: standing.spent / amount * 100 }
    })
  }

  /** Copy budget/notify settings from a normalized configuration. */
  private applyRuntime(normalized: NormalizedConfig): void {
    this.budgets = normalized.budgets
    this.thresholds = normalized.notify.thresholdPct
    this.channels = normalized.notify.channel
  }

  /** Rebuild the resolver and feed from a normalized configuration. */
  private rebuild(normalized: NormalizedConfig): void {
    if (this.feed === undefined) {
      // The feed is created once; toggling `enabled` only flips the resolver's use of it.
      this.feed = new OpenRouterPriceFeed({
        cachePath: normalized.openrouter.cachePath,
        refreshHours: normalized.openrouter.refreshHours,
        onError: (error) => this.ctx.logger.warn('[dsh-cost-meter] openrouter refresh failed:', error),
      })
    }
    this.resolver = createPriceResolver({
      manual: normalized.pricing,
      openrouter: {
        enabled: normalized.openrouter.enabled,
        overwrite: normalized.openrouter.overwrite,
        lookup: (model) => this.feed?.lookup(model),
      },
      snapshot: {
        enabled: normalized.snapshot.enabled,
        preferSnapshots: normalized.snapshot.preferSnapshots,
        table: DEEPSEEK_SNAPSHOT,
      },
    })
  }

  /** Eager observation bounds read latency: sessions a consumer has synced stay current. */
  private observeSessions(): void {
    this.ctx.on('session/event', (session: Session) => {
      // Every emitting session joins the tracked universe (cheap; the ledger
      // fold stays lazy), so budgets and aggregates cover active sessions even
      // before anyone reads them.
      this.tracked.add(session)
      if (this.states.has(session)) this._sync(session)
      // Budgets are evaluated at turn boundaries, not per chunk; a session that
      // just finished its first turn is folded into the tracked universe first.
      const last = session.events[session.events.length - 1]
      if (last?.type === 'turn/end') {
        this._sync(session)
        this.evaluateBudgets()
      }
    })
  }

  /** Catch one session's ledger up to the current durable tail. */
  private _sync(session: Session): LedgerState {
    let state = this.states.get(session)
    if (state === undefined) {
      state = createLedgerState()
      this.states.set(session, state)
      this.tracked.add(session)
    }
    while (state.consumedEvents < session.events.length) {
      // Contiguous session seqs index the durable log; a gap ends the fold so
      // a truncated log reads as far as it goes instead of crashing.
      const event: SessionEvent | undefined = session.events[state.consumedEvents]
      if (event === undefined) break
      foldEvent(state, event, this.resolver)
      state.consumedEvents += 1
    }
    return state
  }
}

export default CostMeter

/** Snapshot metadata re-exported for surfaces that show provenance. */
export const SNAPSHOT_VERSION = SNAPSHOT_DATE
