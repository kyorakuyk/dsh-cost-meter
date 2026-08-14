import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import CostMeter, {
  createPriceResolver,
  foldEvent,
  resolveScheduled,
  SNAPSHOT_DATE,
  snapshotStaleAt,
} from '../src/index.ts'
import { createLedgerState, toReport } from '../src/ledger.ts'
import { asRateSpec, localHHMM, validateWindow } from '../src/schedule.ts'
import type { CostMeterConfig, Rate, RateSpec } from '../src/types.ts'

/** Fixed instants with known Asia/Shanghai local times (UTC+8). */
const SHANGHAI = 'Asia/Shanghai'
const BEFORE_CHANGE = Date.UTC(2026, 7, 16, 10, 0, 0) // 18:00 +08
const AFTER_CHANGE = Date.UTC(2026, 7, 18, 10, 0, 0) // 18:00 +08
const OFF_PEAK = Date.UTC(2026, 7, 16, 22, 0, 0) // 06:00 +08 (next day) — inside 00:30-08:30
const PEAK = Date.UTC(2026, 7, 16, 2, 0, 0) // 10:00 +08 — outside 00:30-08:30

/** A rate spec with a base, an off-peak window, and a price change. */
const SCHEDULE: RateSpec = {
  rate: { input: 0.27, output: 1.10 },
  windows: [
    { from: '00:30', to: '08:30', tz: SHANGHAI, label: 'off-peak', rate: { input: 0.135, output: 0.55 } },
  ],
  history: [
    { effectiveFrom: Date.UTC(2026, 7, 17, 0, 0, 0), rate: { input: 0.55, output: 2.19 } },
  ],
}

const PRICING: NonNullable<CostMeterConfig['pricing']> = {
  'deepseek-official': { default: SCHEDULE },
}

function headerEvent(seq: number, time: number, provider: string, model: string): SessionEvent {
  return { type: 'request/header', seq, time, data: { header: { config: { provider, model } }, reason: 'initial' } }
}

function usageEvent(seq: number, time: number, input: number, output = 0): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'x' }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
      usage: { inputTokens: input, outputTokens: output },
    },
  } as unknown as SessionEvent
}

/** Temp cache file per test so OpenRouter feeds never leak across tests. */
const tempCachePaths: string[] = []
async function freshCachePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cost-m4-openrouter-'))
  const path = join(dir, 'pricing.openrouter.json')
  tempCachePaths.push(path)
  return path
}

const originalFetch = globalThis.fetch
afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const path of tempCachePaths.splice(0)) {
    await rm(path, { force: true }).catch(() => undefined)
  }
})

describe('schedule: local time (M4)', () => {
  it('converts instants to Asia/Shanghai HH:MM', () => {
    expect(localHHMM(OFF_PEAK, SHANGHAI)).toBe('06:00')
    expect(localHHMM(PEAK, SHANGHAI)).toBe('10:00')
    expect(localHHMM(AFTER_CHANGE, SHANGHAI)).toBe('18:00')
  })

  it('rejects malformed windows', () => {
    expect(() => validateWindow({ from: '25:00', to: '08:30', rate: { input: 1, output: 1 } })).toThrow('out of range')
    expect(() => validateWindow({ from: '8:30', to: '09:00', rate: { input: 1, output: 1 } })).toThrow('"HH:MM"')
  })
})

describe('resolveScheduled: versions and windows (M4)', () => {
  it('applies the base rate before a version and the version after it', () => {
    expect(resolveScheduled(PRICING, 'deepseek-official', 'deepseek-v4-flash', BEFORE_CHANGE)?.rate.input).toBe(0.27)
    expect(resolveScheduled(PRICING, 'deepseek-official', 'deepseek-v4-flash', AFTER_CHANGE)?.rate.input).toBe(0.55)
  })

  it('applies the window rate inside an off-peak window and the default outside', () => {
    const offPeak = resolveScheduled(PRICING, 'deepseek-official', 'deepseek-v4-flash', OFF_PEAK)
    expect(offPeak?.rate.input).toBe(0.135)
    expect(offPeak?.window).toBe('off-peak')
    expect(resolveScheduled(PRICING, 'deepseek-official', 'deepseek-v4-flash', PEAK)?.rate.input).toBe(0.27)
    expect(resolveScheduled(PRICING, 'deepseek-official', 'deepseek-v4-flash', PEAK)?.window).toBeUndefined()
  })

  it('resolves undefined for a spec with no applicable rate', () => {
    expect(resolveScheduled({ p: { default: { history: [{ effectiveFrom: Date.UTC(2030), rate: { input: 1, output: 1 } }] } } }, 'p', 'm', BEFORE_CHANGE))
      .toBeUndefined()
  })

  it('treats a flat rate as always applicable', () => {
    expect(asRateSpec({ input: 0.1, output: 0.2 })).toEqual({ rate: { input: 0.1, output: 0.2 } })
  })
})

