# dsh-cost-meter — 成本核算插件设计文档

> 状态：设计稿 v0.1 · **M1（核心核算）已实现**（`src/` + `tests/`：17 个单测通过、typecheck 通过、tsdown 构建通过、真实发布包冒烟测试通过）· 依据：`deepseek-harness-ecosystem-research.md`（G1 缺口）· 参考源码：`packages/llm/llm`、`packages/llm/llm-pi-ai`、`packages/llm/token-meter`、`packages/session`
>
> 一句话定位：**把 DSH 里"每笔模型请求花多少钱"算清楚——按会话/项目/日/月归因，超预算告警，可导出审计。**

---

## 1. 背景与缺口证据

DSH 已内置多 provider（`dsh-llm-pi-ai`）与 token 计量（`dsh-token-meter`），但**成本核算完全空白**，源码级证据：

- `packages/llm/llm-pi-ai/src/catalog.ts`：`NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`，注释原文 *"The harness never reads pi-ai's cost metadata — `replay.ts` zeroes it and no consumer reports spend"*
- `packages/llm/llm-pi-ai/README.md`：*"Pricing and input modalities have no harness consumer and ride the installed entry or are absent"*
- `packages/llm/token-meter/README.md`：token-meter 只做**上下文压力/压缩用计量**，明确"不是一个计费记录"（*"not a billing record or a gating input"*）

结论：用户用 DSH 混接多个 provider（DeepSeek + LiteLLM + OpenRouter…）后，**没有任何地方告诉他钱花哪了**。这是生态里唯一"用户可感知、可商业化"的空白。

## 2. 定位（做什么 / 不做什么）

**做：**
- 会话级成本归因：每笔请求 usage × provider/model 定价 → 会话累计
- 项目/日/月聚合投影（复用 token-meter 的 projection 机制）
- 预算与告警：按会话/项目/周期设限，超限通知
- 导出与审计：CSV/JSON 导出、按 provider/model/日期分解
- Web UI 面板（client 插件）：实时成本、分解图表、预算进度

**不做：**
- ❌ 不重复实现网关侧能力（虚拟密钥、负载均衡——那是 LiteLLM/one-api 的事）
- ❌ 不做限流/熔断（那是 `dsh-llm-router` 的事，两者互补不重叠）
- ❌ 不接账单 API（网关侧成本追踪归 LiteLLM 等；DSH 端只做"本地用量 × 本地价格"）
- 🟡 **定价来源**：M1 纯用户手填；M2 起增加**自动定价**（见 4.2）——有公开价格 API 的供应商（OpenRouter）自动抓取，无 API 的官方 provider（DeepSeek）用内置快照表；**手填永远优先于自动来源**

## 3. 核心接缝（源码实证）

| 接缝 | API | 用途 |
|---|---|---|
| usage 数据源 | `ctx.sessionProjections` 的 `tokenUsage` 单元：`uncachedInputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`（`packages/llm/token-meter/src/usage-projection.ts`） | 每笔成功/失败请求的真实 token 用量 |
| 请求归属 | `tokenUsage` 投影 + `session.event` 流（请求 header 事件含 provider/model） | 确定这笔 usage 属于哪个 provider/model |
| 模型元数据 | `ctx.llm.resolveModelInfo(provider, model)`（身份/上下文窗/输出上限）；`ctx.llm.listModels(provider)` | 校验定价表引用的模型存在 |
| 会话上下文 | `ctx.measure`（`token-meter`）：`measure(session, requestHeader?)`、`estimateMessage(message)` | 无 provider 上报时的启发式估算兜底 |
| 配置 | `ctx.settings` 的 `installSettingsSection(ctx, NS, Config, …)`（settingsNamespace） | 定价表/预算/告警阈值，热生效 |
| 凭据（可选） | `ctx.credentials`（`credentialRef`） | 网关账单 API 密钥（预留，不做默认） |
| 持久化 | `dsh-session` 会话日志事件（**model-visible ⟺ logged 不变式**） | 成本账本必须能从会话日志重建（审计要求） |

## 4. 配置 Schema（`$DSH_HOME/settings.yaml`）

