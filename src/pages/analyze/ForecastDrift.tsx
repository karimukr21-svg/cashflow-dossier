import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  fetchForecastCells, fetchAreaMeta, fetchProjectsMeta, netFlow,
  resolveAreaMeta, groupRank,
  type ProjectCell, type AreaMeta, type CfProjectMeta, type AreaGroupName,
} from '@/lib/projectQueries'
import { fmt, fmtDelta, classNum } from '@/lib/format'
import type { AnalyzeScope } from './AnalyzeShell'
import { monthName } from './AnalyzeShell'

type Props = {
  scope: AnalyzeScope
  setUrl: (patch: Record<string, string | null>) => void
  focusArea: string | null
}

/* Forecast drift = how the forecast for the same future periods changed from
 * one cycle to the next. Compares two cycles' forecasts over the periods both
 * still treat as forecast (after the later cutover). Drift = B − A. */
export default function ForecastDrift({ scope }: Props) {
  const [cellsA, setCellsA] = useState<ProjectCell[]>([])
  const [cellsB, setCellsB] = useState<ProjectCell[]>([])
  const [areaMeta, setAreaMeta] = useState<Map<string, AreaMeta>>(new Map())
  const [projMeta, setProjMeta] = useState<Map<string, CfProjectMeta>>(new Map())
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<Set<string>>(new Set())

  const va = scope.versions.find(v => v.version_code === scope.primaryVersion)
  const vb = scope.versions.find(v => v.version_code === scope.compareVersion)
  const samePick = scope.primaryVersion === scope.compareVersion

  useEffect(() => {
    if (samePick || !scope.compareVersion) { setLoading(false); return }
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const [a, b, am, pm] = await Promise.all([
          fetchForecastCells({ version: scope.primaryVersion, fromYear: scope.fromYear, toYear: scope.toYear }),
          fetchForecastCells({ version: scope.compareVersion, fromYear: scope.fromYear, toYear: scope.toYear }),
          fetchAreaMeta(),
          fetchProjectsMeta(),
        ])
        if (cancel) return
        setCellsA(a); setCellsB(b); setAreaMeta(am); setProjMeta(pm)
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [scope.primaryVersion, scope.compareVersion, scope.fromYear, scope.toYear, samePick])

  const cutover = useMemo(() => {
    const p = (s?: string) => { if (!s) return 0; const [y, m] = s.split('-').map(Number); return y * 100 + m }
    return Math.max(p(va?.as_of_date), p(vb?.as_of_date))
  }, [va, vb])

  const fromYM = scope.fromYear * 100 + scope.fromMonth
  const toYM = scope.toYear * 100 + scope.toMonth
  const winLo = Math.max(cutover + 1, fromYM)
  const winHi = toYM
  const inWindow = (y: number, m: number) => {
    const ym = y * 100 + m
    return ym > cutover && ym >= fromYM && ym <= toYM
  }

  const areas = useMemo(() => {
    const s = new Set<string>()
    for (const c of cellsA) s.add(c.area)
    for (const c of cellsB) s.add(c.area)
    return s
  }, [cellsA, cellsB])

  const aByArea = useMemo(() => groupByArea(cellsA), [cellsA])
  const bByArea = useMemo(() => groupByArea(cellsB), [cellsB])

  const groups = useMemo(() => {
    const g = new Map<AreaGroupName, string[]>()
    for (const area of areas) {
      const meta = resolveAreaMeta(area, areaMeta)
      if (!g.has(meta.group_name)) g.set(meta.group_name, [])
      g.get(meta.group_name)!.push(area)
    }
    for (const arr of g.values())
      arr.sort((a, b) => resolveAreaMeta(a, areaMeta).sort_order - resolveAreaMeta(b, areaMeta).sort_order || a.localeCompare(b))
    return [...g.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0]))
  }, [areas, areaMeta])

  if (samePick) return <div className="placeholder-box">Pick two different cycles to compare (use the “vs cycle” pills).</div>
  if (loading) return <div className="placeholder-box">Loading…</div>
  if (!va || !vb) return <div className="placeholder-box">Cycle not found.</div>
  if (winLo > winHi) return (
    <div className="placeholder-box">
      No overlapping forecast window for {va.version_code} vs {vb.version_code} within the chosen period — widen the period range.
    </div>
  )

  const ymLabel = (ym: number) => `${monthName(ym % 100)} ${Math.floor(ym / 100)}`
  const projectName = (code: string) =>
    code === '_AREA' ? 'Area-level items' : (projMeta.get(code)?.display_name || code)

  const cmpRow = (subA: ProjectCell[], subB: ProjectCell[]) => {
    const a = netFlow(subA, inWindow)
    const b = netFlow(subB, inWindow)
    const drift = b - a
    const pct = Math.abs(a) > 0.5 ? (drift / Math.abs(a)) * 100 : null
    return { a, b, drift, pct }
  }
  const Cells = ({ a, b, drift, pct }: { a: number; b: number; drift: number; pct: number | null }) => (
    <>
      <td className={classNum(a)}>{fmt(a)}</td>
      <td className={classNum(b)}>{fmt(b)}</td>
      <td className={classNum(drift)}>{fmtDelta(drift)}</td>
      <td className={classNum(pct)}>{pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`}</td>
    </>
  )

  return (
    <div>
      <h1>Forecast Drift</h1>
      <div className="sub">
        How the forward forecast changed from <strong>{va.version_code}</strong> to <strong>{vb.version_code}</strong> for
        the periods both still treat as forecast. Drift = {vb.version_code} − {va.version_code}.
      </div>
      <div className="accuracy-window">
        Window · {ymLabel(winLo)} → {ymLabel(winHi)} <span className="accuracy-window-note">(both forecasting after {ymLabel(cutover)})</span>
      </div>
      <div className="table-scroll">
        <table className="cf-table" style={{ minWidth: 360 }}>
          <colgroup>
            <col style={{ width: 280 }} /><col style={{ width: 120 }} /><col style={{ width: 120 }} /><col style={{ width: 120 }} /><col style={{ width: 80 }} />
          </colgroup>
          <thead>
            <tr>
              <th className="label">Area / project</th>
              <th>{va.version_code}</th>
              <th>{vb.version_code}</th>
              <th>Drift</th>
              <th>%</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(([group, gAreas]) => {
              const subA = gAreas.flatMap(a => aByArea.get(a) || [])
              const subB = gAreas.flatMap(a => bByArea.get(a) || [])
              const g = cmpRow(subA, subB)
              return (
                <Fragment key={group}>
                  <tr className="pivot-section-row">
                    <td className="label">{group.toUpperCase()}</td>
                    <Cells {...g} />
                  </tr>
                  {gAreas.map(area => {
                    const sA = aByArea.get(area) || []
                    const sB = bByArea.get(area) || []
                    const r = cmpRow(sA, sB)
                    const isOpen = open.has(area)
                    const codes = [...new Set([...sA, ...sB].map(c => c.project_code))]
                    return (
                      <Fragment key={area}>
                        <tr className={`pivot-area-row clickable ${isOpen ? 'open' : ''}`}
                          onClick={() => setOpen(p => { const n = new Set(p); n.has(area) ? n.delete(area) : n.add(area); return n })}>
                          <td className="label"><span className="pivot-card-chev">▶</span>{area}</td>
                          <Cells {...r} />
                        </tr>
                        {isOpen && codes
                          .sort((x, y) => (x === '_AREA' ? 1 : 0) - (y === '_AREA' ? 1 : 0) || projectName(x).localeCompare(projectName(y)))
                          .map(code => {
                            const pr = cmpRow(sA.filter(c => c.project_code === code), sB.filter(c => c.project_code === code))
                            return (
                              <tr key={`${area}-${code}`} className="drill-line-row">
                                <td className="label" style={{ paddingLeft: 40 }}>{projectName(code)}</td>
                                <Cells {...pr} />
                              </tr>
                            )
                          })}
                      </Fragment>
                    )
                  })}
                </Fragment>
              )
            })}
            <tr className="total net-row">
              <td className="label">ALL AREAS</td>
              <Cells {...cmpRow(cellsA, cellsB)} />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

function groupByArea(cells: ProjectCell[]): Map<string, ProjectCell[]> {
  const m = new Map<string, ProjectCell[]>()
  for (const c of cells) {
    if (!m.has(c.area)) m.set(c.area, [])
    m.get(c.area)!.push(c)
  }
  return m
}
