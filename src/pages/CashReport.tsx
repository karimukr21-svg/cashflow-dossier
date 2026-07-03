import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTopbarExtras, useTopbarScope } from '@/lib/displayFmt'
import {
  fetchActuals, fetchForecasts, fetchPayablesTrajectory, fetchFxRate, fetchProjectCells,
  fetchAccountGroups, fetchGroupAccounts, subgroupMatchesArea,
  fetchPayablesMaps, fetchPayablesForBooks,
  type CfCell, type CfLine, type PayablesTrajRow, type GroupDef, type GroupAccount,
  type CanonicalArea, type AreaGroup, type PayablesMaps,
} from '@/lib/queries'
import AreaFilterPopover from '@/components/AreaFilterPopover'
import { fmt, fmtDelta } from '@/lib/format'
import { buildModel, buildStatement, buildStatementMatrix, payablesSeries, arrangeSectionColumns, arrangeByColumns, STMT_COLUMNS, type AreaAgg, type StmtSection, type MatrixSection, type PaySeriesPt } from './reportModel'
import { buildReportHtml, buildProjectsPrintHtml } from './reportPrint'
import { waterfallSvg, areaBarsSvg, netTrendSvg, payablesTrendSvg } from './reportCharts'
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

type Level = 'group' | 'area' | 'sections' | 'project' | 'coverage' | 'definitions'
const LEVELS: Level[] = ['group', 'area', 'sections', 'project', 'coverage', 'definitions']
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
  const startLabel = `Dec ${year - 1}`            // payables start — a real Dec month-end snapshot
  const cashStartLabel = `Jan ${year}`            // cash opening — the Jan-1 / start-of-year position

  // Remember the last-viewed tab across reloads (localStorage, survives reopen).
  const [level, setLevel] = useState<Level>(() => {
    try { const s = localStorage.getItem('crp-level') as Level | null; return LEVELS.includes(s as Level) ? (s as Level) : 'group' } catch { return 'group' }
  })
  useEffect(() => { try { localStorage.setItem('crp-level', level) } catch { /* best-effort */ } }, [level])
  const [excluded, setExcluded] = useState<Set<string>>(new Set())   // areas unticked in the top-bar filter
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
        // Merge/override at PROJECT grain: cf data is project-grain (many rows
        // per area|line|month), so the key MUST include project_code — else the
        // areas collapse to one project's value (undercounting multi-project
        // areas). Published actuals still override the matching forecast cell.
        const key = (c: CfCell & { project_code?: string | null }) =>
          `${c.area}|${c.project_code ?? ''}|${c.line_code}|${c.year}|${c.month}`
        const merged = new Map<string, CfCell & { currency?: string }>()
        for (const c of f) merged.set(key(c), c)
        for (const c of a) merged.set(key(c), c)
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

  // Cash-flow scope = every area with pushed cash flow AND an FX rate (so it
  // converts to USD). NOT gated on the payables mapping — unmapped areas still
  // show their cash flow; their payables columns just stay blank (that mapping
  // gap is surfaced in Coverage and tackled later).
  const cfAreasAll = useMemo(() =>
    scope.areas.map(a => model.get(a.area_id)).filter((a): a is AreaAgg => !!a && a.hasCf && a.fxOk)
      .sort((x, y) => Math.abs(y.netOps) - Math.abs(x.netOps)),
    [model, scope.areas])
  // Areas actually in scope = all cash-flow areas minus the ones unticked in the
  // top-bar area filter. Drives Group / Area / Sections.
  const cfAreas = useMemo(() => cfAreasAll.filter(a => !excluded.has(a.areaId)), [cfAreasAll, excluded])
  // The same cash-flow areas as canonical rows (area_id === AreaAgg.areaId), so
  // the area filter can reuse the shared grouped popover (like All Areas).
  const cfCanonical = useMemo(() => {
    const ids = new Set(cfAreasAll.map(a => a.areaId))
    return scope.areas.filter(a => ids.has(a.area_id))
  }, [cfAreasAll, scope.areas])

  // Monthly trade-payables series (Dec → as-of) for the in-scope areas.
  // Only mapped areas carry payables, so unmapped areas contribute nothing;
  // endpoints tie payStart/payEnd.
  const paySeries = useMemo(() => {
    const scopedIds = new Set(cfAreas.map(a => a.areaId))
    return payablesSeries(payTraj, scopedIds, scope.areas, (year - 1) * 100 + 12, asOf)
  }, [payTraj, cfAreas, scope.areas, year, asOf])

  // Project grain covers any area with pushed cash flow that is FX-convertible
  // (payables mapping not required — project view is cash-flow only).
  const projAreaOptions = useMemo(() =>
    scope.areas.filter(a => { const m = model.get(a.area_id); return m?.hasCf && m.fxOk })
      .map(a => ({ areaId: a.area_id, label: a.display_name })),
    [model, scope.areas])

  const tabs: { key: Level; label: string }[] = [
    { key: 'group', label: 'Group' }, { key: 'area', label: 'Area' }, { key: 'sections', label: 'Sections' },
    { key: 'project', label: 'Project' }, { key: 'coverage', label: 'Coverage' }, { key: 'definitions', label: 'Definitions' },
  ]
  const canPrint = level === 'group' || level === 'area' || level === 'sections'
  const slot = useTopbarExtras()
  const scopeSlot = useTopbarScope()

  const print = () => {
    const w = window.open('', '_blank'); if (!w) return
    let html = ''
    if (level === 'area') {
      const areaRows = cfAreas.map(a => ({ label: a.label, netOps: a.netOps, payStart: a.payStart, payEnd: a.payEnd }))
      const areaTotals = cfAreas.reduce((t, a) => ({ netOps: t.netOps + a.netOps, payStart: t.payStart + (a.payStart ?? 0), payEnd: t.payEnd + (a.payEnd ?? 0) }), { netOps: 0, payStart: 0, payEnd: 0 })
      html = buildReportHtml({ level: 'area', scopeLabel: 'Areas', year, asOfLabel, startLabel, areaRows, areaTotals, matchedCount: cfAreas.length })
    } else if (level === 'sections') {
      html = buildReportHtml({
        level: 'sections', scopeLabel: 'Sections', year, asOfLabel, startLabel, matchedCount: cfAreas.length,
        sections: sectionCards(cfAreas, scope.lines),
      })
    } else {
      const { scopeLabel, lineUsd, payStart, payEnd, hasPay, startCash } = aggregateScope(cfAreas)
      const stmt = buildStatement(lineUsd, scope.lines)
      html = buildReportHtml({
        level: 'group', scopeLabel, year, asOfLabel, startLabel, cashStartLabel, matchedCount: cfAreas.length,
        statement: stmt, payStart, payEnd, hasPay, startCash, endCash: startCash + stmt.netMovement,   // derived ending
        paySeries: paySeries.map(p => ({ label: MONTHS[(p.period % 100) - 1] ?? '', value: p.usd })),
      })
    }
    w.document.write(html); w.document.close()
  }

  // Report controls (view tabs + area include/exclude filter + Print) — rendered
  // up in the Dossier top bar (Row 2) via the slot; inline fallback if absent.
  const showAreaFilter = level === 'group' || level === 'area' || level === 'sections'
  // The Areas scope filter lives on Row 1 right after the Period selector (via
  // the scope slot); Print + the page tabs live on Row 2 (the extras slot).
  const areaControl = showAreaFilter
    ? <AreaFilter areas={cfCanonical} excluded={excluded} setExcluded={setExcluded} />
    : null
  // Order matters: the top bar is right-anchored, so the LAST item sits at the
  // stable right edge. Put the page selector last so it never shifts as the
  // Print button appears and disappears across tabs.
  const controls = (
    <>
      {canPrint && <button className="crp-print" style={{ marginLeft: 0 }} onClick={print}>Print</button>}
      <div className="crp-levels">
        {tabs.map(t => (
          <button key={t.key} className={`crp-lvl ${level === t.key ? 'active' : ''}`} onClick={() => setLevel(t.key)}>{t.label}</button>
        ))}
      </div>
    </>
  )

  return (
    <div className="crp">
      {scopeSlot && areaControl && createPortal(areaControl, scopeSlot)}
      {slot
        ? createPortal(controls, slot)
        : <div className="crp-toolbar no-print">{areaControl}{controls}</div>}

      {loading ? <div className="placeholder-box">Loading…</div>
        : level === 'group' ? <GroupView scope={scope} matched={cfAreas} year={year} asOfLabel={asOfLabel} startLabel={startLabel} cashStartLabel={cashStartLabel} paySeries={paySeries} />
        : level === 'area' ? <AreaView matched={cfAreas} year={year} asOfLabel={asOfLabel} startLabel={startLabel} onOpenProjects={(id) => { setProjArea(id); setLevel('project') }} />
        : level === 'sections' ? <SectionsView scope={scope} matched={cfAreas} asOfLabel={asOfLabel} />
        : level === 'project' ? <ProjectView scope={scope} fxMap={fxMap} areaOptions={projAreaOptions} projArea={projArea} setProjArea={setProjArea} year={year} asOfMonth={asOfMonth} asOfLabel={asOfLabel} />
        : level === 'coverage' ? <CoverageView scope={scope} model={model} payTraj={payTraj} />
        : <DefinitionsView period={asOf} asOfLabel={asOfLabel} />}
    </div>
  )
}

