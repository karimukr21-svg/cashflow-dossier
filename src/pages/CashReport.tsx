import { useEffect, useMemo, useState } from 'react'
import {
  fetchActuals, fetchForecasts, fetchPayablesTrajectory, fetchFxRate, fetchProjectCells,
  fetchAccountGroups, fetchGroupAccounts, subgroupMatchesArea,
  type CfCell, type PayablesTrajRow, type GroupDef, type GroupAccount,
} from '@/lib/queries'
import { fmt, fmtDelta } from '@/lib/format'
import { buildModel, buildStatement, buildStatementMatrix, type AreaAgg, type StmtSection, type MatrixSection } from './reportModel'
import { buildReportHtml } from './reportPrint'
import { waterfallSvg, areaBarsSvg, netTrendSvg } from './reportCharts'
import type { Scope } from './Dossier'

/* ── The Cash Flow Report ───────────────────────────────────────────────────
 * The first compiled report, three grains:
 *  • Group  — cash-flow line items (actual to date, USD) + a separated trade-
 *             payables position (Start Dec / End Apr / Δ). Filterable to an area.
 *  • Area   — one row per area: net cash from operations + payables Start/End/Δ.
 *  • Project— line items × actual months (built in the next pass).
 * Group + Area are scoped to MATCHED areas only — areas that carry BOTH pushed
 * cash-flow data AND a trade-payables mapping (via the org_chart→area name
 * crosswalk) AND an FX rate — so the two halves cover the same set. Everything
 * is USD (cash flow FX-converted at the cycle's as-of rate; the TB is USD).
 * Payables = the editable trade_payables account-group (see the Definitions
 * pass). Coverage of matched vs unmapped areas is its own pass. */

type Level = 'group' | 'area' | 'project' | 'coverage' | 'definitions'
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const fMm = (v: number | null | undefined) => v == null ? '—' : fmt(v / 1e6, { decimals: 1 })
const fMd = (v: number | null | undefined) => v == null ? '—' : fmtDelta(v / 1e6, { decimals: 1 })
const cls = (v: number | null | undefined) => (v == null || Math.abs(v) < 1) ? '' : (v < 0 ? 'neg' : 'pos')

