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

import { useEffect, useState } from 'react'
import { OVERVIEW_ROUTE } from '../constants.ts'
import type { CostOverview } from '../index.ts'
import { formatUsd, toOverviewView, type OverviewView } from './overview-view.ts'

interface CostPanelProps {
  /** The settings shell's close affordance (unused here). */
  close: () => void
}

/** One settings-section page for the cost overview. */
export function CostPanel(_props: CostPanelProps): JSX.Element {
  const [view, setView] = useState<OverviewView>(() => toOverviewView(undefined))
  const [error, setError] = useState<string | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)

  const load = async (): Promise<void> => {
    setRefreshing(true)
    setError(undefined)
    try {
      const response = await fetch(OVERVIEW_ROUTE)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json() as CostOverview
      setView(toOverviewView(payload))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const budgeted = view.standings.filter((s) => s.amount !== undefined)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '24px', fontWeight: 600 }}>{formatUsd(view.totalCost)}</span>
        <button type="button" onClick={() => void load()} disabled={refreshing}>
          {refreshing ? '刷新中…' : '刷新'}
        </button>
      </div>
      <div style={{ opacity: 0.7, fontSize: '12px' }}>
        {view.totalCalls} 次调用 · {view.unpricedCalls} 次未定价
      </div>
      {error !== undefined && (
        <div style={{ color: '#c0392b', fontSize: '12px' }}>加载失败：{error}</div>
      )}

      {view.outdated.length > 0 && (
        <section style={{ border: '1px solid #e67e22', borderRadius: '4px', padding: '8px', background: '#fef9f0' }}>
          <h3 style={{ fontSize: '13px', margin: '0 0 6px', color: '#b9770e' }}>⚠️ 定价可能已过时</h3>
          <div style={{ fontSize: '12px' }}>
            以下手填价与最新已知价（{view.outdated[0]?.source}）不一致，请核对官方定价：
          </div>
          {view.outdated.map((o) => (
            <div key={`${o.provider}:${o.model}`} style={{ fontSize: '12px', marginTop: '4px', display: 'flex', justifyContent: 'space-between' }}>
              <span>{o.provider} / {o.model}</span>
              <span>手填 {o.manual} → 最新 {o.latest}</span>
            </div>
          ))}
        </section>
      )}

      {view.snapshot.stale && (
        <div style={{ color: '#b9770e', fontSize: '12px' }}>
          内置快照（{view.snapshot.date}）可能已过期，请核对官方价格。
        </div>
      )}

      {budgeted.length > 0 && (
        <section>
          <h3 style={{ fontSize: '13px', margin: '0 0 6px' }}>预算</h3>
          {budgeted.map((s) => (
            <div key={`${s.scope}:${s.key}`} style={{ marginBottom: '6px' }}>
              <div style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between' }}>
                <span>{s.scope} · {s.key}</span>
                <span>{formatUsd(s.spent ?? 0)} / {formatUsd(s.amount ?? 0)}</span>
              </div>
              <div style={{ background: '#eee', borderRadius: '3px', height: '6px', marginTop: '2px' }}>
                <div
                  style={{
                    background: (s.pct ?? 0) >= 100 ? '#c0392b' : (s.pct ?? 0) >= 80 ? '#e67e22' : '#2e86de',
                    borderRadius: '3px',
                    height: '6px',
                    width: `${Math.min(100, s.pct ?? 0)}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </section>
      )}

      <section>
        <h3 style={{ fontSize: '13px', margin: '0 0 6px' }}>按项目</h3>
        {view.projects.length === 0
          ? <div style={{ opacity: 0.6, fontSize: '12px' }}>暂无数据</div>
          : view.projects.map((p) => (
            <div key={p.key} style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between' }}>
              <span>{p.key}</span>
              <span>{formatUsd(p.cost)} · {p.calls} 次</span>
            </div>
          ))}
      </section>

      <section>
        <h3 style={{ fontSize: '13px', margin: '0 0 6px' }}>按月</h3>
        {view.months.length === 0
          ? <div style={{ opacity: 0.6, fontSize: '12px' }}>暂无数据</div>
          : view.months.map((m) => (
            <div key={m.key} style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between' }}>
              <span>{m.key}</span>
              <span>{formatUsd(m.cost)}</span>
            </div>
          ))}
      </section>
    </div>
  )
}