describe('fold prices at event time (M4)', () => {
  it('prices peak and off-peak calls differently and records the window', () => {
    const resolver = createPriceResolver({ manual: PRICING })
    const state = createLedgerState()
    foldEvent(state, headerEvent(0, PEAK, 'deepseek-official', 'deepseek-v4-flash'), resolver)
    foldEvent(state, usageEvent(1, PEAK, 1_000_000), resolver) // peak: 0.27
    foldEvent(state, usageEvent(2, OFF_PEAK, 1_000_000), resolver) // off-peak: 0.135
    const report = toReport(state)
    expect(report.totalCost).toBeCloseTo(0.27 + 0.135, 9)
    expect(report.entries[0]?.window).toBe('off-peak') // last applied window
    expect(report.entries[0]?.priceSource).toBe('manual')
  })

  it('reprices old events with the pre-change version after a price change', () => {
    const resolver = createPriceResolver({ manual: PRICING })
    const state = createLedgerState()
    foldEvent(state, headerEvent(0, BEFORE_CHANGE, 'deepseek-official', 'deepseek-v4-flash'), resolver)
    foldEvent(state, usageEvent(1, BEFORE_CHANGE, 1_000_000), resolver) // 0.27 (old price)
    foldEvent(state, usageEvent(2, AFTER_CHANGE, 1_000_000), resolver) // 0.55 (new price)
    expect(toReport(state).totalCost).toBeCloseTo(0.27 + 0.55, 9)
  })
})

describe('snapshot staleness (M4)', () => {
  it('flags a snapshot older than the threshold', () => {
    const verified = Date.parse(`${SNAPSHOT_DATE}T00:00:00Z`)
    expect(snapshotStaleAt(verified + 10 * 86_400_000)).toBe(false)
    expect(snapshotStaleAt(verified + 60 * 86_400_000)).toBe(true)
    expect(snapshotStaleAt(verified + 10 * 86_400_000, SNAPSHOT_DATE, 5)).toBe(true)
  })
})

describe('price-changed event (M4)', () => {
  it('emits cost-meter/price-changed when an OpenRouter refresh changes prices', async () => {
    let fetchCall = 0
    globalThis.fetch = (async () => {
      fetchCall += 1
      return {
        ok: true,
        json: async () => fetchCall === 1
          ? { data: [{ id: 'a/b', pricing: { prompt: '1', completion: '2' } }] }
          : { data: [{ id: 'a/b', pricing: { prompt: '3', completion: '4' } }] },
      }
    }) as unknown as typeof fetch

    const ctx = new Context()
    await ctx.plugin(CostMeter, {
      autoPricing: { openrouter: { enabled: true, refreshHours: 1, cachePath: await freshCachePath() } },
    })
    const changes: Array<{ reason: string; provider?: string }> = []
    ctx.on('cost-meter/price-changed', (change) => changes.push(change))

    await ctx.costMeter.refreshOpenRouter() // first fetch, no diff
    expect(changes).toHaveLength(0)
    await ctx.costMeter.refreshOpenRouter() // second fetch, prices changed
    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual({ reason: 'openrouter-refresh', provider: 'openrouter' })
  })

  it('does not emit when a refresh returns the same prices', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'a/b', pricing: { prompt: '1', completion: '2' } }] }),
    })) as unknown as typeof fetch
    const ctx = new Context()
    await ctx.plugin(CostMeter, {
      autoPricing: { openrouter: { enabled: true, refreshHours: 1, cachePath: await freshCachePath() } },
    })
    const changes: unknown[] = []
    ctx.on('cost-meter/price-changed', (change) => changes.push(change))
    await ctx.costMeter.refreshOpenRouter()
    await ctx.costMeter.refreshOpenRouter()
    expect(changes).toHaveLength(0)
  })
})
