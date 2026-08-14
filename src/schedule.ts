/**
 * Time-aware rate resolution (M4): price versions + peak/off-peak windows.
 *
 * A {@link RateSpec} prices a (provider, model) pair as a function of time:
 *   1. pick the applicable history version: the latest `effectiveFrom <= atTime
 *      < effectiveUntil` entry, or the base (no version) state;
 *   2. within that state, match the time-of-day window whose `[from, to)`
 *      contains `atTime` in the window's timezone (default Asia/Shanghai);
 *   3. the matched window's rate wins, otherwise the state's flat rate.
 *
 * Windows compare zero-padded "HH:MM" strings; `from > to` crosses midnight.
 * The version list is append-only: removing old versions would make past logs
 * repricable, which is exactly what the audit invariant forbids.
 *
 * @module dsh-cost-meter/schedule
 */

import type { Rate, RateLike, RateSpec, RateVersion, RateWindow } from './types.ts'

/** Timezone window rates are expressed in unless a window overrides it. */
export const DEFAULT_TZ = 'Asia/Shanghai'

/** Windows matching uses a coarse HH:MM comparison. */
const HHMM = /^\d{2}:\d{2}$/

/**
 * Whether a value is a plain flat {@link Rate} rather than a {@link RateSpec}.
 * @param value - a rate-like configuration value.
 * @returns true when the value carries the flat rate's own fields.
 */
export function isFlatRate(value: RateLike | undefined): value is Rate {
  return typeof value === 'object' && value !== null
    && 'input' in value && typeof (value as Rate).input === 'number'
    && 'output' in value && typeof (value as Rate).output === 'number'
}

/** Normalize a rate-like value into a spec; a plain rate wraps as its flat rate. */
export function asRateSpec(value: RateLike | undefined): RateSpec | undefined {
  if (value === undefined) return undefined
  return isFlatRate(value) ? { rate: value } : value
}

/** The history version effective at `atTime`, latest wins; undefined = base state. */
export function applicableVersion(spec: RateSpec, atTime: number): RateVersion | undefined {
  if (spec.history === undefined) return undefined
  let best: RateVersion | undefined
  for (const version of spec.history) {
    if (version.effectiveFrom <= atTime
      && (version.effectiveUntil === undefined || version.effectiveUntil > atTime)
      && (best === undefined || version.effectiveFrom > best.effectiveFrom)) {
      best = version
    }
  }
  return best
}

/** Local "HH:MM" for an epoch-ms instant in an IANA timezone. */
export function localHHMM(atTime: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(atTime))
  let hour = ''
  let minute = ''
  for (const part of parts) {
    if (part.type === 'hour') hour = part.value
    else if (part.type === 'minute') minute = part.value
  }
  // Some engines emit "24" for midnight under hour12:false; normalize to "00".
  if (hour === '24') hour = '00'
  return `${hour}:${minute}`
}

/** Whether `hhmm` falls in `[from, to)`; `from > to` crosses midnight. */
export function inWindow(hhmm: string, from: string, to: string): boolean {
  if (from <= to) return hhmm >= from && hhmm < to
  return hhmm >= from || hhmm < to
}

/** The first window matching `atTime`, in declaration order. */
export function matchWindow(windows: readonly RateWindow[] | undefined, atTime: number): RateWindow | undefined {
  if (windows === undefined) return undefined
  for (const window of windows) {
    if (inWindow(localHHMM(atTime, window.tz ?? DEFAULT_TZ), window.from, window.to)) return window
  }
  return undefined
}

/** One resolved rate with the context that produced it. */
export interface ScheduledRate {
  rate: Rate
  window?: string
  versionFrom?: number
}

/**
 * Resolve a spec at an instant: version → window → flat rate.
 * @param spec - the rate spec, or undefined for "no price at all".
 * @param atTime - epoch ms of the call being priced.
 * @returns the applicable rate plus window/version context, or undefined when the
 *   spec has no rate applicable at `atTime`.
 */
export function resolveSpecAt(spec: RateSpec | undefined, atTime: number): ScheduledRate | undefined {
  if (spec === undefined) return undefined
  const version = applicableVersion(spec, atTime)
  const windows = version?.windows ?? spec.windows
  const flat = version?.rate ?? spec.rate

  const matched = matchWindow(windows, atTime)
  if (matched !== undefined) return { rate: matched.rate, window: matched.label, versionFrom: version?.effectiveFrom }
  if (flat !== undefined) return { rate: flat, versionFrom: version?.effectiveFrom }
  return undefined
}

/** Validate a window's time format ("HH:MM", hour 00-23, minute 00-59). */
export function validateWindow(window: RateWindow): void {
  if (!HHMM.test(window.from) || !HHMM.test(window.to)) {
    throw new Error(`cost-meter: window from/to must be "HH:MM" (got "${window.from}".."${window.to}")`)
  }
  for (const [label, value] of [['from', window.from], ['to', window.to]] as const) {
    const [h, m] = value.split(':')
    const hour = Number(h)
    const minute = Number(m)
    if (hour > 23 || minute > 59) {
      throw new Error(`cost-meter: window ${label} "${value}" is out of range`)
    }
  }
}

/** Validate a whole spec: window formats and version time bounds. */
export function validateSpec(label: string, spec: RateSpec | undefined): void {
  if (spec === undefined) return
  for (const window of spec.windows ?? []) validateWindow(window)
  for (const [index, version] of (spec.history ?? []).entries()) {
    if (!Number.isFinite(version.effectiveFrom)) {
      throw new Error(`cost-meter: ${label}.history[${index}].effectiveFrom must be a finite epoch ms`)
    }
    if (version.effectiveUntil !== undefined
      && (!Number.isFinite(version.effectiveUntil) || version.effectiveUntil <= version.effectiveFrom)) {
      throw new Error(`cost-meter: ${label}.history[${index}].effectiveUntil must exceed effectiveFrom`)
    }
    for (const window of version.windows ?? []) validateWindow(window)
  }
}