export default function CashReport({ scope, onSelectArea }: { scope: Scope; onSelectArea?: (areaId: string) => void }) {
  const selVer = scope.versions?.find(v => v.version_code === scope.primaryVersion)
  const year = selVer?.cycle_year ?? Math.floor(scope.latestActualYM / 100)
  const [ay, am] = (selVer?.as_of_date ?? '').split('-').map(Number)
  const asOf = ay && am ? ay * 100 + am : scope.latestActualYM
  const asOfMonth = asOf % 100
  const asOfLabel = `${MONTHS[asOfMonth - 1] ?? ''} ${year}`
  const startLabel = `Dec ${year - 1}`

  const [level, setLevel] = useState<Level>('group')
  const [groupArea, setGroupArea] = useState<string>('')   // '' = all matched (the group)
  const [projArea, setProjArea] = useState<string>('')     // selected area for the Project grain

  const [cells, setCells] = useState<(CfCell & { currency?: string })[]>([])
  const [payTraj, setPayTraj] = useState<PayablesTrajRow[]>([])
  const [fxMap, setFxMap] = useState<Map<string, number | null>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!scope.primaryVersion) return
    let cancel = false; setLoading(true)
    ;(async () => {
      try {
        const [a, f, pt] = await Promise.all([
          fetchActuals({ fromYear: year, fromMonth: 1, toYear: year, toMonth: asOfMonth }),
          fetchForecasts({ version: scope.primaryVersion, fromYear: year, fromMonth: 1, toYear: year, toMonth: asOfMonth }),
          fetchPayablesTrajectory(),
        ])
        if (cancel) return
        // published actuals (if any) override the elapsed forecast cells
        const merged = new Map<string, CfCell & { currency?: string }>()
        for (const c of f) merged.set(`${c.area}|${c.line_code}|${c.year}|${c.month}`, c)
        for (const c of a) merged.set(`${c.area}|${c.line_code}|${c.year}|${c.month}`, c)
        const mc = [...merged.values()]
        setCells(mc); setPayTraj(pt)
        const curs = [...new Set(mc.map(c => c.currency).filter(Boolean))] as string[]
        const asOfDate = selVer?.as_of_date || `${year}-${String(asOfMonth).padStart(2, '0')}-01`
        const entries = await Promise.all(curs.map(async c =>
          [c, c === 'USD' ? 1 : await fetchFxRate(c, asOfDate)] as const))
        if (!cancel) setFxMap(new Map(entries))
      } finally { if (!cancel) setLoading(false) }
    })()
    return () => { cancel = true }
  }, [scope.primaryVersion, year, asOfMonth])

  const model = useMemo(() => buildModel(cells, payTraj, fxMap, scope.areas, scope.cfToCanonical, scope.lines, year, asOf),
    [cells, payTraj, fxMap, scope.areas, scope.cfToCanonical, scope.lines, year, asOf])

  const matched = useMemo(() =>
    scope.areas.map(a => model.get(a.area_id)).filter((a): a is AreaAgg => !!a && a.matched)
      .sort((x, y) => Math.abs(y.netOps) - Math.abs(x.netOps)),
    [model, scope.areas])

  // Project grain covers any area with pushed cash flow that is FX-convertible
  // (payables mapping not required — project view is cash-flow only).
  const projAreaOptions = useMemo(() =>
    scope.areas.filter(a => { const m = model.get(a.area_id); return m?.hasCf && m.fxOk })
      .map(a => ({ areaId: a.area_id, label: a.display_name })),
    [model, scope.areas])

  const tabs: { key: Level; label: string }[] = [
    { key: 'group', label: 'Group' }, { key: 'area', label: 'Area' }, { key: 'project', label: 'Project' },
    { key: 'coverage', label: 'Coverage' }, { key: 'definitions', label: 'Definitions' },
  ]
  const canPrint = level === 'group' || level === 'area'

  const print = () => {
    const w = window.open('', '_blank'); if (!w) return
    let html = ''
    if (level === 'area') {
      const areaRows = matched.map(a => ({ label: a.label, netOps: a.netOps, payStart: a.payStart, payEnd: a.payEnd }))
      const areaTotals = matched.reduce((t, a) => ({ netOps: t.netOps + a.netOps, payStart: t.payStart + (a.payStart ?? 0), payEnd: t.payEnd + (a.payEnd ?? 0) }), { netOps: 0, payStart: 0, payEnd: 0 })
      html = buildReportHtml({ level: 'area', scopeLabel: 'Areas', year, asOfLabel, startLabel, areaRows, areaTotals, matchedCount: matched.length })
    } else {
      const { scopeLabel, lineUsd, payStart, payEnd, hasPay } = aggregateScope(model, matched, groupArea)
      html = buildReportHtml({
        level: 'group', scopeLabel, year, asOfLabel, startLabel, matchedCount: groupArea ? undefined : matched.length,
        statement: buildStatement(lineUsd, scope.lines), payStart, payEnd, hasPay,
      })
    }
    w.document.write(html); w.document.close()
  }

  return (
    <div className="crp">
      <div className="crp-toolbar no-print">
        <div className="crp-levels">
          {tabs.map(t => (
            <button key={t.key} className={`crp-lvl ${level === t.key ? 'active' : ''}`} onClick={() => setLevel(t.key)}>{t.label}</button>
          ))}
        </div>
        {level === 'group' && (
          <select className="crp-select" value={groupArea} onChange={e => setGroupArea(e.target.value)}>
            <option value="">All matched areas (Group)</option>
            {matched.map(a => <option key={a.areaId} value={a.areaId}>{a.label}</option>)}
          </select>
        )}
        {canPrint && <button className="crp-print" onClick={print}>Print</button>}
      </div>

      {loading ? <div className="placeholder-box">Loading…</div>
        : level === 'group' ? <GroupView scope={scope} model={model} matched={matched} groupArea={groupArea} year={year} asOfLabel={asOfLabel} startLabel={startLabel} />
        : level === 'area' ? <AreaView matched={matched} year={year} asOfLabel={asOfLabel} startLabel={startLabel} onOpenProjects={(id) => { setProjArea(id); setLevel('project') }} />
        : level === 'project' ? <ProjectView scope={scope} fxMap={fxMap} areaOptions={projAreaOptions} projArea={projArea} setProjArea={setProjArea} year={year} asOfMonth={asOfMonth} asOfLabel={asOfLabel} />
        : level === 'coverage' ? <CoverageView scope={scope} model={model} payTraj={payTraj} />
        : <DefinitionsView period={asOf} asOfLabel={asOfLabel} />}
    </div>
  )
}

