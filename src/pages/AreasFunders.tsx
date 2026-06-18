import { Fragment, useEffect, useMemo, useState } from 'react'
import { fetchActuals, fetchForecasts, type CfCell, type CanonicalArea } from '@/lib/queries'
import type { Scope } from './Dossier'

/* Areas — Funders vs Consumers
 * ─────────────────────────────
 * Baseline-only view (no scenario plumbing yet — that lands in Step 9).
 * Per canonical area, sum non-Balance line values per month in the topbar
 * period. Bar per month, +ve (green) = funder, −ve (red) = consumer.
 * Sort by absolute net contribution, split into funders block then
 * consumers block (a thin "flip" separator marks the boundary).
 * Row click → existing per-area drill.
 *
 * Data path:
 *   cf_actuals + cf_forecasts (table-direct via queries.ts)
 *     ↓ filter where line.nature !== 'Balance'
 *     ↓ resolve cf_actuals.area → CanonicalArea via scope.cfToCanonical
 *     ↓ sum (canonical_area_id, year, month)
 *
 * Period: comes from the topbar Period control via scope.fromYear/fromMonth/toYear/toMonth.
 * No in-page selector — topbar is the global control.
 */

type MonthlySum = { ym: number; value: number }
type AreaRow = {
  area: CanonicalArea
  monthly: MonthlySum[]
  net: number
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatM(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(0)}K`
  return value.toFixed(0)
}

function enumerateMonths(fromYear: number, fromMonth: number, toYear: number, toMonth: number): number[] {
  const out: number[] = []
  let y = fromYear, m = fromMonth
  while (y < toYear || (y === toYear && m <= toMonth)) {
    out.push(y * 100 + m)
    m++
    if (m > 12) { m = 1; y++ }
  }
  return out
}

export default function AreasFunders({ scope, onSelectArea }: { scope: Scope; onSelectArea: (areaId: string) => void }) {
  const [actuals, setActuals] = useState<(CfCell & { source_version: string })[]>([])
  const [forecasts, setForecasts] = useState<(CfCell & { version: string })[]>([])
  const [loading, setLoading] = useState(true)

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

  /* Non-Balance line filter: receipts + payments sum gives net cash to/from
   * area. Payments are stored negative (Karim's convention), so a simple sum
   * yields the signed net. Balance lines (cash position) are NOT cash flows
   * and would double-count. */
  const cashLineCodes = useMemo(() => {
    const set = new Set<string>()
    for (const l of scope.lines) if (l.nature !== 'Balance') set.add(l.line_code)
    return set
  }, [scope.lines])

  const months = useMemo(
    () => enumerateMonths(scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth),
    [scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth],
  )

  /* Sum cf_actuals + cf_forecasts (whichever has the row for that month) by
   * (canonical_area_id, ym). One pass over each source. Forecasts only cover
   * months > latestActualYM in practice but we don't gate on that — we just
   * sum whatever the row says, mirroring how Overall.tsx treats the two
   * streams as additive. */
  const rows: AreaRow[] = useMemo(() => {
    if (loading) return []
    const acc = new Map<string, Map<number, number>>()
    const bump = (areaId: string, ym: number, v: number) => {
      let row = acc.get(areaId)
      if (!row) { row = new Map(); acc.set(areaId, row) }
      row.set(ym, (row.get(ym) || 0) + v)
    }
    const process = (r: CfCell) => {
      if (!cashLineCodes.has(r.line_code)) return
      const canonical = scope.cfToCanonical.get(r.area)
      if (!canonical) return  // orphan area, skip per house rule
      const v = r.value
      bump(canonical.area_id, r.year * 100 + r.month, v)
    }
    for (const r of actuals) process(r)
    for (const r of forecasts) process(r)

    /* Build AreaRow[] over selectedAreas so the topbar Areas chip works.
     * Areas with zero net + no monthly activity in the period still render
     * (helps the user see "this area is dormant in the window"). */
    const out: AreaRow[] = scope.selectedAreas.map(area => {
      const monthMap = acc.get(area.area_id) || new Map<number, number>()
      const monthly: MonthlySum[] = months.map(ym => ({ ym, value: monthMap.get(ym) || 0 }))
      const net = monthly.reduce((s, m) => s + m.value, 0)
      return { area, monthly, net }
    })
    return out.sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
  }, [loading, actuals, forecasts, cashLineCodes, scope.cfToCanonical, scope.selectedAreas, months])

  /* Bar scaling — single global max(abs) across every monthly cell so bars
   * are comparable across areas and months. Net column uses its own scale
   * (max abs net) so the leftmost net bar reaches full width. */
  const { monthlyMax, netMax } = useMemo(() => {
    let mm = 0, nm = 0
    for (const r of rows) {
      if (Math.abs(r.net) > nm) nm = Math.abs(r.net)
      for (const m of r.monthly) if (Math.abs(m.value) > mm) mm = Math.abs(m.value)
    }
    return { monthlyMax: mm || 1, netMax: nm || 1 }
  }, [rows])

  const funders = rows.filter(r => r.net > 0)
  const consumers = rows.filter(r => r.net < 0)
  const dormant = rows.filter(r => r.net === 0)
  const flipIndex = funders.length  // where the consumer block begins

  const top5Funders = funders.slice(0, 5)
  const top5Consumers = [...consumers].sort((a, b) => a.net - b.net).slice(0, 5)

  if (loading) return <div className="placeholder-box">Loading…</div>

  return (
    <div className="funders-page">
      <h1>Areas — Funders vs Consumers</h1>
      <div className="funders-subtitle">
        Net cash contribution per area · {scope.fromYear}-{String(scope.fromMonth).padStart(2, '0')} →
        {' '}{scope.toYear}-{String(scope.toMonth).padStart(2, '0')} ·
        {' '}{funders.length} funders / {consumers.length} consumers{dormant.length > 0 ? ` / ${dormant.length} dormant` : ''}
      </div>

      <div className="funders-layout">
        <div className="funders-grid-wrap">
          <table className="funders-grid">
            <thead>
              <tr>
                <th className="funders-col-area">Area</th>
                {months.map(ym => (
                  <th key={ym} className="funders-col-month">{MONTH_NAMES[(ym % 100) - 1]}</th>
                ))}
                <th className="funders-col-net">Net</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <Fragment key={r.area.area_id}>
                  {idx === flipIndex && consumers.length > 0 && (
                    <tr className="funders-flip-row">
                      <td colSpan={months.length + 2}>
                        <span>flip · funders above / consumers below</span>
                      </td>
                    </tr>
                  )}
                  <tr
                    className="funders-row"
                    onClick={() => onSelectArea(r.area.area_id)}
                    title={`Open ${r.area.display_name} drill`}
                  >
                    <td className="funders-col-area" title={r.area.display_name}>{r.area.display_name}</td>
                    {r.monthly.map(m => (
                      <td key={m.ym} className="funders-col-month">
                        <MonthBar value={m.value} max={monthlyMax} />
                      </td>
                    ))}
                    <td className="funders-col-net">
                      <NetBar value={r.net} max={netMax} />
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <aside className="funders-side">
          <div className="funders-side-block">
            <div className="funders-side-title">Top 5 funders</div>
            {top5Funders.length === 0 && <div className="funders-side-empty">No funders in period.</div>}
            {top5Funders.map(r => (
              <div key={r.area.area_id} className="funders-side-row" onClick={() => onSelectArea(r.area.area_id)}>
                <span className="funders-side-name">{r.area.display_name}</span>
                <span className="funders-side-val funders-pos">+{formatM(r.net)}</span>
              </div>
            ))}
          </div>
          <div className="funders-side-block">
            <div className="funders-side-title">Top 5 consumers</div>
            {top5Consumers.length === 0 && <div className="funders-side-empty">No consumers in period.</div>}
            {top5Consumers.map(r => (
              <div key={r.area.area_id} className="funders-side-row" onClick={() => onSelectArea(r.area.area_id)}>
                <span className="funders-side-name">{r.area.display_name}</span>
                <span className="funders-side-val funders-neg">{formatM(r.net)}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}

/* Per-month bar. Centered on a vertical axis; positive grows right (green),
 * negative grows left (red). Bar width = pct of monthlyMax. */
function MonthBar({ value, max }: { value: number; max: number }) {
  if (value === 0) return <div className="funders-bar-cell" />
  const pct = Math.min(100, (Math.abs(value) / max) * 100)
  const isPos = value > 0
  return (
    <div className="funders-bar-cell" title={formatM(value)}>
      <div className="funders-bar-axis" />
      <div
        className={`funders-bar ${isPos ? 'funders-pos' : 'funders-neg'}`}
        style={{
          width: `${pct / 2}%`,
          left: isPos ? '50%' : `${50 - pct / 2}%`,
        }}
      />
    </div>
  )
}

/* Net column bar — same axis pattern, but wider cell and shows the formatted
 * number alongside the bar. */
function NetBar({ value, max }: { value: number; max: number }) {
  if (value === 0) return <div className="funders-net-cell"><span className="funders-net-label">—</span></div>
  const pct = Math.min(100, (Math.abs(value) / max) * 100)
  const isPos = value > 0
  return (
    <div className="funders-net-cell" title={formatM(value)}>
      <div className="funders-bar-axis" />
      <div
        className={`funders-bar ${isPos ? 'funders-pos' : 'funders-neg'}`}
        style={{
          width: `${pct / 2}%`,
          left: isPos ? '50%' : `${50 - pct / 2}%`,
        }}
      />
      <span className={`funders-net-label ${isPos ? 'funders-pos' : 'funders-neg'}`}>
        {isPos ? '+' : ''}{formatM(value)}
      </span>
    </div>
  )
}
