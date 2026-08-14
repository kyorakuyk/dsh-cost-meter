window.__ModuleLoader__.load({
	id: "dsh-cost-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/constants.ts
		/**
		* Shared constants between the host and browser halves.
		*
		* @module dsh-cost-meter/constants
		*/
		/** HTTP route the Web client fetches for the cost overview (M3). */
		const OVERVIEW_ROUTE = "/cost-meter/api/overview";
		//#endregion
		//#region src/client/overview-view.ts
		/** Format USD with two decimals and a thousands separator. */
		function formatUsd(value) {
			return `$${value.toLocaleString("en-US", {
				minimumFractionDigits: 2,
				maximumFractionDigits: 2
			})}`;
		}
		/** Build the panel view from the host payload; tolerates a missing/unusable payload. */
		function toOverviewView(payload) {
			const aggregate = payload?.aggregate;
			const projects = Object.entries(aggregate?.byProject ?? {}).map(([key, summary]) => ({
				key,
				cost: summary.cost,
				calls: summary.calls
			})).sort((a, b) => b.cost - a.cost);
			const months = Object.entries(aggregate?.byMonth ?? {}).map(([key, summary]) => ({
				key,
				cost: summary.cost
			})).sort((a, b) => a.key < b.key ? 1 : -1);
			return {
				totalCost: aggregate?.totalCost ?? 0,
				totalCalls: aggregate?.totalCalls ?? 0,
				unpricedCalls: aggregate?.totalUnpricedCalls ?? 0,
				projects,
				months,
				standings: payload?.standings ?? [],
				outdated: (payload?.outdated ?? []).map(toOutdatedView),
				snapshot: {
					date: payload?.snapshot?.date ?? "",
					stale: payload?.snapshot?.stale ?? false
				}
			};
		}
		function toOutdatedView(price) {
			return {
				provider: price.provider,
				model: price.model,
				manual: formatUsd(price.manualRate.input) + "/" + formatUsd(price.manualRate.output),
				latest: formatUsd(price.latestRate.input) + "/" + formatUsd(price.latestRate.output),
				source: price.latestSource
			};
		}
		//#endregion
		//#region src/client/CostPanel.tsx
		/**
		* Web cost panel (M3): a Settings → Cost section that fetches the host
		* overview route and renders totals, per-project/month buckets, and budget
		* progress. Pure presentation: the fold/aggregate all happens on the host.
		*
		* Component-local fetch state (the only channel for data only this component
		* knows) refreshes on mount and on manual refresh; no store, no subscriptions.
		*
		* @module dsh-cost-meter/client/CostPanel
		*/
		/** One settings-section page for the cost overview. */
		function CostPanel(_props) {
			const [view, setView] = (0, react.useState)(() => toOverviewView(void 0));
			const [error, setError] = (0, react.useState)(void 0);
			const [refreshing, setRefreshing] = (0, react.useState)(false);
			const load = async () => {
				setRefreshing(true);
				setError(void 0);
				try {
					const response = await fetch(OVERVIEW_ROUTE);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const payload = await response.json();
					setView(toOverviewView(payload));
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setRefreshing(false);
				}
			};
			(0, react.useEffect)(() => {
				load();
			}, []);
			const budgeted = view.standings.filter((s) => s.amount !== void 0);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: "12px",
					padding: "4px 0"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "baseline",
							justifyContent: "space-between"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: "24px",
								fontWeight: 600
							},
							children: formatUsd(view.totalCost)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => void load(),
							disabled: refreshing,
							children: refreshing ? "刷新中…" : "刷新"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							opacity: .7,
							fontSize: "12px"
						},
						children: [
							view.totalCalls,
							" 次调用 · ",
							view.unpricedCalls,
							" 次未定价"
						]
					}),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							color: "#c0392b",
							fontSize: "12px"
						},
						children: ["加载失败：", error]
					}),
					view.outdated.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: {
							border: "1px solid #e67e22",
							borderRadius: "4px",
							padding: "8px",
							background: "#fef9f0"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								style: {
									fontSize: "13px",
									margin: "0 0 6px",
									color: "#b9770e"
								},
								children: "⚠️ 定价可能已过时"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { fontSize: "12px" },
								children: [
									"以下手填价与最新已知价（",
									view.outdated[0]?.source,
									"）不一致，请核对官方定价："
								]
							}),
							view.outdated.map((o) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: "12px",
									marginTop: "4px",
									display: "flex",
									justifyContent: "space-between"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									o.provider,
									" / ",
									o.model
								] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									"手填 ",
									o.manual,
									" → 最新 ",
									o.latest
								] })]
							}, `${o.provider}:${o.model}`))
						]
					}),
					view.snapshot.stale && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							color: "#b9770e",
							fontSize: "12px"
						},
						children: [
							"内置快照（",
							view.snapshot.date,
							"）可能已过期，请核对官方价格。"
						]
					}),
					budgeted.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: {
							fontSize: "13px",
							margin: "0 0 6px"
						},
						children: "预算"
					}), budgeted.map((s) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { marginBottom: "6px" },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								fontSize: "12px",
								display: "flex",
								justifyContent: "space-between"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								s.scope,
								" · ",
								s.key
							] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								formatUsd(s.spent ?? 0),
								" / ",
								formatUsd(s.amount ?? 0)
							] })]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								background: "#eee",
								borderRadius: "3px",
								height: "6px",
								marginTop: "2px"
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
								background: (s.pct ?? 0) >= 100 ? "#c0392b" : (s.pct ?? 0) >= 80 ? "#e67e22" : "#2e86de",
								borderRadius: "3px",
								height: "6px",
								width: `${Math.min(100, s.pct ?? 0)}%`
							} })
						})]
					}, `${s.scope}:${s.key}`))] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: {
							fontSize: "13px",
							margin: "0 0 6px"
						},
						children: "按项目"
					}), view.projects.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							opacity: .6,
							fontSize: "12px"
						},
						children: "暂无数据"
					}) : view.projects.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							fontSize: "12px",
							display: "flex",
							justifyContent: "space-between"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: p.key }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							formatUsd(p.cost),
							" · ",
							p.calls,
							" 次"
						] })]
					}, p.key))] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: {
							fontSize: "13px",
							margin: "0 0 6px"
						},
						children: "按月"
					}), view.months.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							opacity: .6,
							fontSize: "12px"
						},
						children: "暂无数据"
					}) : view.months.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							fontSize: "12px",
							display: "flex",
							justifyContent: "space-between"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: m.key }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: formatUsd(m.cost) })]
					}, m.key))] })
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services: the slot registry. */
		const inject = ["slots"];
		/**
		* Mount the browser registrations.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "cost-meter",
				order: 90,
				label: "成本"
			}, CostPanel));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map