```yaml
dsh-cost-meter:
  # 定价表：provider → model → 每百万 token 价格（USD）
  # 缺省模型用 provider 级 fallback；未列出的 provider 不算钱（明确显示"未定价"）
  pricing:
    deepseek-official:
      default: { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 }
    my-gateway:                       # 自定义 provider（llm-pi-ai 路由）
      default: { input: 0.15, output: 0.60, cacheRead: 0.05, cacheWrite: 0.15 }
      models:
        vision-preview: { input: 0.30, output: 1.20, cacheRead: 0.10, cacheWrite: 0.30 }
  # 预算（任一命中即告警；不拦截请求，只通知）
  budgets:
    session:  { amount: 2.00 }   # M2b 实现为标量：session: 2.00（见下方实现说明）
    project:  20.00
    month:    200.00
  # 告警通道：'event' 发射 cost-meter/budget-alert 事件，'log' 写警告日志
  notify: { thresholdPct: [50, 80, 100], channel: [event, log] }
  # 导出
  export: { path: ~/.dsh/costs, format: [csv, jsonl], rotation: daily }
  # ---- M2 起：自动定价来源（见 4.2 优先级）----
  autoPricing:
    openrouter:
      enabled: false         # true = 启动/定时抓取 https://openrouter.ai/api/v1/models 并缓存
      refreshHours: 24       # 缓存刷新周期；抓取失败时沿用旧缓存并告警
      overwrite: false       # true = 抓取结果覆盖手填（默认 false：手填优先）
  snapshot:
    enabled: false           # 默认关闭：内置快照价需显式开启（避免占位价被静默应用）
    preferSnapshots: false   # true = 快照优先于手填（不推荐，仅调试用）
```

### 4.2 定价来源优先级（M2）

| 优先级 | 来源 | 机制 | 标注 |
|---|---|---|---|
| 1（最高） | **用户手填** `pricing` | settings.yaml 热更新 | 无标注（权威） |
| 2 | **OpenRouter 抓取**（B） | `GET https://openrouter.ai/api/v1/models` 免费公开价格 JSON → 缓存至 `$DSH_HOME/costs/pricing.openrouter.json`；`refreshHours` 周期刷新，失败沿用旧缓存 + 告警 | UI 标注"自动抓取 · 快照时间" |
| 3 | **DeepSeek 内置快照**（C） | 插件内置静态价格表（官方公开价，随插件版本更新，标注快照日期） | UI 标注"内置快照 · 可能过期" |
| —（最低） | 无任何来源 | 记入 `unpriced`，显示"未定价" | 绝不猜测 |

规则：**手填永远优先**（`overwrite: true` 才允许自动来源覆盖）；自动来源只在"该 (provider, model) 无手填价"时兜底。所有自动来源的价格都带**来源标记 + 时间戳**，UI 区分"权威/抓取/快照"。

> **实现偏差说明（M2a 落地时）**：`snapshot.enabled` 默认 **false**（设计稿示例写的是 true）——内置快照价是"占位/可能过期"的数据，默认开启会把未核对的价静默算进账单；改为显式 opt-in，并在 `src/snapshot.ts` 标注 `SNAPSHOT_DATE` 与"发布前核对"要求。
>
> **实现偏差说明（M2b 落地时）**：设计稿 yaml 里 `budgets.session` 写了 `{ amount, period }` 对象——M2b 简化为**标量金额**（`session: 2.00`），period 隐含在 scope 里（session=会话累计、project=工作目录累计、month=自然月累计）；`notify.channel` 实现为 `['event','log']`（webhook 留待 M3）。
>
> **实现偏差说明（M3 落地时）**：① Web 面板文案为硬编码中文（未接入 locale 注册，简化）；② overview 路由与 GUI 同源、无独立鉴权（复用 GUI 的部署信任边界）；③ `dsh costs replay` 官方子命令需上游 `apps/cli` 改动——以插件自带 `dsh-cost-meter` bin 替代（`npx dsh-cost-meter audit`），上游 PR 仍列为可选项。

### 4.3 调度定价（M4）——应对调价与峰谷

**背景（2026-08 实测）**：DeepSeek 已公布 8-17 生效的**大幅上调**与**峰谷定价**方案。当前设计三个缺陷：① 折叠用"此刻价"定价——调价后历史会话全部按新价重算（账/审计/预算全错）；② 快照静态、会静默过期；③ `Rate` 无时间维度，峰谷无法表达。根因：定价解析缺少 `atTime`。

