#!/usr/bin/env node
/**
 * Legacy audit entry: delegates to the dsh-cost-meter CLI (bin).
 * Prefer `npx dsh-cost-meter audit <sessionId> …` going forward.
 */

import { main } from '../bin/dsh-cost-meter.mjs'

await main(['audit', ...process.argv.slice(2)])
