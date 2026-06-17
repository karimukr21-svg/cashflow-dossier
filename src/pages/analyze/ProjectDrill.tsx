import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  fetchProjectCells, fetchAreaMeta, fetchProjectsMeta, buildPeriodCols, isFlow,
  resolveAreaMeta, groupRank,
  type ProjectCell, type AreaMeta, type CfProjectMeta, type PeriodCol, type AreaGroupName,
} from '@/lib/projectQueries'
import { fmt, classNum } from '@/lib/format'
import type { AnalyzeScope } from './AnalyzeShell'

/* Line ordering within a project — mirrors the area dossier's section read. */
const CATEGORY_ORDER = [
  'Opening Balance', 'Operation', 'Claims', 'New Sales', 'Interest',
  'Non Operational', 'Within Group', 'Bank Financing',
  'Ending Balance', 'Accumulated Loans', 'Overdrafts',
]
const catRank = (c: string) => {
  const i = CATEGORY_ORDER.indexOf(c)
  return i < 0 ? 90 : i
}

type Props = {
  scope: AnalyzeScope
  setUrl: (patch: Record<string, string | null>) => void
  focusArea: string | null
}

export default function ProjectDrill({ scope, setUrl, focusArea }: Props) {
  const [cells, setCells] = useState<ProjectCell[]>([])
  const [areaMeta, setAreaMeta] = useState<Map<string, AreaMeta>>(new Map())
  const [projMeta, setProjMeta] = useState<Map<string, CfProjectMeta>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const [c, am, pm] = await Promise.all([
          fetchProjectCells({
            version: scope.primaryVersion,
            fromYear: scope.fromYear, toYear: scope.toYear,
            area: focusArea || undefined,
          }),
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
  }, [scope.primaryVersion, scope.fromYear, scope.toYear, focusArea])

  const cols = useMemo(
    () => buildPeriodCols(scope.grain, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth, scope.latestActualYM),
    [scope.grain, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth, scope.latestActualYM],
  )

  if (loading) return <div className="placeholder-box">Loading…</div>

  if (focusArea) {
    return <AreaProjectDrill area={focusArea} cells={cells} cols={cols} projMeta={projMeta}
      back={() => setUrl({ area: null })} />
  }
  return <GroupAreaSummary cells={cells} cols={cols} areaMeta={areaMeta} projMeta={projMeta}
    onPickArea={(a) => setUrl({ area: a })} />
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Sum value over a cell subset for a period column, picking Actual rows for
 *  actual columns and Forecast rows for forecast columns (continuous-actuals
 *  overlay). `flowOnly` excludes balance/stock lines. */
function colSum(subset: ProjectCell[], col: PeriodCol, flowOnly: boolean): number | null {
  let t = 0, touched = false
  const want = col.isActual ? 'Actual' : 'Forecast'
  for (const c of subset) {
    if (c.type !== want) continue
    if (flowOnly && !isFlow(c)) continue
    if (!col.matches(c.year, c.month)) continue
    t += c.value; touched = true
  }
  return touched ? t : null
}

/* ── Group → area summary ──────────────────────────────────────────────── */

function GroupAreaSummary({
  cells, cols, areaMeta, projMeta, onPickArea,
}: {
  cells: ProjectCell[]
  cols: PeriodCol[]
  areaMeta: Map<string, AreaMeta>
  projMeta: Map<string, CfProjectMeta>
  onPickArea: (area: string) => void
}) {
  const byArea = useMemo(() => {
    const m = new Map<string, ProjectCell[]>()
    for (const c of cells) {
      if (!m.has(c.area)) m.set(c.area, [])
      m.get(c.area)!.push(c)
    }
    return m
  }, [cells])

  // group → [areas]
  const groups = useMemo(() => {
    const g = new Map<AreaGroupName, string[]>()
    for (const area of byArea.keys()) {
      const meta = resolveAreaMeta(area, areaMeta)
      if (!g.has(meta.group_name)) g.set(meta.group_name, [])
      g.get(meta.group_name)!.push(area)
    }
    for (const arr of g.values()) {
      arr.sort((a, b) =>
        resolveAreaMeta(a, areaMeta).sort_order - resolveAreaMeta(b, areaMeta).sort_order
        || a.localeCompare(b))
    }
    return [...g.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0]))
  }, [byArea, areaMeta])

  const areaStats = (area: string) => {
    const codes = new Set<string>()
    let jv = 0
    for (const c of byArea.get(area) || []) {
      if (codes.has(c.project_code)) continue
      codes.add(c.project_code)
    }
    for (const code of codes) if (projMeta.get(code)?.is_jv) jv++
    const real = [...codes].filter(c => c !== '_AREA').length
    return { projects: real, jv, hasArea: codes.has('_AREA') }
  }

  const colNet = (subset: ProjectCell[], col: PeriodCol) => colSum(subset, col, true) ?? 0
  const rowTotal = (subset: ProjectCell[]) => cols.reduce((s, c) => s + colNet(subset, c), 0)

  return (
    <div>
      <h1>Project Drill</h1>
      <div className="sub">
        Net cash flow by area, reconciled Σ projects = area total. Click an area to drill into its projects and lines.
      </div>
      <div className="table-scroll">
        <table className="cf-table" style={{ minWidth: 240 + cols.length * 84 + 110 }}>
          <colgroup>
            <col style={{ width: 240 }} />
            {cols.map(c => <col key={c.key} style={{ width: 84 }} />)}
            <col style={{ width: 110 }} />
          </colgroup>
          <thead>
            <tr>
              <th className="label">Area</th>
              {cols.map(c => <th key={c.key} className={c.isActual ? 'cell actual' : 'cell forecast'}>{c.label}</th>)}
              <th>Net (period)</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(([group, areas]) => {
              const groupCells = areas.flatMap(a => byArea.get(a) || [])
              return (
                <Fragment key={group}>
                  <tr className="pivot-section-row">
                    <td className="label">{group.toUpperCase()}</td>
                    {cols.map(c => {
                      const v = colNet(groupCells, c)
                      return <td key={c.key} className={classNum(v)}>{fmt(v)}</td>
                    })}
                    <td className={classNum(rowTotal(groupCells))}>{fmt(rowTotal(groupCells))}</td>
                  </tr>
                  {areas.map(area => {
                    const subset = byArea.get(area) || []
                    const st = areaStats(area)
                    return (
                      <tr key={area} className="pivot-area-row clickable" onClick={() => onPickArea(area)}>
                        <td className="label">
                          {area}
                          <span className="drill-area-meta">
                            {st.projects > 0 ? `${st.projects} proj` : 'area-grain'}
                            {st.jv > 0 ? ` · ${st.jv} JV` : ''}
                          </span>
                        </td>
                        {cols.map(c => {
                          const v = colNet(subset, c)
                          return <td key={c.key} className={classNum(v)}>{fmt(v)}</td>
                        })}
                        <td className={classNum(rowTotal(subset))}>{fmt(rowTotal(subset))}</td>
                      </tr>
                    )
                  })}
                </Fragment>
              )
            })}
            <tr className="total net-row">
              <td className="label">ALL AREAS</td>
              {cols.map(c => {
                const v = colNet(cells, c)
                return <td key={c.key} className={classNum(v)}>{fmt(v)}</td>
              })}
              <td className={classNum(rowTotal(cells))}>{fmt(rowTotal(cells))}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── Area → project → line drill ───────────────────────────────────────── */