**模型**：价格从"一个数"升级为"按时间生效的调度"：

```yaml
cost-meter:
  pricing:
    deepseek-official:
      default: { input: 0.27, output: 1.10 }        # 基准价（= 无历史版本的默认态）
      windows:                                       # 峰谷时段（可跨午夜）
        - { from: "00:30", to: "08:30", tz: "Asia/Shanghai", label: off-peak,
            rate: { input: 0.135, output: 0.55 } }
      history:                                       # 调价版本（append-only！旧价保留）
        - { effectiveFrom: 2026-08-17T00:00:00+08:00,
            rate: { input: 0.55, output: 2.19 } }
```

**解析**：`resolveRate(pricing, provider, model, atTime)`——
1. **版本**：取 `history` 中 `effectiveFrom <= atTime < effectiveUntil` 的最新版本；无命中用基准；
2. **时段**：把 `atTime` 按窗口 `tz`（默认 Asia/Shanghai）换算本地 HH:MM，匹配 `[from, to)`（`from > to` 视为跨午夜）；命中用窗口价，否则用版本/基准价。

**关键不变式（审计稳定）**：改价 = **追加** history 版本，**绝不覆盖**。同一配置重放日志 → 同一结果；8-16 的调用永远按旧价，8-17 后按新价。

**配套**：
- `CostEntry.window` 记录命中的窗口 label（如 `off-peak`），面板可对比峰谷；
- 快照过期检测：`SNAPSHOT_DATE` 距今 > `SNAPSHOT_STALE_AFTER_DAYS`（默认 30）→ `overview().snapshot.stale` 置位，面板提示"请核对官方价格"；
- `cost-meter/price-changed` 事件：OpenRouter 刷新检测到价格变化 / settings 定价变更时触发（webhook/通知可订阅）。

## 5. 数据流

```
provider 上报 usage (session.event / tokenUsage 投影)
        │
        ▼
┌─────────────────────────────────────────────┐
│ dsh-cost-meter 消费端（挂 session 事件流）     │
│ 1. 按 (sessionId, provider, model) 匹配定价    │
│ 2. 金额 = Σ(usage分桶 × 单价)                  │
│ 3. 写入会话级账本（事件日志，可重建）            │
│ 4. 聚合投影：项目 / 日 / 月                    │
└─────────────────────────────────────────────┘
        │ 超预算？──→ 通知（ui / notification / webhook）
        ▼
   Web UI 面板（client 插件）：会话成本、分解图、预算进度
        │
        ▼
   CSV / JSONL 导出（日轮转，审计用）
```

**关键不变式**：金额永远从"会话日志可重建的 usage"推导，绝不单独存一份不可校验的账本——审计时重放会话日志即可对账。

## 6. 功能清单与里程碑

