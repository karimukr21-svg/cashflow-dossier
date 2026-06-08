import { useEffect, useMemo, useState } from 'react'
import { useScenario } from '../lib/ScenarioContext'
import { fetchActuals, fetchForecasts, type CfCell, type CfLine } from '../lib/queries'
import { applyDeltaToCell } from '../lib/scenario'

type Props = {
  lines: CfLine[]
  primaryVersionCode: string
  currentYear: number      // year whose end we project to
}

/* Pinned strip showing the 3 numbers a CFO cares about, always live:
 *   Year-end Cash · Treasury Ask · Δ vs Baseline
 *
 * Both baseline and scenario values are derived from the same baseline
 * cell set — scenario applies workingIndex + savedIndex on top. */
export function ScenarioTileBar({ lines, primaryVersionCode, currentYear }: Props) {
  const { activeId, workingIndex, savedIndex } = useScenario()
  const [cells, setCells] = useState<CfCell[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (activeId === 'baseline' || !primaryVersionCode) return
    let cancel = false
    setLoading(true)
    Promise.all([
      fetchActuals({ fromYear: currentYear, fromMonth: 1, toYear: currentYear, toMonth: 12 }),
      fetchForecasts({ version: primaryVersionCode, fromYear: currentYear, fromMonth: 1, toYear: currentYear, toMonth: 12 }),
    ])
      .then(([a, f]) => {
        if (cancel) return
        const all: CfCell[] = []
        for (const r of a) all.push({ area: r.area, line_code: r.line_code, year: r.year, month: r.month, value: r.value })
        for (const r of f) all.push({ area: r.area, line_code: r.line_code, year: r.year, month: r.month, value: r.value })
        setCells(all)
      })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [activeId, primaryVersionCode, currentYear])

  const cashLineCodes = useMemo(() => {
    const out = new Set<string>()
    for (const l of lines) if (l.nature !== 'Balance') out.add(l.line_code)
    return out
  }, [lines])

  const { baselineSum, scenarioSum } = useMemo(() => {
    let b = 0, s = 0
    for (const c of cells) {
      if (!cashLineCodes.has(c.line_code)) continue
      b += c.value
      s += applyDeltaToCell(workingIndex, savedIndex, c.area, c.line_code, c.year, c.month, c.value)
    }
    return { baselineSum: b, scenarioSum: s }
  }, [cells, cashLineCodes, workingIndex, savedIndex])

  if (activeId === 'baseline') return null

  const delta = scenarioSum - baselineSum
  const treasuryAsk = scenarioSum < 0 ? scenarioSum : 0  // negative-side only
  const baselineAsk = baselineSum < 0 ? baselineSum : 0

  return (
    <div className="tile-bar">
      <div className="tile">
        <div className="tile-eyebrow">Year-end {currentYear} cash</div>
        <div className={`tile-value ${scenarioSum < 0 ? 'neg' : 'pos'}`}>
          {fmt(scenarioSum)}
          {!loading && (
            <span className="tile-delta">{delta >= 0 ? '+' : ''}{fmt(delta, true)}</span>
          )}
        </div>
      </div>
      <div className="tile">
        <div className="tile-eyebrow">Treasury ask</div>
        <div className={`tile-value ${treasuryAsk < 0 ? 'neg' : 'pos'}`}>
          {treasuryAsk < 0 ? fmt(treasuryAsk) : '—'}
          {!loading && treasuryAsk < 0 && (
            <span className="tile-delta">{(treasuryAsk - baselineAsk) >= 0 ? '+' : ''}{fmt(treasuryAsk - baselineAsk, true)}</span>
          )}
        </div>
      </div>
      <div className="tile">
        <div className="tile-eyebrow">Δ vs baseline</div>
        <div className={`tile-value ${delta < 0 ? 'neg' : delta > 0 ? 'pos' : ''}`}>
          {loading ? '…' : (delta >= 0 ? `+${fmt(delta, true)}` : fmt(delta, true))}
        </div>
      </div>
    </div>
  )
}

function fmt(n: number, plain = false): string {
  const abs = Math.abs(n)
  let v: string
  if (abs >= 1e9) v = `${(n / 1e9).toFixed(1)}B`
  else if (abs >= 1e6) v = `${(n / 1e6).toFixed(1)}M`
  else if (abs >= 1e3) v = `${(n / 1e3).toFixed(0)}K`
  else v = n.toFixed(0)
  return plain ? v : v
}