function AreaProjectDrill({
  area, cells, cols, projMeta, back,
}: {
  area: string
  cells: ProjectCell[]
  cols: PeriodCol[]
  projMeta: Map<string, CfProjectMeta>
  back: () => void
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (code: string) => setOpen(prev => {
    const n = new Set(prev); n.has(code) ? n.delete(code) : n.add(code); return n
  })

  const byProject = useMemo(() => {
    const m = new Map<string, ProjectCell[]>()
    for (const c of cells) {
      if (!m.has(c.project_code)) m.set(c.project_code, [])
      m.get(c.project_code)!.push(c)
    }
    return m
  }, [cells])

  const projectName = (code: string) => {
    if (code === '_AREA') return 'Area-level items'
    return projMeta.get(code)?.display_name || code
  }

  const projects = useMemo(() => {
    return [...byProject.keys()].sort((a, b) => {
      // _AREA last; JV after real; then by name
      const ja = a === '_AREA' ? 2 : (projMeta.get(a)?.is_jv ? 1 : 0)
      const jb = b === '_AREA' ? 2 : (projMeta.get(b)?.is_jv ? 1 : 0)
      return ja - jb || projectName(a).localeCompare(projectName(b))
    })
  }, [byProject, projMeta])

  const colNet = (subset: ProjectCell[], col: PeriodCol) => colSum(subset, col, true) ?? 0
  const periodNet = (subset: ProjectCell[]) => cols.reduce((s, c) => s + colNet(subset, c), 0)

  const tableWidth = 260 + cols.length * 78 + 96

  return (
    <div>
      <a className="drill-back" onClick={back}>← All areas</a>
      <h1>{area}</h1>
      <div className="sub">
        {projects.filter(p => p !== '_AREA').length} project{projects.filter(p => p !== '_AREA').length === 1 ? '' : 's'}
        {byProject.has('_AREA') ? ' + area-level items' : ''} · net cash flow, USD. Click a project to expand its lines.
      </div>

      {/* Per-project net summary (always visible) */}
      <div className="table-scroll">
        <table className="cf-table" style={{ minWidth: tableWidth }}>
          <colgroup>
            <col style={{ width: 260 }} />
            {cols.map(c => <col key={c.key} style={{ width: 78 }} />)}
            <col style={{ width: 96 }} />
          </colgroup>
          <thead>
            <tr>
              <th className="label">Project · net</th>
              {cols.map(c => <th key={c.key} className={c.isActual ? 'cell actual' : 'cell forecast'}>{c.label}</th>)}
              <th>Net</th>
            </tr>
          </thead>
          <tbody>
            {projects.map(code => {
              const subset = byProject.get(code) || []
              const meta = projMeta.get(code)
              const isOpen = open.has(code)
              return (
                <Fragment key={code}>
                  <tr className={`pivot-area-headrow clickable ${isOpen ? 'open' : ''}`} onClick={() => toggle(code)}>
                    <td className="label">
                      <span className="pivot-card-chev">▶</span>
                      {projectName(code)}
                      {meta?.is_jv && <span className="drill-tag tag-jv">JV{meta.jv_share_pct ? ` ${meta.jv_share_pct}%` : ''}</span>}
                      {meta?.is_area_item && code !== '_AREA' && <span className="drill-tag tag-area">area item</span>}
                    </td>
                    {cols.map(c => {
                      const v = colNet(subset, c)
                      return <td key={c.key} className={classNum(v)}>{fmt(v)}</td>
                    })}
                    <td className={classNum(periodNet(subset))}>{fmt(periodNet(subset))}</td>
                  </tr>
                  {isOpen && <ProjectLines subset={subset} cols={cols} />}
                </Fragment>
              )
            })}
            <tr className="total net-row">
              <td className="label">AREA TOTAL (net)</td>
              {cols.map(c => {
                const v = colNet(cells, c)
                return <td key={c.key} className={classNum(v)}>{fmt(v)}</td>
              })}
              <td className={classNum(periodNet(cells))}>{fmt(periodNet(cells))}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* Line rows inside an expanded project, grouped by category. */
function ProjectLines({ subset, cols }: { subset: ProjectCell[]; cols: PeriodCol[] }) {
  // unique (category, description, nature) lines present
  const lines = useMemo(() => {
    const m = new Map<string, { category: string; description: string; nature: string; cells: ProjectCell[] }>()
    for (const c of subset) {
      const key = `${c.category}||${c.description}`
      if (!m.has(key)) m.set(key, { category: c.category, description: c.description, nature: c.nature, cells: [] })
      m.get(key)!.cells.push(c)
    }
    return [...m.values()].sort((a, b) =>
      catRank(a.category) - catRank(b.category) || a.description.localeCompare(b.description))
  }, [subset])

  // group by category for divider rows
  const cats = useMemo(() => {
    const order: string[] = []
    const m = new Map<string, typeof lines>()
    for (const l of lines) {
      if (!m.has(l.category)) { m.set(l.category, []); order.push(l.category) }
      m.get(l.category)!.push(l)
    }
    return order.map(c => ({ category: c, lines: m.get(c)! }))
  }, [lines])

  const lineColVal = (cellSet: ProjectCell[], col: PeriodCol): number | null => {
    let t = 0, touched = false
    const want = col.isActual ? 'Actual' : 'Forecast'
    for (const c of cellSet) {
      if (c.type !== want) continue
      if (!col.matches(c.year, c.month)) continue
      t += c.value; touched = true
    }
    return touched ? t : null
  }
  const lineTotal = (cellSet: ProjectCell[], flow: boolean): number | null => {
    if (!flow) return null
    return cols.reduce((s, c) => s + (lineColVal(cellSet, c) ?? 0), 0)
  }

  return (
    <>
      {cats.map(cat => (
        <Fragment key={cat.category}>
          <tr className="pivot-subgroup-row">
            <td className="label" style={{ paddingLeft: 28 }}>{cat.category || 'Other'}</td>
            {cols.map(c => <td key={c.key} />)}
            <td />
          </tr>
          {cat.lines.map(l => {
            const flow = l.nature !== 'Balance'
            const tot = lineTotal(l.cells, flow)
            return (
              <tr key={`${cat.category}-${l.description}`} className="drill-line-row">
                <td className="label" style={{ paddingLeft: 40 }}>{l.description}</td>
                {cols.map(c => {
                  const v = lineColVal(l.cells, c)
                  return (
                    <td key={c.key} className={`${classNum(v)} ${c.isActual ? 'cell actual' : 'cell forecast'}`}>
                      {v == null ? '' : fmt(v)}
                    </td>
                  )
                })}
                <td className={classNum(tot)}>{tot == null ? '' : fmt(tot)}</td>
              </tr>
            )
          })}
        </Fragment>
      ))}
    </>
  )
}
