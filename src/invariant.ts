/**
 * Runtime-invariant companion for dsh-cost-meter.
 *
 * The durable relationship this package owns: every priced amount in a session
 * ledger derives from a provider-reported `assistant/message` usage event in
 * that session's log (usage travels with the assistant message that produced
 * it, never in a separate record — the harness reconstructability invariant),
 * and `totalCost` equals the sum of priced entry costs. The arithmetic half is
 * asserted by {@link assertLedgerConsistent} at every report read; the
 * derivation half is a property of the session log itself, not of this
 * package's fold.
 *
 * Empty by design, following the dsh-process-folding precedent: the one
 * assertion this package owns runs inside `toReport` (loud at read time) and
 * is unit-covered; mounting another session/event listener here would fold the
 * same logs twice for no new signal.
 *
 * @module dsh-cost-meter/invariant
 */

import type { Context } from '@deepseek-ai/cordis'

export const PACKAGE_NAME = 'dsh-cost-meter'

/**
 * Install the invariant companion.
 * @param ctx - host context.
 */
export function install(ctx: Context): void {
  void ctx
}
