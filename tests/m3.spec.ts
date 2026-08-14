import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import CostMeter from '../src/index.ts'
import {
  aggregateRows,
  bucketRows,
  csvField,
  sessionRows,
  toCsv,
  toJsonl,
} from '../src/export.ts'
import type { CostReport } from '../src/types.ts'
import { formatUsd, toOverviewView } from '../src/client/overview-view.ts'

const PRICING = {
  'deepseek-official': { default: { input: 0.27, output: 1.10 } },
}

function appendCall(session: Session, provider: string, model: string, usage: TokenUsage, turn = 1): void {
  const step = 1
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  session.append('request/header', { header: { config: { provider, model } }, reason: 'initial' })
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  for (const chunk of chunks) session.append('assistant/chunk', { turn, step, chunk })
  session.append('assistant/message', {
    turn, step,
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider, model } }),
    usage,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function sampleReport(): CostReport {
  const session = Session.create(SessionId('s1'))
  appendCall(session, 'deepseek-official', 'deepseek-v4-flash', { inputTokens: 1_000_000, outputTokens: 500_000 })
  const meter = new CostMeter(new Context(), { pricing: PRICING })
  return meter.sessionCost(session)
}

describe('export (M3)', () => {
  it('quotes CSV fields containing delimiters', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
  })

  it('flattens a session report into rows', () => {
    const rows = sessionRows('session-1', sampleReport())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      scope: 'session',
      key: 'session-1',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      calls: 1,
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cost: 0.27 + 0.55,
      priced: true,
      priceSource: 'manual',
    })
  })

  it('serializes bucket aggregates and the full aggregate report', () => {
    const buckets = { '/a': { cost: 1, calls: 2, unpricedCalls: 0 } }
    expect(bucketRows('project', buckets)[0]).toMatchObject({ scope: 'project', key: '/a', cost: 1, calls: 2, priced: true })
    expect(bucketRows('day', { d: { cost: 0, calls: 1, unpricedCalls: 1 } })[0]).toMatchObject({
      scope: 'day',
      calls: 1,
      cost: 0,
      priced: false,
    })
    expect(aggregateRows({ totalCost: 1, totalCalls: 1, totalUnpricedCalls: 0, byDay: {}, byMonth: {}, byProject: buckets }))
      .toHaveLength(1)
  })

  it('renders CSV with a header and JSONL one-object-per-line', () => {
    const rows = sessionRows('s', sampleReport())
    const csv = toCsv(rows)
    expect(csv.split('\n')[0]).toBe('scope,key,provider,model,calls,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,cost,priced,priceSource')
    expect(csv.trimEnd().split('\n')).toHaveLength(2)
    const jsonl = toJsonl(rows)
    expect(jsonl.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(jsonl.trimEnd().split('\n')[0]!)).toMatchObject({ key: 's' })
  })
})

describe('overview + panel view (M3)', () => {
  it('serves an overview payload over the tracked universe', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CostMeter, {
      pricing: PRICING,
      budgets: { session: 1 },
    })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/proj' } })
    appendCall(session, 'deepseek-official', 'deepseek-v4-flash', { inputTokens: 1_000_000, outputTokens: 0 })
    const overview = ctx.costMeter.overview()
    expect(overview.aggregate.totalCost).toBeCloseTo(0.27, 9)
    expect(overview.aggregate.byProject['/proj']?.calls).toBe(1)
    expect(overview.standings.some((s) => s.scope === 'session' && s.key === String(session.id))).toBe(true)
  })

  it('flattens the payload for the panel and formats USD', () => {
    const view = toOverviewView({
      aggregate: {
        totalCost: 1234.5,
        totalCalls: 3,
        totalUnpricedCalls: 1,
        byDay: {},
        byMonth: { '2026-01': { cost: 100, calls: 1, unpricedCalls: 0 } },
        byProject: { '/b': { cost: 34.5, calls: 2, unpricedCalls: 0 }, '/a': { cost: 1200, calls: 1, unpricedCalls: 1 } },
      },
      standings: [{ scope: 'month', key: '2026-01', spent: 100, amount: 200, pct: 50 }],
      snapshot: { date: '2026-01-15', stale: false, staleAfterDays: 30 },
    })
    expect(view.totalCost).toBe(1234.5)
    expect(view.projects[0]).toMatchObject({ key: '/a', cost: 1200 }) // sorted desc
    expect(view.months[0]).toEqual({ key: '2026-01', cost: 100 })
    expect(view.standings[0]?.pct).toBe(50)
    expect(formatUsd(1234.5)).toBe('$1,234.50')
    expect(formatUsd(0)).toBe('$0.00')
  })

  it('tolerates a missing payload', () => {
    const view = toOverviewView(undefined)
    expect(view.totalCost).toBe(0)
    expect(view.projects).toEqual([])
    expect(view.standings).toEqual([])
  })
})