/* Top-bar area filter — same control as the All Areas page: a .areas-dd trigger
 * that opens the shared, grouped AreaFilterPopover to include/exclude areas from
 * the report scope (Group / Area / Sections). All ticked = whole group. */
const CRP_AREA_GROUP_LABEL: Record<AreaGroup, string> = {
  Operations: 'OPERATIONS', Subsidiaries: 'SUBSIDIARIES', Corporate: 'CORPORATE', Contingency: 'CONTINGENCY',
}
function AreaFilter({ areas, excluded, setExcluded }: {
  areas: CanonicalArea[]; excluded: Set<string>; setExcluded: (s: Set<string>) => void
}) {
  const [open, setOpen] = useState(false)
  const included = areas.length - areas.filter(a => excluded.has(a.area_id)).length
  return (
    <div className="crp-areafilter">
      <button className={`areas-dd ${excluded.size > 0 ? 'filtered' : ''}`} onClick={() => setOpen(true)}
              aria-haspopup="menu" aria-expanded={open}
              title="Select which areas are included in the report">
        Areas · {included} of {areas.length} <span className="areas-dd-caret">▾</span>
      </button>
      {open && (
        <AreaFilterPopover
          areas={areas}
          excluded={excluded}
          onChange={setExcluded}
          onClose={() => setOpen(false)}
          groupLabels={CRP_AREA_GROUP_LABEL}
        />
      )}
    </div>
  )
}

