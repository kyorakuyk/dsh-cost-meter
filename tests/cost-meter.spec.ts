import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, canonicalHeader } from '@deepseek-ai/dsh-session'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import CostMeter from '../src/index.ts'
import { OpenRouterPriceFeed, parseOpenRouterListing } from '../src/openrouter.ts'
import { aggregateCosts, dayKey, monthKey, NO_PROJECT } from '../src/aggregate.ts'
import { crossingId, evaluateBudgets, normalizeThresholds } from '../src/budget.ts'
import { createLedgerState, foldEvent, toReport } from '../src/ledger.ts'
import { createPriceResolver } from '../src/resolver.ts'
import { DEEPSEEK_SNAPSHOT } from '../src/snapshot.ts'
import { costOf, resolveRate } from '../src/pricing.ts'
import type { BudgetAlert, BudgetConfig, BudgetStanding, CostMeterConfig, Rate } from '../src/types.ts'

const PRICING: NonNullable<CostMeterConfig['pricing']> = {
  'deepseek-official': {
    default: { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
    models: {
      'deepseek-v4-pro': { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
    },
  },
  gateway: {
    default: { input: 0.15, output: 0.60 },
  },
}

function header(provider: string, model: string): EpochHeader {
  return canonicalHeader({ config: { provider, model } })
}

/** Append one billable model call: step/start → header → chunks → message(usage) → step/end. */
function appendCall(
  session: Session,
  provider: string,
  model: string,
  usage: TokenUsage | undefined,
  opts: { turn?: number; step?: number } = {},
): void {
  const turn = opts.turn ?? 1
  const step = opts.step ?? 1
  session.append('step/start', { turn, step })
  session.append('request/header', { header: header(provider, model), reason: 'initial' })

  const sources: number[] = []
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'answer' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } },
    ...(usage === undefined ? [] : [{ type: 'usage' as const, usage }]),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  for (const chunk of chunks) {
    sources.push(session.append('assistant/chunk', { turn, step, chunk }).seq)
  }
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider, model },
    }),
    ...(usage === undefined ? {} : { usage }),
  }, { surfaceOp: 'append', sourceEventSeqs: sources })
  session.append('step/end', { turn, step })
}

describe('resolveRate', () => {
  it('lets a model override win over the route default', () => {
    expect(resolveRate(PRICING, 'deepseek-official', 'deepseek-v4-pro')?.input).toBe(0.55)
  })

  it('falls back to the route default for unknown models', () => {
    expect(resolveRate(PRICING, 'deepseek-official', 'deepseek-v4-flash')?.input).toBe(0.27)
    expect(resolveRate(PRICING, 'gateway', 'anything')?.input).toBe(0.15)
  })

  it('resolves undefined for unknown providers and empty tables', () => {
    expect(resolveRate(PRICING, 'missing-provider', 'model')).toBeUndefined()
    expect(resolveRate(undefined, 'deepseek-official', 'deepseek-v4-pro')).toBeUndefined()
  })
})

describe('costOf', () => {
  it('prices disjoint buckets at their own rates', () => {
    const rate: Rate = { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 }
    const usage: TokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    }
    expect(costOf(usage, rate)).toBeCloseTo(0.27 + 0.55 + 0.07 + 0.27, 9)
  })

  it('defaults absent cache rates to the input rate', () => {
    const rate: Rate = { input: 0.10, output: 0.20 }
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    }
    expect(costOf(usage, rate)).toBeCloseTo(0.20, 9)
  })
})

