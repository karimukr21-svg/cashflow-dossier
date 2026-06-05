import { useEffect, useMemo, useState } from 'react'
import { fetchActuals, fetchForecasts, type CfCell, type CfLine } from '@/lib/queries'
import { fmt, classNum } from '@/lib/format'
import type { Scope, Grain } from './Dossier'

export default function AreaDrill({ area, scope }: { area: string; scope: Scope }) {
  const [actuals, setActuals] = useState<(CfCell & { source_version: string })[]>([])
  const [forecasts, setForecasts] = useState<(CfCell & { version: string })[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const [a, f] = await Promise.all([
          fetchActuals({ fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth, area }),
          fetchForecasts({ version: scope.primaryVersion, fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth, area }),
        ])
        if (cancel) return
        setActuals(a); setForecasts(f)
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [area, scope.primaryVersion, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth])

  if (loading) return <div className="placeholder-box">Loading {area}…</div>

  return (
    <div>
      <h1>{area}</h1>
      <div style={{ height: 16 }} />
      <AreaCategoryCards
        actuals={actuals}
        forecasts={forecasts}
        lines={scope.lines}
        grain={scope.grain}
        scope={scope}
      />
    </div>
  )
}

/* Column-alignment constants (apply to every category card on the page so
 * columns line up vertically across sections). */
const LABEL_COL_PX = 220
const PERIOD_COL_PX = 80
const TOTAL_COL_PX = 100

export function AreaCategoryCards({
  actuals, forecasts, lines, grain, scope,
}: {
  actuals: CfCell[];
  forecasts: CfCell[];
  lines: CfLine[];
  grain: Grain;
  scope: Pick<Scope, 'fromYear' | 'fromMonth' | 'toYear' | 'toMonth' | 'latestActualYM'>;
}) {
  const groups = useMemo(() => {
    const g = new Map<string, { nature: string; category: string; lines: CfLine[] }>()
    lines.filter(l => l.is_active)
         .sort((a, b) => a.sort_order - b.sort_order)
         .forEach(l => {
           const key = `${l.nature}|${l.category}`
           if (!g.has(key)) g.set(key, { nature: l.nature, category: l.category, lines: [] })
           g.get(key)!.lines.push(l)
         })
    return [...g.values()]
  }, [lines])

  const columns = useMemo(() => buildColumns(grain, scope, scope.latestActualYM),
    [grain, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth, scope.latestActualYM])

  const colSum = (line_code: string, matches: (y: number, m: number) => boolean) => {
    let sum: number | null = null
    actuals.forEach(c => {
      if (c.line_code !== line_code) return
      if (!matches(c.year, c.month)) return
      sum = (sum ?? 0) + c.value
    })
    forecasts.forEach(c => {
      if (c.line_code !== line_code) return
      if (!matches(c.year, c.month)) return
      sum = (sum ?? 0) + c.value
    })
    return sum
  }

  const catTotal = (lineCodes: string[], matches: (y: number, m: number) => boolean) => {
    let t = 0; let touched = false
    lineCodes.forEach(lc => {
      const s = colSum(lc, matches)
      if (s != null) { t += s; touched = true }
    })
    return touched ? t : null
  }

  // Wrap everything in a horizontally-scrollable container so all tables
  // scroll together and columns stay aligned visually.
  const tableMinWidth = LABEL_COL_PX + (columns.length * PERIOD_COL_PX) + TOTAL_COL_PX

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: tableMinWidth }}>
        {groups.map(grp => {
          const natureClass = `nature-${grp.nature.toLowerCase()}`
          const periodTotal = catTotal(grp.lines.map(l => l.line_code), () => true) || 0
          return (
            <div key={`${grp.nature}|${grp.category}`} className="cat-group">
              <div className={`cat-group-header ${natureClass}`}>
                <span>{grp.nature} · {grp.category}</span>
                <span className="cat-totals">Period total: {fmt(periodTotal)}</span>
              </div>
              <table className="cf-table" style={{ tableLayout: 'fixed', width: tableMinWidth }}>
                <colgroup>
                  <col style={{ width: LABEL_COL_PX }} />
                  {columns.map(c => <col key={c.key} style={{ width: PERIOD_COL_PX }} />)}
                  <col style={{ width: TOTAL_COL_PX }} />
                </colgroup>
                <thead>
                  <tr>
                    <th className="label" style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}>Line</th>
                    {columns.map(c => (
                      <th key={c.key} className={c.isActual ? 'cell actual' : 'cell forecast'}>{c.label}</th>
                    ))}
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {grp.lines.map(l => {
                    const rowTotal = colSum(l.line_code, () => true)
                    return (
                      <tr key={l.line_code}>
                        <td className="label">{l.description}</td>
                        {columns.map(col => {
                          const v = colSum(l.line_code, col.matches)
                          return (
                            <td key={col.key} className={`${classNum(v)} ${col.isActual ? 'cell actual' : 'cell forecast'}`}>
                              {v == null ? '' : fmt(v)}
                            </td>
                          )
                        })}
                        <td className={`${classNum(rowTotal)}`} style={{ fontWeight: 500 }}>
                          {rowTotal == null ? '' : fmt(rowTotal)}
                        </td>
                      </tr>
                    )
                  })}
                  <tr className="total">
                    <td className="label">Subtotal</td>
                    {columns.map(col => {
                      const v = catTotal(grp.lines.map(l => l.line_code), col.matches)
                      return (
                        <td key={col.key} className={`${classNum(v)}`}>
                          {v == null ? '' : fmt(v)}
                        </td>
                      )
                    })}
                    <td className={classNum(periodTotal)}>{fmt(periodTotal)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function buildColumns(grain: Grain, scope: Pick<Scope, 'fromYear' | 'fromMonth' | 'toYear' | 'toMonth'>, asOfYM: number) {
  const cols: { key: string; label: string; matches: (y: number, m: number) => boolean; isActual: boolean }[] = []
  const months: { y: number; m: number }[] = []
  for (let y = scope.fromYear; y <= scope.toYear; y++) {
    const startM = y === scope.fromYear ? scope.fromMonth : 1
    const endM = y === scope.toYear ? scope.toMonth : 12
    for (let m = startM; m <= endM; m++) months.push({ y, m })
  }

  if (grain === 'monthly') {
    months.forEach(({ y, m }) => {
      const ym = y * 100 + m
      cols.push({
        key: `${y}-${m}`,
        label: `${String(y).slice(2)}-${String(m).padStart(2, '0')}`,
        matches: (yy, mm) => yy === y && mm === m,
        isActual: ym <= asOfYM,
      })
    })
  } else if (grain === 'quarterly') {
    const seen = new Set<string>()
    months.forEach(({ y, m }) => {
      const q = Math.ceil(m / 3)
      const key = `${y}-Q${q}`
      if (seen.has(key)) return
      seen.add(key)
      cols.push({
        key,
        label: `${String(y).slice(2)} Q${q}`,
        matches: (yy, mm) => yy === y && Math.ceil(mm / 3) === q,
        isActual: (y * 100 + q * 3) <= asOfYM,
      })
    })
  } else {
    const years = new Set(months.map(x => x.y))
    ;[...years].sort().forEach(y => {
      cols.push({
        key: `${y}`,
        label: `${y}`,
        matches: yy => yy === y,
        isActual: (y * 100 + 12) <= asOfYM,
      })
    })
  }
  return cols
}