/* Merge the in-scope areas into a single line→USD map + payables position.
 * Shared by the screen and print. Label collapses to the one area's name when
 * exactly one is in scope, else "the Group". */
function aggregateScope(matched: AreaAgg[]) {
  const lineUsd = new Map<string, number>()
  let payStart = 0, payEnd = 0, hasPay = false, startCash = 0, endCash = 0
  for (const a of matched) {
    for (const [lc, v] of a.lineUsd) lineUsd.set(lc, (lineUsd.get(lc) ?? 0) + v)
    if (a.payStart != null) { payStart += a.payStart; hasPay = true }
    if (a.payEnd != null) { payEnd += a.payEnd; hasPay = true }
    startCash += a.openCash; endCash += a.endCash
  }
  const scopeLabel = matched.length === 1 ? (matched[0]?.label || 'area') : 'the Group'
  return { scopeLabel, lineUsd, payStart, payEnd, hasPay, startCash, endCash }
}

/* One card per cash-flow section (canonical statement order) — each carries the
 * section's net + that net broken down by area. Shared by the Sections screen
 * and its print. Sections/areas below THRESH (50k) drop out. */
export type SectionCard = { label: string; net: number; rows: { label: string; value: number }[] }
function sectionCards(matched: AreaAgg[], lines: CfLine[]): SectionCard[] {
  const agg = new Map<string, number>()
  for (const a of matched) for (const [lc, v] of a.lineUsd) agg.set(lc, (agg.get(lc) ?? 0) + v)
  const stmt = buildStatement(agg, lines)
  const byArea = matched.map(a => ({
    label: a.label,
    nets: new Map(buildStatement(a.lineUsd, lines).sections.map(s => [s.label, s.net])),
  }))
  return stmt.sections.map(s => ({
    label: s.label, net: s.net,
    rows: byArea.map(a => ({ label: a.label, value: a.nets.get(s.label) ?? 0 })).filter(r => Math.abs(r.value) >= 50000),
  })).filter(c => c.rows.length > 0)
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

/* Cash-journey timeline — the top band of the Group page. Starting cash → the
 * net movement (with net operations / net financing as the headline drivers) →
 * ending cash, read left to right. Replaces the KPI tiles + cash-walk strip. */
const SHORT_SEC: Record<string, string> = { 'Bank Financing': 'Financing', 'Within Group': 'Within group', 'Non Operational': 'Non-op', 'New Sales': 'New sales' }
function CashTimeline({ startCash, endCash, netMovement, drivers, hasCash, startLabel, asOfLabel }: {
  startCash: number; endCash: number; netMovement: number; drivers: { label: string; value: number }[]
  hasCash: boolean; startLabel: string; asOfLabel: string
}) {
  const chip = (label: string, v: number) => (
    <span className="crp-tl-chip" key={label}>{SHORT_SEC[label] ?? label} <b className={cls(v)}>{fMd(v)}</b></span>
  )
  return (
    <div className={`crp-timeline${hasCash ? '' : ' crp-timeline--nocash'}`}>
      {hasCash ? <div className="crp-tl-node">
        <div className="crp-tl-cap">Starting cash · {startLabel}</div>
        <div className={`crp-tl-val ${cls(startCash)}`}>{fMm(startCash)}</div>
      </div> : null}
      <div className="crp-tl-flow">
        <div className={`crp-tl-move ${cls(netMovement)}`}>{netMovement < 0 ? '−' : '+'}{fMm(Math.abs(netMovement))}<i>net cash movement · of which</i></div>
        <div className="crp-tl-chips">{drivers.filter(d => Math.abs(d.value) >= 50000).map(d => chip(d.label, d.value))}</div>
      </div>
      {hasCash ? <div className="crp-tl-node crp-tl-node--end">
        <div className="crp-tl-cap">Ending cash · {asOfLabel}</div>
        <div className={`crp-tl-val ${cls(endCash)}`}>{fMm(endCash)}</div>
      </div> : null}
    </div>
  )
}

/* One statement section as its own card: the section name + net in the header,
 * then the receipts and payments line items (per-nature subtotal only when a
 * nature has more than one bucket). */
function StmtSectionCard({ sec }: { sec: StmtSection }) {
  return (
    <div className="crp-card crp-stmtcard">
      <div className="crp-sechead">
        <span className="crp-sechead-t">{sec.label}</span>
        <b className={`crp-sechead-n ${cls(sec.net)}`}>{fMm(sec.net)}</b>
      </div>
      <table className="crp-table">
        <tbody>
          {sec.receipts.map(b => <tr key={`r-${b.label}`}><td className="crp-item">{b.label}</td><td className={`r ${cls(b.value)}`}>{fMm(b.value)}</td></tr>)}
          {sec.receipts.length > 1 && <tr className="crp-natsub"><td>Total receipts</td><td className={`r ${cls(sec.recTotal)}`}>{fMm(sec.recTotal)}</td></tr>}
          {sec.payments.map(b => <tr key={`p-${b.label}`}><td className="crp-item">{b.label}</td><td className={`r ${cls(b.value)}`}>{fMm(b.value)}</td></tr>)}
          {sec.payments.length > 1 && <tr className="crp-natsub"><td>Total payments</td><td className={`r ${cls(sec.payTotal)}`}>{fMm(sec.payTotal)}</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

/* ── Group view — cash-flow statement + separated payables position ─────────── */
function GroupView({ scope, matched, year, asOfLabel, startLabel, cashStartLabel, paySeries }: {
  scope: Scope; matched: AreaAgg[]
  year: number; asOfLabel: string; startLabel: string; cashStartLabel: string; paySeries: PaySeriesPt[]
}) {
  const { scopeLabel, lineUsd, payStart, payEnd, hasPay, startCash } = aggregateScope(matched)
  const payDelta = hasPay ? payEnd - payStart : null
  const { sections, netMovement } = buildStatement(lineUsd, scope.lines)
  const drivers = sections.map(s => ({ label: s.label, value: s.net }))
  // Ending cash is DERIVED (opening + net movement), not read from the stored
  // "balance at end" line — a cash-flow statement's closing position is opening
  // plus the flows by definition, so the walk always reconciles. (The stored
  // ending vs this derived one is a data-quality check that lives in staging.)
  const endCash = startCash + netMovement
  const hasCash = Math.abs(startCash) > 1 || Math.abs(endCash) > 1

  return (
    <div className="crp-page">
      <div className="crp-head">
        <img className="crp-logo" src="/ccc-logo.png" alt="CCC" />
        <div className="crp-head-t">
          <h1>Cash Flow Report — {scopeLabel}</h1>
          <div className="crp-sub">Actual to date · Jan–{asOfLabel} · USD millions · {matched.length} areas</div>
        </div>
        <div className="crp-brand">Treasury</div>
      </div>

      <CashTimeline startCash={startCash} endCash={endCash} netMovement={netMovement} drivers={drivers} hasCash={hasCash} startLabel={cashStartLabel} asOfLabel={asOfLabel} />

      {/* Justified 3-column grid: Operations · the four stacked sections · charts */}
      <div className="crp-groupcols">
        {arrangeByColumns(sections, STMT_COLUMNS).map((col, i) => (
          <div className={`crp-seccol${i === 1 ? ' crp-seccol--spaced' : ''}`} key={i}>
            {col.map(sec => <StmtSectionCard key={sec.label} sec={sec} />)}
          </div>
        ))}

        <div className="crp-seccol">
          {/* How the cash moved — waterfall */}
          <div className="crp-card">
            <div className="crp-card-h">How the cash moved <span>· sections → net movement</span></div>
            <Svg html={waterfallSvg(sections.map(s => ({ label: s.label, value: s.net })), netMovement, undefined, 1.35)} />
          </div>

          {/* Trade payables — monthly trajectory */}
          <div className="crp-card">
            <div className="crp-card-h">Trade payables <span>· monthly · {startLabel} → {asOfLabel}</span></div>
            {hasPay ? <>
              <Svg html={payablesTrendSvg(paySeries.map(p => ({ label: MONTHS[(p.period % 100) - 1] ?? '', value: p.usd })))} />
              <div className="crp-paysum">
                <span>{startLabel} <b className={cls(payStart)}>{fMm(payStart)}</b></span>
                <span>{asOfLabel} <b className={cls(payEnd)}>{fMm(payEnd)}</b></span>
                <span>Δ <b className={cls(payDelta)}>{fMd(payDelta)}</b></span>
              </div>
              <div className="crp-note">Suppliers, subcontractors &amp; taxes — the editable <b>trade_payables</b> group (Midas TB, USD). Δ positive = paid down. Recent months are still posting, so the latest may understate.</div>
            </> : <div className="crp-note crp-note--empty">No matched payables for this scope.</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Sections view — one card per cash-flow section, net broken down by area ───
 * The Group page's "How the cash moved" waterfall shows section NETS; this page
 * takes each section one level deeper — which AREAS drove it — reusing the same
 * diverging by-area bars as the Area page's "Net cash from operations by area".
 * Always group-scoped (a by-area breakdown of a single area is one bar). */
function SectionsView({ scope, matched, asOfLabel }: {
  scope: Scope; matched: AreaAgg[]; asOfLabel: string
}) {
  const columns = useMemo(() => arrangeSectionColumns(sectionCards(matched, scope.lines)), [matched, scope.lines])

  return (
    <div className="crp-page">
      <div className="crp-head">
        <img className="crp-logo" src="/ccc-logo.png" alt="CCC" />
        <div className="crp-head-t">
          <h1>Cash Flow Report — Sections</h1>
          <div className="crp-sub">Actual to date · Jan–{asOfLabel} · USD millions · {matched.length} areas · each section's net, by area</div>
        </div>
        <div className="crp-brand">Treasury</div>
      </div>

      <div className="crp-seccols">
        {columns.map((col, i) => (
          <div className="crp-seccol" key={i}>
            {col.map(c => (
              <div className="crp-card" key={c.label}>
                <div className="crp-sechead">
                  <span className="crp-sechead-t">{c.label}<span> · by area</span></span>
                  <b className={`crp-sechead-n ${cls(c.net)}`}>{fMm(c.net)}</b>
                </div>
                <Svg html={areaBarsSvg(c.rows.map(r => ({ label: r.label, value: r.value })), undefined, { zoom: 1.55 })} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="crp-note">Each card is one cash-flow section; bars show that section's net cash per area (green = generated, crimson = consumed), USD, year-to-date. Section nets tie the "How the cash moved" waterfall on the Group page.</div>
    </div>
  )
}

/* ── Area view — one row per matched area ───────────────────────────────────── */
function AreaView({ matched, year, asOfLabel, startLabel, onOpenProjects }: {
  matched: AreaAgg[]; year: number; asOfLabel: string; startLabel: string; onOpenProjects?: (id: string) => void
}) {
  const tot = matched.reduce((t, a) => ({
    netOps: t.netOps + a.netOps, payStart: t.payStart + (a.payStart ?? 0), payEnd: t.payEnd + (a.payEnd ?? 0),
  }), { netOps: 0, payStart: 0, payEnd: 0 })
  const totDelta = tot.payEnd - tot.payStart

  return (
    <div className="crp-page">
      <div className="crp-head">
        <img className="crp-logo" src="/ccc-logo.png" alt="CCC" />
        <div className="crp-head-t">
          <h1>Cash Flow Report — Areas</h1>
          <div className="crp-sub">Actual to date · Jan–{asOfLabel} · USD millions · {matched.length} areas</div>
        </div>
        <div className="crp-brand">Treasury</div>
      </div>

      <div className="crp-lede">
        From January to {asOfLabel}, these areas <b className={cls(tot.netOps)}>{tot.netOps < 0 ? 'used' : 'generated'} {fMm(Math.abs(tot.netOps))}m</b> of cash from operations, and mapped trade payables moved from <b>{fMm(Math.abs(tot.payStart))}m</b> to <b>{fMm(Math.abs(tot.payEnd))}m</b> — <b className={cls(totDelta)}>{totDelta >= 0 ? 'paid down' : 'up'} {fMm(Math.abs(totDelta))}m</b>.
      </div>

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
          <div className="crp-note">Net cash from operations (receipts − payments, USD-converted) — all areas with cash flow. Payables = trade_payables (Midas TB), shown only where an area is mapped (blank = not yet mapped; see Coverage). Δ positive = paid down. Click an area to drill into its projects.</div>
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
  const ALL = '__ALL__', SEP = ''
  const areaId = projArea || areaOptions[0]?.areaId || ''
  const allMode = areaId === ALL
  const [cells, setCells] = useState<(CfCell & { project_code: string | null; currency?: string })[]>([])
  const [project, setProject] = useState<string>('')   // holds the composite key (area|code)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)   // last-clicked row for shift-range
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!scope.primaryVersion || (!allMode && !areaId)) { setCells([]); return }
    let cancel = false; setLoading(true)
    fetchProjectCells({ version: scope.primaryVersion, cfArea: allMode ? undefined : areaId, fromYear: year, fromMonth: 1, toYear: year, toMonth: asOfMonth })
      .then(rows => { if (!cancel) { setCells(rows); setProject(''); setSelected(new Set()) } })
      .catch(() => { if (!cancel) setCells([]) })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [areaId, allMode, scope.primaryVersion, year, asOfMonth])

  // Trade-payables crosswalk (book -> project via canonical) + the selected
  // project's monthly payables balance (CCC share), from the trial balance.
  const [payMaps, setPayMaps] = useState<PayablesMaps | null>(null)
  useEffect(() => { fetchPayablesMaps().then(setPayMaps).catch(() => setPayMaps(null)) }, [])
  const [paySeries, setPaySeries] = useState<{ period: number; usd: number }[]>([])
  const [payBooks, setPayBooks] = useState(0)

  const months = useMemo(() => Array.from({ length: asOfMonth }, (_, i) => i + 1), [asOfMonth])
  const flowCodes = useMemo(() => new Set(scope.lines.filter(l => l.nature !== 'Balance').map(l => l.line_code)), [scope.lines])
  const rateOf = (cur?: string) => (cur || 'USD') === 'USD' ? 1 : (fxMap.get(cur || '') ?? null)
  const areaLabelOf = (a: string) => areaOptions.find(o => o.areaId === a)?.label || a

  // Rank projects by |net cash movement| (flow lines, USD) → big movers on top.
  // Keyed by area+code so All-areas mode ranks every project across areas together.
  const ranking = useMemo(() => {
    const agg = new Map<string, { area: string; code: string; net: number; cur: string; fxOk: boolean }>()
    for (const c of cells) {
      const code = c.project_code; if (!code) continue
      const key = c.area + SEP + code
      let a = agg.get(key); if (!a) { a = { area: c.area, code, net: 0, cur: 'USD', fxOk: true }; agg.set(key, a) }
      if (c.currency && c.currency !== 'USD') a.cur = c.currency
      if (!flowCodes.has(c.line_code)) continue
      const r = rateOf(c.currency); if (r == null) { a.fxOk = false; continue }
      a.net += c.value * r
    }
    return [...agg.entries()].map(([key, x]) => ({ key, ...x }))
      .sort((p, q) => Math.abs(q.net) - Math.abs(p.net))
  }, [cells, flowCodes, fxMap])

  const maxAbs = Math.max(1, ...ranking.map(r => Math.abs(r.net)))
  const bigCut = maxAbs * 0.12
  const sel = project || ranking[0]?.key || ''
  const selArea = sel ? sel.slice(0, sel.indexOf(SEP)) : ''
  const selCode = sel ? sel.slice(sel.indexOf(SEP) + 1) : ''

  // Resolve the selected cf project -> canonical -> its TB books, then fetch the
  // monthly payables balance (Dec prior year through as-of).
  useEffect(() => {
    if (!payMaps || !selCode) { setPaySeries([]); setPayBooks(0); return }
    const cid = payMaps.cfCodeToCanon.get(selCode.toUpperCase())
    const books = cid ? (payMaps.canonToBooks.get(cid) ?? []) : []
    setPayBooks(books.length)
    if (!books.length) { setPaySeries([]); return }
    let cancel = false
    fetchPayablesForBooks(books, (year - 1) * 100 + 12, year * 100 + asOfMonth)
      .then(s => { if (!cancel) setPaySeries(s) })
      .catch(() => { if (!cancel) setPaySeries([]) })
    return () => { cancel = true }
  }, [payMaps, selCode, year, asOfMonth])

  const matrixFor = (key: string) => {
    const area = key.slice(0, key.indexOf(SEP)), code = key.slice(key.indexOf(SEP) + 1)
    const perCode = new Map<string, Map<number, number>>()
    let cur = 'USD', ok = true
    for (const c of cells) {
      if (c.area !== area || c.project_code !== code) continue
      if (c.currency && c.currency !== 'USD') cur = c.currency
      const r = rateOf(c.currency); if (r == null) { ok = false; continue }
      let m = perCode.get(c.line_code); if (!m) { m = new Map(); perCode.set(c.line_code, m) }
      m.set(c.month, (m.get(c.month) ?? 0) + c.value * r)
    }
    return { matrix: buildStatementMatrix(perCode, scope.lines, months), currency: cur, fxOk: ok, area, code }
  }
  const { matrix, currency, fxOk } = useMemo(() => matrixFor(sel), [cells, sel, fxMap, scope.lines, months])
  const areaLabel = allMode ? 'All areas' : areaLabelOf(areaId)
  const secNet = (label: string) => matrix.sections.find(s => s.label === label)?.netTot ?? 0
  const showBody = !loading && !!sel && fxOk && matrix.sections.length > 0

  const toggle = (key: string) => setSelected(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  // Quick-pick the top-N ranked projects (big movers first) so you don't tick each box.
  const pickTop = (n: number) => { setSelected(new Set(ranking.slice(0, n).map(r => r.key))); setAnchor(null) }
  // Shift-click a checkbox to select the whole range from the last clicked row.
  const rangeSelect = (idx: number) => setSelected(prev => {
    if (anchor == null) return prev
    const n = new Set(prev), [a, b] = anchor < idx ? [anchor, idx] : [idx, anchor]
    for (let i = a; i <= b; i++) n.add(ranking[i].key)
    return n
  })
  const printProjects = (keys: string[]) => {
    const w = window.open('', '_blank'); if (!w) return
    const list = keys.map(k => matrixFor(k))
      .filter(x => x.fxOk && x.matrix.sections.length > 0)
      .map(x => ({ areaLabel: areaLabelOf(x.area), project: x.code, currency: x.currency, asOfLabel, months, matrix: x.matrix }))
    if (list.length === 0) { w.close(); return }
    w.document.write(buildProjectsPrintHtml(list)); w.document.close()
  }

  return (
    <div className="crp-page">
      <div className="crp-head">
        <img className="crp-logo" src="/ccc-logo.png" alt="CCC" />
        <div className="crp-head-t">
          <h1>Cash Flow Report — Projects</h1>
          <div className="crp-sub">{areaLabel} · monthly actuals Jan–{asOfLabel} · USD millions · {ranking.length} projects</div>
        </div>
        <div className="crp-brand">Treasury</div>
      </div>

      <div className="crp-projtop no-print">
        <select className="crp-select" value={areaId} onChange={e => { setProjArea(e.target.value); setProject('') }}>
          <option value={ALL}>All areas</option>
          {areaOptions.map(a => <option key={a.areaId} value={a.areaId}>{a.label}</option>)}
        </select>
        {ranking.length > 0 && (
          <div className="crp-pick">
            <span className="crp-pick-l">Select</span>
            {[5, 10, 20].filter(n => n < ranking.length).map(n => (
              <button key={n} className="crp-pickbtn" onClick={() => pickTop(n)}>Top {n}</button>
            ))}
            <button className="crp-pickbtn" onClick={() => pickTop(ranking.length)}>All</button>
            <button className="crp-pickbtn" disabled={selected.size === 0} onClick={() => { setSelected(new Set()); setAnchor(null) }}>None</button>
          </div>
        )}
        <button className="crp-print" disabled={!showBody} onClick={() => printProjects([sel])}>Print this</button>
        <button className="crp-print" disabled={selected.size === 0} onClick={() => printProjects([...selected])}>Print selected ({selected.size})</button>
      </div>

      <div className="crp-grid crp-grid--proj">
        {/* Ranked project list — big movers on top, tick to print */}
        <div className="crp-card">
          <div className="crp-card-h">Projects <span>· by cash movement</span></div>
          <div className="crp-projlist">
            {ranking.map((r, idx) => {
              const big = Math.abs(r.net) >= bigCut
              return (
                <div key={r.key} className={`crp-projrow ${r.key === sel ? 'active' : ''}`}>
                  <input type="checkbox" checked={selected.has(r.key)}
                    onClick={e => { if (e.shiftKey && anchor != null) { e.preventDefault(); rangeSelect(idx) } else { setAnchor(idx) } }}
                    onChange={() => toggle(r.key)} title="Tick to select · Shift-click to select a range" />
                  <button className="crp-projname" onClick={() => setProject(r.key)} title="View this project">
                    {big ? <span className="crp-bigdot" /> : null}<span className="crp-projcode">{r.code}</span>{allMode ? <span className="crp-projarea">{areaLabelOf(r.area)}</span> : null}
                  </button>
                  <div className="crp-projbar"><div className={`crp-projbar-fill ${r.net < 0 ? 'neg' : 'pos'}`} style={{ width: `${(Math.abs(r.net) / maxAbs) * 100}%` }} /></div>
                  <div className={`crp-projval ${cls(r.net)}`}>{fMm(r.net)}</div>
                </div>
              )
            })}
            {ranking.length === 0 ? <div className="crp-note crp-note--empty">No project-grain cash flow for this scope.</div> : null}
          </div>
          <div className="crp-note"><span className="crp-bigdot" /> Big movers (largest cash movement) — the ones worth printing. Use <b>Top 5/10/20</b> above, or tick projects (shift-click for a range), then “Print selected”. Bars USD, net of the elapsed months.</div>
        </div>

        {/* Selected project detail */}
        <div className="crp-card">
          {loading ? <div className="crp-note crp-note--empty">Loading…</div>
            : !sel ? <div className="crp-note crp-note--empty">Pick a project on the left.</div>
            : !fxOk ? <div className="crp-note crp-note--empty">No FX rate for {currency} — cannot show this project in USD.</div>
            : <>
                <div className="crp-card-h">{selCode} <span>· {areaLabelOf(selArea)} · USD millions{currency !== 'USD' ? ` (from ${currency})` : ''}</span></div>
                <KpiBand cards={[
                  { label: 'Net cash movement · YTD', value: fMm(matrix.netTotal), cls: cls(matrix.netTotal) },
                  { label: 'Net from operations', value: fMm(secNet('Operations')), cls: cls(secNet('Operations')) },
                  { label: 'Net financing', value: fMm(secNet('Bank Financing')), cls: cls(secNet('Bank Financing')) },
                ]} />
                <div className="crp-svg" style={{ margin: '10px 0' }}><Svg html={netTrendSvg(months.map(m => MONTHS[m - 1]), matrix.netMovement)} /></div>
                <table className="crp-table crp-table--matrix">
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
                </table>

                {/* Trade payables — balance and its month-by-month move over the
                    same window, from the trial balance (CCC share, mapped books). */}
                {(() => {
                  const pts = paySeries.map(p => ({
                    label: MONTHS[(p.period % 100) - 1] ?? '', value: p.usd,
                  }))
                  const first = pts[0]?.value ?? 0, last = pts[pts.length - 1]?.value ?? 0
                  const delta = last - first
                  return (
                    <div className="crp-paysec">
                      <div className="crp-card-h">Trade payables <span>· CCC share{payBooks ? ` · ${payBooks} book${payBooks === 1 ? '' : 's'}` : ''}</span></div>
                      {payBooks === 0 ? (
                        <div className="crp-note crp-note--empty">Not mapped to a trial-balance book yet — this project's payables sit in its area's “Area &amp; other projects”. Assign a book in Manage → Payables map.</div>
                      ) : pts.length === 0 ? (
                        <div className="crp-note crp-note--empty">No payables balance for the mapped book(s) in this window.</div>
                      ) : (
                        <>
                          <KpiBand cards={[
                            { label: `Payables · ${asOfLabel}`, value: fMm(last), cls: cls(last) },
                            { label: 'At start (Dec)', value: fMm(first), cls: cls(first) },
                            { label: 'Change over period', value: fMm(delta), cls: cls(delta) },
                          ]} />
                          <div className="crp-svg" style={{ margin: '10px 0' }}><Svg html={payablesTrendSvg(pts)} /></div>
                        </>
                      )}
                    </div>
                  )
                })()}
              </>}
        </div>
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
        <img className="crp-logo" src="/ccc-logo.png" alt="CCC" />
        <div className="crp-head-t">
          <h1>Cash Flow Report — Coverage</h1>
          <div className="crp-sub">{matchedN} of {rows.length} areas matched (cash flow ↔ trade-payables) · cash flow covers all areas; the trade-payables column covers only the matched ones</div>
        </div>
        <div className="crp-brand">Treasury</div>
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
          <div className="crp-note">Matched = the area has pushed cash flow, a trade-payables mapping, and an FX rate. Cash flow is shown for every area with an FX rate; only the trade-payables column waits on the mapping. No FX rate = excluded from the USD totals until a rate is set.</div>
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
        <img className="crp-logo" src="/ccc-logo.png" alt="CCC" />
        <div className="crp-head-t">
          <h1>Cash Flow Report — Definitions</h1>
          <div className="crp-sub">Liability account-groups & what feeds trade_payables · balances at {asOfLabel} · USD millions</div>
        </div>
        <div className="crp-brand">Treasury</div>
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