describe('sessionCost', () => {
  it('prices a single call from provider usage', () => {
    const meter = new CostMeter(new Context(), { pricing: PRICING })
    const session = Session.create(SessionId('one'))
    appendCall(session, 'deepseek-official', 'deepseek-v4-flash', {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    })
    const report = meter.sessionCost(session)
    expect(report.totalCost).toBeCloseTo(0.27 + 0.55, 9)
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      calls: 1,
      priced: true,
    })
    expect(report.entries[0]?.usage).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(report.unpriced).toHaveLength(0)
  })

  it('attributes calls per (provider, model) across header changes', () => {
    const meter = new CostMeter(new Context(), { pricing: PRICING })
    const session = Session.create(SessionId('two'))
    appendCall(session, 'deepseek-official', 'deepseek-v4-pro', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    })
    appendCall(session, 'gateway', 'openai/gpt-4o', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, { turn: 2 })
    const report = meter.sessionCost(session)
    expect(report.entries).toHaveLength(2)
    expect(report.totalCost).toBeCloseTo(0.55 + 0.15 + 0.60, 9)
    const pro = report.entries.find((e) => e.model === 'deepseek-v4-pro')
    const gpt = report.entries.find((e) => e.model === 'openai/gpt-4o')
    expect(pro).toMatchObject({ provider: 'deepseek-official', calls: 1, priced: true, cost: 0.55 })
    expect(gpt).toMatchObject({ provider: 'gateway', calls: 1, priced: true, cost: 0.75 })
  })

  it('reports unpriced pairs with zero cost instead of guessing', () => {
    const meter = new CostMeter(new Context(), { pricing: PRICING })
    const session = Session.create(SessionId('unpriced'))
    appendCall(session, 'no-rate-provider', 'mystery-model', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    const report = meter.sessionCost(session)
    expect(report.totalCost).toBe(0)
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]).toMatchObject({ priced: false, cost: 0 })
    expect(report.unpriced).toEqual([
      { provider: 'no-rate-provider', model: 'mystery-model', calls: 1 },
    ])
  })

  it('ignores assistant messages without provider usage', () => {
    const meter = new CostMeter(new Context(), { pricing: PRICING })
    const session = Session.create(SessionId('nousage'))
    appendCall(session, 'deepseek-official', 'deepseek-v4-flash', undefined)
    const report = meter.sessionCost(session)
    expect(report.totalCost).toBe(0)
    expect(report.entries).toHaveLength(0)
    expect(report.unpriced).toHaveLength(0)
  })

  it('continues folding events appended after an earlier read', () => {
    const meter = new CostMeter(new Context(), { pricing: PRICING })
    const session = Session.create(SessionId('grow'))
    appendCall(session, 'gateway', 'openai/gpt-4o', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    })
    expect(meter.sessionCost(session).totalCost).toBeCloseTo(0.15, 9)
    appendCall(session, 'gateway', 'openai/gpt-4o', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    }, { turn: 2 })
    const report = meter.sessionCost(session)
    expect(report.entries[0]).toMatchObject({ calls: 2 })
    expect(report.totalCost).toBeCloseTo(0.30, 9)
  })

  it('prices cache buckets and defaults absent cache rates to input', () => {
    const meter = new CostMeter(new Context(), { pricing: PRICING })
    const session = Session.create(SessionId('cache'))
    appendCall(session, 'gateway', 'openai/gpt-4o', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    })
    // gateway has no cache rates → both fall back to the input rate 0.15.
    expect(meter.sessionCost(session).totalCost).toBeCloseTo(0.30, 9)
  })
})

describe('foldEvent ledger consistency', () => {
  it('asserts totalCost equals the sum of priced entry costs', () => {
    const state = createLedgerState()
    const resolver = createPriceResolver({ manual: PRICING })
    const session = Session.create(SessionId('fold'))
    appendCall(session, 'gateway', 'openai/gpt-4o', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    for (const event of session.events) foldEvent(state, event, resolver)
    const report = toReport(state)
    expect(report.totalCost).toBeCloseTo(0.75, 9)
  })
})

describe('registration', () => {
  it('registers and unregisters ctx.costMeter with its plugin fiber', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(CostMeter)
    expect(ctx.get('costMeter')).toBeInstanceOf(CostMeter)
    await fiber.dispose()
    expect(ctx.get('costMeter')).toBeUndefined()
  })
})

describe('config validation', () => {
  it('rejects unknown top-level keys', () => {
    expect(() => new CostMeter(new Context(), { bogus: 1 } as unknown as CostMeterConfig))
      .toThrow('CostMeterConfig: unknown key "bogus"')
  })

  it('rejects non-finite rates', () => {
    expect(() => new CostMeter(new Context(), {
      pricing: { p: { default: { input: Number.NaN, output: 1 } } },
    } as unknown as CostMeterConfig)).toThrow('must be finite')
  })
})

describe('estimateCost', () => {
  it('returns undefined for unpriced pairs', () => {
    const meter = new CostMeter(new Context(), { pricing: PRICING })
    const message = createMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    expect(meter.estimateCost(message, 'missing', 'model')).toBeUndefined()
  })

  it('returns undefined when the token-meter seam is absent', () => {
    const meter = new CostMeter(new Context(), { pricing: PRICING })
    const message = createMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    expect(meter.estimateCost(message, 'gateway', 'openai/gpt-4o')).toBeUndefined()
  })
})

