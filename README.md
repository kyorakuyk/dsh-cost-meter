# dsh-cost-meter

[English](README.md) | [中文](README.zh.md)

Per-session model cost accounting for **DeepSeek Harness**: replay the durable
session log, price every provider-reported usage record against a layered,
time-aware pricing table, and surface per-session / per-project / per-month
costs — with budget alerts, CSV/JSONL export, an independent audit CLI, and a
Web cost panel.

> Status: production-ready for M1→M4.1 (see [Roadmap](#roadmap)). Design
> decisions and rationale live in [DESIGN.md](DESIGN.md). MIT licensed.

---

## Features

| Milestone | What you get |
|---|---|
| **M1 Core ledger** | `ctx.costMeter.sessionCost(session)` — per-(provider, model) breakdown from the session log; unpriced pairs reported, never guessed |
| **M2a Auto pricing** | Manual prices → **OpenRouter auto-fetch** → **DeepSeek built-in snapshot**, each rate carrying a source marker |
| **M2b Aggregation & alerts** | day / month / project buckets + idempotent budget alerts (`cost-meter/budget-alert`) |
| **M3 Export & Web** | CSV / JSONL export, `dsh-cost-meter` CLI, Settings → Cost panel |
| **M4 Scheduled pricing** | Price-history versions + peak/off-peak windows, priced at the call's own timestamp — **audit-stable across price changes** |
| **M4.1 Outdated detection** | Warns when a manual price differs from the latest known price — no more silent mis-statement |

---

## Install

```sh
dsh plugin --profile web add https://github.com/kyorakuyk/dsh-cost-meter/archive/refs/tags/v0.2.0.tar.gz
```

Or link the package into the profile's module directory and add the plugin row
from `cordis.patch.yml` manually.

### Dependency model (opt-in by design)

- **Required runtime peers** — `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`,
  `@deepseek-ai/dsh-settings`: the host half's `lib/index.js` imports only these.
- **Optional peers** (`peerDependenciesMeta.optional`) — `dsh-session`, `dsh-llm`,
  `dsh-host-webserver`, `dsh-session-persistence-jsonl`, `dsh-client-*`, `react`:
  type-only, browser-bundle, or CLI-only. A headless/minimal profile installs the
  plugin without them; runtime seams degrade gracefully (`ctx.inject` for
  settings/webServer, `ctx.get` for token-meter).
- `lib/` is committed, so tarball installs need no build; git installs run
  `prepare` (standard `allowBuilds` entry required in the profile).

---

## Quick start

```yaml
# $DSH_HOME/settings.yaml
cost-meter:
  pricing:
    deepseek-official:
      default: { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 }
```

Rates are **USD per one million tokens**. A model's own entry wins over the
route default; absent cache rates fall back to the input rate; a pair with no
rate is reported as **unpriced** (never guessed).

---

## Pricing sources

| Priority | Source | Notes |
|---|---|---|
| 1 | **Manual** `pricing` (authoritative) | Hot-reloads from `settings.yaml` |
| 2 | **OpenRouter auto-fetch** | `GET https://openrouter.ai/api/v1/models`, cached at `$DSH_HOME/costs/pricing.openrouter.json`, `refreshHours` freshness, stale-cache fallback on failure |
| 3 | **DeepSeek built-in snapshot** | Version-stamped table in `src/snapshot.ts`; **off by default** — opt in via `snapshot.enabled` |

Manual prices always win; automatic sources only fill unpriced pairs, each
carrying a source marker (`manual` / `openrouter` / `snapshot`).

```yaml
cost-meter:
  pricing:
    deepseek-official: { default: { input: 0.27, output: 1.10 } }
  autoPricing:
    openrouter:
      enabled: true        # fetch prices from the public listing
      refreshHours: 24     # cache freshness window (hours)
      overwrite: false     # true = fetched prices beat manual prices
  snapshot:
    enabled: false         # opt-in; verify SNAPSHOT_DATE against official prices first
```

---

## Scheduled pricing (M4)

DeepSeek announced a major API price increase plus peak/off-peak pricing
(effective 2026-08-17). The table is now time-aware: a rate can carry recurring
time-of-day windows and an append-only price history, and every call is priced
at the instant it happened (`event.time`).

```yaml
cost-meter:
  pricing:
    deepseek-official:
      default:
        rate: { input: 0.27, output: 1.10 }        # base price
        windows:                                    # peak/off-peak (midnight-crossing OK)
          - { from: "00:30", to: "08:30", tz: "Asia/Shanghai", label: off-peak,
              rate: { input: 0.135, output: 0.55 } }
        history:                                    # one-time changes; append-only
          - { effectiveFrom: 2026-08-17T00:00:00+08:00,
              rate: { input: 0.55, output: 2.19 } }
```

- **Price changes** — append a `history` version. Old logs keep repricing with
  the old price, so the audit stays stable; the ledger never re-prices history
  with today's rates.
- **Peak/off-peak** — `windows` match the call's local time in the window's
  timezone (default `Asia/Shanghai`); matched entries carry the window label in
  `CostEntry.window`.
- **Snapshot staleness** — the built-in snapshot is flagged stale in
  `overview().snapshot` once older than `SNAPSHOT_STALE_AFTER_DAYS` (30), so the
  panel can ask you to re-verify official prices.
- **Change notification** — `cost-meter/price-changed` fires when an OpenRouter
  refresh produces a different table or settings change the pricing config.

### Outdated-price warning (M4.1)

Manual prices are authoritative, but a *stale* manual price is silently wrong.
When a manual price is applied and an automatic source prices the same pair
differently, the entry is flagged:

- `CostReport.outdated[]` / `ctx.costMeter.collectOutdated()` — the pairs, with
  the manual and latest rates and the source.
- **Web panel** — a banner warns *"⚠️ 定价可能已过时"* (manual X → latest Y).
- **CLI** — `dsh-cost-meter audit` prints the outdated pairs after the bill.

The OpenRouter fetch always participates (it is live); the built-in snapshot
participates only while it is current — a stale snapshot cannot cry wolf, and
it still prices as before.

---

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

- Evaluated automatically at each `turn/end`, or on demand via
  `ctx.costMeter.evaluateBudgets()`.
- Idempotent: each (scope, key, threshold) fires **exactly one**
  `cost-meter/budget-alert` event — listen with
  `ctx.on('cost-meter/budget-alert', ...)`.
- Current standing: `ctx.costMeter.budgetStatus()`; bucketed overview:
  `ctx.costMeter.aggregateCost(sessions)` (byDay / byMonth / byProject).
- Budgets cover the sessions the meter has priced (the tracked universe).

---

## Service API

```ts
ctx.costMeter.sessionCost(session)                       // CostReport
ctx.costMeter.resolvePrice(provider, model, atTime?)     // ResolvedPrice (rate + source + window + outdated)
ctx.costMeter.resolveRate(provider, model, atTime?)      // Rate | undefined
ctx.costMeter.estimateCost(message, provider, model)     // number | undefined (needs dsh-token-meter)
ctx.costMeter.aggregateCost(sessions)                    // AggregateReport (byDay/byMonth/byProject)
ctx.costMeter.budgetStatus()                             // BudgetStanding[]
ctx.costMeter.evaluateBudgets()                          // BudgetAlert[] (emits events)
ctx.costMeter.overview()                                 // CostOverview (panel payload)
ctx.costMeter.collectOutdated()                          // OutdatedPrice[]
ctx.costMeter.refreshOpenRouter()                        // force an OpenRouter refresh
ctx.costMeter.snapshotStatus()                           // { date, stale, staleAfterDays }
```

Events: `cost-meter/budget-alert` · `cost-meter/price-changed`.

`CostReport` shape: `{ totalCost, entries: [{ provider, model, calls, usage,
cost, priced, priceSource?, window?, priceOutdated? }], unpriced: [...],
outdated: [...] }`.

---

## Web panel (M3)

The browser half registers a **Settings → 成本** section that fetches
`/cost-meter/api/overview` (served by the host half through the GUI's own web
server) and renders the total, per-project/month buckets, budget progress,
snapshot staleness, and outdated-price warnings. The panel is Chinese-labeled
and does not register a locale dictionary; all data is computed on the host
(`ctx.costMeter.overview()`).

---

## Audit & export (M3)

The ledger is a pure fold over the durable session log, so the authoritative
check is to fold the log **again**, outside the plugin (and outside any running
DSH), and compare:

```sh
pnpm build

# independent recomputation; --compare diffs against a captured
# ctx.costMeter.sessionCost(session) report (exit 0 only on match)
npx dsh-cost-meter audit <sessionId> [--pricing pricing.json] [--compare report.json] [--snapshot]

# CSV / JSONL export of one session's ledger
npx dsh-cost-meter export <sessionId> [--pricing pricing.json] [--format csv|jsonl] [--out file]
```

- Sessions live under `$DSH_HOME/sessions` (default `~/.dsh/sessions`, zstd
  compressed; pass `--compression none` for plaintext roots).
- **Trust anchors** — the log is event-sourced and append-only (DSH
  guarantees); the pricing table is what *you* declare; the arithmetic here is
  independent of the plugin service. `scripts/audit.mjs` is a thin wrapper
  around the same `audit` command.

---

## Development

```sh
pnpm install
pnpm test        # vitest, keyless
pnpm typecheck
pnpm build       # tsdown → lib/ (node + browser bundles)
```

---

## Roadmap

- ✅ M1 core ledger · ✅ M2a auto pricing · ✅ M2b aggregation & alerts
- ✅ M3 Web panel + export + CLI · ✅ M4 scheduled pricing · ✅ M4.1 outdated detection
- Optional upstream: PR to expose `Model.cost` on `LlmResolvedModelInfo` + fold
  `dsh costs` into `apps/cli`

---

## License

MIT — see [LICENSE](LICENSE).
