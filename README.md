# dsh-cost-meter

Per-session model cost accounting for DeepSeek Harness: replay the session log,
price every provider-reported usage record against a user-declared pricing
table, and expose a per-(provider, model) cost breakdown.

> 状态：M1（核心核算）已实现 · 设计文档见 [DESIGN.md](DESIGN.md)

## What M1 does

- Registers the `ctx.costMeter` service (host half only; Web panel is M3).
- Registers the `cost-meter` settings namespace: the pricing table in
  `$DSH_HOME/settings.yaml` hot-reloads on commit.
- Replays each session's durable log (eagerly on `session/event`, lazily on
  read) and prices every `assistant/message` carrying provider `usage`.
- Reports priced entries, unpriced calls, and a detached snapshot via
  `ctx.costMeter.sessionCost(session)`.

## Install

```sh
dsh plugin --profile web add https://github.com/kyorakuyk/dsh-cost-meter/archive/refs/tags/v0.1.0.tar.gz
```

Or link the package into the profile's module directory and add the plugin row
from `cordis.patch.yml` manually.

## Dependency model (opt-in by design)

- **True runtime peers** (required): `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`,
  `@deepseek-ai/dsh-settings` — the host half's `lib/index.js` imports only these.
- **Optional peers** (`peerDependenciesMeta.optional`): `dsh-session`, `dsh-llm`,
  `dsh-host-webserver`, `dsh-session-persistence-jsonl`, `dsh-client-*`, `react` —
  type-only, client-bundle, or CLI-only. A headless/minimal profile installs the
  plugin without them; runtime seams degrade gracefully (`ctx.inject` for
  settings/webServer, `ctx.get` for token-meter, no-op without them).
- `lib/` is committed, so tarball installs need no build; git installs run
  `prepare` (requires the standard `allowBuilds` entry in the profile).

## Configure

```yaml
# $DSH_HOME/settings.yaml
cost-meter:
  pricing:
    deepseek-official:
      default: { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 }
      models:
        deepseek-v4-pro: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 }
    my-gateway:
      default: { input: 0.15, output: 0.60 }
```

Rates are USD per one million tokens. A model's own entry wins over the route
default; absent cache rates fall back to the input rate; a (provider, model)
pair with no rate is reported as **unpriced** (never guessed).

## Pricing sources (M2a — implemented)

| Priority | Source | Notes |
|---|---|---|
| 1 | Manual `pricing` (authoritative) | Hot-reloads from settings.yaml |
| 2 | **OpenRouter auto-fetch** | `GET https://openrouter.ai/api/v1/models`, cached at `$DSH_HOME/costs/pricing.openrouter.json`, `refreshHours` refresh, stale-cache fallback on failure |
| 3 | **DeepSeek built-in snapshot** | Static table in `src/snapshot.ts`, version-stamped (`SNAPSHOT_DATE`); **off by default** — opt in via `snapshot.enabled` |

Manual prices always win; auto sources only fill unpriced pairs, each carrying
a source marker + timestamp (authoritative / fetched / snapshot).

```yaml
cost-meter:
  pricing:
    deepseek-official: { default: { input: 0.27, output: 1.10 } }
  autoPricing:
    openrouter:
      enabled: true        # fetch prices from the public listing
      refreshHours: 24     # cache freshness window
      overwrite: false     # true = fetched prices beat manual prices
  snapshot:
    enabled: false         # opt-in: built-in DeepSeek snapshot (verify SNAPSHOT_DATE first)
```

## Scheduled pricing (M4 — price changes & peak/off-peak)

DeepSeek announced a major API price increase and peak/off-peak pricing
(effective 2026-08-17). The pricing table is now time-aware: a rate can carry
recurring time-of-day windows and an append-only price history, and every call
is priced at the instant it happened (`event.time`).

```yaml
cost-meter:
  pricing:
    deepseek-official:
      default:
        rate: { input: 0.27, output: 1.10 }        # base price
        windows:                                    # peak/off-peak (crosses midnight OK)
          - { from: "00:30", to: "08:30", tz: "Asia/Shanghai", label: off-peak,
              rate: { input: 0.135, output: 0.55 } }
        history:                                    # one-time changes; append-only
          - { effectiveFrom: 2026-08-17T00:00:00+08:00,
              rate: { input: 0.55, output: 2.19 } }
```

- **Price changes**: append a `history` version — old logs keep repricing with
  the old price (audit-stable); the ledger never re-prices history with today's
  rates.
- **Peak/off-peak**: `windows` match the call's local time in the window's
  timezone; matched entries carry the window label (`CostEntry.window`).