/* Merge the scoped areas (all matched = the Group, or one selected area) into a
 * single line→USD map + payables position. Shared by the screen and print. */
function aggregateScope(model: Map<string, AreaAgg>, matched: AreaAgg[], groupArea: string) {
  const aggs = groupArea ? [model.get(groupArea)].filter((a): a is AreaAgg => !!a) : matched
  const lineUsd = new Map<string, number>()
  let payStart = 0, payEnd = 0, hasPay = false
  for (const a of aggs) {
    for (const [lc, v] of a.lineUsd) lineUsd.set(lc, (lineUsd.get(lc) ?? 0) + v)
    if (a.payStart != null) { payStart += a.payStart; hasPay = true }
    if (a.payEnd != null) { payEnd += a.payEnd; hasPay = true }
  }
  const scopeLabel = groupArea ? (model.get(groupArea)?.label || 'area') : 'the Group'
  return { scopeLabel, lineUsd, payStart, payEnd, hasPay }
}

/* KPI tile band — the headline numbers, shared across the three pages. */
function KpiBand({ cards }: { cards: { label: string; value: string; cls?: string; sub?: string }[] }) {
  return (
    <div className="crp-kpis">
      {cards.map((c, i) => (
        <div className="crp-kpi" key={i}>
          <div className="crp-kpi-l">{c.label}</div>
          <div className={`crp-kpi-v ${c.cls || ''}`}>{c.value}</div>
          {c.sub ? <div className="crp-kpi-s">{c.sub}</div> : null}
        </div>
      ))}
    </div>
  )
}
const Svg = ({ html }: { html: string }) => <div className="crp-svg" dangerouslySetInnerHTML={{ __html: html }} />

/* One statement section: receipts grouped, then payments grouped, then net.
 * Per-nature subtotals show only when a nature has more than one bucket. */
function StmtSectionRows({ sec }: { sec: StmtSection }) {
  return (
    <>
      <tr className="crp-sec"><td>{sec.label}</td><td className="r" /></tr>
      {sec.receipts.map(b => <tr key={`r-${b.label}`}><td className="crp-item">{b.label}</td><td className={`r ${cls(b.value)}`}>{fMm(b.value)}</td></tr>)}
      {sec.receipts.length > 1 && <tr className="crp-natsub"><td>Total receipts</td><td className={`r ${cls(sec.recTotal)}`}>{fMm(sec.recTotal)}</td></tr>}
      {sec.payments.map(b => <tr key={`p-${b.label}`}><td className="crp-item">{b.label}</td><td className={`r ${cls(b.value)}`}>{fMm(b.value)}</td></tr>)}
      {sec.payments.length > 1 && <tr className="crp-natsub"><td>Total payments</td><td className={`r ${cls(sec.payTotal)}`}>{fMm(sec.payTotal)}</td></tr>}
      <tr className="crp-subtot"><td>Net {sec.label.toLowerCase()}</td><td className={`r ${cls(sec.net)}`}>{fMm(sec.net)}</td></tr>
    </>
  )
}

