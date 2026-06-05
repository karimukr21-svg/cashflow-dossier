import { useEffect, useMemo, useState } from 'react'
import { fetchActuals, fetchForecasts, type CfCell } from '@/lib/queries'
import { fmt, classNum } from '@/lib/format'
import { AreaCategoryCards } from './AreaDrill'
import type { Scope } from './Dossier'

export default function AllAreas({ scope }: { scope: Scope }) {
  const [actuals, setActuals] = useState<(CfCell & { source_version: string })[]>([])
  const [forecasts, setForecasts] = useState<(CfCell & { version: string })[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const [a, f] = await Promise.all([
          fetchActuals({ fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth }),
          fetchForecasts({ version: scope.primaryVersion, fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth }),
        ])
        if (cancel) return
        setActuals(a); setForecasts(f)
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [scope.primaryVersion, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth])

  const byArea = useMemo(() => {
    const map = new Map<string, { receipts: number; payments: number; net: number; actualsRows: CfCell[]; forecastsRows: CfCell[] }>()
    const lineKind = new Map(scope.lines.map(l => [l.line_code, l.nature]))
    const get = (a: string) => {
      if (!map.has(a)) map.set(a, { receipts: 0, payments: 0, net: 0, actualsRows: [], forecastsRows: [] })
      return map.get(a)!
    }
    actuals.forEach(c => {
      const e = get(c.area)
      e.actualsRows.push(c)
      const k = lineKind.get(c.line_code)
      if (k === 'Receipts') e.receipts += c.value
      else if (k === 'Payments') e.payments += c.value
    })
    forecasts.forEach(c => {
      const e = get(c.area)
      e.forecastsRows.push(c)
      const k = lineKind.get(c.line_code)
      if (k === 'Receipts') e.receipts += c.value
      else if (k === 'Payments') e.payments += c.value
    })
    map.forEach(e => { e.net = e.receipts + e.payments })
    return map
  }, [actuals, forecasts, scope.lines])

  const toggle = (area: string) => {
    const next = new Set(expanded)
    if (next.has(area)) next.delete(area)
    else next.add(area)
    setExpanded(next)
  }

  const expandAll = () => setExpanded(new Set(scope.areas))
  const collapseAll = () => setExpanded(new Set())

  if (loading) return <div className="placeholder-box">Loading…</div>

  return (
    <div>
      <h1>All Areas</h1>
      <div style={{ display: 'flex', gap: 8, margin: '0 0 16px' }}>
        <button className="pill-btn" onClick={expandAll}
                style={{ background: 'var(--surface-alt)', border: '1px solid var(--border)' }}>Expand all</button>
        <button className="pill-btn" onClick={collapseAll}
                style={{ background: 'var(--surface-alt)', border: '1px solid var(--border)' }}>Collapse all</button>
      </div>

      {scope.areas.map(area => {
        const e = byArea.get(area)
        if (!e) return null
        const isExpanded = expanded.has(area)
        return (
          <div key={area} className="area-card">
            <div className={`area-card-header ${isExpanded ? 'expanded' : ''}`} onClick={() => toggle(area)}>
              <span className="chevron">▶</span>
              <span className="area-name">{area}</span>
              <div className="area-mini">
                <div className="mini-item"><span className="ml">Receipts</span><span className={classNum(e.receipts)}>{fmt(e.receipts)}</span></div>
                <div className="mini-item"><span className="ml">Payments</span><span className={classNum(e.payments)}>{fmt(e.payments)}</span></div>
                <div className="mini-item"><span className="ml">Net</span><span className={classNum(e.net)}>{fmt(e.net)}</span></div>
              </div>
            </div>
            {isExpanded && (
              <div className="area-card-body">
                <AreaCategoryCards
                  actuals={e.actualsRows}
                  forecasts={e.forecastsRows}
                  lines={scope.lines}
                  grain={scope.grain}
                  scope={scope}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