describe('layered resolver (M2a)', () => {
  it('manual wins over snapshot by default', () => {
    const resolver = createPriceResolver({
      manual: { 'deepseek-official': { default: { input: 9, output: 9 } } },
      snapshot: { enabled: true, preferSnapshots: false, table: DEEPSEEK_SNAPSHOT },
    })
    expect(resolver('deepseek-official', 'deepseek-v4-flash')).toEqual({
      rate: { input: 9, output: 9 },
      source: 'manual',
    })
  })

  it('snapshot fills pairs with no manual price when enabled', () => {
    const resolver = createPriceResolver({
      manual: {},
      snapshot: { enabled: true, preferSnapshots: false, table: DEEPSEEK_SNAPSHOT },
    })
    expect(resolver('deepseek-official', 'deepseek-v4-flash')).toEqual({
      rate: { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
      source: 'snapshot',
    })
    expect(resolver('deepseek-official', 'unknown-model')).toBeUndefined()
  })

  it('is disabled by default and scoped to snapshotted providers', () => {
    const resolver = createPriceResolver({ snapshot: { enabled: false, preferSnapshots: false, table: DEEPSEEK_SNAPSHOT } })
    expect(resolver('deepseek-official', 'deepseek-v4-flash')).toBeUndefined()
    const enabled = createPriceResolver({ snapshot: { enabled: true, preferSnapshots: false, table: DEEPSEEK_SNAPSHOT } })
    expect(enabled('other-provider', 'deepseek-v4-flash')).toBeUndefined()
  })

  it('preferSnapshots beats manual', () => {
    const resolver = createPriceResolver({
      manual: { 'deepseek-official': { default: { input: 9, output: 9 } } },
      snapshot: { enabled: true, preferSnapshots: true, table: DEEPSEEK_SNAPSHOT },
    })
    expect(resolver('deepseek-official', 'deepseek-v4-flash')?.source).toBe('snapshot')
  })

  it('applies fetched prices to the openrouter route, manual winning unless overwrite', () => {
    const fetched = () => ({ input: 0.1, output: 0.2 })
    const plain = createPriceResolver({
      manual: { openrouter: { default: { input: 1, output: 2 } } },
      openrouter: { enabled: true, overwrite: false, lookup: fetched },
    })
    expect(plain('openrouter', 'deepseek/deepseek-chat')).toEqual({
      rate: { input: 1, output: 2 },
      source: 'manual',
    })
    const overwrite = createPriceResolver({
      manual: { openrouter: { default: { input: 1, output: 2 } } },
      openrouter: { enabled: true, overwrite: true, lookup: fetched },
    })
    expect(overwrite('openrouter', 'deepseek/deepseek-chat')).toEqual({
      rate: { input: 0.1, output: 0.2 },
      source: 'openrouter',
    })
  })
})

describe('parseOpenRouterListing', () => {
  it('maps string pricing to rates and skips malformed entries', () => {
    const models = parseOpenRouterListing({
      data: [
        { id: 'a/b', pricing: { prompt: '0.27', completion: '1.10', input_cache_read: '0.07', input_cache_write: '0.27' } },
        { id: 'bad', pricing: { prompt: 'nope', completion: '1' } },
        { id: 'no-pricing' },
      ],
    })
    expect(models['a/b']).toEqual({ input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 })
    expect(models['bad']).toBeUndefined()
    expect(models['no-pricing']).toBeUndefined()
  })

  it('tolerates a non-array payload', () => {
    expect(parseOpenRouterListing({})).toEqual({})
    expect(parseOpenRouterListing(undefined)).toEqual({})
  })
})

describe('OpenRouterPriceFeed', () => {
  it('serves the initial cache and marks staleness by clock', () => {
    let now = 1_000
    const feed = new OpenRouterPriceFeed({
      refreshHours: 1,
      now: () => now,
      initialCache: { fetchedAt: 1_000 - 1_800_000, source: 'openrouter', models: { 'a/b': { input: 1, output: 2 } } },
    })
    expect(feed.lookup('a/b')).toEqual({ input: 1, output: 2 })
    expect(feed.isStale()).toBe(false) // 30 minutes old < 1h window
    now = 1_000 + 2_700_000 // +45 min → 75 minutes old
    expect(feed.isStale()).toBe(true)
  })

  it('keeps the stale cache when a refresh fails, then serves the next refresh', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      if (calls === 1) throw new Error('network down')
      return { ok: true, json: async () => ({ data: [{ id: 'x/y', pricing: { prompt: '1', completion: '2' } }] }) }
    }
    const feed = new OpenRouterPriceFeed({
      refreshHours: 1,
      now: () => 10_000,
      fetchImpl,
      initialCache: { fetchedAt: 0, source: 'openrouter', models: { 'a/b': { input: 9, output: 9 } } },
      onError: () => {},
    })
    expect(await feed.refresh()).toBeUndefined()
    expect(feed.lookup('a/b')).toEqual({ input: 9, output: 9 }) // stale cache kept
    const ok = await feed.refresh()
    expect(ok?.models['x/y']).toEqual({ input: 1, output: 2 })
    expect(feed.lookup('x/y')).toEqual({ input: 1, output: 2 })
  })

  it('shares one in-flight refresh across concurrent calls', async () => {
    let inFlight = 0
    let max = 0
    const fetchImpl = async () => {
      inFlight += 1
      max = Math.max(max, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
      return { ok: true, json: async () => ({ data: [] }) }
    }
    const feed = new OpenRouterPriceFeed({ refreshHours: 1, fetchImpl, now: () => 0 })
    await Promise.all([feed.refresh(), feed.refresh()])
    expect(max).toBe(1)
  })
})

