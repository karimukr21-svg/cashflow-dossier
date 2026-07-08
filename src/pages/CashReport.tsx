import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTopbarExtras, useTopbarScope } from '@/lib/displayFmt'
import {
  fetchActuals, fetchForecasts, fetchDebtStocks, fetchPayablesTrajectory, fetchFxRate, fetchProjectCells,
  fetchPayablesMaps, fetchPayablesForBooks, fetchPayablesBookBalances,
  type CfCell, type CfLine, type PayablesTrajRow,
  type CanonicalArea, type AreaGroup, type PayablesMaps,
} from '@/lib/queries'
import AreaFilterPopover from '@/components/AreaFilterPopover'
import { fmt, fmtDelta } from '@/lib/format'
import { buildModel, buildStatement, buildStatementMatrix, buildForecastLineUsd, buildDualStatement, payablesSeries, arrangeSectionColumns, arrangeByColumns, STMT_COLUMNS, type AreaAgg, type StmtSection, type DualSection, type MatrixSection, type PaySeriesPt } from './reportModel'
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

type Level = 'group' | 'area' | 'sections' | 'project' | 'movers'
const LEVELS: Level[] = ['group', 'area', 'sections', 'project', 'movers']
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

  // Forecast horizon — driven by the Period selector. Actuals are always anchored
  // Jan → as-of; when the selected period reaches PAST the cycle's as-of month,
  // the Group page extends into the forecast tail (as-of+1 … horizon), capped at
  // Dec of the cycle year. Default period (YTD, ending at as-of) → actual only.
  const periodEnd = scope.toYear * 100 + scope.toMonth
  const forecastActive = periodEnd > asOf
  const horizonMonth = forecastActive ? (scope.toYear > year ? 12 : Math.min(scope.toMonth, 12)) : asOfMonth
  const horizonLabel = `${MONTHS[horizonMonth - 1] ?? ''} ${year}`

  // Remember the last-viewed tab across reloads (localStorage, survives reopen).
  const [level, setLevel] = useState<Level>(() => {
    try { const s = localStorage.getItem('crp-level') as Level | null; return LEVELS.includes(s as Level) ? (s as Level) : 'group' } catch { return 'group' }
  })
  useEffect(() => { try { localStorage.setItem('crp-level', level) } catch { /* best-effort */ } }, [level])
  const [excluded, setExcluded] = useState<Set<string>>(new Set())   // areas unticked in the top-bar filter
  const [projArea, setProjArea] = useState<string>('')     // selected area for the Project grain

  const [cells, setCells] = useState<(CfCell & { currency?: string })[]>([])
  // Forecast tail (as-of+1 … Dec of the cycle year), fetched once per version and
  // sliced to the selected horizon in-memory — so changing the Period re-slices
  // without a refetch. Empty until the actual+forecast load resolves.
  const [fcTail, setFcTail] = useState<(CfCell & { currency?: string })[]>([])
  const [payTraj, setPayTraj] = useState<PayablesTrajRow[]>([])
  const [fxMap, setFxMap] = useState<Map<string, number | null>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!scope.primaryVersion) return
    let cancel = false; setLoading(true)
    ;(async () => {
      try {
        const [a, f, pt, dec, ftail] = await Promise.all([
          fetchActuals({ fromYear: year, fromMonth: 1, toYear: year, toMonth: asOfMonth }),
          fetchForecasts({ version: scope.primaryVersion, fromYear: year, fromMonth: 1, toYear: year, toMonth: asOfMonth }),
          fetchPayablesTrajectory(),
          fetchDebtStocks(year - 1, 12),   // prior-year Dec period-end debt = the start-of-year debt anchor
          asOfMonth < 12
            ? fetchForecasts({ version: scope.primaryVersion, fromYear: year, fromMonth: asOfMonth + 1, toYear: year, toMonth: 12 })
            : Promise.resolve([]),
        ])
        if (cancel) return
        setFcTail(ftail)
        // Merge/override at PROJECT grain: cf data is project-grain (many rows
        // per area|line|month), so the key MUST include project_code — else the
        // areas collapse to one project's value (undercounting multi-project
        // areas). Published actuals still override the matching forecast cell.
        const key = (c: CfCell & { project_code?: string | null }) =>
          `${c.area}|${c.project_code ?? ''}|${c.line_code}|${c.year}|${c.month}`
        const merged = new Map<string, CfCell & { currency?: string }>()
        for (const c of f) merged.set(key(c), c)
        for (const c of a) merged.set(key(c), c)
        // Dec-prior debt stocks feed only the debt card's start anchor (different
        // year → no key collision with the Jan–asOf window; only balance lines,
        // so they never enter the flow statement).
        const mc = [...merged.values(), ...dec]
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

  // Forecast line→USD per area, sliced to the selected horizon (as-of+1 …
  // horizonMonth). Empty when the period doesn't reach past the as-of month.
  const fcByArea = useMemo(() => {
    if (!forecastActive) return new Map<string, Map<string, number>>()
    const tail = fcTail.filter(c => c.year === year && c.month > asOfMonth && c.month <= horizonMonth)
    return buildForecastLineUsd(tail, fxMap, scope.cfToCanonical)
  }, [forecastActive, fcTail, fxMap, scope.cfToCanonical, year, asOfMonth, horizonMonth])

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
    { key: 'project', label: 'Project' }, { key: 'movers', label: 'Movers' },
  ]
  const canPrint = level === 'group' || level === 'area' || level === 'sections' || level === 'movers'
  const slot = useTopbarExtras()
  const scopeSlot = useTopbarScope()
  // The Movers view owns its own print (it holds the grouped/ignored data); it
  // registers the fn here so the shared top-bar Print button can fire it.
  const moversPrint = useRef<(() => void) | null>(null)

  const print = () => {
    if (level === 'movers') { moversPrint.current?.(); return }
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
      const { scopeLabel, lineUsd, payStart, payEnd, hasPay, startCash, loanStart, loanEnd, odStart, odEnd } = aggregateScope(cfAreas)
      const stmt = buildStatement(lineUsd, scope.lines)
      // Forecast overlay for print (mirrors the screen) — only when a forecast
      // horizon is in scope. Aggregate the per-area forecast lines over the
      // in-scope areas and build the dual statement.
      let forecast: Parameters<typeof buildReportHtml>[0]['forecast']
      if (forecastActive) {
        const fcLineUsd = new Map<string, number>()
        for (const a of cfAreas) { const m = fcByArea.get(a.areaId); if (m) for (const [lc, v] of m) fcLineUsd.set(lc, (fcLineUsd.get(lc) ?? 0) + v) }
        const dual = buildDualStatement(lineUsd, fcLineUsd, scope.lines)
        const midCash = startCash + stmt.netMovement
        forecast = { dual, netMovement: dual.netF, endCash: midCash + dual.netF, horizonLabel }
      }
      html = buildReportHtml({
        level: 'group', scopeLabel, year, asOfLabel, startLabel, cashStartLabel, matchedCount: cfAreas.length,
        statement: stmt, payStart, payEnd, hasPay, startCash, endCash: startCash + stmt.netMovement,   // derived ending
        loanStart, loanEnd, odStart, odEnd,
        paySeries: paySeries.map(p => ({ label: MONTHS[(p.period % 100) - 1] ?? '', value: p.usd })),
        forecast,
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
        : level === 'group' ? <GroupView scope={scope} matched={cfAreas} year={year} asOfLabel={asOfLabel} startLabel={startLabel} cashStartLabel={cashStartLabel} paySeries={paySeries} fcByArea={fcByArea} forecastActive={forecastActive} horizonLabel={horizonLabel} />
        : level === 'area' ? <AreaView matched={cfAreas} year={year} asOfLabel={asOfLabel} startLabel={startLabel} onOpenProjects={(id) => { setProjArea(id); setLevel('project') }} />
        : level === 'sections' ? <SectionsView scope={scope} matched={cfAreas} asOfLabel={asOfLabel} />
        : level === 'project' ? <ProjectView scope={scope} fxMap={fxMap} areaOptions={projAreaOptions} projArea={projArea} setProjArea={setProjArea} year={year} asOfMonth={asOfMonth} asOfLabel={asOfLabel} />
        : level === 'movers' ? <MoversView scope={scope} fxMap={fxMap} areaOptions={projAreaOptions} year={year} asOfMonth={asOfMonth} asOfLabel={asOfLabel} startLabel={startLabel} registerPrint={fn => { moversPrint.current = fn }} />
        : null}
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
  let loanStart = 0, loanEnd = 0, odStart = 0, odEnd = 0
  for (const a of matched) {
    for (const [lc, v] of a.lineUsd) lineUsd.set(lc, (lineUsd.get(lc) ?? 0) + v)
    if (a.payStart != null) { payStart += a.payStart; hasPay = true }
    if (a.payEnd != null) { payEnd += a.payEnd; hasPay = true }
    startCash += a.openCash; endCash += a.endCash
    loanStart += a.loanStart; loanEnd += a.loanEnd; odStart += a.odStart; odEnd += a.odEnd
  }
  const scopeLabel = matched.length === 1 ? (matched[0]?.label || 'area') : 'the Group'
  return { scopeLabel, lineUsd, payStart, payEnd, hasPay, startCash, endCash, loanStart, loanEnd, odStart, odEnd }
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
function KpiBand({ cards, compact }: { cards: { label: string; value: string; cls?: string; sub?: string }[]; compact?: boolean }) {
  return (
    <div className={`crp-kpis${compact ? ' crp-kpis--compact' : ''}`}>
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
const tlChip = (label: string, v: number) => (
  <span className="crp-tl-chip" key={label}>{SHORT_SEC[label] ?? label} <b className={cls(v)}>{fMd(v)}</b></span>
)
const TlFlow = ({ move, drivers, caption, forecast }: { move: number; drivers: { label: string; value: number }[]; caption: string; forecast?: boolean }) => (
  <div className={`crp-tl-flow${forecast ? ' crp-tl-flow--fc' : ''}`}>
    <div className={`crp-tl-move ${cls(move)}`}>{move < 0 ? '−' : '+'}{fMm(Math.abs(move))}<i>{caption}</i></div>
    <div className="crp-tl-chips">{drivers.filter(d => Math.abs(d.value) >= 50000).map(d => tlChip(d.label, d.value))}</div>
  </div>
)
const TlNode = ({ cap, val, cls: extra }: { cap: string; val: number; cls?: string }) => (
  <div className={`crp-tl-node${extra ? ` ${extra}` : ''}`}>
    <div className="crp-tl-cap">{cap}</div>
    <div className={`crp-tl-val ${cls(val)}`}>{fMm(val)}</div>
  </div>
)
/* Cash-journey timeline — the top band of the Group page. Actual side: starting
 * cash → net movement → as-of cash. When a forecast horizon is in scope, the
 * as-of cash becomes the MIDDLE pivot and a second segment extends to the right:
 * forecast movement → forecast year-end cash. */
function CashTimeline({ startCash, endCash, netMovement, drivers, hasCash, startLabel, asOfLabel,
  forecast }: {
  startCash: number; endCash: number; netMovement: number; drivers: { label: string; value: number }[]
  hasCash: boolean; startLabel: string; asOfLabel: string
  forecast?: { endCash: number; netMovement: number; drivers: { label: string; value: number }[]; horizonLabel: string } | null
}) {
  if (forecast) {
    return (
      <div className="crp-timeline crp-timeline--fc">
        {hasCash ? <TlNode cap={`Starting cash · ${startLabel}`} val={startCash} /> : null}
        <TlFlow move={netMovement} drivers={drivers} caption="actual movement · of which" />
        {hasCash ? <TlNode cap={`Cash · ${asOfLabel}`} val={endCash} cls="crp-tl-node--mid" /> : null}
        <TlFlow move={forecast.netMovement} drivers={forecast.drivers} caption="forecast movement · of which" forecast />
        {hasCash ? <TlNode cap={`Forecast cash · ${forecast.horizonLabel}`} val={forecast.endCash} cls="crp-tl-node--end crp-tl-node--fc" /> : null}
      </div>
    )
  }
  return (
    <div className={`crp-timeline${hasCash ? '' : ' crp-timeline--nocash'}`}>
      {hasCash ? <TlNode cap={`Starting cash · ${startLabel}`} val={startCash} /> : null}
      <TlFlow move={netMovement} drivers={drivers} caption="net cash movement · of which" />
      {hasCash ? <TlNode cap={`Ending cash · ${asOfLabel}`} val={endCash} cls="crp-tl-node--end" /> : null}
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

/* Loans & Overdrafts — the group's debt position at start of year vs the current
 * point. These are point-in-time STOCKS (read at the month, never summed across
 * months), so they sit apart from the cash-flow statement. Δ colour is inverted
 * vs the flow lines — a fall in debt (negative Δ) is good (green), a rise is
 * crimson — matching the "paid down = good" reading used on the payables card. */
function DebtPositionCard({ loanStart, loanEnd, odStart, odEnd, startLabel, asOfLabel }: {
  loanStart: number; loanEnd: number; odStart: number; odEnd: number; startLabel: string; asOfLabel: string
}) {
  const totStart = loanStart + odStart, totEnd = loanEnd + odEnd
  // debt Δ: down = good (green), up = crimson — inverted from cls()
  const dCls = (v: number) => Math.abs(v) < 1 ? '' : (v < 0 ? 'pos' : 'neg')
  const rows = [
    { label: 'Accumulated loans', start: loanStart, end: loanEnd },
    { label: 'Overdrafts', start: odStart, end: odEnd },
  ]
  return (
    <div className="crp-card">
      <div className="crp-card-h">Loans &amp; overdrafts <span>· {startLabel} → {asOfLabel}</span></div>
      <table className="crp-table">
        <thead><tr><th></th><th className="r">{startLabel}</th><th className="r">{asOfLabel}</th><th className="r">Δ</th></tr></thead>
        <tbody>
          {rows.map(r => {
            const d = r.end - r.start
            return <tr key={r.label}><td className="crp-item">{r.label}</td><td className="r">{fMm(r.start)}</td><td className="r">{fMm(r.end)}</td><td className={`r ${dCls(d)}`}>{fMd(d)}</td></tr>
          })}
          <tr className="crp-natsub"><td>Total debt</td><td className="r">{fMm(totStart)}</td><td className="r">{fMm(totEnd)}</td><td className={`r ${dCls(totEnd - totStart)}`}>{fMd(totEnd - totStart)}</td></tr>
        </tbody>
      </table>
    </div>
  )
}

/* Dual statement section card — same layout as StmtSectionCard but with two
 * value columns: the actual figure (Jan→as-of) and the forecast figure over the
 * selected forecast period. Header carries the two column labels; a Net row at
 * the foot shows the section net for each side. */
function DualStmtSectionCard({ sec }: { sec: DualSection }) {
  const dual = (label: string, a: number, f: number, klass = '') => (
    <tr className={klass} key={`${klass}-${label}`}>
      <td className={klass ? '' : 'crp-item'}>{label}</td>
      <td className={`r ${cls(a)}`}>{fMm(a)}</td>
      <td className={`r crp-fc ${cls(f)}`}>{fMm(f)}</td>
    </tr>
  )
  return (
    <div className="crp-card crp-stmtcard crp-stmtcard--dual">
      <table className="crp-table crp-table--dual">
        <thead><tr>
          <th className="crp-sechead-t">{sec.label}</th>
          <th className="r">Actual</th>
          <th className="r crp-fc">Forecast</th>
        </tr></thead>
        <tbody>
          {sec.receipts.map(b => dual(b.label, b.actual, b.forecast))}
          {sec.receipts.length > 1 && dual('Total receipts', sec.recA, sec.recF, 'crp-natsub')}
          {sec.payments.map(b => dual(b.label, b.actual, b.forecast))}
          {sec.payments.length > 1 && dual('Total payments', sec.payA, sec.payF, 'crp-natsub')}
          {dual(`Net ${sec.label.toLowerCase()}`, sec.netA, sec.netF, 'crp-secnet')}
        </tbody>
      </table>
    </div>
  )
}

/* ── Group view — cash-flow statement + separated payables position ─────────── */
function GroupView({ scope, matched, year, asOfLabel, startLabel, cashStartLabel, paySeries, fcByArea, forecastActive, horizonLabel }: {
  scope: Scope; matched: AreaAgg[]
  year: number; asOfLabel: string; startLabel: string; cashStartLabel: string; paySeries: PaySeriesPt[]
  fcByArea: Map<string, Map<string, number>>; forecastActive: boolean; horizonLabel: string
}) {
  const { scopeLabel, lineUsd, payStart, payEnd, hasPay, startCash, loanStart, loanEnd, odStart, odEnd } = aggregateScope(matched)
  const payDelta = hasPay ? payEnd - payStart : null
  const hasDebt = Math.abs(loanStart) + Math.abs(loanEnd) + Math.abs(odStart) + Math.abs(odEnd) > 1
  const { sections, netMovement } = buildStatement(lineUsd, scope.lines)
  const drivers = sections.map(s => ({ label: s.label, value: s.net }))
  // Ending cash is DERIVED (opening + net movement), not read from the stored
  // "balance at end" line — a cash-flow statement's closing position is opening
  // plus the flows by definition, so the walk always reconciles. (The stored
  // ending vs this derived one is a data-quality check that lives in staging.)
  const endCash = startCash + netMovement
  const hasCash = Math.abs(startCash) > 1 || Math.abs(endCash) > 1

  // Forecast overlay: aggregate the per-area forecast lines over the in-scope
  // areas, then a dual (actual | forecast) statement. Forecast year-end cash =
  // as-of cash + the forecast-period net movement.
  const fcLineUsd = useMemo(() => {
    const m = new Map<string, number>()
    if (forecastActive) for (const a of matched) { const am = fcByArea.get(a.areaId); if (am) for (const [lc, v] of am) m.set(lc, (m.get(lc) ?? 0) + v) }
    return m
  }, [forecastActive, matched, fcByArea])
  const dual = useMemo(() => forecastActive ? buildDualStatement(lineUsd, fcLineUsd, scope.lines) : null, [forecastActive, lineUsd, fcLineUsd, scope.lines])
  const forecast = forecastActive && dual
    ? { endCash: endCash + dual.netF, netMovement: dual.netF, drivers: dual.sections.map(s => ({ label: s.label, value: s.netF })), horizonLabel }
    : null
  // Column layout: dual cards when forecast is on, single-value cards otherwise.
  const stmtColumns: { label: string }[][] = forecastActive && dual
    ? arrangeByColumns(dual.sections, STMT_COLUMNS)
    : arrangeByColumns(sections, STMT_COLUMNS)

  return (
    <div className="crp-page">
      <div className="crp-head">
        <img className="crp-logo" src="/ccc-logo.png" alt="CCC" />
        <div className="crp-head-t">
          <h1>Cash Flow Report — {scopeLabel}</h1>
          <div className="crp-sub">{forecastActive
            ? <>Actual Jan–{asOfLabel} · forecast to {horizonLabel} · USD millions · {matched.length} areas</>
            : <>Actual to date · Jan–{asOfLabel} · USD millions · {matched.length} areas</>}</div>
        </div>
        <div className="crp-brand">Treasury</div>
      </div>

      <CashTimeline startCash={startCash} endCash={endCash} netMovement={netMovement} drivers={drivers} hasCash={hasCash} startLabel={cashStartLabel} asOfLabel={asOfLabel} forecast={forecast} />

      {/* Justified 3-column grid: Operations · the four stacked sections · charts.
          The Loans & Overdrafts debt position sits at the top of column 1, above
          the Operations card. */}
      <div className="crp-groupcols">
        {stmtColumns.map((col, i) => (
          <div className={`crp-seccol${i === 1 ? ' crp-seccol--spaced' : ''}`} key={i}>
            {i === 0 && hasDebt && <DebtPositionCard loanStart={loanStart} loanEnd={loanEnd} odStart={odStart} odEnd={odEnd} startLabel={startLabel} asOfLabel={asOfLabel} />}
            {col.map(sec => forecastActive
              ? <DualStmtSectionCard key={sec.label} sec={sec as DualSection} />
              : <StmtSectionCard key={sec.label} sec={sec as StmtSection} />)}
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

/* ── Movers view — the Area table, but one row per PROJECT ───────────────────
 * Mirrors the Area page: net cash from operations (Operation + Claims, USD) +
 * trade-payables position at two periods + Δ, per project, GROUPED BY AREA with
 * an area subtotal and a grand total. Sortable by cash from ops (Both / Positive
 * / Negative), which surfaces the biggest movers in each direction. Payables are
 * the CCC-share trade payables of each project's mapped TB books (blank where a
 * project is not yet mapped — same as the Area page). */
type MoverRow = { key: string; area: string; code: string; netOps: number; payStart: number | null; payEnd: number | null }
function MoversView({ scope, fxMap, areaOptions, year, asOfMonth, asOfLabel, startLabel, registerPrint }: {
  scope: Scope; fxMap: Map<string, number | null>; areaOptions: { areaId: string; label: string }[]
  year: number; asOfMonth: number; asOfLabel: string; startLabel: string
  registerPrint: (fn: (() => void) | null) => void
}) {
  const ALL = '__ALL__', SEP = '', MINIMAL = 100_000   // "minimal mover" = |CFO| under 0.1m
  const [areaId, setAreaId] = useState<string>(ALL)
  const [moverFilter, setMoverFilter] = useState<'both' | 'pos' | 'neg'>('both')
  const [selected, setSelected] = useState<Set<string>>(new Set())   // ticked rows
  const [ignored, setIgnored] = useState<Set<string>>(new Set())     // hidden from table/chart/totals/print
  // Areas collapsed to just their subtotal row — persisted, and honoured in print too.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { const raw = localStorage.getItem('crp-movers-collapsed-v1'); return new Set<string>(raw ? JSON.parse(raw) : []) } catch { return new Set() }
  })
  const persistCollapsed = (n: Set<string>) => {
    try { localStorage.setItem('crp-movers-collapsed-v1', JSON.stringify([...n])) } catch { /* ignore */ }
    setCollapsed(n)
  }
  const toggleCollapse = (area: string) => { const n = new Set(collapsed); n.has(area) ? n.delete(area) : n.add(area); persistCollapsed(n) }
  const [cells, setCells] = useState<(CfCell & { project_code: string | null; currency?: string })[]>([])
  const [loading, setLoading] = useState(false)
  const [payMaps, setPayMaps] = useState<PayablesMaps | null>(null)
  const [bookBal, setBookBal] = useState<Map<string, Map<number, number>>>(new Map())
  const decP = (year - 1) * 100 + 12, asOfP = year * 100 + asOfMonth

  useEffect(() => { fetchPayablesMaps().then(setPayMaps).catch(() => setPayMaps(null)) }, [])
  useEffect(() => { fetchPayablesBookBalances([decP, asOfP]).then(setBookBal).catch(() => setBookBal(new Map())) }, [decP, asOfP])
  useEffect(() => {
    if (!scope.primaryVersion) { setCells([]); return }
    let cancel = false; setLoading(true)
    fetchProjectCells({ version: scope.primaryVersion, cfArea: areaId === ALL ? undefined : areaId, fromYear: year, fromMonth: 1, toYear: year, toMonth: asOfMonth })
      .then(rows => { if (!cancel) setCells(rows) })
      .catch(() => { if (!cancel) setCells([]) })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [areaId, scope.primaryVersion, year, asOfMonth])

  const opCodes = useMemo(() => new Set(scope.lines.filter(l => l.category === 'Operation' || l.category === 'Claims').map(l => l.line_code)), [scope.lines])
  const rateOf = (cur?: string) => (cur || 'USD') === 'USD' ? 1 : (fxMap.get(cur || '') ?? null)
  const areaLabelOf = (a: string) => areaOptions.find(o => o.areaId === a)?.label || a

  // Per-project net cash from operations (USD).
  const projOps = useMemo(() => {
    const agg = new Map<string, { area: string; code: string; netOps: number }>()
    for (const c of cells) {
      const code = c.project_code; if (!code) continue
      if (!opCodes.has(c.line_code)) continue
      const r = rateOf(c.currency); if (r == null) continue
      const key = c.area + SEP + code
      let a = agg.get(key); if (!a) { a = { area: c.area, code, netOps: 0 }; agg.set(key, a) }
      a.netOps += c.value * r
    }
    return agg
  }, [cells, opCodes, fxMap])

  // Attach each project's trade-payables at the two periods (via its books).
  const rows = useMemo<MoverRow[]>(() => {
    return [...projOps.entries()].map(([key, x]) => {
      const cid = payMaps?.cfCodeToCanon.get(x.code.toUpperCase())
      const books = cid ? (payMaps?.canonToBooks.get(cid) ?? []) : []
      let ps = 0, pe = 0, has = false
      for (const b of books) { const bm = bookBal.get(b); if (bm) { ps += bm.get(decP) ?? 0; pe += bm.get(asOfP) ?? 0; has = true } }
      return { key, area: x.area, code: x.code, netOps: x.netOps, payStart: has ? ps : null, payEnd: has ? pe : null }
    }).sort((a, b) => Math.abs(b.netOps) - Math.abs(a.netOps))
  }, [projOps, payMaps, bookBal, decP, asOfP])

  const shown = useMemo(() =>
    moverFilter === 'pos' ? rows.filter(r => r.netOps > 0)
    : moverFilter === 'neg' ? rows.filter(r => r.netOps < 0)
    : rows, [rows, moverFilter])
  // Visible set = filtered rows minus the ones the user has ignored.
  const kept = useMemo(() => shown.filter(r => !ignored.has(r.key)), [shown, ignored])

  const groups = useMemo(() => {
    const m = new Map<string, MoverRow[]>()
    for (const r of kept) { const arr = m.get(r.area) ?? []; arr.push(r); m.set(r.area, arr) }
    return [...m.entries()].map(([area, items]) => {
      let ps = 0, pe = 0, hasPay = false
      for (const r of items) if (r.payStart != null || r.payEnd != null) { ps += r.payStart ?? 0; pe += r.payEnd ?? 0; hasPay = true }
      return {
        area, label: areaLabelOf(area),
        netOps: items.reduce((t, r) => t + r.netOps, 0),
        payStart: hasPay ? ps : null, payEnd: hasPay ? pe : null,
        items: [...items].sort((a, b) => b.netOps - a.netOps),
      }
    }).sort((a, b) => Math.abs(b.netOps) - Math.abs(a.netOps))
  }, [kept])

  const grand = useMemo(() => {
    let netOps = 0, ps = 0, pe = 0, hasPay = false
    for (const r of kept) { netOps += r.netOps; if (r.payStart != null || r.payEnd != null) { ps += r.payStart ?? 0; pe += r.payEnd ?? 0; hasPay = true } }
    return { netOps, payStart: hasPay ? ps : null, payEnd: hasPay ? pe : null }
  }, [kept])

  const toggle = (key: string) => setSelected(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  const ignoreSelected = () => { setIgnored(prev => new Set([...prev, ...selected])); setSelected(new Set()) }
  const ignoreMinimal = () => setIgnored(prev => new Set([...prev, ...kept.filter(r => Math.abs(r.netOps) < MINIMAL).map(r => r.key)]))
  const resetIgnored = () => { setIgnored(new Set()); setSelected(new Set()) }
  const nMinimal = kept.filter(r => Math.abs(r.netOps) < MINIMAL).length

  const areaLabel = areaId === ALL ? 'All areas' : areaLabelOf(areaId)
  const payD = (s: number | null, e: number | null) => (s != null && e != null) ? e - s : null

  const printMovers = () => {
    const w = window.open('', '_blank'); if (!w) return
    const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
    const cell = (v: number | null) => `<td class="r ${cls(v)}">${fMm(v)}</td>`
    const dcell = (v: number | null) => `<td class="r ${cls(v)}">${fMd(v)}</td>`
    const body = groups.map(g => `
      <tr class="grp"><td>${esc(g.label)} <span class="k">· ${g.items.length}</span></td>${cell(g.netOps)}${cell(g.payStart)}${cell(g.payEnd)}${dcell(payD(g.payStart, g.payEnd))}</tr>
      ${collapsed.has(g.area) ? '' : g.items.map(r => `<tr><td class="p">${esc(r.code)}</td>${cell(r.netOps)}${cell(r.payStart)}${cell(r.payEnd)}${dcell(payD(r.payStart, r.payEnd))}</tr>`).join('')}`).join('')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Cash Flow — Projects by area</title><style>
      @page { size: A4 landscape; margin: 12mm; }
      * { box-sizing: border-box; } body { font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; color: #141414; margin: 0; }
      header { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #E10020; padding-bottom: 8px; margin-bottom: 12px; }
      header img { height: 34px; } header h1 { font-size: 16px; margin: 0; font-weight: 700; } .sub { font-size: 10px; color: #64748b; }
      .brand { margin-left: auto; font-size: 11px; font-weight: 700; color: #E10020; text-transform: uppercase; letter-spacing: .5px; }
      table { width: 100%; border-collapse: collapse; font-size: 10.5px; } th { text-align: left; font-size: 8px; text-transform: uppercase; letter-spacing: .4px; color: #64748b; border-bottom: 1px solid #cbd5e1; padding: 3px 8px; }
      th.r, td.r { text-align: right; font-variant-numeric: tabular-nums; } td { padding: 2.5px 8px; }
      tr.grp td { background: #f1f4f8; font-weight: 800; text-transform: uppercase; font-size: 9.5px; border-top: 1.2px solid #141414; } td.p { padding-left: 16px; }
      tr.tot td { font-weight: 800; border-top: 2px solid #141414; } .neg { color: #E10020; } .pos { color: #057a55; } .k { color: #94a3b8; font-weight: 400; }
      .chart { margin-top: 14px; page-break-inside: avoid; }
    </style></head><body>
      <header><img src="${location.origin}/ccc-logo.png" alt="CCC"/><div><h1>Cash Flow Report — Projects by area</h1><div class="sub">${esc(areaLabel)} · net cash from operations · Jan–${asOfLabel} · USD millions · ${kept.length} projects${moverFilter !== 'both' ? ` (${moverFilter === 'pos' ? 'positive' : 'negative'})` : ''}</div></div><div class="brand">Treasury</div></header>
      <table><thead><tr><th>Project</th><th class="r">Net cash from ops</th><th class="r">Payables ${startLabel}</th><th class="r">Payables ${asOfLabel}</th><th class="r">Δ</th></tr></thead>
      <tbody>${body}<tr class="tot"><td>All shown (${kept.length})</td>${cell(grand.netOps)}${cell(grand.payStart)}${cell(grand.payEnd)}${dcell(payD(grand.payStart, grand.payEnd))}</tr></tbody></table>
      <div class="chart">${areaBarsSvg(kept.map(r => ({ label: r.code, value: r.netOps })), undefined, { zoom: 1.05, maxRows: 24 })}</div>
      <script>window.onload=function(){window.print()}</script></body></html>`
    w.document.write(html); w.document.close()
  }
  // Keep the top-bar Print button wired to the current print closure.
  useEffect(() => { registerPrint(kept.length ? printMovers : null); return () => registerPrint(null) })

  return (
    <div className="crp-page">
      <div className="crp-head">
        <img className="crp-logo" src="/ccc-logo.png" alt="CCC" />
        <div className="crp-head-t">
          <h1>Cash Flow Report — Projects by area</h1>
          <div className="crp-sub">{areaLabel} · net cash from operations · Jan–{asOfLabel} · USD millions · {kept.length}{moverFilter !== 'both' ? ` ${moverFilter === 'pos' ? 'positive' : 'negative'}` : ''} project{kept.length === 1 ? '' : 's'}{ignored.size > 0 ? ` · ${ignored.size} ignored` : ''}</div>
        </div>
        <div className="crp-brand">Treasury</div>
      </div>

      <div className="crp-projtop no-print">
        <select className="crp-select" value={areaId} onChange={e => setAreaId(e.target.value)}>
          <option value={ALL}>All areas</option>
          {areaOptions.map(a => <option key={a.areaId} value={a.areaId}>{a.label}</option>)}
        </select>
        {rows.length > 0 && (
          <div className="crp-movers" role="group" aria-label="Show which cash movers">
            <span className="crp-pick-l">Movers</span>
            {([['both', 'Both'], ['pos', 'Positive'], ['neg', 'Negative']] as const).map(([k, l]) => (
              <button key={k} className={`crp-moverbtn ${moverFilter === k ? 'active' : ''}`}
                title={k === 'pos' ? 'Biggest cash generators' : k === 'neg' ? 'Biggest cash consumers' : 'Biggest movers, either direction'}
                onClick={() => setMoverFilter(k)}>{l}</button>
            ))}
          </div>
        )}
        {groups.length > 1 && (
          <div className="crp-pick">
            <button className="crp-pickbtn" disabled={groups.every(g => collapsed.has(g.area))} onClick={() => persistCollapsed(new Set(groups.map(g => g.area)))}>Collapse all</button>
            <button className="crp-pickbtn" disabled={collapsed.size === 0} onClick={() => persistCollapsed(new Set())}>Expand all</button>
          </div>
        )}
        {(kept.length > 0 || ignored.size > 0) && (
          <div className="crp-pick">
            <button className="crp-pickbtn" disabled={selected.size === 0} onClick={ignoreSelected}>Ignore selected ({selected.size})</button>
            <button className="crp-pickbtn" disabled={nMinimal === 0} onClick={ignoreMinimal} title="Hide projects that barely move — |net cash from ops| under 0.1m">Ignore minimal ({nMinimal})</button>
            {ignored.size > 0 && <button className="crp-pickbtn" onClick={resetIgnored}>Reset ({ignored.size} ignored)</button>}
          </div>
        )}
      </div>

      <div className="crp-grid">
        <div className="crp-card">
          <div className="crp-card-h">Projects <span>· net cash from operations &amp; trade payables, by area{moverFilter === 'pos' ? ' · positive' : moverFilter === 'neg' ? ' · negative' : ''}</span></div>
          {loading ? <div className="crp-note crp-note--empty">Loading…</div>
            : kept.length === 0 ? <div className="crp-note crp-note--empty">{rows.length === 0 ? 'No project-grain cash flow for this scope.' : shown.length === 0 ? `No ${moverFilter === 'pos' ? 'positive' : 'negative'} projects in this scope.` : 'All projects are ignored — use Reset to show them.'}</div>
            : <table className="crp-table crp-table--area crp-table--projarea">
              <thead><tr>
                <th className="crp-ck"></th>
                <th>Project</th>
                <th className="r">Net cash from ops</th>
                <th className="r crp-sep-l">Payables {startLabel}</th>
                <th className="r">Payables {asOfLabel}</th>
                <th className="r">Δ</th>
              </tr></thead>
              <tbody>
                {groups.flatMap(g => [
                  <tr className="crp-projgrp crp-projgrp--clickable" key={g.area} onClick={() => toggleCollapse(g.area)} title={collapsed.has(g.area) ? 'Expand area' : 'Collapse area'}>
                    <td className="crp-ck"></td>
                    <td className="crp-projgrp-name"><span className={`crp-grp-chev ${collapsed.has(g.area) ? '' : 'open'}`} aria-hidden>▶</span>{g.label} <span className="crp-key">· {g.items.length}</span></td>
                    <td className={`r ${cls(g.netOps)}`}>{fMm(g.netOps)}</td>
                    <td className={`r crp-sep-l ${cls(g.payStart)}`}>{fMm(g.payStart)}</td>
                    <td className={`r ${cls(g.payEnd)}`}>{fMm(g.payEnd)}</td>
                    <td className={`r ${cls(payD(g.payStart, g.payEnd))}`}>{fMd(payD(g.payStart, g.payEnd))}</td>
                  </tr>,
                  ...(collapsed.has(g.area) ? [] : g.items.map(r => (
                    <tr className={`crp-projtr ${selected.has(r.key) ? 'sel' : ''}`} key={r.key}>
                      <td className="crp-ck"><input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} title="Select to ignore" /></td>
                      <td className="crp-projtd">{r.code}</td>
                      <td className={`r ${cls(r.netOps)}`}>{fMm(r.netOps)}</td>
                      <td className={`r crp-sep-l ${cls(r.payStart)}`}>{fMm(r.payStart)}</td>
                      <td className={`r ${cls(r.payEnd)}`}>{fMm(r.payEnd)}</td>
                      <td className={`r ${cls(payD(r.payStart, r.payEnd))}`}>{fMd(payD(r.payStart, r.payEnd))}</td>
                    </tr>
                  ))),
                ])}
                <tr className="crp-total">
                  <td className="crp-ck"></td>
                  <td>All shown ({kept.length})</td>
                  <td className={`r ${cls(grand.netOps)}`}>{fMm(grand.netOps)}</td>
                  <td className={`r crp-sep-l ${cls(grand.payStart)}`}>{fMm(grand.payStart)}</td>
                  <td className={`r ${cls(grand.payEnd)}`}>{fMm(grand.payEnd)}</td>
                  <td className={`r ${cls(payD(grand.payStart, grand.payEnd))}`}>{fMd(payD(grand.payStart, grand.payEnd))}</td>
                </tr>
              </tbody>
            </table>}
          <div className="crp-note">Net cash from operations (receipts − payments, USD, Jan–{asOfLabel}) — same basis as the Area page. Grouped by area with an area subtotal; use <b>Movers</b> to isolate positive or negative and sort by size. Payables = the project's CCC-share trade payables from its mapped Midas books ({startLabel} → {asOfLabel}); blank = not yet mapped to a book. Δ positive = paid down.</div>
        </div>

        <div className="crp-card">
          <div className="crp-card-h">Net cash from operations <span>· top project movers</span></div>
          <Svg html={areaBarsSvg(kept.map(r => ({ label: r.code, value: r.netOps })), undefined, { maxRows: 16 })} />
          <div className="crp-note">Green = cash generated, crimson = consumed (USD, Jan–{asOfLabel}). Top 16 projects by size; the rest rolled into “Other”.</div>
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
  const [moverFilter, setMoverFilter] = useState<'both' | 'pos' | 'neg'>('both')   // movers list: both / positive / negative

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

  // Movers filter — `ranking` is sorted by |net| desc (biggest movers first), so
  // filtering by sign keeps that order: top gainers, or top drainers. Drives the
  // list, the top-N picks, and which project the detail panel defaults to.
  const shown = useMemo(() =>
    moverFilter === 'pos' ? ranking.filter(r => r.net > 0)
    : moverFilter === 'neg' ? ranking.filter(r => r.net < 0)
    : ranking, [ranking, moverFilter])
  const maxAbs = Math.max(1, ...shown.map(r => Math.abs(r.net)))
  const bigCut = maxAbs * 0.12
  const sel = project || shown[0]?.key || ''
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
  const pickTop = (n: number) => { setSelected(new Set(shown.slice(0, n).map(r => r.key))); setAnchor(null) }
  // Shift-click a checkbox to select the whole range from the last clicked row.
  const rangeSelect = (idx: number) => setSelected(prev => {
    if (anchor == null) return prev
    const n = new Set(prev), [a, b] = anchor < idx ? [anchor, idx] : [idx, anchor]
    for (let i = a; i <= b; i++) n.add(shown[i].key)
    return n
  })
  const printProjects = async (keys: string[]) => {
    const w = window.open('', '_blank'); if (!w) return
    w.document.write('<p style="font:14px -apple-system,sans-serif;padding:24px;color:#475569">Preparing print…</p>')
    const base = keys.map(k => matrixFor(k)).filter(x => x.fxOk && x.matrix.sections.length > 0)
    if (base.length === 0) { w.close(); return }
    const fromP = (year - 1) * 100 + 12, toP = year * 100 + asOfMonth
    const list = await Promise.all(base.map(async x => {
      // Trade-payables balance movement for this project (Dec → as-of), aligned to months.
      let payables: import('./reportPrint').ProjectPrint['payables']
      const cid = payMaps?.cfCodeToCanon.get(x.code.toUpperCase())
      const books = cid ? (payMaps?.canonToBooks.get(cid) ?? []) : []
      if (books.length) {
        const s = await fetchPayablesForBooks(books, fromP, toP)
        const byP = new Map(s.map(p => [p.period, p.usd]))
        const monthly = months.map(m => byP.has(year * 100 + m) ? byP.get(year * 100 + m)! : null)
        const start = byP.has(fromP) ? byP.get(fromP)! : null
        const last = [...monthly].reverse().find(v => v != null) ?? null
        payables = { monthly, start, change: last != null && start != null ? last - start : null }
      }
      return { areaLabel: areaLabelOf(x.area), project: x.code, currency: x.currency, asOfLabel, months, matrix: x.matrix, payables }
    }))
    w.document.open(); w.document.write(buildProjectsPrintHtml(list)); w.document.close()
  }

  // Trade-payables balance series for the selected project (screen charts).
  const payPts = paySeries.map(p => ({ label: MONTHS[(p.period % 100) - 1] ?? '', value: p.usd }))
  const payFirst = payPts[0]?.value ?? 0
  const payLast = payPts[payPts.length - 1]?.value ?? 0
  const payDelta = payLast - payFirst

  return (
    <div className="crp-page">
      <div className="crp-head">
        <img className="crp-logo" src="/ccc-logo.png" alt="CCC" />
        <div className="crp-head-t">
          <h1>Cash Flow Report — Projects</h1>
          <div className="crp-sub">{areaLabel} · monthly actuals Jan–{asOfLabel} · USD millions · {shown.length}{moverFilter !== 'both' ? ` ${moverFilter === 'pos' ? 'positive' : 'negative'}` : ''} project{shown.length === 1 ? '' : 's'}</div>
        </div>
        <div className="crp-brand">Treasury</div>
      </div>

      <div className="crp-projtop no-print">
        <select className="crp-select" value={areaId} onChange={e => { setProjArea(e.target.value); setProject('') }}>
          <option value={ALL}>All areas</option>
          {areaOptions.map(a => <option key={a.areaId} value={a.areaId}>{a.label}</option>)}
        </select>
        {ranking.length > 0 && (
          <div className="crp-movers" role="group" aria-label="Show which cash movers">
            <span className="crp-pick-l">Movers</span>
            {([['both', 'Both'], ['pos', 'Positive'], ['neg', 'Negative']] as const).map(([k, l]) => (
              <button key={k} className={`crp-moverbtn ${moverFilter === k ? 'active' : ''}`}
                title={k === 'pos' ? 'Biggest cash generators' : k === 'neg' ? 'Biggest cash consumers' : 'Biggest movers, either direction'}
                onClick={() => { setMoverFilter(k); setProject('') }}>{l}</button>
            ))}
          </div>
        )}
        {shown.length > 0 && (
          <div className="crp-pick">
            <span className="crp-pick-l">Select</span>
            {[5, 10, 20].filter(n => n < shown.length).map(n => (
              <button key={n} className="crp-pickbtn" onClick={() => pickTop(n)}>Top {n}</button>
            ))}
            <button className="crp-pickbtn" onClick={() => pickTop(shown.length)}>All</button>
            <button className="crp-pickbtn" disabled={selected.size === 0} onClick={() => { setSelected(new Set()); setAnchor(null) }}>None</button>
          </div>
        )}
        <button className="crp-print" disabled={!showBody} onClick={() => printProjects([sel])}>Print this</button>
        <button className="crp-print" disabled={selected.size === 0} onClick={() => printProjects([...selected])}>Print selected ({selected.size})</button>
      </div>

      <div className="crp-grid crp-grid--proj">
        {/* Ranked project list — big movers on top, tick to print */}
        <div className="crp-card">
          <div className="crp-card-h">Projects <span>· by cash movement{moverFilter === 'pos' ? ' · generators' : moverFilter === 'neg' ? ' · consumers' : ''}</span></div>
          <div className="crp-projlist">
            {shown.map((r, idx) => {
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
            {shown.length === 0 ? <div className="crp-note crp-note--empty">{ranking.length === 0 ? 'No project-grain cash flow for this scope.' : `No ${moverFilter === 'pos' ? 'positive' : 'negative'} movers in this scope.`}</div> : null}
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
                {/* Each chart carries its own stat cards directly above it, so the
                    figures read against the chart they describe (not floating). */}
                <div className="crp-chartpair">
                  <div className="crp-chartcell">
                    <div className="crp-chart-cap">Net cash movement <span>· by month</span></div>
                    <KpiBand compact cards={[
                      { label: 'Net cash movement · YTD', value: fMm(matrix.netTotal), cls: cls(matrix.netTotal) },
                      { label: 'Net from operations', value: fMm(secNet('Operations')), cls: cls(secNet('Operations')) },
                      { label: 'Net financing', value: fMm(secNet('Bank Financing')), cls: cls(secNet('Bank Financing')) },
                    ]} />
                    <Svg html={netTrendSvg(months.map(m => MONTHS[m - 1]), matrix.netMovement)} />
                  </div>
                  <div className="crp-chartcell">
                    <div className="crp-chart-cap">Trade payables <span>· balance{payBooks ? ` · ${payBooks} book${payBooks === 1 ? '' : 's'}` : ''}</span></div>
                    {payBooks > 0 && payPts.length > 0 && (
                      <KpiBand compact cards={[
                        { label: `Payables · ${asOfLabel}`, value: fMm(payLast), cls: cls(payLast) },
                        { label: 'At start (Dec)', value: fMm(payFirst), cls: cls(payFirst) },
                        { label: 'Change over period', value: fMm(payDelta), cls: cls(payDelta) },
                      ]} />
                    )}
                    {payBooks === 0
                      ? <div className="crp-note crp-note--empty">Not mapped to a book yet — payables sit in the area bucket. Assign in Manage → Payables map.</div>
                      : payPts.length === 0
                      ? <div className="crp-note crp-note--empty">No payables balance for the mapped book(s).</div>
                      : <Svg html={payablesTrendSvg(payPts)} />}
                  </div>
                </div>
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
