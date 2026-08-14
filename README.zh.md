# dsh-cost-meter

[English](README.md) | 中文

为 **DeepSeek Harness** 打造的会话级模型成本核算插件：重放持久化会话日志，按分层、时间感知的定价表为每笔 provider 用量计价，输出会话 / 项目 / 月度成本——附带预算告警、CSV/JSONL 导出、独立审计 CLI 与 Web 成本面板。

> 状态：M1→M4.1 全部就绪（见 [路线图](#路线图)）。设计决策与理由见 [DESIGN.md](DESIGN.md)。MIT 协议。

---

## 功能一览

| 里程碑 | 能力 |
|---|---|
| **M1 核心账本** | `ctx.costMeter.sessionCost(session)`——按 (provider, model) 分解的会话成本；未定价调用如实上报，绝不猜测 |
| **M2a 自动定价** | 手填价 → **OpenRouter 自动抓取** → **DeepSeek 内置快照**，每份价格带来源标记 |
| **M2b 聚合与告警** | 天 / 月 / 项目分桶 + 幂等预算告警（`cost-meter/budget-alert`） |
| **M3 导出与 Web** | CSV / JSONL 导出、`dsh-cost-meter` CLI、设置→成本面板 |
| **M4 调度定价** | 调价版本 + 峰谷时段，按调用发生时刻计价——**调价后历史审计依然稳定** |
| **M4.1 过时检测** | 手填价与最新已知价不一致时告警——不再静默算错 |

---

## 安装

```sh
dsh plugin --profile web add https://github.com/kyorakuyk/dsh-cost-meter/archive/refs/tags/v0.2.0.tar.gz
```

或将包链接进 profile 的模块目录，手动在 `cordis.patch.yml` 中追加插件行。

### 依赖模型（按需设计）

- **必需运行时 peer**——`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings`：host 半区 `lib/index.js` 运行时只 import 这三个。
- **可选 peer**（`peerDependenciesMeta.optional`）——`dsh-session`、`dsh-llm`、`dsh-host-webserver`、`dsh-session-persistence-jsonl`、`dsh-client-*`、`react`：类型擦除 / 仅浏览器 bundle / 仅 CLI。headless / 最小 profile 无需安装即可运行；运行时接缝优雅降级（settings/webServer 走 `ctx.inject`，token-meter 走 `ctx.get`）。
- `lib/` 已入库：tarball 安装免构建；git 安装会跑 `prepare`（profile 需按惯例加 `allowBuilds` 放行）。

---

## 快速开始

```yaml
# $DSH_HOME/settings.yaml
cost-meter:
  pricing:
    deepseek-official:
      default: { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 }
```

价格单位：**每百万 token 的美元价**。模型级条目优先于路由默认价；缺省 cache 价按 input 价计；无价的 (provider, model) 记为 **未定价**（绝不猜测）。

---

## 定价来源

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | **手填** `pricing`（权威） | `settings.yaml` 热更新 |
| 2 | **OpenRouter 自动抓取** | `GET https://openrouter.ai/api/v1/models`，缓存于 `$DSH_HOME/costs/pricing.openrouter.json`，`refreshHours` 新鲜度，失败沿用旧缓存 |
| 3 | **DeepSeek 内置快照** | `src/snapshot.ts` 版本化静态表；**默认关闭**——`snapshot.enabled` 显式开启 |

手填永远优先；自动来源只兜底未定价组合，且都带来源标记（`manual` / `openrouter` / `snapshot`）。

```yaml
cost-meter:
  pricing:
    deepseek-official: { default: { input: 0.27, output: 1.10 } }
  autoPricing:
    openrouter:
      enabled: true        # 从公开列表抓取价格
      refreshHours: 24     # 缓存新鲜度（小时）
      overwrite: false     # true = 抓取价可覆盖手填价
  snapshot:
    enabled: false         # 显式开启；先核对 SNAPSHOT_DATE 与官方价格一致
```

---

## 调度定价（M4）

DeepSeek 已公布 8-17 生效的**大幅调价**与**峰谷定价**。定价表现在是时间感知的：价格可携带每日峰谷窗口与追加式（append-only）调价历史，且每笔调用按**发生时刻**（`event.time`）计价。

```yaml
cost-meter:
  pricing:
    deepseek-official:
      default:
        rate: { input: 0.27, output: 1.10 }        # 基准价
        windows:                                    # 峰谷时段（支持跨午夜）
          - { from: "00:30", to: "08:30", tz: "Asia/Shanghai", label: off-peak,
              rate: { input: 0.135, output: 0.55 } }
        history:                                    # 调价版本（append-only）
          - { effectiveFrom: 2026-08-17T00:00:00+08:00,
              rate: { input: 0.55, output: 2.19 } }
```

- **调价**——追加 `history` 版本。旧日志永远按旧价重算，**审计稳定**；账本绝不用今日价格重算历史。
- **峰谷**——`windows` 按调用在窗口时区（默认 `Asia/Shanghai`）的本地时间匹配；命中条目的 `CostEntry.window` 记录窗口标签。
- **快照过期**——内置快照超过 `SNAPSHOT_STALE_AFTER_DAYS`（30 天）后，`overview().snapshot` 标记 `stale`，面板提示重新核对官方价格。
- **变更通知**——OpenRouter 刷新产生差异 / settings 修改定价时触发 `cost-meter/price-changed` 事件。

### 过时定价告警（M4.1）

手填价是权威的，但**过时的手填价会静默算错**。当手填价生效、而某自动来源对同一组合的定价不同时，条目被标记：

- `CostReport.outdated[]` / `ctx.costMeter.collectOutdated()`——差异组合（含手填价、最新价与来源）。
- **Web 面板**——横幅告警 *"⚠️ 定价可能已过时"*（手填 X → 最新 Y）。
- **CLI**——`dsh-cost-meter audit` 在账单后打印过时组合。

OpenRouter 抓取价始终参与对比（实时来源）；内置快照仅在未过期时参与——过期快照不能"狼来了"，且仍照常定价。

---

## 预算与告警（M2b）

```yaml
cost-meter:
  budgets:
    session: 2.00          # 会话预算（USD）
    project: 20.00         # 项目预算（项目 = 会话工作目录）
    month: 200.00          # 自然月预算
  notify:
    thresholdPct: [50, 80, 100]   # 每个跨过的百分比触发一次
    channel: [event, log]         # 'event' 发 cost-meter/budget-alert，'log' 写警告
```

- 每个 `turn/end` 自动评估；也可 `ctx.costMeter.evaluateBudgets()` 按需触发。
- 幂等：每个 (scope, key, threshold) 恰好触发一次 `cost-meter/budget-alert`——用 `ctx.on('cost-meter/budget-alert', ...)` 监听。
- 当前站位：`ctx.costMeter.budgetStatus()`；分桶总览：`ctx.costMeter.aggregateCost(sessions)`（byDay / byMonth / byProject）。
- 预算覆盖 meter 已计价过的会话（tracked 宇宙）。

---

## 服务 API

```ts
ctx.costMeter.sessionCost(session)                       // CostReport
ctx.costMeter.resolvePrice(provider, model, atTime?)     // ResolvedPrice（价 + 来源 + 窗口 + outdated）
ctx.costMeter.resolveRate(provider, model, atTime?)      // Rate | undefined
ctx.costMeter.estimateCost(message, provider, model)     // number | undefined（需要 dsh-token-meter）
ctx.costMeter.aggregateCost(sessions)                    // AggregateReport（byDay/byMonth/byProject）
ctx.costMeter.budgetStatus()                             // BudgetStanding[]
ctx.costMeter.evaluateBudgets()                          // BudgetAlert[]（发射事件）
ctx.costMeter.overview()                                 // CostOverview（面板数据）
ctx.costMeter.collectOutdated()                          // OutdatedPrice[]
ctx.costMeter.refreshOpenRouter()                        // 强制刷新 OpenRouter 价格
ctx.costMeter.snapshotStatus()                           // { date, stale, staleAfterDays }
```

事件：`cost-meter/budget-alert` · `cost-meter/price-changed`。

`CostReport` 结构：`{ totalCost, entries: [{ provider, model, calls, usage,
cost, priced, priceSource?, window?, priceOutdated? }], unpriced: [...],
outdated: [...] }`。

---

## Web 面板（M3）

浏览器半区注册 **设置 → 成本** 页面，拉取 `/cost-meter/api/overview`（由 host 半区通过 GUI 自身的 web server 提供），渲染总额、按项目/月度分桶、预算进度、快照过期与过时定价告警。面板文案为中文且未注册 locale 字典；数据全部在 host 端计算（`ctx.costMeter.overview()`）。

---

## 审计与导出（M3）

账本是会话日志的纯折叠，因此权威校验 = **绕过插件**（也不依赖运行中的 DSH）把日志**再折一遍**对比：

```sh
pnpm build

# 独立重算；--compare 与捕获的 ctx.costMeter.sessionCost(session) 报告对账（仅一致时 exit 0）
npx dsh-cost-meter audit <sessionId> [--pricing pricing.json] [--compare report.json] [--snapshot]

# 单会话账本导出 CSV / JSONL
npx dsh-cost-meter export <sessionId> [--pricing pricing.json] [--format csv|jsonl] [--out file]
```

- 会话位于 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`，zstd 压缩；明文根目录加 `--compression none`）。
- **信任锚点**——日志事件溯源、append-only（DSH 保证）；定价表由**你**声明；这里的算术与插件服务无关。`scripts/audit.mjs` 是同名 `audit` 命令的薄包装。

---

## 开发

```sh
pnpm install
pnpm test        # vitest，keyless
pnpm typecheck
pnpm build       # tsdown → lib/（node + 浏览器双 bundle）
```

---

## 路线图

- ✅ M1 核心账本 · ✅ M2a 自动定价 · ✅ M2b 聚合与告警
- ✅ M3 Web 面板 + 导出 + CLI · ✅ M4 调度定价 · ✅ M4.1 过时检测
- 可选上游：给 `LlmResolvedModelInfo` 加 `cost` 字段 + 把 `dsh costs` 并入 `apps/cli`

---

## 许可证

MIT——见 [LICENSE](LICENSE)。