describe('priceSource in reports (M2a)', () => {
  it('records manual vs snapshot provenance per entry', () => {
    const meter = new CostMeter(new Context(), {
      // No route default for deepseek-official: pro is manual, flash falls to the snapshot.
      pricing: { 'deepseek-official': { models: { 'deepseek-v4-pro': { input: 9, output: 9 } } } },
      snapshot: { enabled: true, preferSnapshots: false },
    })
    const session = Session.create(SessionId('src'))
    appendCall(session, 'deepseek-official', 'deepseek-v4-pro', { inputTokens: 1_000_000, outputTokens: 0 })
    appendCall(session, 'deepseek-official', 'deepseek-v4-flash', { inputTokens: 1_000_000, outputTokens: 0 }, { turn: 2 })
    const report = meter.sessionCost(session)
    expect(report.entries.find((e) => e.model === 'deepseek-v4-pro')?.priceSource).toBe('manual')
    expect(report.entries.find((e) => e.model === 'deepseek-v4-flash')?.priceSource).toBe('snapshot')
    expect(report.totalCost).toBeCloseTo(9 + 0.27, 9)
  })
})

describe('config validation (M2a)', () => {
  it('accepts autoPricing and snapshot keys', () => {
    expect(() => new CostMeter(new Context(), {
      autoPricing: { openrouter: { enabled: true } },
      snapshot: { enabled: true },
    })).not.toThrow()
  })

  it('rejects non-positive refreshHours', () => {
    expect(() => new CostMeter(new Context(), {
      autoPricing: { openrouter: { refreshHours: 0 } },
    })).toThrow('refreshHours')
  })

  it('still rejects unknown top-level keys', () => {
    expect(() => new CostMeter(new Context(), { bogus: 1 } as unknown as CostMeterConfig))
      .toThrow('CostMeterConfig: unknown key "bogus"')
  })
})

describe('aggregateCosts (M2b)', () => {
  async function harness(): Promise<{ ctx: Context; meter: CostMeter }> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CostMeter, { pricing: PRICING })
    return { ctx, meter: ctx.costMeter }
  }

  it('buckets priced calls by day, month, and project', async () => {
    const { ctx, meter } = await harness()
    const a = ctx.sessions.create(undefined, { meta: { cwd: '/proj-a' } })
    const b = ctx.sessions.create(undefined, { meta: { cwd: '/proj-b' } })
    appendCall(a, 'gateway', 'openai/gpt-4o', { inputTokens: 1_000_000, outputTokens: 0 })
    appendCall(b, 'gateway', 'openai/gpt-4o', { inputTokens: 0, outputTokens: 1_000_000 })
    appendCall(b, 'gateway', 'openai/gpt-4o', { inputTokens: 1_000_000, outputTokens: 0 }, { turn: 2 })

    const report = meter.aggregateCost([a, b])
    expect(report.totalCost).toBeCloseTo(0.15 + 0.60 + 0.15, 9)
    expect(report.totalCalls).toBe(3)
    expect(report.totalUnpricedCalls).toBe(0)
    expect(report.byProject['/proj-a']?.cost).toBeCloseTo(0.15, 9)
    expect(report.byProject['/proj-b']?.cost).toBeCloseTo(0.75, 9)
    const today = dayKey(Date.now())
    const month = monthKey(Date.now())
    expect(report.byDay[today]).toBeDefined()
    expect(report.byDay[today]?.cost).toBeCloseTo(0.90, 9)
    expect(report.byMonth[month]?.cost).toBeCloseTo(0.90, 9)
  })

  it('counts unpriced calls with zero cost and buckets cwd-less sessions under NO_PROJECT', async () => {
    const { ctx, meter } = await harness()
    const bare = Session.create(SessionId('bare'))
    appendCall(bare, 'no-rate', 'x', { inputTokens: 1_000_000, outputTokens: 0 })
    const report = meter.aggregateCost([bare])
    expect(report.totalCost).toBe(0)
    expect(report.totalCalls).toBe(1)
    expect(report.totalUnpricedCalls).toBe(1)
    expect(report.byProject[NO_PROJECT]).toBeDefined()
    expect(report.byProject[NO_PROJECT]?.calls).toBe(1)
  })
})

