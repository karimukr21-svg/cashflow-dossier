import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  fetchProjectCells, fetchAreaMeta, fetchProjectsMeta, netFlow,
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

/* Forecast accuracy = overlay the continuous actuals on a chosen cycle's
 * forecast for the periods that cycle forecasted and have since actualized.
 * Variance = actual − forecast (positive = beat the forecast on net cash). */
export default function ForecastAccuracy({ scope }: Props) {
  const [cells, setCells] = useState<ProjectCell[]>([])
  const [areaMeta, setAreaMeta] = useState<Map<string, AreaMeta>>(new Map())
  const [projMeta, setProjMeta] = useState<Map<string, CfProjectMeta>>(new Map())
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<Set<string>>(new Set())

  const version = scope.versions.find(v => v.version_code === scope.primaryVersion)

  useEffect(() => {
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const [c, am, pm] = await Promise.all([
          fetchProjectCells({ version: scope.primaryVersion, fromYear: scope.fromYear, toYear: scope.toYear }),
          fetchAreaMeta(),
          fetchProjectsMeta(),
        ])
        if (cancel) return
        setCells(c); setAreaMeta(am); setProjMeta(pm)
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [scope.primaryVersion, scope.fromYear, scope.toYear])

  const dYM = useMemo(() => {
    if (!version) return 0
    const [y, m] = version.as_of_date.split('-').map(Number)
    return y * 100 + m
  }, [version])

  const fromYM = scope.fromYear * 100 + scope.fromMonth
  const toYM = scope.toYear * 100 + scope.toMonth
  const winLo = Math.max(dYM + 1, fromYM) // first forecast period after cutover
  const winHi = Math.min(scope.latestActualYM, toYM)

  const inWindow = (y: number, m: number) => {
    const ym = y * 100 + m
    return ym > dYM && ym <= scope.latestActualYM && ym >= fromYM && ym <= toYM
  }

  const windowEmpty = winLo > winHi

  const byArea = useMemo(() => {
    const m = new Map<string, ProjectCell[]>()
    for (const c of cells) {
      if (!m.has(c.area)) m.set(c.area, [])
      m.get(c.area)!.push(c)
    }
    return m
  }, [cells])

  const groups = useMemo(() => {
    const g = new Map<AreaGroupName, string[]>()
    for (const area of byArea.keys()) {
      const meta = resolveAreaMeta(area, areaMeta)
      if (!g.has(meta.group_name)) g.set(meta.group_name, [])
      g.get(meta.group_name)!.push(area)
    }
    for (const arr of g.values())
      arr.sort((a, b) => resolveAreaMeta(a, areaMeta).sort_order - resolveAreaMeta(b, areaMeta).sort_order || a.localeCompare(b))
    return [...g.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0]))
  }, [byArea, areaMeta])

  if (loading) return <div className="placeholder-box">Loading…</div>
  if (!version) return <div className="placeholder-box">Cycle not found.</div>

  const ymLabel = (ym: number) => `${monthName(ym % 100)} ${Math.floor(ym / 100)}`

  const projectName = (code: string) =>
    code === '_AREA' ? 'Area-level items' : (projMeta.get(code)?.display_name || code)

  const Row = ({ label, subset, kind, indent }: {
    label: React.ReactNode; subset: ProjectCell[]; kind: 'group' | 'area' | 'project'; indent?: number
  }) => {
    const f = netFlow(subset, inWindow, 'Forecast')
    const a = netFlow(subset, inWindow, 'Actual')
    const variance = a - f
    const pct = Math.abs(f) > 0.5 ? (variance / Math.abs(f)) * 100 : null
    const cls = kind === 'group' ? 'pivot-section-row'
      : kind === 'area' ? 'pivot-area-row clickable' : 'drill-line-row'
    return (
      <tr className={cls}>
        <td className="label" style={indent ? { paddingLeft: indent } : undefined}>{label}</td>
        <td className={classNum(f)}>{fmt(f)}</td>
        <td className={classNum(a)}>{fmt(a)}</td>
        <td className={classNum(variance)}>{fmtDelta(variance)}</td>
        <td className={classNum(pct)} style={{ fontVariantNumeric: 'tabular-nums' }}>
          {pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`}
        </td>
      </tr>
    )
  }

  return (
    <div>
      <h1>Forecast Accuracy</h1>
      <div className="sub">
        How well cycle <strong>{version.version_code}</strong>{version.final_label ? ` (${version.final_label})` : ''} predicted
        what actually happened. Actuals overlaid on its forecast for the periods it forecasted that have since settled.
      </div>

      {windowEmpty ? (
        <div className="placeholder-box">
          No actualized window for {version.version_code}. Its cutover is {monthName(dYM % 100)} {Math.floor(dYM / 100)} and
          the latest actual is {ymLabel(scope.latestActualYM)} — pick an earlier cycle, or widen the period.
        </div>
      ) : (
        <>
          <div className="accuracy-window">
            Window · {ymLabel(winLo)} → {ymLabel(winHi)} <span className="accuracy-window-note">(forecast cutover {ymLabel(dYM)}, latest actual {ymLabel(scope.latestActualYM)})</span>
          </div>
          <div className="table-scroll">
            <table className="cf-table" style={{ minWidth: 360 }}>
              <colgroup>
                <col style={{ width: 280 }} /><col style={{ width: 120 }} /><col style={{ width: 120 }} /><col style={{ width: 120 }} /><col style={{ width: 80 }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="label">Area / project</th>
                  <th>Forecast</th>
                  <th>Actual</th>
                  <th>Variance</th>
                  <th>Var %</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(([group, areas]) => {
                  const groupCells = areas.flatMap(a => byArea.get(a) || [])
                  return (
                    <Fragment key={group}>
                      <Row label={group.toUpperCase()} subset={groupCells} kind="group" />
                      {areas.map(area => {
                        const subset = byArea.get(area) || []
                        const isOpen = open.has(area)
                        const codes = [...new Set(subset.map(c => c.project_code))]
                        return (
                          <Fragment key={area}>
                            <tr className={`pivot-area-row clickable ${isOpen ? 'open' : ''}`}
                              onClick={() => setOpen(p => { const n = new Set(p); n.has(area) ? n.delete(area) : n.add(area); return n })}>
                              <td className="label"><span className="pivot-card-chev">▶</span>{area}</td>
                              {(() => {
                                const f = netFlow(subset, inWindow, 'Forecast')
                                const a = netFlow(subset, inWindow, 'Actual')
                                const variance = a - f
                                const pct = Math.abs(f) > 0.5 ? (variance / Math.abs(f)) * 100 : null
                                return (
                                  <>
                                    <td className={classNum(f)}>{fmt(f)}</td>
                                    <td className={classNum(a)}>{fmt(a)}</td>
                                    <td className={classNum(variance)}>{fmtDelta(variance)}</td>
                                    <td className={classNum(pct)}>{pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`}</td>
                                  </>
                                )
                              })()}
                            </tr>
                            {isOpen && codes
                              .sort((x, y) => (x === '_AREA' ? 1 : 0) - (y === '_AREA' ? 1 : 0) || projectName(x).localeCompare(projectName(y)))
                              .map(code => (
                                <Row key={`${area}-${code}`} label={projectName(code)}
                                  subset={subset.filter(c => c.project_code === code)} kind="project" indent={40} />
                              ))}
                          </Fragment>
                        )
                      })}
                    </Fragment>
                  )
                })}
                <Row label="ALL AREAS" subset={cells} kind="group" />
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