- **Snapshot staleness**: the built-in DeepSeek snapshot is flagged stale in
  `overview().snapshot` once older than `SNAPSHOT_STALE_AFTER_DAYS` (30), so
  the panel can ask you to re-verify official prices.
- **Change notification**: `cost-meter/price-changed` fires when an OpenRouter
  refresh produces a different table or settings change the pricing config.

## Budgets & alerts (M2b)

```yaml
cost-meter:
  budgets:
    session: 2.00          # per-session budget (USD)
    project: 20.00         # per-project budget (project = session working directory)
    month: 200.00          # per-calendar-month budget
  notify:
    thresholdPct: [50, 80, 100]   # alert at each crossed percentage
    channel: [event, log]         # 'event' emits cost-meter/budget-alert, 'log' warns
```

- Evaluated automatically at each `turn/end`; also on demand via
  `ctx.costMeter.evaluateBudgets()`.
- Idempotent: each (scope, key, threshold) fires exactly one
  `cost-meter/budget-alert` event — listen with `ctx.on('cost-meter/budget-alert', ...)`.
- Current standing: `ctx.costMeter.budgetStatus()`; bucketed overview:
  `ctx.costMeter.aggregateCost(sessions)` (byDay / byMonth / byProject).
- Budgets cover the sessions the meter has priced (the tracked universe).

## Service API

```ts
ctx.costMeter.sessionCost(session): CostReport
// { totalCost, entries: [{ provider, model, calls, usage, cost, priced }], unpriced: [...] }

ctx.costMeter.resolveRate(provider, model): Rate | undefined
ctx.costMeter.estimateCost(message, provider, model): number | undefined  // needs dsh-token-meter, input-rate heuristic
```

## Audit

The ledger is a pure fold over the durable session log, so the authoritative
check is to fold the log **again**, outside the plugin (and outside any running
DSH), and compare:

```sh
pnpm build
node scripts/audit.mjs <sessionId>                      # usage-only bill
node scripts/audit.mjs <sessionId> --pricing pricing.json
node scripts/audit.mjs <sessionId> --pricing pricing.json --compare report.json
```

- Sessions live under `$DSH_HOME/sessions` (default `~/.dsh/sessions`, zstd
  compressed; pass `--compression none` for plaintext roots).
- `--compare` diffs against a report captured from
  `ctx.costMeter.sessionCost(session)`; exit 0 only when they match.
- Trust anchors: the log is event-sourced and append-only (DSH guarantees);
  the pricing table is what YOU declare; the arithmetic here is independent of
  the plugin service.

## Export & CLI (M3)

Export any persisted session's ledger as CSV or JSONL — fully independent of a
running DSH:

```sh
pnpm build
npx dsh-cost-meter audit <sessionId> [--pricing pricing.json] [--compare report.json] [--snapshot]
npx dsh-cost-meter export <sessionId> [--pricing pricing.json] [--format csv|jsonl] [--out file]
```

- `audit` — independent recomputation from the durable log (trust anchors: the
  log is event-sourced/append-only, the pricing table is what you declare, the
  arithmetic here is independent of the plugin service). `--compare` diffs
  against a captured `ctx.costMeter.sessionCost(...)` report, exit 0 only on match.
- `export` — `sessionRows` → CSV (header row) or JSONL; `--out` writes a file.
- Sessions live under `$DSH_HOME/sessions` (default `~/.dsh/sessions`, zstd;
  `--compression none` for plaintext roots). `scripts/audit.mjs` is a thin
  wrapper around the same `audit` command.

## Web panel (M3)

The browser half registers a **Settings → 成本** section. It fetches
`/cost-meter/api/overview` (served by the host half through the GUI's own web
server) and renders the total, per-project/month buckets, and budget progress.
The panel is Chinese-labeled and does not register a locale dictionary; data is
computed entirely on the host (`ctx.costMeter.overview()`).

## Development

```sh
pnpm install
pnpm test        # vitest, keyless
pnpm typecheck
pnpm build       # tsdown → lib/
```

## Roadmap

- ✅ M1: core ledger — usage × pricing → session cost report + audit replay script
- ✅ M2a: auto pricing sources — OpenRouter auto-fetch + DeepSeek built-in snapshot (manual always wins)
- ✅ M2b: aggregation (day/month/project) + budget alerts (event + log channels)
- ✅ M3: Web cost panel (Settings → 成本) + CSV/JSONL export + `dsh-cost-meter` CLI (audit/export)
- ✅ M4: scheduled pricing — price-history versions + peak/off-peak windows + snapshot staleness + `price-changed` events
- Upstream (optional): PR to expose `Model.cost` on `LlmResolvedModelInfo` + fold `dsh costs` into `apps/cli`