describe('budget engine (M2b)', () => {
  it('fires only crossed thresholds, ascending', () => {
    const notified = new Set<string>()
    const budgets: BudgetConfig = { session: 10 }
    const standings: BudgetStanding[] = [{ scope: 'session', key: 's1', spent: 9 }]
    const alerts = evaluateBudgets(standings, budgets, [50, 80, 100], notified)
    expect(alerts.map((a) => a.thresholdPct)).toEqual([50, 80])
    expect(alerts[0]).toMatchObject({ scope: 'session', key: 's1', amount: 10, spent: 9, pct: 90 })
  })

  it('is idempotent across repeated evaluations', () => {
    const notified = new Set<string>()
    const budgets: BudgetConfig = { month: 100 }
    const standings: BudgetStanding[] = [{ scope: 'month', key: '2026-01', spent: 120 }]
    const first = evaluateBudgets(standings, budgets, [50, 100], notified)
    const second = evaluateBudgets(standings, budgets, [50, 100], notified)
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(0)
  })

  it('ignores unbudgeted scopes and non-crossed thresholds', () => {
    const notified = new Set<string>()
    const budgets: BudgetConfig = { session: 10 } // project/month unbudgeted
    const standings: BudgetStanding[] = [
      { scope: 'session', key: 's', spent: 4 },
      { scope: 'project', key: 'p', spent: 999 },
      { scope: 'month', key: '2026-01', spent: 999 },
    ]
    expect(evaluateBudgets(standings, budgets, [50, 100], notified)).toEqual([])
  })

  it('normalizes thresholds: defaults, dedupe, sort, out-of-range filter', () => {
    expect(normalizeThresholds(undefined)).toEqual([50, 80, 100])
    expect(normalizeThresholds([100, 50, 80, 50, 0])).toEqual([0, 50, 80, 100])
    expect(normalizeThresholds([-5, 101, 30])).toEqual([30])
    expect(crossingId('session', 's1', 50)).toBe('session\u0000s1\u000050')
  })
})

describe('service budgets (M2b)', () => {
  it('emits one budget-alert event per crossing, idempotently', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CostMeter, {
      pricing: PRICING,
      budgets: { session: 0.30 },
      notify: { thresholdPct: [50, 100], channel: ['event'] },
    })
    const received: BudgetAlert[] = []
    ctx.on('cost-meter/budget-alert', (alert) => received.push(alert))
    const session = ctx.sessions.create()
    // 0.15 + 0.15 = 0.30 → 100% crossed; both thresholds fire on one evaluation.
    appendCall(session, 'gateway', 'openai/gpt-4o', { inputTokens: 1_000_000, outputTokens: 0 })
    appendCall(session, 'gateway', 'openai/gpt-4o', { inputTokens: 1_000_000, outputTokens: 0 }, { turn: 2 })
    const alerts = ctx.costMeter.evaluateBudgets()
    expect(alerts).toHaveLength(2)
    expect(received.map((a) => a.thresholdPct).sort((a, b) => a - b)).toEqual([50, 100])
    // Second evaluation: nothing new.
    expect(ctx.costMeter.evaluateBudgets()).toHaveLength(0)
    expect(received).toHaveLength(2)
  })

  it('reports standings through budgetStatus', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CostMeter, {
      pricing: PRICING,
      budgets: { session: 1, month: 100 },
    })
    const session = ctx.sessions.create()
    appendCall(session, 'gateway', 'openai/gpt-4o', { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    const standings = ctx.costMeter.budgetStatus()
    const sessionStanding = standings.find((s) => s.scope === 'session')
    expect(sessionStanding).toMatchObject({ amount: 1, spent: 0.75, pct: 75 })
  })

  it('auto-evaluates budgets at turn/end through the event stream', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CostMeter, {
      pricing: PRICING,
      budgets: { session: 1 },
      notify: { thresholdPct: [50], channel: ['event'] },
    })
    const received: BudgetAlert[] = []
    ctx.on('cost-meter/budget-alert', (alert) => received.push(alert))
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 0 })
    appendCall(session, 'gateway', 'openai/gpt-4o', { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ scope: 'session', thresholdPct: 50 })
  })

  it('rejects negative budget amounts', () => {
    expect(() => new CostMeter(new Context(), {
      budgets: { session: -1 },
    })).toThrow('budgets.session')
  })
})
