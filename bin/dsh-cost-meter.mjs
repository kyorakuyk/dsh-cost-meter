#!/usr/bin/env node
/**
 * dsh-cost-meter CLI — audit and export from the durable session log.
 *
 * Commands:
 *   dsh-cost-meter audit <sessionId> [--root <sessionsDir>] [--pricing <pricing.json>] [--compare <report.json>] [--snapshot] [--compression zstd|none]
 *   dsh-cost-meter export <sessionId> [--root <sessionsDir>] [--pricing <pricing.json>] [--snapshot] [--compression zstd|none] [--format csv|jsonl] [--out <file>]
 *
 * Both commands load the session from disk through the JSONL persistence
 * backend and recompute costs independently of any running DSH. Defaults:
 * root = $DSH_HOME/sessions or ~/.dsh/sessions; compression = zstd.
 * Requires `pnpm build` first (imports lib/index.js).
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  createLedgerState,
  createPriceResolver,
  DEEPSEEK_SNAPSHOT,
  foldEvent,
  sessionRows,
  toCsv,
  toJsonl,
  toReport,
} from '../lib/index.js'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DEFAULT_ROOT = join(DSH_HOME, 'sessions')

function arg(args, name, fallback) {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}

async function parseCommon(args) {
  const root = resolve(arg(args, '--root', DEFAULT_ROOT))
  const compression = arg(args, '--compression', 'zstd')
  if (compression !== 'zstd' && compression !== 'none') throw new Error(`unknown compression "${compression}"`)
  const pricingPath = arg(args, '--pricing', undefined)
  const snapshot = args.includes('--snapshot')
  let manual
  if (pricingPath !== undefined) {
    manual = JSON.parse(await readFile(pricingPath, 'utf8')).pricing
  }
  const resolver = createPriceResolver({
    manual,
    ...(snapshot ? { snapshot: { enabled: true, preferSnapshots: false, table: DEEPSEEK_SNAPSHOT } } : {}),
  })
  return { root, compression, resolver, pricingPath, snapshot }
}

async function loadSession(root, compression, sessionId) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlPersistence, { root, compression })
  const headers = await ctx.sessionPersistence.list()
  const header = headers.find((h) => String(h.id) === sessionId)
  if (header === undefined) {
    const ids = headers.map((h) => String(h.id)).join(', ')
    throw new Error(`session ${sessionId} not found under ${root} (known: ${ids === '' ? 'none' : ids})`)
  }
  const { events } = await ctx.sessionPersistence.load(header.id)
  return Session.create(SessionId(String(header.id)), events)
}

async function audit(args) {
  const [sessionId, ...rest] = args
  if (sessionId === undefined) throw new Error('audit requires <sessionId>')
  const { root, compression, resolver, pricingPath, snapshot } = await parseCommon(rest)
  const session = await loadSession(root, compression, sessionId)

  const state = createLedgerState()
  for (const event of session.events) foldEvent(state, event, resolver)
  const report = toReport(state)

  console.log(`session   ${sessionId}`)
  console.log(`log       ${session.events.length} events`)
  console.log(`pricing   ${pricingPath ?? '(none — usage only)'}${snapshot ? ' + snapshot' : ''}`)
  console.log('')
  if (report.entries.length === 0 && report.unpriced.length === 0) {
    console.log('no assistant messages with provider usage in this log')
  }
  for (const entry of report.entries) {
    if (!entry.priced) continue
    const u = entry.usage
    console.log(
      `${entry.provider} / ${entry.model}`
      + `  calls=${entry.calls}  cost=$${entry.cost.toFixed(6)}  src=${entry.priceSource ?? '?'}`
      + `  in=${u.inputTokens} out=${u.outputTokens} cacheR=${u.cacheReadTokens} cacheW=${u.cacheWriteTokens}`,
    )
  }
  for (const u of report.unpriced) {
    console.log(`[UNPRICED] ${u.provider} / ${u.model}  calls=${u.calls}`)
  }
  console.log('')
  console.log(`TOTAL     $${report.totalCost.toFixed(6)}`)

  const comparePath = arg(rest, '--compare', undefined)
  if (comparePath !== undefined) {
    const expected = JSON.parse(await readFile(comparePath, 'utf8'))
    const tol = 1e-9
    const totalOk = Math.abs(expected.totalCost - report.totalCost) <= tol
    const callsOk = expected.entries.length === report.entries.length
    console.log('')
    console.log(`compare   ${totalOk && callsOk ? 'OK — recomputation matches the plugin report' : 'MISMATCH — investigate!'}`)
    if (!totalOk) {
      console.log(`  plugin totalCost   = ${expected.totalCost}`)
      console.log(`  recomputed total   = ${report.totalCost}`)
    }
    if (!callsOk) {
      console.log(`  plugin entries     = ${expected.entries.length}`)
      console.log(`  recomputed entries = ${report.entries.length}`)
    }
    if (!totalOk || !callsOk) process.exitCode = 1
  }
}

async function exportCmd(args) {
  const [sessionId, ...rest] = args
  if (sessionId === undefined) throw new Error('export requires <sessionId>')
  const { root, compression, resolver } = await parseCommon(rest)
  const format = arg(rest, '--format', 'csv')
  if (format !== 'csv' && format !== 'jsonl') throw new Error(`unknown format "${format}"`)
  const session = await loadSession(root, compression, sessionId)

  const state = createLedgerState()
  for (const event of session.events) foldEvent(state, event, resolver)
  const rows = sessionRows(sessionId, toReport(state))
  const output = format === 'csv' ? toCsv(rows) : toJsonl(rows)

  const outPath = arg(rest, '--out', undefined)
  if (outPath !== undefined) {
    await writeFile(outPath, output, 'utf8')
    console.log(`wrote ${rows.length} rows to ${outPath}`)
  } else {
    process.stdout.write(output)
  }
}

/** Run one command; exits non-zero on error. */
export async function main(argv) {
  const [command, ...args] = argv
  try {
    switch (command) {
      case 'audit':
        await audit(args)
        break
      case 'export':
        await exportCmd(args)
        break
      default:
        throw new Error(`unknown command "${command ?? '(none)'}"; expected audit | export`)
    }
  } catch (error) {
    console.error(`dsh-cost-meter: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

// Direct execution (node bin/dsh-cost-meter.mjs ...); imported elsewhere for tests.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2))
}