| 里程碑 | 内容 | 验证 |
|---|---|---|
| **M1 核心核算** ✅ 已实现 | usage 事件 → 定价匹配 → 会话账本 + `ctx.costMeter` 服务（`sessionCost(session)`）；无 provider 上报时用 `token-meter` 启发式兜底 | 17 个 keyless 单测通过 + typecheck + tsdown 构建 + 真实包冒烟测试 |
| **M2a 自动定价来源** ✅ 已实现 | **B. OpenRouter 自动抓取**（`src/openrouter.ts`：`GET /api/v1/models` → 缓存 `$DSH_HOME/costs/pricing.openrouter.json`，`refreshHours` 刷新、失败沿用旧缓存 + 告警，并发刷新共享一次 in-flight）；**C. DeepSeek 内置快照表**（`src/snapshot.ts`，`SNAPSHOT_DATE` 标注）；**分层 resolver**（`src/resolver.ts`：手填 > 抓取 > 快照，`overwrite`/`preferSnapshots` 翻转）；`CostEntry.priceSource` 记录来源 | 31 个单测（含 mock fetch/时钟/并发/优先级/来源标记）+ typecheck + build + 冒烟 |
| **M2b 聚合与告警** ✅ 已实现 | **聚合**（`src/aggregate.ts`：`aggregateCost(sessions)` 按天/月/项目分桶，纯函数可审计）；**预算**（`src/budget.ts`：session/project/month 三档金额 + 阈值 [50,80,100] 幂等触发）；**告警**（`ctx.emit('cost-meter/budget-alert')` 事件 + log 双通道，turn/end 自动评估，`budgetStatus()`/`evaluateBudgets()` 可按需调用）；`tracked` 会话宇宙自动登记（观察器 + `_sync`） | 41 个单测 + typecheck + build + 端到端冒烟（聚合分桶/站位/事件幂等） |
| **M3 UI 与导出** ✅ 已实现 | **Web 成本面板**（`src/client/`：注册 `settings.section`"成本"页，经 host 的 `webServer` 路由 `/cost-meter/api/overview` 拉取 `overview()` 快照；纯数据 prep `overview-view.ts` 可测）；**CSV/JSONL 导出**（`src/export.ts` 纯函数：`sessionRows`/`bucketRows`/`toCsv`/`toJsonl`）；**CLI**（`bin/dsh-cost-meter.mjs`：`audit` + `export` 子命令，`npx dsh-cost-meter …` 即用；`scripts/audit.mjs` 改为薄包装） | 48 个单测 + typecheck + build（node + client 双 bundle）+ 端到端（HTTP 路由 200 + CLI 全子命令） |
| **M4 调度定价** ✅ 已实现 | **时间感知定价**（`src/schedule.ts`：`resolveSpecAt(spec, atTime)` 版本选择 `effectiveFrom/effectiveUntil` + 峰谷窗口 `[from,to)` 跨午夜 + tz（默认 Asia/Shanghai））；**折叠按事件时间选价**（`foldEvent` 传 `event.time`，旧事件永远按旧价——append-only 价格历史，审计稳定）；**快照过期检测**（`snapshotStaleAt` + `overview().snapshot.stale`，30 天阈值）；**`cost-meter/price-changed` 事件**（OpenRouter 刷新差异 / settings 定价变更）；`CostEntry.window` 记录峰谷标签 | 59 个单测（新增 11 个：时段/版本/过期/事件/一致性）+ typecheck + build + 冒烟（峰谷+调价实测） |
| **上游（可选）** | **A. 向官方提 PR**：给 `LlmResolvedModelInfo` 加 `cost` 字段，让 `ctx.llm.listModels/resolveModelInfo` 暴露 pi-ai 目录里已有的 `Model.cost`——成了则自动定价可直达目录价 | 上游合并后插件读公共接缝即可 |

## 7. 风险与边界

- **定价准确性（M2 起三源并存）**：手填（权威）> OpenRouter 抓取（自动，带时间戳）> DeepSeek 内置快照（标注"可能过期"）；自动来源只在无手填价时兜底，且全部带**来源标记**，UI 区分"权威/抓取/快照"——手填永远优先，`overwrite: true` 才允许覆盖
- **抓取健壮性**：OpenRouter 抓取失败/超时 → 沿用旧缓存 + 告警，绝不让"没抓到价"影响记账（unpriced 兜底）；缓存文件损坏 → 视为无缓存重建
- **快照过期**：DeepSeek 官方价变动 → 快照随插件版本更新；UI 显示快照日期，用户可一键切手填
- **usage 缺失**：请求失败/无上报 → 用启发式估算并打标 `estimated: true`，账本区分"实报/估算"
- **缓存计费**：`cacheRead`/`cacheWrite` 单价通常低于 input——定价表分桶设计已覆盖
- **多 provider 切换**：同一会话切换模型（compaction/手动）→ 按请求粒度归属，不串账
- **性能**：事件流消费必须是 O(1) 级增量聚合，不做全量重放（投影机制天然支持）
- **上游变动**：`tokenUsage` 投影字段是 `dsh-token-meter` 契约——插件需随上游 schema 版本对齐（`SESSION_FORMAT_VERSION` 门控）

## 8. 与 dsh-llm-router 的分工

- cost-meter：**记账/告警/审计**（只读消费，不干预请求）
- llm-router：**路由/回退/密钥轮换**（干预请求，不记账）
- 可选联动：router 读 cost-meter 的实时成本做"成本路由"（非阻塞，M2+）
