import { Service } from "@deepseek-ai/cordis";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
//#region src/pricing.ts
/** One million tokens. */
const TOKENS_PER_UNIT = 1e6;
/**
* Resolve the rate for one (provider, model): the model's own entry wins over
* the route default; a provider with no entry resolves to undefined (unpriced).
* @param pricing - the configured pricing table.
* @param provider - provider route key.
* @param model - model id.
* @returns the rate, or undefined when the pair has no configured price.
*/
function resolveRate(pricing, provider, model) {
	if (pricing === void 0) return void 0;
	const entry = pricing[provider];
	if (entry === void 0) return void 0;
	const modelRate = entry.models?.[model];
	if (modelRate !== void 0) return modelRate;
	return entry.default;
}
/**
* USD cost of one usage record at a rate. Cache buckets default to the input
* rate when the rate does not name them, because cache-hit and cache-write
* pricing is the common deviation and a silent zero would undercharge.
* @param usage - provider-reported disjoint token buckets.
* @param rate - the resolved rate.
* @returns cost in USD.
*/
function costOf(usage, rate) {
	const input = usage.inputTokens / TOKENS_PER_UNIT * rate.input;
	const output = usage.outputTokens / TOKENS_PER_UNIT * rate.output;
	const cacheRead = (usage.cacheReadTokens ?? 0) / TOKENS_PER_UNIT * (rate.cacheRead ?? rate.input);
	const cacheWrite = (usage.cacheWriteTokens ?? 0) / TOKENS_PER_UNIT * (rate.cacheWrite ?? rate.input);
	return input + output + cacheRead + cacheWrite;
}
//#endregion
//#region src/ledger.ts
const KEY_SEPARATOR = "\0";
function key(provider, model) {
	return `${provider}${KEY_SEPARATOR}${model}`;
}
/** Fresh empty fold state. */
function createLedgerState() {
	return {
		consumedEvents: 0,
		provider: void 0,
		model: void 0,
		entries: /* @__PURE__ */ new Map(),
		unpriced: /* @__PURE__ */ new Map(),
		totalCost: 0
	};
}
/**
* Fold one session event into the ledger.
* @param state - ledger state to mutate.
* @param event - the next durable event.
* @param resolve - layered price resolution consulted per priced call, so a
*   hot-reloaded table or a refreshed feed reaches the next fold without restart.
*/
function foldEvent(state, event, resolve) {
	switch (event.type) {
		case "request/header": {
			const config = event.data.header.config;
			state.provider = config.provider;
			state.model = config.model;
			break;
		}
		case "assistant/message": {
			const usage = event.data.usage;
			if (usage === void 0) break;
			const provider = state.provider;
			const model = state.model;
			if (provider === void 0 || model === void 0) break;
			foldUsage(state, provider, model, usage, resolve);
			break;
		}
	}
}
/** Price one usage record into the matching entry, or record it as unpriced. */
function foldUsage(state, provider, model, usage, resolve) {
	const k = key(provider, model);
	let entry = state.entries.get(k);
	if (entry === void 0) {
		entry = {
			provider,
			model,
			calls: 0,
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0
			},
			cost: 0,
			priced: false
		};
		state.entries.set(k, entry);
	}
	entry.calls += 1;
	entry.usage.inputTokens += usage.inputTokens;
	entry.usage.outputTokens += usage.outputTokens;
	entry.usage.cacheReadTokens += usage.cacheReadTokens ?? 0;
	entry.usage.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
	const resolved = resolve(provider, model);
	if (resolved !== void 0) {
		entry.cost += costOf(usage, resolved.rate);
		entry.priced = true;
		entry.priceSource = resolved.source;
		state.totalCost += costOf(usage, resolved.rate);
		return;
	}
	let unpriced = state.unpriced.get(k);
	if (unpriced === void 0) {
		unpriced = {
			provider,
			model,
			calls: 0
		};
		state.unpriced.set(k, unpriced);
	}
	unpriced.calls += 1;
}
/** Stable ordering for report output: provider, then model. */
function byProviderModel(a, b) {
	return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
}
/** Clone an entry so the report is detached from the live fold state. */
function cloneEntry(entry) {
	return {
		provider: entry.provider,
		model: entry.model,
		calls: entry.calls,
		usage: { ...entry.usage },
		cost: entry.cost,
		priced: entry.priced,
		...entry.priceSource === void 0 ? {} : { priceSource: entry.priceSource }
	};
}
/**
* Assert the fold invariant: the running total equals the sum of priced entry
* costs. Called by {@link toReport} so a fold bug fails loud at read time.
* @param state - ledger state to verify.
* @throws Error naming the mismatch.
*/
function assertLedgerConsistent(state) {
	let sum = 0;
	for (const entry of state.entries.values()) if (entry.priced) sum += entry.cost;
	if (Math.abs(sum - state.totalCost) > 1e-9) throw new Error(`dsh-cost-meter: ledger invariant violated — priced entry costs sum to ${sum}, totalCost is ${state.totalCost}`);
}
/**
* Detached immutable-by-convention report over the current fold state.
* @param state - ledger state.
* @returns a fresh snapshot with stable ordering.
*/
function toReport(state) {
	assertLedgerConsistent(state);
	const entries = [...state.entries.values()].sort(byProviderModel).map(cloneEntry);
	const unpriced = [...state.unpriced.values()].sort(byProviderModel).map((u) => ({ ...u }));
	return {
		totalCost: state.totalCost,
		entries,
		unpriced
	};
}
//#endregion
//#region src/aggregate.ts
/** Project bucket key for sessions without a working directory. */
const NO_PROJECT = "(no project)";
function pad(value) {
	return String(value).padStart(2, "0");
}
/** Local-timezone YYYY-MM-DD key for an epoch-ms timestamp. */
function dayKey(time) {
	const d = new Date(time);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Local-timezone YYYY-MM key for an epoch-ms timestamp. */
function monthKey(time) {
	const d = new Date(time);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function add(bucket, key, cost, unpriced) {
	const entry = bucket[key] ?? (bucket[key] = {
		cost: 0,
		calls: 0,
		unpricedCalls: 0
	});
	entry.cost += cost;
	entry.calls += 1;
	if (unpriced) entry.unpricedCalls += 1;
}
/**
* Aggregate priced calls across sessions into day/month/project buckets.
* Mirrors the ledger fold: `request/header` sets attribution, `assistant/message`
* with provider usage is the billable unit; unpriced pairs count as calls with
* zero cost. Sessions whose headers carry no cwd bucket under {@link NO_PROJECT}.
* @param sessions - sessions to aggregate.
* @param resolve - layered price resolution (the service's live resolver).
* @returns a fresh bucketed report.
*/
function aggregateCosts(sessions, resolve) {
	const byDay = {};
	const byMonth = {};
	const byProject = {};
	let totalCost = 0;
	let totalCalls = 0;
	let totalUnpricedCalls = 0;
	for (const session of sessions) {
		let provider;
		let model;
		const project = session.header.cwd ?? "(no project)";
		for (const event of session.events) switch (event.type) {
			case "request/header": {
				const config = event.data.header.config;
				provider = config.provider;
				model = config.model;
				break;
			}
			case "assistant/message": {
				const usage = event.data.usage;
				if (usage === void 0 || provider === void 0 || model === void 0) break;
				const resolved = resolve(provider, model);
				const cost = resolved === void 0 ? 0 : costOf(usage, resolved.rate);
				const unpriced = resolved === void 0;
				const day = dayKey(event.time);
				const month = monthKey(event.time);
				totalCost += cost;
				totalCalls += 1;
				if (unpriced) totalUnpricedCalls += 1;
				add(byDay, day, cost, unpriced);
				add(byMonth, month, cost, unpriced);
				add(byProject, project, cost, unpriced);
				break;
			}
		}
	}
	return {
		totalCost,
		totalCalls,
		totalUnpricedCalls,
		byDay,
		byMonth,
		byProject
	};
}
//#endregion
//#region src/budget.ts
/**
* Evaluate standings against budgets and emit newly crossed thresholds.
* @param standings - current spending per scope/key.
* @param budgets - USD budget per scope; absent scope = not budgeted.
* @param thresholds - ascending percentages; alerts fire at each crossed level.
* @param notified - caller-owned idempotency set, mutated with fired crossings.
* @returns alerts for crossings not already in `notified`.
*/
function evaluateBudgets(standings, budgets, thresholds, notified) {
	const alerts = [];
	for (const standing of standings) {
		const amount = budgets[standing.scope];
		if (amount === void 0 || amount <= 0) continue;
		const pct = standing.spent / amount * 100;
		for (const threshold of thresholds) {
			if (pct < threshold) continue;
			const id = crossingId(standing.scope, standing.key, threshold);
			if (notified.has(id)) continue;
			notified.add(id);
			alerts.push({
				scope: standing.scope,
				key: standing.key,
				amount,
				spent: standing.spent,
				pct,
				thresholdPct: threshold
			});
		}
	}
	return alerts;
}
/** Stable id for one (scope, key, threshold) crossing. */
function crossingId(scope, key, threshold) {
	return `${scope}\u0000${key}\u0000${threshold}`;
}
/** Sort ascending and dedupe thresholds, so evaluation order is deterministic. */
function normalizeThresholds(thresholds) {
	const seen = /* @__PURE__ */ new Set();
	const sorted = [...thresholds ?? [
		50,
		80,
		100
	]].filter((t) => Number.isFinite(t) && t >= 0 && t <= 100).sort((a, b) => a - b);
	const result = [];
	for (const t of sorted) if (!seen.has(t)) {
		seen.add(t);
		result.push(t);
	}
	return result;
}
//#endregion
//#region src/constants.ts
/**
* Shared constants between the host and browser halves.
*
* @module dsh-cost-meter/constants
*/
/** HTTP route the Web client fetches for the cost overview (M3). */
const OVERVIEW_ROUTE = "/cost-meter/api/overview";
//#endregion
//#region src/openrouter.ts
/**
* OpenRouter price feed (M2a, source: 'openrouter').
*
* Fetches the free public model listing (`GET https://openrouter.ai/api/v1/models`),
* maps each model's `pricing` object (USD per 1M tokens, string-typed) into a
* {@link Rate}, and caches the result. Reads are synchronous from memory (the
* fold is a pure sync replay); refresh is asynchronous and lazy — a stale
* cache triggers a background refresh while serving the old prices, and a
* failed refresh keeps the old cache (never fails the fold, never guesses).
*
* The fetch implementation, clock, and persistence are injectable so unit
* tests run keyless and offline.
*
* @module dsh-cost-meter/openrouter
*/
/** The public, keyless OpenRouter model listing. */
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
/** Cache artifact written under the DSH home costs directory. */
const DEFAULT_CACHE_FILE = "pricing.openrouter.json";
/**
* Parse the OpenRouter listing payload into a model-id → rate map. Prices are
* strings; entries without finite input/output are skipped.
* @param payload - the JSON body of GET /api/v1/models.
* @returns model rates, stable by listing order.
*/
function parseOpenRouterListing(payload) {
	const result = {};
	const data = payload?.data;
	if (!Array.isArray(data)) return result;
	for (const entry of data) {
		const model = entry?.id;
		const pricing = entry?.pricing;
		if (typeof model !== "string" || model.length === 0 || typeof pricing !== "object" || pricing === null) continue;
		const p = pricing;
		const input = Number.parseFloat(String(p.prompt));
		const output = Number.parseFloat(String(p.completion));
		if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
		result[model] = {
			input,
			output,
			...readOptionalRate(p.input_cache_read, "cacheRead"),
			...readOptionalRate(p.input_cache_write, "cacheWrite")
		};
	}
	return result;
}
/** Build a single optional rate field only from finite present values. */
function readOptionalRate(value, field) {
	const parsed = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? { [field]: parsed } : {};
}
/** Validate a loaded cache artifact; undefined means absent or unusable. */
function validateCache(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const v = value;
	if (v.source !== "openrouter" || typeof v.fetchedAt !== "number" || !Number.isFinite(v.fetchedAt)) return void 0;
	if (typeof v.models !== "object" || v.models === null) return void 0;
	return {
		fetchedAt: v.fetchedAt,
		source: "openrouter",
		models: { ...v.models }
	};
}
/** One in-memory feed with lazy async refresh. */
var OpenRouterPriceFeed = class {
	options;
	cache;
	refreshing;
	fetchImpl;
	now;
	onError;
	constructor(options) {
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.now = options.now ?? (() => Date.now());
		this.onError = options.onError ?? ((error) => console.warn("[dsh-cost-meter] openrouter refresh failed:", error));
		this.cache = options.initialCache ?? this.load();
	}
	/** The current rate for one model, or undefined when absent/stale-with-no-cache. */
	lookup(model) {
		if (this.cache !== void 0 && this.isStale()) this.refresh();
		return this.cache?.models[model];
	}
	/** Whether the cache is older than the configured freshness window. */
	isStale() {
		if (this.cache === void 0) return true;
		return this.now() - this.cache.fetchedAt > this.options.refreshHours * 36e5;
	}
	/**
	* Fetch and replace the cache. Concurrent calls share one in-flight refresh;
	* a failure keeps the previous cache and reports through the error sink.
	* @returns the refreshed cache, or undefined on failure.
	*/
	async refresh() {
		if (this.refreshing !== void 0) return this.refreshing;
		this.refreshing = this.doRefresh().finally(() => {
			this.refreshing = void 0;
		});
		return this.refreshing;
	}
	async doRefresh() {
		try {
			const response = await this.fetchImpl(OPENROUTER_MODELS_URL);
			if (!response.ok) throw new Error(`openrouter listing returned HTTP ${response.status}`);
			const models = parseOpenRouterListing(await response.json());
			const cache = {
				fetchedAt: this.now(),
				source: "openrouter",
				models
			};
			if (this.options.cachePath !== void 0) this.write(cache);
			this.cache = cache;
			return cache;
		} catch (error) {
			this.onError(error);
			return;
		}
	}
	/** Synchronous best-effort load from the configured cache file. */
	load() {
		if (this.options.cachePath === void 0) return void 0;
		try {
			const raw = readFileSync(this.options.cachePath, "utf8");
			return validateCache(JSON.parse(raw));
		} catch {
			return;
		}
	}
	write(cache) {
		if (this.options.cachePath === void 0) return;
		mkdirSync(dirname(this.options.cachePath), { recursive: true });
		writeFileSync(this.options.cachePath, JSON.stringify(cache, null, 2), "utf8");
	}
};
//#endregion
//#region src/resolver.ts
/**
* Layered price resolution (M2a): manual → openrouter → snapshot.
*
* Precedence, highest first:
*   1. openrouter `overwrite` — fetched prices beat manual prices (opt-in);
*   2. snapshot `preferSnapshots` — built-in table beats manual prices (debug);
*   3. manual `pricing` — authoritative (default);
*   4. openrouter fetched — auto, timestamped;
*   5. snapshot table — auto, version-stamped;
*   6. undefined — reported as unpriced, never guessed.
*
* The composed resolver is a pure function of its option sources, so the
* service and the audit script share the exact same precedence logic.
*
* @module dsh-cost-meter/resolver
*/
/** Build the layered resolver over the given sources. */
function createPriceResolver(options) {
	return (provider, model) => {
		const manual = resolveRate(options.manual, provider, model);
		const fetched = options.openrouter?.enabled === true && provider === "openrouter" ? options.openrouter.lookup(model) : void 0;
		const snapshot = options.snapshot?.enabled === true ? resolveRate(options.snapshot.table, provider, model) : void 0;
		if (options.openrouter?.overwrite === true && fetched !== void 0) return priced(fetched, "openrouter");
		if (options.snapshot?.preferSnapshots === true && snapshot !== void 0) return priced(snapshot, "snapshot");
		if (manual !== void 0) return priced(manual, "manual");
		if (fetched !== void 0) return priced(fetched, "openrouter");
		if (snapshot !== void 0) return priced(snapshot, "snapshot");
	};
}
function priced(rate, source) {
	return {
		rate,
		source
	};
}
//#endregion
//#region src/snapshot.ts
/** When this snapshot was last verified against official pricing. */
const SNAPSHOT_DATE = "2026-01-15";
/**
* Snapshot table keyed like the manual `pricing` table: provider route →
* (default / models). Only the official route ships; other providers stay out.
*/
const DEEPSEEK_SNAPSHOT = { "deepseek-official": { models: {
	"deepseek-v4-flash": {
		input: .27,
		output: 1.1,
		cacheRead: .07,
		cacheWrite: .27
	},
	"deepseek-v4-pro": {
		input: .55,
		output: 2.19,
		cacheRead: .14,
		cacheWrite: .55
	}
} } };
/**
* Whether the snapshot table prices the given provider/model pair.
* @param provider - provider route key.
* @param model - model id.
* @returns the snapshot rate, or undefined when the pair is not snapshotted.
*/
function snapshotRate(provider, model) {
	return DEEPSEEK_SNAPSHOT[provider]?.models?.[model];
}
//#endregion
//#region src/export.ts
const CSV_HEADER = [
	"scope",
	"key",
	"provider",
	"model",
	"calls",
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"cost",
	"priced",
	"priceSource"
];
/** Quote a CSV field: wrap in quotes when it contains a delimiter, quote, or newline. */
function csvField(value) {
	return /[",\n\r]/.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}
/** Rows for one session's report, one row per (provider, model) entry. */
function sessionRows(sessionKey, report) {
	return report.entries.map((entry) => ({
		scope: "session",
		key: sessionKey,
		provider: entry.provider,
		model: entry.model,
		calls: entry.calls,
		inputTokens: entry.usage.inputTokens,
		outputTokens: entry.usage.outputTokens,
		cacheReadTokens: entry.usage.cacheReadTokens,
		cacheWriteTokens: entry.usage.cacheWriteTokens,
		cost: entry.cost,
		priced: entry.priced,
		priceSource: entry.priceSource
	}));
}
/** Rows for one aggregate bucket map (e.g. byProject), one row per bucket. */
function bucketRows(scope, buckets) {
	return Object.entries(buckets).map(([key, summary]) => ({
		scope,
		key,
		provider: "",
		model: "",
		calls: summary.calls,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: summary.cost,
		priced: summary.unpricedCalls === 0,
		priceSource: void 0
	}));
}
/** One aggregate report → one row per project, month, and day bucket. */
function aggregateRows(report) {
	return [
		...bucketRows("project", report.byProject),
		...bucketRows("month", report.byMonth),
		...bucketRows("day", report.byDay)
	];
}
/** CSV serialization with a header row. */
function toCsv(rows) {
	const lines = [CSV_HEADER.map((h) => csvField(h)).join(",")];
	for (const row of rows) lines.push([
		row.scope,
		csvField(row.key),
		csvField(row.provider),
		csvField(row.model),
		String(row.calls),
		String(row.inputTokens),
		String(row.outputTokens),
		String(row.cacheReadTokens),
		String(row.cacheWriteTokens),
		String(row.cost),
		String(row.priced),
		row.priceSource === void 0 ? "" : row.priceSource
	].join(","));
	return `${lines.join("\n")}\n`;
}
/** JSONL serialization, one JSON object per line. */
function toJsonl(rows) {
	return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length === 0 ? "" : "\n");
}
//#endregion
//#region src/index.ts
/**
* dsh-cost-meter — per-session model cost accounting.
*
* Registers the singleton `ctx.costMeter` service and the `cost-meter`
* settings namespace. The service replays each session's durable log (eagerly
* on `session/event`, lazily on read) and prices every `assistant/message`
* that carries provider `usage` through a layered resolver — manual `pricing`
* (authoritative) → OpenRouter auto-fetch → DeepSeek built-in snapshot —
* exposing a per-(provider, model) cost breakdown per session with the price
* provenance on every entry.
*
* An unlisted pair is reported as `unpriced` rather than guessed; automatic
* sources are opt-in and version/timestamp-stamped.
*
* @module dsh-cost-meter
*/
/** The settings namespace owning the pricing table. */
const NAMESPACE = settingsNamespace("cost-meter");
const RateSchema = z.object({
	input: z.number().min(0).required(),
	output: z.number().min(0).required(),
	cacheRead: z.number().min(0),
	cacheWrite: z.number().min(0)
});
const ProviderPricingSchema = z.object({
	default: RateSchema,
	models: z.dict(RateSchema)
});
const OpenRouterAutoPricingSchema = z.object({
	enabled: z.boolean().default(false),
	refreshHours: z.number().min(.001).default(24),
	overwrite: z.boolean().default(false),
	cachePath: z.string()
});
const SnapshotConfigSchema = z.object({
	enabled: z.boolean().default(false),
	preferSnapshots: z.boolean().default(false)
});
const BudgetConfigSchema = z.object({
	session: z.number().min(0),
	project: z.number().min(0),
	month: z.number().min(0)
});
const NotifyConfigSchema = z.object({
	thresholdPct: z.array(z.number().min(0).max(100)).default([
		50,
		80,
		100
	]),
	channel: z.array(z.string()).default(["event", "log"])
});
/** Plugin configuration schema; doubles as the `cost-meter` settings section shape. */
const Config = z.object({
	pricing: z.dict(ProviderPricingSchema).default({}),
	autoPricing: z.object({ openrouter: OpenRouterAutoPricingSchema }),
	snapshot: SnapshotConfigSchema,
	budgets: BudgetConfigSchema,
	notify: NotifyConfigSchema
});
/** Top-level keys the plugin configuration accepts. */
const CONFIG_KEYS = /* @__PURE__ */ new Set([
	"pricing",
	"autoPricing",
	"snapshot",
	"budgets",
	"notify"
]);
/** Apply the same defaults the schema materializes, so raw constructor configs behave identically. */
function normalizeConfig(config) {
	return {
		pricing: config.pricing ?? {},
		openrouter: {
			enabled: config.autoPricing?.openrouter?.enabled ?? false,
			refreshHours: config.autoPricing?.openrouter?.refreshHours ?? 24,
			overwrite: config.autoPricing?.openrouter?.overwrite ?? false,
			cachePath: config.autoPricing?.openrouter?.cachePath ?? defaultCachePath()
		},
		snapshot: {
			enabled: config.snapshot?.enabled ?? false,
			preferSnapshots: config.snapshot?.preferSnapshots ?? false
		},
		budgets: {
			session: config.budgets?.session,
			project: config.budgets?.project,
			month: config.budgets?.month
		},
		notify: {
			thresholdPct: normalizeThresholds(config.notify?.thresholdPct),
			channel: config.notify?.channel?.length === 0 ? ["event", "log"] : config.notify?.channel ?? ["event", "log"]
		}
	};
}
/** Reject stale or misspelled keys before defaults can hide them. */
function validateConfigKeys(config) {
	for (const key of Object.keys(config)) if (!CONFIG_KEYS.has(key)) throw new Error(`CostMeterConfig: unknown key "${key}"`);
}
/** Reject non-finite rates that a hand-written settings.yaml could smuggle past the schema. */
function validateRatesFinite(pricing) {
	if (pricing === void 0) return;
	for (const [provider, entry] of Object.entries(pricing)) {
		const rates = [["default", entry.default], ...Object.entries(entry.models ?? {}).map(([model, r]) => [`models.${model}`, r])];
		for (const [label, rate] of rates) {
			if (rate === void 0) continue;
			for (const field of [
				"input",
				"output",
				"cacheRead",
				"cacheWrite"
			]) {
				const value = rate[field];
				if (value !== void 0 && !Number.isFinite(value)) throw new Error(`CostMeterConfig: ${provider}.${label}.${field} must be finite`);
			}
		}
	}
}
/** Reject unserviceable auto-pricing/snapshot settings. */
function validateAutoPricing(normalized) {
	if (!Number.isFinite(normalized.openrouter.refreshHours) || normalized.openrouter.refreshHours <= 0) throw new Error("CostMeterConfig: autoPricing.openrouter.refreshHours must be a positive finite number");
	if (normalized.openrouter.cachePath.length === 0) throw new Error("CostMeterConfig: autoPricing.openrouter.cachePath must be a non-empty string");
}
/** Reject non-finite budget amounts. */
function validateBudgets(budgets) {
	for (const scope of [
		"session",
		"project",
		"month"
	]) {
		const amount = budgets[scope];
		if (amount !== void 0 && (!Number.isFinite(amount) || amount < 0)) throw new Error(`CostMeterConfig: budgets.${scope} must be a non-negative finite number`);
	}
}
/** Default cache location: $DSH_HOME/costs/pricing.openrouter.json, else ~/.dsh/…. */
function defaultCachePath() {
	const home = (process.env.DSH_HOME ?? "").trim() || join(homedir(), ".dsh");
	return join(home, "costs", DEFAULT_CACHE_FILE);
}
/** Replay owner: one ledger per observed session, priced through the live layered resolver. */
var CostMeter = class extends Service {
	static Config = Config;
	states = /* @__PURE__ */ new WeakMap();
	/** Sessions cost-meter has priced; the aggregation/budget universe. */
	tracked = /* @__PURE__ */ new Set();
	/** Fired (scope, key, threshold) crossings; idempotency across evaluations. */
	notified = /* @__PURE__ */ new Set();
	resolver;
	feed;
	budgets = {};
	thresholds = [
		50,
		80,
		100
	];
	channels = ["event", "log"];
	constructor(ctx, config = {}) {
		super(ctx, "costMeter");
		validateConfigKeys(config);
		const initial = normalizeConfig(config);
		validateRatesFinite(initial.pricing);
		validateAutoPricing(initial);
		validateBudgets(initial.budgets);
		this.applyRuntime(initial);
		this.rebuild(initial);
		let current = () => config;
		installSettingsSection(ctx, NAMESPACE, Config, config, {
			setSource: (source) => {
				current = source;
			},
			onChange: () => {
				try {
					const normalized = normalizeConfig(current());
					validateRatesFinite(normalized.pricing);
					validateAutoPricing(normalized);
					validateBudgets(normalized.budgets);
					this.applyRuntime(normalized);
					this.rebuild(normalized);
				} catch (error) {
					this.ctx.logger.error("dsh-cost-meter: keeping the last good configuration after an invalid settings section");
					this.ctx.logger.error(error);
				}
			},
			validate: (value) => {
				const normalized = normalizeConfig(value);
				validateRatesFinite(normalized.pricing);
				validateAutoPricing(normalized);
				validateBudgets(normalized.budgets);
			}
		});
		this.installOverviewRoute(ctx);
		this.observeSessions();
	}
	/**
	* Serve the Web panel's data through the GUI's own web server. The route is
	* registered only when a `webServer` service is present (i.e. inside the Web
	* profile), and removed with this plugin's fiber.
	*/
	installOverviewRoute(ctx) {
		ctx.inject(["webServer"], (wctx) => {
			const dispose = wctx.webServer.register({
				kind: "exact",
				path: OVERVIEW_ROUTE,
				handler: (_req, res) => {
					res.setHeader("content-type", "application/json");
					res.end(JSON.stringify(this.overview()));
				}
			});
			wctx.effect(() => dispose);
		});
	}
	/**
	* Current cost report for a session, replayed through its durable tail.
	* @param session - session to fold.
	* @returns detached per-(provider, model) breakdown plus unpriced calls.
	*/
	sessionCost(session) {
		return toReport(this._sync(session));
	}
	/**
	* Layered price for one (provider, model): manual → openrouter → snapshot.
	* @param provider - provider route key.
	* @param model - model id.
	* @returns the resolved rate plus provenance, or undefined when unpriced.
	*/
	resolvePrice(provider, model) {
		return this.resolver(provider, model);
	}
	/**
	* The rate half of {@link resolvePrice}, for callers that ignore provenance.
	* @param provider - provider route key.
	* @param model - model id.
	* @returns the configured rate, or undefined when unpriced.
	*/
	resolveRate(provider, model) {
		return this.resolver(provider, model)?.rate;
	}
	/**
	* Heuristic cost estimate for one message, for surfaces with no provider
	* usage yet. Requires the optional `ctx.tokenMeter` seam (token-meter's
	* four-characters-per-token estimator); the estimate prices the message as
	* input tokens at the resolved route's input rate.
	* @param message - message to price.
	* @param provider - provider route key.
	* @param model - model id.
	* @returns estimated USD, or undefined when the pair is unpriced or token-meter is absent.
	*/
	estimateCost(message, provider, model) {
		const resolved = this.resolver(provider, model);
		if (resolved === void 0) return void 0;
		const meter = this.ctx.get("tokenMeter");
		if (meter === void 0) return void 0;
		return meter.estimateMessage(message) / 1e6 * resolved.rate.input;
	}
	/**
	* Force an OpenRouter refresh (exposed for maintenance and tests).
	* @returns the refreshed cache, or undefined when the feed is unconfigured or the fetch failed.
	*/
	refreshOpenRouter() {
		return this.feed?.refresh() ?? Promise.resolve(void 0);
	}
	/**
	* Bucketed cost aggregate over the given sessions (day / month / project).
	* @param sessions - sessions to aggregate.
	* @returns a fresh report priced with the live resolver.
	*/
	aggregateCost(sessions) {
		return aggregateCosts(sessions, this.resolver);
	}
	/**
	* Current spending standing against configured budgets, without evaluating
	* or emitting alerts. Sessions outside `tracked` (never priced) are absent.
	* @returns standings for every scope/key with spending.
	*/
	budgetStatus() {
		return this.buildStandings();
	}
	/**
	* One snapshot for the Web panel: aggregate over the tracked universe plus
	* budget standings. Pure read; never emits alerts.
	* @returns the overview payload.
	*/
	overview() {
		return {
			aggregate: aggregateCosts(this.tracked, this.resolver),
			standings: this.buildStandings()
		};
	}
	/**
	* Evaluate budgets over every tracked session and emit newly crossed
	* thresholds. Idempotent: each (scope, key, threshold) fires once. Runs
	* automatically at `turn/end` and is available for on-demand checks.
	* @returns the alerts emitted by this evaluation.
	*/
	evaluateBudgets() {
		const alerts = evaluateBudgets(this.buildStandings(), this.budgets, this.thresholds, this.notified);
		for (const alert of alerts) {
			if (this.channels.includes("event")) this.ctx.emit("cost-meter/budget-alert", alert);
			if (this.channels.includes("log")) this.ctx.logger.warn(`[dsh-cost-meter] budget alert ${alert.scope} ${alert.key}: ${alert.pct.toFixed(1)}% of $${alert.amount}`);
		}
		return alerts;
	}
	/** Current spending per session / project / month over the tracked universe. */
	buildStandings() {
		const standings = [];
		const aggregate = aggregateCosts(this.tracked, this.resolver);
		for (const session of this.tracked) standings.push({
			scope: "session",
			key: String(session.id),
			spent: this._sync(session).totalCost
		});
		for (const [project, summary] of Object.entries(aggregate.byProject)) standings.push({
			scope: "project",
			key: project,
			spent: summary.cost
		});
		for (const [month, summary] of Object.entries(aggregate.byMonth)) standings.push({
			scope: "month",
			key: month,
			spent: summary.cost
		});
		return standings.map((standing) => {
			const amount = this.budgets[standing.scope];
			if (amount === void 0) return standing;
			return {
				...standing,
				amount,
				pct: standing.spent / amount * 100
			};
		});
	}
	/** Copy budget/notify settings from a normalized configuration. */
	applyRuntime(normalized) {
		this.budgets = normalized.budgets;
		this.thresholds = normalized.notify.thresholdPct;
		this.channels = normalized.notify.channel;
	}
	/** Rebuild the resolver and feed from a normalized configuration. */
	rebuild(normalized) {
		if (this.feed === void 0) this.feed = new OpenRouterPriceFeed({
			cachePath: normalized.openrouter.cachePath,
			refreshHours: normalized.openrouter.refreshHours,
			onError: (error) => this.ctx.logger.warn("[dsh-cost-meter] openrouter refresh failed:", error)
		});
		this.resolver = createPriceResolver({
			manual: normalized.pricing,
			openrouter: {
				enabled: normalized.openrouter.enabled,
				overwrite: normalized.openrouter.overwrite,
				lookup: (model) => this.feed?.lookup(model)
			},
			snapshot: {
				enabled: normalized.snapshot.enabled,
				preferSnapshots: normalized.snapshot.preferSnapshots,
				table: DEEPSEEK_SNAPSHOT
			}
		});
	}
	/** Eager observation bounds read latency: sessions a consumer has synced stay current. */
	observeSessions() {
		this.ctx.on("session/event", (session) => {
			this.tracked.add(session);
			if (this.states.has(session)) this._sync(session);
			if (session.events[session.events.length - 1]?.type === "turn/end") {
				this._sync(session);
				this.evaluateBudgets();
			}
		});
	}
	/** Catch one session's ledger up to the current durable tail. */
	_sync(session) {
		let state = this.states.get(session);
		if (state === void 0) {
			state = createLedgerState();
			this.states.set(session, state);
			this.tracked.add(session);
		}
		while (state.consumedEvents < session.events.length) {
			const event = session.events[state.consumedEvents];
			if (event === void 0) break;
			foldEvent(state, event, this.resolver);
			state.consumedEvents += 1;
		}
		return state;
	}
};
/** Snapshot metadata re-exported for surfaces that show provenance. */
const SNAPSHOT_VERSION = SNAPSHOT_DATE;
//#endregion
export { Config, CostMeter, CostMeter as default, DEEPSEEK_SNAPSHOT, NAMESPACE, NO_PROJECT, OVERVIEW_ROUTE, OpenRouterPriceFeed, SNAPSHOT_DATE, SNAPSHOT_VERSION, TOKENS_PER_UNIT, aggregateCosts, aggregateRows, assertLedgerConsistent, bucketRows, costOf, createLedgerState, createPriceResolver, crossingId, csvField, dayKey, defaultCachePath, evaluateBudgets, foldEvent, monthKey, normalizeThresholds, parseOpenRouterListing, resolveRate, sessionRows, snapshotRate, toCsv, toJsonl, toReport };