/* ── Group view — cash-flow statement + separated payables position ─────────── */
function GroupView({ scope, model, matched, groupArea, year, asOfLabel, startLabel }: {
  scope: Scope; model: Map<string, AreaAgg>; matched: AreaAgg[]; groupArea: string
  year: number; asOfLabel: string; startLabel: string
}) {
  const { scopeLabel, lineUsd, payStart, payEnd, hasPay } = aggregateScope(model, matched, groupArea)
  const payDelta = hasPay ? payEnd - payStart : null
  const { sections, netMovement } = buildStatement(lineUsd, scope.lines)
  const secNet = (label: string) => sections.find(s => s.label === label)?.net ?? 0
  const opsNet = secNet('Operations'), finNet = secNet('Bank Financing')

  return (
    <div className="crp-page">
      <div className="crp-head">
        <div>
          <h1>Cash Flow Report — {scopeLabel}</h1>
          <div className="crp-sub">Actual to date · Jan–{asOfLabel} · USD millions{groupArea ? '' : ` · ${matched.length} matched areas`}</div>
        </div>
        <div className="crp-brand"><span className="crp-glyph">C</span> CCC · Treasury</div>
      </div>

      <div className="crp-lede">
        From January to {asOfLabel}, {scopeLabel} <b className={cls(netMovement)}>{netMovement < 0 ? 'used' : 'generated'} {fMm(Math.abs(netMovement))}m</b> of cash.
        {hasPay ? <> Trade payables moved from <b>{fMm(Math.abs(payStart))}m</b> to <b>{fMm(Math.abs(payEnd))}m</b> — <b className={cls(payDelta)}>{(payDelta ?? 0) >= 0 ? 'paid down' : 'up'} {fMm(Math.abs(payDelta ?? 0))}m</b>.</> : null}
      </div>

      <KpiBand cards={[
        { label: 'Net from operations', value: fMm(opsNet), cls: cls(opsNet) },
        { label: 'Net financing', value: fMm(finNet), cls: cls(finNet) },
        { label: 'Net cash movement', value: fMm(netMovement), cls: cls(netMovement) },
        { label: `Trade payables · ${asOfLabel}`, value: fMm(payEnd), cls: cls(payEnd), sub: hasPay ? `${fMd(payDelta)} since ${startLabel}` : 'not mapped' },
      ]} />

      <div className="crp-grid">
        {/* Cash flow statement */}
        <div className="crp-card">
          <div className="crp-card-h">Cash flow <span>· actual to date</span></div>
          <table className="crp-table">
            <thead><tr><th>Line item</th><th className="r">USD m</th></tr></thead>
            <tbody>
              {sections.map(sec => <StmtSectionRows key={sec.label} sec={sec} />)}
              <tr className="crp-total"><td>Net cash movement</td><td className={`r ${cls(netMovement)}`}>{fMm(netMovement)}</td></tr>
            </tbody>
          </table>
        </div>

        <div className="crp-rcol">
          {/* How the cash moved — waterfall */}
          <div className="crp-card">
            <div className="crp-card-h">How the cash moved <span>· sections → net movement</span></div>
            <Svg html={waterfallSvg(sections.map(s => ({ label: s.label, value: s.net })), netMovement)} />
          </div>

          {/* Trade payables — then vs now */}
          <div className="crp-card crp-card--pos">
            <div className="crp-card-h">Trade payables <span>· then vs now</span></div>
            {hasPay ? <>
              <table className="crp-table crp-table--pos">
                <thead><tr><th>Liabilities</th><th className="r">{startLabel}</th><th className="r">{asOfLabel}</th><th className="r">Δ</th></tr></thead>
                <tbody>
                  <tr className="crp-total"><td>Trade payables</td>
                    <td className={`r ${cls(payStart)}`}>{fMm(payStart)}</td>
                    <td className={`r ${cls(payEnd)}`}>{fMm(payEnd)}</td>
                    <td className={`r ${cls(payDelta)}`}>{fMd(payDelta)}</td></tr>
                </tbody>
              </table>
              <PosBar start={payStart} end={payEnd} startLabel={startLabel} endLabel={asOfLabel} />
              <div className="crp-note">Suppliers, subcontractors &amp; taxes — the editable <b>trade_payables</b> group (Midas TB, USD). Δ positive = paid down. Recent months are still posting, so the latest may understate.</div>
            </> : <div className="crp-note crp-note--empty">No matched payables for this scope.</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

/* Two-bar Start→End magnitude comparison for the payables position. */
function PosBar({ start, end, startLabel, endLabel }: { start: number; end: number; startLabel: string; endLabel: string }) {
  const max = Math.max(Math.abs(start), Math.abs(end), 1)
  const row = (label: string, v: number) => (
    <div className="crp-posbar-row">
      <div className="crp-posbar-lab">{label}</div>
      <div className="crp-posbar-track"><div className="crp-posbar-fill" style={{ width: `${(Math.abs(v) / max) * 100}%` }} /></div>
      <div className="crp-posbar-val">{fMm(v)}</div>
    </div>
  )
  return <div className="crp-posbar">{row(startLabel, start)}{row(endLabel, end)}</div>
}

/* ── Area view — one row per matched area ───────────────────────────────────── */
function AreaView({ matched, year, asOfLabel, startLabel, onOpenProjects }: {
  matched: AreaAgg[]; year: number; asOfLabel: string; startLabel: string; onOpenProjects?: (id: string) => void
}) {
  const tot = matched.reduce((t, a) => ({
    netOps: t.netOps + a.netOps, payStart: t.payStart + (a.payStart ?? 0), payEnd: t.payEnd + (a.payEnd ?? 0),
  }), { netOps: 0, payStart: 0, payEnd: 0 })
  const totDelta = tot.payEnd - tot.payStart
  const top = [...matched].sort((a, b) => b.netOps - a.netOps)[0]

  return (
    <div className="crp-page">
      <div className="crp-head">
        <div>
          <h1>Cash Flow Report — Areas</h1>
          <div className="crp-sub">Actual to date · Jan–{asOfLabel} · USD millions · {matched.length} matched areas</div>
        </div>
        <div className="crp-brand"><span className="crp-glyph">C</span> CCC · Treasury</div>
      </div>

      <div className="crp-lede">
        From January to {asOfLabel}, the matched areas <b className={cls(tot.netOps)}>{tot.netOps < 0 ? 'used' : 'generated'} {fMm(Math.abs(tot.netOps))}m</b> of cash from operations, and trade payables moved from <b>{fMm(Math.abs(tot.payStart))}m</b> to <b>{fMm(Math.abs(tot.payEnd))}m</b> — <b className={cls(totDelta)}>{totDelta >= 0 ? 'paid down' : 'up'} {fMm(Math.abs(totDelta))}m</b>.
      </div>

      <KpiBand cards={[
        { label: 'Group net from ops', value: fMm(tot.netOps), cls: cls(tot.netOps) },
        { label: `Trade payables · ${asOfLabel}`, value: fMm(tot.payEnd), cls: cls(tot.payEnd), sub: `${fMd(totDelta)} since ${startLabel}` },
        { label: 'Matched areas', value: String(matched.length) },
        { label: 'Top cash generator', value: top ? top.label : '—', sub: top ? `${fMm(top.netOps)}m` : '' },
      ]} />

      <div className="crp-grid">
        <div className="crp-card">
        <table className="crp-table crp-table--area">
          <thead><tr>
            <th>Area</th>
            <th className="r">Net cash from ops</th>
            <th className="r crp-sep-l">Payables {startLabel}</th>
            <th className="r">Payables {asOfLabel}</th>
            <th className="r">Δ</th>
          </tr></thead>
          <tbody>
            {matched.map(a => (
              <tr key={a.areaId} className="crp-clickable" onClick={() => onOpenProjects?.(a.areaId)} title="Open this area's projects">
                <td>{a.label}</td>
                <td className={`r ${cls(a.netOps)}`}>{fMm(a.netOps)}</td>
                <td className={`r crp-sep-l ${cls(a.payStart)}`}>{fMm(a.payStart)}</td>
                <td className={`r ${cls(a.payEnd)}`}>{fMm(a.payEnd)}</td>
                <td className={`r ${cls(a.payEnd != null && a.payStart != null ? a.payEnd - a.payStart : null)}`}>{fMd(a.payEnd != null && a.payStart != null ? a.payEnd - a.payStart : null)}</td>
              </tr>
            ))}
            <tr className="crp-total">
              <td>Group ({matched.length} areas)</td>
              <td className={`r ${cls(tot.netOps)}`}>{fMm(tot.netOps)}</td>
              <td className={`r crp-sep-l ${cls(tot.payStart)}`}>{fMm(tot.payStart)}</td>
              <td className={`r ${cls(tot.payEnd)}`}>{fMm(tot.payEnd)}</td>
              <td className={`r ${cls(totDelta)}`}>{fMd(totDelta)}</td>
            </tr>
          </tbody>
        </table>
          <div className="crp-note">Net cash from operations (receipts − payments, USD-converted). Payables = trade_payables (Midas TB). Δ positive = paid down. Click an area to drill into its projects.</div>
        </div>

        <div className="crp-card">
          <div className="crp-card-h">Net cash from operations <span>· by area</span></div>
          <Svg html={areaBarsSvg(matched.map(a => ({ label: a.label, value: a.netOps })))} />
          <div className="crp-note">Green = cash generated, crimson = cash consumed (USD, YTD). Click a row on the left to drill into an area's projects.</div>
        </div>
      </div>
    </div>
  )
}

/* ── Project view — line items × actual months (USD) ────────────────────────── */
function ProjectView({ scope, fxMap, areaOptions, projArea, setProjArea, year, asOfMonth, asOfLabel }: {
  scope: Scope; fxMap: Map<string, number | null>; areaOptions: { areaId: string; label: string }[]
  projArea: string; setProjArea: (id: string) => void; year: number; asOfMonth: number; asOfLabel: string
}) {
  const areaId = projArea || areaOptions[0]?.areaId || ''
  const [cells, setCells] = useState<(CfCell & { project_code: string | null; currency?: string })[]>([])
  const [project, setProject] = useState<string>('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!areaId || !scope.primaryVersion) { setCells([]); return }
    let cancel = false; setLoading(true)
    fetchProjectCells({ version: scope.primaryVersion, cfArea: areaId, fromYear: year, fromMonth: 1, toYear: year, toMonth: asOfMonth })
      .then(rows => { if (!cancel) { setCells(rows); setProject('') } })
      .catch(() => { if (!cancel) setCells([]) })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [areaId, scope.primaryVersion, year, asOfMonth])

  const projects = useMemo(() => {
    const s = new Set(cells.map(c => c.project_code).filter(Boolean) as string[])
    return [...s].sort()
  }, [cells])
  const sel = project || projects[0] || ''
  const months = useMemo(() => Array.from({ length: asOfMonth }, (_, i) => i + 1), [asOfMonth])

  // perCode: line_code → (month → USD) for the selected project
  const { matrix, currency, fxOk } = useMemo(() => {
    const perCode = new Map<string, Map<number, number>>()
    let cur = 'USD'; let ok = true
    for (const c of cells) {
      if (c.project_code !== sel) continue
      cur = c.currency || cur
      const rate = (c.currency || 'USD') === 'USD' ? 1 : (fxMap.get(c.currency || '') ?? null)
      if (rate == null) { ok = false; continue }
      let m = perCode.get(c.line_code); if (!m) { m = new Map(); perCode.set(c.line_code, m) }
      m.set(c.month, (m.get(c.month) ?? 0) + c.value * rate)
    }
    return { matrix: buildStatementMatrix(perCode, scope.lines, months), currency: cur, fxOk: ok }
  }, [cells, sel, fxMap, scope.lines, months])

  const areaLabel = areaOptions.find(a => a.areaId === areaId)?.label || areaId
  const secNet = (label: string) => matrix.sections.find(s => s.label === label)?.netTot ?? 0
  const showBody = !loading && !!sel && fxOk && matrix.sections.length > 0

  return (
    <div className="crp-page">
      <div className="crp-head">
        <div>
          <h1>Cash Flow Report — Project</h1>
          <div className="crp-sub">{areaLabel}{sel ? ` · ${sel}` : ''} · monthly actuals Jan–{asOfLabel} · USD millions{currency !== 'USD' ? ` (converted from ${currency})` : ''}</div>
        </div>
        <div className="crp-brand"><span className="crp-glyph">C</span> CCC · Treasury</div>
      </div>

      <div className="crp-projpick no-print">
        <select className="crp-select" value={areaId} onChange={e => { setProjArea(e.target.value); setProject('') }}>
          {areaOptions.map(a => <option key={a.areaId} value={a.areaId}>{a.label}</option>)}
        </select>
        <select className="crp-select" value={sel} onChange={e => setProject(e.target.value)} disabled={projects.length === 0}>
          {projects.length === 0 && <option value="">No projects</option>}
          {projects.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {showBody ? <>
        <KpiBand cards={[
          { label: 'Net cash movement · YTD', value: fMm(matrix.netTotal), cls: cls(matrix.netTotal) },
          { label: 'Net from operations', value: fMm(secNet('Operations')), cls: cls(secNet('Operations')) },
          { label: 'Net financing', value: fMm(secNet('Bank Financing')), cls: cls(secNet('Bank Financing')) },
        ]} />
        <div className="crp-card">
          <div className="crp-card-h">Net cash movement <span>· by month</span></div>
          <Svg html={netTrendSvg(months.map(m => MONTHS[m - 1]), matrix.netMovement)} />
        </div>
      </> : null}

      <div className="crp-card">
        {loading ? <div className="crp-note crp-note--empty">Loading…</div>
          : !sel ? <div className="crp-note crp-note--empty">No project-grain cash flow for this area.</div>
          : !fxOk ? <div className="crp-note crp-note--empty">No FX rate for {currency} — cannot show this project in USD.</div>
          : <table className="crp-table crp-table--matrix">
              <thead><tr>
                <th>Line item</th>
                {months.map(m => <th key={m} className="r">{MONTHS[m - 1]}</th>)}
                <th className="r crp-sep-l">YTD</th>
              </tr></thead>
              <tbody>
                {matrix.sections.map(sec => <MatrixSectionRows key={sec.label} sec={sec} months={months} />)}
                <tr className="crp-total">
                  <td>Net cash movement</td>
                  {months.map((_, i) => <td key={i} className={`r ${cls(matrix.netMovement[i])}`}>{fMm(matrix.netMovement[i])}</td>)}
                  <td className={`r crp-sep-l ${cls(matrix.netTotal)}`}>{fMm(matrix.netTotal)}</td>
                </tr>
              </tbody>
            </table>}
        <div className="crp-note">Monthly actual cash flow for the selected project, USD-converted at the cycle FX. Grouped to the same line buckets as the Group view.</div>
      </div>
    </div>
  )
}

function MatrixSectionRows({ sec, months }: { sec: MatrixSection; months: number[] }) {
  const row = (label: string, monthly: number[], total: number, klass: string) => (
    <tr className={klass}>
      <td className={klass === '' ? 'crp-item' : ''}>{label}</td>
      {monthly.map((v, i) => <td key={i} className={`r ${cls(v)}`}>{fMm(v)}</td>)}
      <td className={`r crp-sep-l ${cls(total)}`}>{fMm(total)}</td>
    </tr>
  )
  const sum = (rows: { monthly: number[] }[], i: number) => rows.reduce((t, r) => t + r.monthly[i], 0)
  return (
    <>
      <tr className="crp-sec"><td colSpan={months.length + 2}>{sec.label}</td></tr>
      {sec.receipts.map(b => row(b.label, b.monthly, b.total, ''))}
      {sec.receipts.length > 1 && row('Total receipts', months.map((_, i) => sum(sec.receipts, i)), sec.receipts.reduce((t, b) => t + b.total, 0), 'crp-natsub')}
      {sec.payments.map(b => row(b.label, b.monthly, b.total, ''))}
      {sec.payments.length > 1 && row('Total payments', months.map((_, i) => sum(sec.payments, i)), sec.payments.reduce((t, b) => t + b.total, 0), 'crp-natsub')}
      {row(`Net ${sec.label.toLowerCase()}`, sec.net, sec.netTot, 'crp-subtot')}
    </>
  )
}

/* ── Coverage — which areas are matched vs not yet mapped ───────────────────── */
function CoverageView({ scope, model, payTraj }: { scope: Scope; model: Map<string, AreaAgg>; payTraj: PayablesTrajRow[] }) {
  const STATUS: Record<string, { label: string; cls: string }> = {
    matched:   { label: 'Matched', cls: 'ok' },
    nopay:     { label: 'No payables mapping', cls: 'warn' },
    nofx:      { label: 'No FX rate', cls: 'warn' },
    nocf:      { label: 'No cash-flow data', cls: 'mute' },
  }
  const rows = scope.areas.map(a => {
    const m = model.get(a.area_id)
    let key = 'matched'
    if (!m || !m.hasCf) key = 'nocf'
    else if (!m.fxOk) key = 'nofx'
    else if (!m.hasPay) key = 'nopay'
    return { areaId: a.area_id, label: a.display_name, key, note: key === 'nofx' ? (m?.currency ?? '') : '' }
  }).sort((a, b) => (a.key === 'matched' ? 0 : 1) - (b.key === 'matched' ? 0 : 1) || a.label.localeCompare(b.label))
  const matchedN = rows.filter(r => r.key === 'matched').length

  // trade-payables books (org_chart subgroups) that don't map to any cf area
  const orphans = [...new Set(payTraj.map(r => r.subgroup).filter(Boolean) as string[])]
    .filter(sg => !scope.areas.some(a => subgroupMatchesArea(sg, a.area_id))).sort()

  return (
    <div className="crp-page">
      <div className="crp-head">
        <div>
          <h1>Cash Flow Report — Coverage</h1>
          <div className="crp-sub">{matchedN} of {rows.length} areas matched (cash flow ↔ trade-payables) · the Group/Area totals sum only matched areas</div>
        </div>
        <div className="crp-brand"><span className="crp-glyph">C</span> CCC · Treasury</div>
      </div>
      <div className="crp-grid">
        <div className="crp-card">
          <div className="crp-card-h">Areas <span>· match status</span></div>
          <table className="crp-table">
            <thead><tr><th>Area</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.areaId}>
                  <td>{r.label}</td>
                  <td><span className={`crp-pill crp-pill--${STATUS[r.key].cls}`}>{STATUS[r.key].label}{r.note ? ` (${r.note})` : ''}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="crp-note">Matched = the area has pushed cash flow, a trade-payables mapping, and an FX rate. Anything else drops out of the Group/Area totals until it's closed.</div>
        </div>
        <div className="crp-card">
          <div className="crp-card-h">Unmapped payables books <span>· in the TB, no area</span></div>
          {orphans.length === 0 ? <div className="crp-note crp-note--empty">All payables books map to an area.</div>
            : <><ul className="crp-list">{orphans.map(o => <li key={o}>{o}</li>)}</ul>
              <div className="crp-note">These org_chart subgroups carry trade payables but don't match a cash-flow area by name — pending the canonical crosswalk.</div></>}
        </div>
      </div>
    </div>
  )
}

/* ── Definitions — the account groups + what feeds trade_payables ───────────── */
function DefinitionsView({ period, asOfLabel }: { period: number; asOfLabel: string }) {
  const [groups, setGroups] = useState<GroupDef[]>([])
  const [tp, setTp] = useState<{ accounts: GroupAccount[]; total: number }>({ accounts: [], total: 0 })
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancel = false; setLoading(true)
    Promise.all([fetchAccountGroups(), fetchGroupAccounts('trade_payables', period)])
      .then(([g, t]) => { if (!cancel) { setGroups(g); setTp(t) } })
      .catch(() => {})
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [period])

  return (
    <div className="crp-page">
      <div className="crp-head">
        <div>
          <h1>Cash Flow Report — Definitions</h1>
          <div className="crp-sub">Liability account-groups & what feeds trade_payables · balances at {asOfLabel} · USD millions</div>
        </div>
        <div className="crp-brand"><span className="crp-glyph">C</span> CCC · Treasury</div>
      </div>
      {loading ? <div className="placeholder-box">Loading…</div> : <div className="crp-grid">
        <div className="crp-card">
          <div className="crp-card-h">Account groups <span>· defined in Chart of Accounts</span></div>
          <table className="crp-table">
            <thead><tr><th>Group</th><th className="r">Accounts</th></tr></thead>
            <tbody>
              {groups.map(g => (
                <tr key={g.key} className={g.key === 'trade_payables' ? 'crp-hl' : ''}>
                  <td>{g.label}<span className="crp-key"> · {g.key}</span></td>
                  <td className="r">{g.accountCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="crp-note">Groups are defined and edited in the Chart of Accounts module (Group Accounts Workspace). This report is read-only — a basis to decide inclusions.</div>
        </div>
        <div className="crp-card">
          <div className="crp-card-h">trade_payables <span>· included accounts</span></div>
          <table className="crp-table">
            <thead><tr><th>Account</th><th>Name</th><th className="r">USD m</th></tr></thead>
            <tbody>
              {tp.accounts.map(a => (
                <tr key={a.account}><td className="crp-mono">{a.account}</td><td className="crp-item">{a.name}</td><td className={`r ${cls(a.balance)}`}>{fMm(a.balance)}</td></tr>
              ))}
              <tr className="crp-total"><td colSpan={2}>Total trade payables ({tp.accounts.length} accounts)</td><td className={`r ${cls(tp.total)}`}>{fMm(tp.total)}</td></tr>
            </tbody>
          </table>
          <div className="crp-note">The accounts currently rolled into trade_payables. Add/remove in the Chart of Accounts module to change what the report treats as payables.</div>
        </div>
      </div>}
    </div>
  )
}
