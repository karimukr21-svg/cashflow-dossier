import { useEffect, useMemo, useState } from 'react'
import { fetchActuals, fetchForecasts, type CfCell } from '@/lib/queries'
import { fmt, classNum } from '@/lib/format'
import type { Scope } from './Dossier'

type Grain = 'monthly' | 'quarterly' | 'yearly'

export default function AreaDrill({ area, scope }: { area: string; scope: Scope }) {
  const [actuals, setActuals] = useState<(CfCell & { source_version: string })[]>([])
  const [forecasts, setForecasts] = useState<(CfCell & { version: string })[]>([])
  const [loading, setLoading] = useState(true)

  // Smart default grain based on period span
  const monthSpan = (scope.toYear * 12 + scope.toMonth) - (scope.fromYear * 12 + scope.fromMonth) + 1
  const defaultGrain: Grain = monthSpan <= 18 ? 'monthly' : monthSpan <= 36 ? 'quarterly' : 'yearly'
  const [grain, setGrain] = useState<Grain>(defaultGrain)

  useEffect(() => { setGrain(defaultGrain) }, [scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth])

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

  // Column buckets based on grain
  const columns = useMemo(() => {
    const cols: { key: string; label: string; matches: (y: number, m: number) => boolean; isActual: (y: number, m: number) => boolean }[] = []
    // Build a list of (year, month) months in scope
    const months: { y: number; m: number }[] = []
    for (let y = scope.fromYear; y <= scope.toYear; y++) {
      const startM = y === scope.fromYear ? scope.fromMonth : 1
      const endM = y === scope.toYear ? scope.toMonth : 12
      for (let m = startM; m <= endM; m++) months.push({ y, m })
    }

    // Determine as_of cutover from actuals data: max year-month present in actuals
    const asOfYM = actuals.reduce((mx, c) => Math.max(mx, c.year * 100 + c.month), 0)

    if (grain === 'monthly') {
      months.forEach(({ y, m }) => {
        const ym = y * 100 + m
        cols.push({
          key: `${y}-${m}`,
          label: `${String(y).slice(2)} ${String(m).padStart(2, '0')}`,
          matches: (yy, mm) => yy === y && mm === m,
          isActual: () => ym <= asOfYM,
        })
      })
    } else if (grain === 'quarterly') {
      const quarters = new Map<string, { y: number; q: number }>()
      months.forEach(({ y, m }) => {
        const q = Math.ceil(m / 3)
        quarters.set(`${y}-Q${q}`, { y, q })
      })
      ;[...quarters.entries()].forEach(([key, { y, q }]) => {
        cols.push({
          key,
          label: `${String(y).slice(2)} Q${q}`,
          matches: (yy, mm) => yy === y && Math.ceil(mm / 3) === q,
          isActual: () => (y * 100 + q * 3) <= asOfYM,
        })
      })
    } else {
      // yearly
      const years = new Set(months.map(x => x.y))
      ;[...years].sort().forEach(y => {
        cols.push({
          key: `${y}`,
          label: `${y}`,
          matches: (yy, _mm) => yy === y,
          isActual: () => (y * 100 + 12) <= asOfYM,
        })
      })
    }

    return cols
  }, [grain, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth, actuals])

  if (loading) return <div className="placeholder-box">Loading {area}…</div>

  // Group lines by category, then list
  const linesByCategory = new Map<string, typeof scope.lines>()
  scope.lines.filter(l => l.is_active).sort((a, b) => a.sort_order - b.sort_order).forEach(l => {
    const key = `${l.nature} · ${l.category}`
    if (!linesByCategory.has(key)) linesByCategory.set(key, [])
    linesByCategory.get(key)!.push(l)
  })

  // Build cell value lookup
  const valueOf = (line_code: string, year: number, month: number) => {
    // Actual takes precedence over forecast for the same cell
    const a = actuals.find(c => c.line_code === line_code && c.year === year && c.month === month)
    if (a) return { v: a.value, isActual: true }
    const f = forecasts.find(c => c.line_code === line_code && c.year === year && c.month === month)
    if (f) return { v: f.value, isActual: false }
    return { v: null as number | null, isActual: false }
  }

  const colSum = (line_code: string, col: typeof columns[0]) => {
    let sum: number | null = null
    let touched = false
    actuals.concat(forecasts as any).forEach((c: any) => {
      if (c.line_code !== line_code) return
      if (!col.matches(c.year, c.month)) return
      sum = (sum ?? 0) + c.value
      touched = true
    })
    return touched ? sum : null
  }

  return (
    <div>
      <h1>{area}</h1>
      <div className="sub">
        Full cash structure. Tinted cells = Actual; white cells = Forecast.
        {' · '}Period {scope.fromYear}-{String(scope.fromMonth).padStart(2, '0')} → {scope.toYear}-{String(scope.toMonth).padStart(2, '0')}
        {' · '}Forecast version <b>{scope.primaryVersion}</b>{' · USD K'}
        <span style={{ marginLeft: 16 }}>
          Grain:{' '}
          {(['monthly', 'quarterly', 'yearly'] as Grain[]).map(g => (
            <button key={g}
              onClick={() => setGrain(g)}
              style={{
                border: 'none', background: grain === g ? 'var(--crimson)' : 'transparent',
                color: grain === g ? 'white' : 'var(--mute)',
                padding: '2px 8px', borderRadius: 3, cursor: 'pointer', marginRight: 4, fontSize: 12,
              }}>
              {g}
            </button>
          ))}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="cf-table" style={{ minWidth: 800 }}>
          <thead>
            <tr>
              <th className="label" style={{ minWidth: 240, position: 'sticky', left: 0, background: 'var(--surface-alt)' }}>Line</th>
              {columns.map(c => (
                <th key={c.key} className={c.isActual(0, 0) ? 'cell actual' : 'cell forecast'}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...linesByCategory.entries()].map(([cat, lines]) => (
              <CategoryRows key={cat} cat={cat} lines={lines} columns={columns} colSum={colSum} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CategoryRows({ cat, lines, columns, colSum }: any) {
  return (
    <>
      <tr style={{ background: 'var(--surface-alt)' }}>
        <td className="label" colSpan={columns.length + 1} style={{ fontWeight: 500, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--mute)' }}>
          {cat}
        </td>
      </tr>
      {lines.map((l: any) => (
        <tr key={l.line_code}>
          <td className="label">{l.description}</td>
          {columns.map((col: any) => {
            const v = colSum(l.line_code, col)
            return (
              <td key={col.key} className={`${classNum(v)} ${col.isActual(0,0) ? 'cell actual' : 'cell forecast'}`}>
                {v == null ? '' : fmt(v)}
              </td>
            )
          })}
        </tr>
      ))}
    </>
  )
}
