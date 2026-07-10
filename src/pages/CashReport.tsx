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
import { buildModel, buildStatement, buildStatementMatrix, buildForecastLineUsd, buildDualStatement, buildMoverRows, payablesSeries, arrangeSectionColumns, arrangeByColumns, STMT_COLUMNS, type AreaAgg, type StmtSection, type DualSection, type MatrixSection, type PaySeriesPt, type MoverRow } from './reportModel'
import { buildReportHtml, buildProjectsPrintHtml, buildPackageHtml, type PackageSheet, type MoversCard, type MoversCardRow, type ProjectPrint, type PrintDisp, type GroupForecast } from './reportPrint'
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
const LEVELS: Level[] = ['group', 'sections', 'area', 'project', 'movers']
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
  const [pkgOpen, setPkgOpen] = useState(false)            // print-package modal
  const [pkgBusy, setPkgBusy] = useState(false)            // package build in flight

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

  // Forecast net cash from operations (Operation + Claims) per area — feeds the
  // Area page's forecast column + the solid/faded bars. Same op categories as
  // buildModel's netOps, so the actual and forecast columns are comparable.
  const opCodes = useMemo(() => new Set(scope.lines.filter(l => l.category === 'Operation' || l.category === 'Claims').map(l => l.line_code)), [scope.lines])
  const fcNetOpsByArea = useMemo(() => {
    const m = new Map<string, number>()
    if (forecastActive) for (const [aid, lm] of fcByArea) { let n = 0; for (const [lc, v] of lm) if (opCodes.has(lc)) n += v; m.set(aid, n) }
    return m
  }, [forecastActive, fcByArea, opCodes])

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
    { key: 'group', label: 'Group' }, { key: 'sections', label: 'Sections' }, { key: 'area', label: 'Area' },
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
      const areaRows = cfAreas.map(a => ({ label: a.label, netOps: a.netOps, fcNetOps: forecastActive ? (fcNetOpsByArea.get(a.areaId) ?? 0) : undefined, payStart: a.payStart, payEnd: a.payEnd }))
      const areaTotals = cfAreas.reduce((t, a) => ({ netOps: t.netOps + a.netOps, fcNetOps: t.fcNetOps + (forecastActive ? (fcNetOpsByArea.get(a.areaId) ?? 0) : 0), payStart: t.payStart + (a.payStart ?? 0), payEnd: t.payEnd + (a.payEnd ?? 0) }), { netOps: 0, fcNetOps: 0, payStart: 0, payEnd: 0 })
      html = buildReportHtml({ level: 'area', scopeLabel: 'Areas', year, asOfLabel, startLabel, areaRows, areaTotals, matchedCount: cfAreas.length, forecastActive, horizonLabel })
    } else if (level === 'sections') {
      html = buildReportHtml({
        level: 'sections', scopeLabel: 'Sections', year, asOfLabel, startLabel, matchedCount: cfAreas.length,
        sections: sectionCards(cfAreas, scope.lines, forecastActive ? fcByArea : undefined),
        forecastActive, horizonLabel,
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
        forecast = { dual: buildDualStatement(lineUsd, fcLineUsd, scope.lines), horizonLabel }
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

  // ── Print package ──────────────────────────────────────────────────────────
  // One document assembling any subset of report pages (Group / Area / Sections /
  // Movers all / Movers mainstream / a page per mainstream project), each on its
  // own page with an invisible bookmark anchor so /pdf-bookmarker builds a matching
  // outline. Group/Area/Sections come from the parent's in-scope model; Movers +
  // project pages need project-grain cells + payables, fetched here on demand.
  const buildPackage = async (sel: PkgSelection) => {
    const w = window.open('', '_blank'); if (!w) return
    w.document.write('<p style="font:14px -apple-system,sans-serif;padding:24px;color:#475569">Preparing report package…</p>')
    setPkgBusy(true)
    try {
      const sheets: PackageSheet[] = []

      // Group / Area / Sections — from the in-scope aggregate (mirror print()).
      if (sel.group) {
        const { scopeLabel, lineUsd, payStart, payEnd, hasPay, startCash, loanStart, loanEnd, odStart, odEnd } = aggregateScope(cfAreas)
        const stmt = buildStatement(lineUsd, scope.lines)
        let forecast: GroupForecast | undefined
        if (forecastActive) {
          const fcLineUsd = new Map<string, number>()
          for (const a of cfAreas) { const m = fcByArea.get(a.areaId); if (m) for (const [lc, v] of m) fcLineUsd.set(lc, (fcLineUsd.get(lc) ?? 0) + v) }
          forecast = { dual: buildDualStatement(lineUsd, fcLineUsd, scope.lines), horizonLabel }
        }
        sheets.push({ kind: 'group', opts: {
          scopeLabel, asOfLabel, startLabel, cashStartLabel, matchedCount: cfAreas.length,
          statement: stmt, payStart, payEnd, hasPay, startCash, endCash: startCash + stmt.netMovement,
          loanStart, loanEnd, odStart, odEnd,
          paySeries: paySeries.map(p => ({ label: MONTHS[(p.period % 100) - 1] ?? '', value: p.usd })),
          forecast, disp: PKG_DISP, bmk: { title: 'Group', depth: 0 },
        } })
      }
      if (sel.sections) {
        sheets.push({ kind: 'sections', opts: {
          asOfLabel, matchedCount: cfAreas.length,
          sections: sectionCards(cfAreas, scope.lines, forecastActive ? fcByArea : undefined),
          forecastActive, horizonLabel, disp: PKG_DISP, bmk: { title: 'Sections', depth: 0 },
        } })
      }
      if (sel.area) {
        const areaRows = cfAreas.map(a => ({ label: a.label, netOps: a.netOps, fcNetOps: forecastActive ? (fcNetOpsByArea.get(a.areaId) ?? 0) : undefined, payStart: a.payStart, payEnd: a.payEnd }))
        const areaTotals = cfAreas.reduce((t, a) => ({ netOps: t.netOps + a.netOps, fcNetOps: t.fcNetOps + (forecastActive ? (fcNetOpsByArea.get(a.areaId) ?? 0) : 0), payStart: t.payStart + (a.payStart ?? 0), payEnd: t.payEnd + (a.payEnd ?? 0) }), { netOps: 0, fcNetOps: 0, payStart: 0, payEnd: 0 })
        sheets.push({ kind: 'area', opts: { asOfLabel, startLabel, areaRows, areaTotals, forecastActive, horizonLabel, disp: PKG_DISP, bmk: { title: 'Area', depth: 0 } } })
      }

      // Movers + mainstream projects — project-grain cells (all areas) + payables.
      if (sel.moversAll || sel.moversMain || sel.projects) {
        const decP = (year - 1) * 100 + 12, asOfP = year * 100 + asOfMonth
        const [act, fcT, pm, bb] = await Promise.all([
          fetchProjectCells({ version: scope.primaryVersion, fromYear: year, fromMonth: 1, toYear: year, toMonth: asOfMonth }),
          forecastActive && asOfMonth < 12
            ? fetchProjectCells({ version: scope.primaryVersion, fromYear: year, fromMonth: asOfMonth + 1, toYear: year, toMonth: horizonMonth })
            : Promise.resolve([] as (CfCell & { project_code: string | null; currency?: string })[]),
          fetchPayablesMaps().catch(() => null),
          fetchPayablesBookBalances([decP, asOfP]).catch(() => new Map<string, Map<number, number>>()),
        ])
        const opCodes = new Set(scope.lines.filter(l => l.category === 'Operation' || l.category === 'Claims').map(l => l.line_code))
        const moverRows = buildMoverRows({ cells: act, fcCells: fcT, opCodes, fxMap, payMaps: pm, bookBal: bb, decP, asOfP, forecastActive })
        const areaLabelOf = (a: string) => projAreaOptions.find(o => o.areaId === a)?.label || a

        if (sel.moversAll) {
          // "All projects" page: mainstream shown in full, everything else folded
          // into one "Other projects" line per area card (totals still reconcile).
          // Cards in three columns, the mainstream chart alone in a full-height
          // fourth column (layout: 'chartCol', cardCols: 3).
          const s = shapeMoverGroupsFolded(moverRows, forecastActive, areaLabelOf)
          sheets.push({ kind: 'movers', opts: {
            title: 'Cash Flow Report — Movers', areaLabel: 'All areas', asOfLabel, startLabel,
            forecastActive, horizonLabel, headNote: `${s.gMain} mainstream · ${s.gN} projects`, layout: 'chartCol', cardCols: 3, ...s, disp: PKG_DISP,
            bmk: { title: 'Movers — all projects', depth: 0 },
          } })
        }
        if (sel.moversMain) {
          // Mainstream-only page: cards in two columns, the net-CFO chart alone in a
          // full-height third column (layout: 'chartCol').
          const s = shapeMoverGroups(moverRows.filter(r => r.isPrimary), forecastActive, areaLabelOf)
          sheets.push({ kind: 'movers', opts: {
            title: 'Cash Flow Report — Mainstream movers', areaLabel: 'All areas', asOfLabel, startLabel,
            forecastActive, horizonLabel, headNote: 'Mainstream projects', layout: 'chartCol', cardCols: 2, ...s, disp: PKG_DISP,
            bmk: { title: 'Movers — mainstream', depth: 0 },
          } })
        }
        if (sel.projects) {
          const mainRows = moverRows.filter(r => r.isPrimary)
          const dispMonths = Array.from({ length: forecastActive ? horizonMonth : asOfMonth }, (_, i) => i + 1)
          const rateOf = (cur?: string) => (cur || 'USD') === 'USD' ? 1 : (fxMap.get(cur || '') ?? null)
          const src = forecastActive ? [...act, ...fcT] : act
          const fromP = decP, toP = asOfP
          let first = true
          for (const mr of mainRows) {
            // Per-project line-items × months matrix (USD), mirroring ProjectView.
            const perCode = new Map<string, Map<number, number>>()
            let cur = 'USD', ok = true
            for (const c of src) {
              if (c.area !== mr.area || c.project_code !== mr.code) continue
              if (c.currency && c.currency !== 'USD') cur = c.currency
              const r = rateOf(c.currency); if (r == null) { ok = false; continue }
              let m = perCode.get(c.line_code); if (!m) { m = new Map(); perCode.set(c.line_code, m) }
              m.set(c.month, (m.get(c.month) ?? 0) + c.value * r)
            }
            if (!ok) continue
            const matrix = buildStatementMatrix(perCode, scope.lines, dispMonths)
            if (matrix.sections.length === 0) continue
            // Trade-payables balance movement (Dec → as-of) for the project's books.
            let payables: ProjectPrint['payables']
            const cid = pm?.cfCodeToCanon.get(mr.code.toUpperCase())
            const books = cid ? (pm?.canonToBooks.get(cid) ?? []) : []
            if (books.length) {
              const sPay = await fetchPayablesForBooks(books, fromP, toP)
              const byP = new Map(sPay.map(p => [p.period, p.usd]))
              const monthly = dispMonths.map(m => byP.has(year * 100 + m) ? byP.get(year * 100 + m)! : null)
              const start = byP.has(fromP) ? byP.get(fromP)! : null
              const last = [...monthly].reverse().find(v => v != null) ?? null
              payables = { monthly, start, change: last != null && start != null ? last - start : null }
            }
            // First project page also carries the depth-0 "Mainstream projects"
            // section header so the outline nests the projects beneath it.
            const projBmk = { title: mr.code, depth: 1 }
            sheets.push({ kind: 'project', opts: {
              areaLabel: areaLabelOf(mr.area), project: mr.code, currency: cur, asOfLabel, months: dispMonths, matrix, payables,
              actualCount: forecastActive ? asOfMonth : undefined, horizonLabel: forecastActive ? horizonLabel : undefined,
              bmk: first ? [{ title: 'Mainstream projects', depth: 0 }, projBmk] : projBmk,
            }, disp: PKG_DISP })
            first = false
          }
        }
      }

      if (sheets.length === 0) { w.document.open(); w.document.write('<p style="font:14px -apple-system,sans-serif;padding:24px;color:#475569">Nothing selected to print.</p>'); w.document.close(); return }
      w.document.open(); w.document.write(buildPackageHtml(sheets)); w.document.close()
    } finally {
      setPkgBusy(false); setPkgOpen(false)
    }
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
      {canPrint && <button className="crp-print" style={{ marginLeft: 0 }} onClick={print}>Print this</button>}
      <button className="crp-print crp-print--pkg" style={{ marginLeft: 0 }} onClick={() => setPkgOpen(true)} title="Build a print-ready report package (Group, Sections, Area, Movers, and a page per mainstream project) with PDF bookmarks">Print…</button>
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
        : level === 'area' ? <AreaView matched={cfAreas} year={year} asOfLabel={asOfLabel} startLabel={startLabel} fcNetOpsByArea={fcNetOpsByArea} forecastActive={forecastActive} horizonLabel={horizonLabel} onOpenProjects={(id) => { setProjArea(id); setLevel('project') }} />
        : level === 'sections' ? <SectionsView scope={scope} matched={cfAreas} asOfLabel={asOfLabel} fcByArea={fcByArea} forecastActive={forecastActive} horizonLabel={horizonLabel} />
        : level === 'project' ? <ProjectView scope={scope} fxMap={fxMap} areaOptions={projAreaOptions} projArea={projArea} setProjArea={setProjArea} year={year} asOfMonth={asOfMonth} asOfLabel={asOfLabel} forecastActive={forecastActive} horizonMonth={horizonMonth} horizonLabel={horizonLabel} />
        : level === 'movers' ? <MoversView scope={scope} fxMap={fxMap} areaOptions={projAreaOptions} year={year} asOfMonth={asOfMonth} asOfLabel={asOfLabel} startLabel={startLabel} forecastActive={forecastActive} horizonMonth={horizonMonth} horizonLabel={horizonLabel} registerPrint={fn => { moversPrint.current = fn }} />
        : null}

      <PrintPackageModal open={pkgOpen} busy={pkgBusy} onClose={() => { if (!pkgBusy) setPkgOpen(false) }} onGenerate={buildPackage} />
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
export type SectionCard = { label: string; net: number; fcNet?: number; rows: { label: string; value: number; forecast?: number }[] }
function sectionCards(matched: AreaAgg[], lines: CfLine[], fcByArea?: Map<string, Map<string, number>>): SectionCard[] {
  const agg = new Map<string, number>()
  for (const a of matched) for (const [lc, v] of a.lineUsd) agg.set(lc, (agg.get(lc) ?? 0) + v)
  const stmt = buildStatement(agg, lines)
  const byArea = matched.map(a => ({
    label: a.label,
    nets: new Map(buildStatement(a.lineUsd, lines).sections.map(s => [s.label, s.net])),
    fcNets: fcByArea ? new Map(buildStatement(fcByArea.get(a.areaId) ?? new Map(), lines).sections.map(s => [s.label, s.net])) : null,
  }))
  return stmt.sections.map(s => ({
    label: s.label, net: s.net,
    fcNet: fcByArea ? byArea.reduce((t, ba) => t + (ba.fcNets?.get(s.label) ?? 0), 0) : undefined,
    rows: byArea.map(a => ({ label: a.label, value: a.nets.get(s.label) ?? 0, forecast: a.fcNets ? (a.fcNets.get(s.label) ?? 0) : undefined }))
      .filter(r => Math.abs(r.value) >= 50000 || Math.abs(r.forecast ?? 0) >= 50000),
  })).filter(c => c.rows.length > 0)
}

/* USD-millions display for the print package (the report is USD-only). */
const PKG_DISP: PrintDisp = { div: 1e6, dec: 1, lineUnit: 'USD millions', payUnit: 'USD millions' }

/* Shape mover rows (already filtered to the wanted tier) into the print-package
 * Movers sheet: one card per area (project rows + subtotal), a diverging net-CFO
 * chart, and the grand totals. Mirrors the on-screen Movers grouping so the two
 * reconcile. */
function shapeMoverGroups(rows: MoverRow[], forecastActive: boolean, areaLabelOf: (a: string) => string): {
  cards: MoversCard[]; chartRows: { label: string; value: number; forecast?: number }[]
  grand: { netOps: number; fcNetOps?: number; payStart: number | null; payEnd: number | null }; gN: number; gMain: number
} {
  const byArea = new Map<string, MoverRow[]>()
  for (const r of rows) { const a = byArea.get(r.area) ?? []; a.push(r); byArea.set(r.area, a) }
  const groups = [...byArea.entries()].map(([area, items]) => {
    let ps = 0, pe = 0, hasPay = false
    for (const r of items) if (r.payStart != null || r.payEnd != null) { ps += r.payStart ?? 0; pe += r.payEnd ?? 0; hasPay = true }
    return {
      area, label: areaLabelOf(area),
      netOps: items.reduce((t, r) => t + r.netOps, 0),
      fcNetOps: items.reduce((t, r) => t + (r.fcNetOps ?? 0), 0),
      payStart: hasPay ? ps : null, payEnd: hasPay ? pe : null,
      items: [...items].sort((a, b) => b.netOps - a.netOps),
    }
  }).sort((a, b) => Math.abs(b.netOps) - Math.abs(a.netOps))
  const cards: MoversCard[] = groups.map(g => ({
    label: g.label, count: `${g.items.length}`,
    rows: g.items.map(r => ({ code: r.code, star: r.isPrimary, netOps: r.netOps, fcNetOps: r.fcNetOps, payStart: r.payStart, payEnd: r.payEnd })),
    subNet: g.netOps, subFc: forecastActive ? g.fcNetOps : undefined, subPayStart: g.payStart, subPayEnd: g.payEnd,
  }))
  let netOps = 0, fcNetOps = 0, ps = 0, pe = 0, hasPay = false, gMain = 0
  for (const r of rows) {
    netOps += r.netOps; fcNetOps += (r.fcNetOps ?? 0); if (r.isPrimary) gMain++
    if (r.payStart != null || r.payEnd != null) { ps += r.payStart ?? 0; pe += r.payEnd ?? 0; hasPay = true }
  }
  const chartRows = rows.map(r => ({ label: r.code, value: r.netOps, forecast: forecastActive ? (r.fcNetOps ?? 0) : undefined }))
  return { cards, chartRows, grand: { netOps, fcNetOps: forecastActive ? fcNetOps : undefined, payStart: hasPay ? ps : null, payEnd: hasPay ? pe : null }, gN: rows.length, gMain }
}

/* Like shapeMoverGroups, but each area card lists its MAINSTREAM projects in full
 * and folds every other project into ONE "Other projects" line at the bottom of the
 * card, so the card subtotal + grand total still reconcile to the full figure. The
 * chart plots only the mainstream projects. Used by the "all projects" movers page. */
function shapeMoverGroupsFolded(rows: MoverRow[], forecastActive: boolean, areaLabelOf: (a: string) => string, foldLabel = 'Others'): {
  cards: MoversCard[]; chartRows: { label: string; value: number; forecast?: number }[]
  grand: { netOps: number; fcNetOps?: number; payStart: number | null; payEnd: number | null }; gN: number; gMain: number
} {
  const sumPay = (arr: MoverRow[]) => { let s = 0, e = 0, has = false; for (const r of arr) if (r.payStart != null || r.payEnd != null) { s += r.payStart ?? 0; e += r.payEnd ?? 0; has = true } return { s: has ? s : null, e: has ? e : null } }
  const byArea = new Map<string, MoverRow[]>()
  for (const r of rows) { const a = byArea.get(r.area) ?? []; a.push(r); byArea.set(r.area, a) }
  const groups = [...byArea.entries()].map(([area, items]) => {
    const primary = items.filter(r => r.isPrimary).sort((a, b) => b.netOps - a.netOps)
    const others = items.filter(r => !r.isPrimary)
    const ap = sumPay(items), op = sumPay(others)
    const prows: MoversCardRow[] = primary.map(r => ({ code: r.code, star: true, netOps: r.netOps, fcNetOps: r.fcNetOps, payStart: r.payStart, payEnd: r.payEnd }))
    if (others.length) prows.push({ code: foldLabel, star: false, sec: true,
      netOps: others.reduce((t, r) => t + r.netOps, 0),
      fcNetOps: forecastActive ? others.reduce((t, r) => t + (r.fcNetOps ?? 0), 0) : undefined,
      payStart: op.s, payEnd: op.e })
    return {
      area, label: areaLabelOf(area),
      count: `${primary.length} main${others.length ? ` · ${others.length} other` : ''}`,
      rows: prows, primary,
      subNet: items.reduce((t, r) => t + r.netOps, 0),
      subFc: forecastActive ? items.reduce((t, r) => t + (r.fcNetOps ?? 0), 0) : undefined,
      subPayStart: ap.s, subPayEnd: ap.e,
    }
  }).sort((a, b) => Math.abs(b.subNet) - Math.abs(a.subNet))
  const cards: MoversCard[] = groups.map(g => ({ label: g.label, count: g.count, rows: g.rows, subNet: g.subNet, subFc: g.subFc, subPayStart: g.subPayStart, subPayEnd: g.subPayEnd }))
  const chartRows = groups.flatMap(g => g.primary).map(r => ({ label: r.code, value: r.netOps, forecast: forecastActive ? (r.fcNetOps ?? 0) : undefined }))
  let netOps = 0, fcNetOps = 0, ps = 0, pe = 0, hasPay = false, gMain = 0
  for (const r of rows) {
    netOps += r.netOps; fcNetOps += (r.fcNetOps ?? 0); if (r.isPrimary) gMain++
    if (r.payStart != null || r.payEnd != null) { ps += r.payStart ?? 0; pe += r.payEnd ?? 0; hasPay = true }
  }
  return { cards, chartRows, grand: { netOps, fcNetOps: forecastActive ? fcNetOps : undefined, payStart: hasPay ? ps : null, payEnd: hasPay ? pe : null }, gN: rows.length, gMain }
}

/* Which report pages to include in the printed package. */
type PkgSelection = { group: boolean; area: boolean; sections: boolean; moversAll: boolean; moversMain: boolean; projects: boolean }
const PKG_ITEMS: { key: keyof PkgSelection; label: string; hint: string }[] = [
  { key: 'group', label: 'Group page', hint: 'The consolidated cash-flow statement + payables' },
  { key: 'sections', label: 'Sections page', hint: "Each section's net, broken down by area" },
  { key: 'area', label: 'Area page', hint: 'One row per area — net cash from ops + payables' },
  { key: 'moversAll', label: 'Movers page — all projects', hint: 'Mainstream projects listed, the rest folded into "Other projects" per area' },
  { key: 'moversMain', label: 'Movers page — mainstream only', hint: 'Mainstream projects only, with a full-height chart column' },
  { key: 'projects', label: 'Project page for every mainstream project', hint: 'One full page per mainstream project' },
]

/* Print-package modal — tick the pages to include; Generate builds one bookmarked
 * PDF (open the print dialog → Save as PDF → run through /pdf-bookmarker). */
function PrintPackageModal({ open, busy, onClose, onGenerate }: {
  open: boolean; busy: boolean; onClose: () => void; onGenerate: (sel: PkgSelection) => void
}) {
  const [sel, setSel] = useState<PkgSelection>({ group: true, area: true, sections: true, moversAll: true, moversMain: true, projects: true })
  if (!open) return null
  const toggle = (k: keyof PkgSelection) => setSel(s => ({ ...s, [k]: !s[k] }))
  const nSel = PKG_ITEMS.filter(i => sel[i.key]).length
  return createPortal(
    <div className="crp-pkg-overlay" onClick={busy ? undefined : onClose}>
      <div className="crp-pkg-modal" onClick={e => e.stopPropagation()}>
        <div className="crp-pkg-head">
          <div>
            <h2>Print report package</h2>
            <p>Pick the pages — they print as one PDF, each on its own page, with bookmarks the <b>/pdf-bookmarker</b> tool reads.</p>
          </div>
          <button className="crp-pkg-x" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>
        <div className="crp-pkg-list">
          {PKG_ITEMS.map(it => (
            <label key={it.key} className={`crp-pkg-row ${sel[it.key] ? 'on' : ''}`}>
              <input type="checkbox" checked={sel[it.key]} onChange={() => toggle(it.key)} disabled={busy} />
              <span className="crp-pkg-rowt"><b>{it.label}</b><span>{it.hint}</span></span>
            </label>
          ))}
        </div>
        <div className="crp-pkg-foot">
          <span className="crp-pkg-count">{nSel} of {PKG_ITEMS.length} selected</span>
          <div>
            <button className="crp-pickbtn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="crp-pkg-go" onClick={() => onGenerate(sel)} disabled={busy || nSel === 0}>{busy ? 'Building…' : 'Generate PDF'}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
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

  // Forecast overlay: aggregate the per-area forecast lines over the in-scope
  // areas, then a dual (actual | forecast) statement. Forecast year-end cash =
  // as-of cash + the forecast-period net movement.
  const fcLineUsd = useMemo(() => {
    const m = new Map<string, number>()
    if (forecastActive) for (const a of matched) { const am = fcByArea.get(a.areaId); if (am) for (const [lc, v] of am) m.set(lc, (m.get(lc) ?? 0) + v) }
    return m
  }, [forecastActive, matched, fcByArea])
  const dual = useMemo(() => forecastActive ? buildDualStatement(lineUsd, fcLineUsd, scope.lines) : null, [forecastActive, lineUsd, fcLineUsd, scope.lines])

  // Actual net movement + section drivers. In forecast mode these come from the
  // dual statement so the timeline reconciles exactly with the dual cards (the
  // dual builder keeps a bucket if EITHER side is material, so its actual total
  // can differ from buildStatement's by sub-threshold buckets).
  const actualMove = forecastActive && dual ? dual.netA : netMovement
  const drivers = forecastActive && dual
    ? dual.sections.map(s => ({ label: s.label, value: s.netA }))
    : sections.map(s => ({ label: s.label, value: s.net }))
  // As-of cash is DERIVED (opening + net movement), not read from the stored
  // "balance at end" line — a cash-flow statement's closing position is opening
  // plus the flows by definition, so the walk always reconciles. (The stored
  // ending vs this derived one is a data-quality check that lives in staging.)
  const endCash = startCash + actualMove
  const hasCash = Math.abs(startCash) > 1 || Math.abs(endCash) > 1
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

      <CashTimeline startCash={startCash} endCash={endCash} netMovement={actualMove} drivers={drivers} hasCash={hasCash} startLabel={cashStartLabel} asOfLabel={asOfLabel} forecast={forecast} />

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
function SectionsView({ scope, matched, asOfLabel, fcByArea, forecastActive, horizonLabel }: {
  scope: Scope; matched: AreaAgg[]; asOfLabel: string
  fcByArea: Map<string, Map<string, number>>; forecastActive: boolean; horizonLabel: string
}) {
  const columns = useMemo(() => arrangeSectionColumns(sectionCards(matched, scope.lines, forecastActive ? fcByArea : undefined)), [matched, scope.lines, forecastActive, fcByArea])

  return (
    <div className="crp-page">
      <div className="crp-head">
        <img className="crp-logo" src="/ccc-logo.png" alt="CCC" />
        <div className="crp-head-t">
          <h1>Cash Flow Report — Sections</h1>
          <div className="crp-sub">{forecastActive
            ? <>Actual Jan–{asOfLabel} · forecast to {horizonLabel} · USD millions · {matched.length} areas · each section's net, by area</>
            : <>Actual to date · Jan–{asOfLabel} · USD millions · {matched.length} areas · each section's net, by area</>}</div>
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
                  <span className="crp-sechead-nn">
                    <b className={`crp-sechead-n ${cls(c.net)}`}>{fMm(c.net)}</b>
                    {forecastActive && <b className="crp-sechead-n crp-fc">{fMm(c.fcNet)}</b>}
                  </span>
                </div>
                <Svg html={areaBarsSvg(c.rows.map(r => ({ label: r.label, value: r.value, forecast: r.forecast })), undefined, { zoom: 1.55, dualLabel: forecastActive })} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="crp-note">Each card is one cash-flow section; bars show that section's net cash per area (green = generated, crimson = consumed), USD{forecastActive ? <>. <b>Solid</b> = actual (Jan–{asOfLabel}); <b>faded</b> = forecast (to {horizonLabel})</> : ', year-to-date'}. Section nets tie the "How the cash moved" waterfall on the Group page.</div>
    </div>
  )
}

/* ── Area view — one row per matched area ───────────────────────────────────── */
function AreaView({ matched, year, asOfLabel, startLabel, fcNetOpsByArea, forecastActive, horizonLabel, onOpenProjects }: {
  matched: AreaAgg[]; year: number; asOfLabel: string; startLabel: string
  fcNetOpsByArea: Map<string, number>; forecastActive: boolean; horizonLabel: string
  onOpenProjects?: (id: string) => void
}) {
  const fcOf = (id: string) => forecastActive ? (fcNetOpsByArea.get(id) ?? 0) : 0
  const tot = matched.reduce((t, a) => ({
    netOps: t.netOps + a.netOps, fcNetOps: t.fcNetOps + fcOf(a.areaId), payStart: t.payStart + (a.payStart ?? 0), payEnd: t.payEnd + (a.payEnd ?? 0),
  }), { netOps: 0, fcNetOps: 0, payStart: 0, payEnd: 0 })
  const totDelta = tot.payEnd - tot.payStart

  return (
    <div className="crp-page">
      <div className="crp-head">
        <img className="crp-logo" src="/ccc-logo.png" alt="CCC" />
        <div className="crp-head-t">
          <h1>Cash Flow Report — Areas</h1>
          <div className="crp-sub">{forecastActive
            ? <>Actual Jan–{asOfLabel} · forecast to {horizonLabel} · USD millions · {matched.length} areas</>
            : <>Actual to date · Jan–{asOfLabel} · USD millions · {matched.length} areas</>}</div>
        </div>
        <div className="crp-brand">Treasury</div>
      </div>

      <div className="crp-lede">
        From January to {asOfLabel}, these areas <b className={cls(tot.netOps)}>{tot.netOps < 0 ? 'used' : 'generated'} {fMm(Math.abs(tot.netOps))}m</b> of cash from operations{forecastActive ? <>, and are forecast to <b className={cls(tot.fcNetOps)}>{tot.fcNetOps < 0 ? 'use' : 'generate'} {fMm(Math.abs(tot.fcNetOps))}m</b> more by {horizonLabel}</> : null}. Mapped trade payables moved from <b>{fMm(Math.abs(tot.payStart))}m</b> to <b>{fMm(Math.abs(tot.payEnd))}m</b> — <b className={cls(totDelta)}>{totDelta >= 0 ? 'paid down' : 'up'} {fMm(Math.abs(totDelta))}m</b>.
      </div>

      <div className="crp-grid">
        <div className="crp-card">
        <table className="crp-table crp-table--area">
          <thead><tr>
            <th>Area</th>
            <th className="r">Net cash from ops</th>
            {forecastActive && <th className="r crp-fc">Forecast</th>}
            <th className="r crp-sep-l">Payables {startLabel}</th>
            <th className="r">Payables {asOfLabel}</th>
            <th className="r">Δ</th>
          </tr></thead>
          <tbody>
            {matched.map(a => (
              <tr key={a.areaId} className="crp-clickable" onClick={() => onOpenProjects?.(a.areaId)} title="Open this area's projects">
                <td>{a.label}</td>
                <td className={`r ${cls(a.netOps)}`}>{fMm(a.netOps)}</td>
                {forecastActive && <td className={`r crp-fc ${cls(fcOf(a.areaId))}`}>{fMm(fcOf(a.areaId))}</td>}
                <td className={`r crp-sep-l ${cls(a.payStart)}`}>{fMm(a.payStart)}</td>
                <td className={`r ${cls(a.payEnd)}`}>{fMm(a.payEnd)}</td>
                <td className={`r ${cls(a.payEnd != null && a.payStart != null ? a.payEnd - a.payStart : null)}`}>{fMd(a.payEnd != null && a.payStart != null ? a.payEnd - a.payStart : null)}</td>
              </tr>
            ))}
            <tr className="crp-total">
              <td>Group ({matched.length} areas)</td>
              <td className={`r ${cls(tot.netOps)}`}>{fMm(tot.netOps)}</td>
              {forecastActive && <td className={`r crp-fc ${cls(tot.fcNetOps)}`}>{fMm(tot.fcNetOps)}</td>}
              <td className={`r crp-sep-l ${cls(tot.payStart)}`}>{fMm(tot.payStart)}</td>
              <td className={`r ${cls(tot.payEnd)}`}>{fMm(tot.payEnd)}</td>
              <td className={`r ${cls(totDelta)}`}>{fMd(totDelta)}</td>
            </tr>
          </tbody>
        </table>
          <div className="crp-note">Net cash from operations (receipts − payments, USD-converted) — all areas with cash flow{forecastActive ? <>. <b>Forecast</b> = net operations {asOfLabel.replace(/ \d+$/, '')}→{horizonLabel} from the selected period</> : null}. Payables = trade_payables (Midas TB), shown only where an area is mapped (blank = not yet mapped; see Coverage). Δ positive = paid down. Click an area to drill into its projects.</div>
        </div>

        <div className="crp-card">
          <div className="crp-card-h">Net cash from operations <span>· by area{forecastActive ? ' · actual + forecast' : ''}</span></div>
          <Svg html={areaBarsSvg(matched.map(a => ({ label: a.label, value: a.netOps, forecast: forecastActive ? fcOf(a.areaId) : undefined })))} />
          <div className="crp-note">Green = cash generated, crimson = cash consumed (USD{forecastActive ? <>). The <b>solid</b> bar is actual (Jan–{asOfLabel}); the <b>faded</b> extension is forecast (to {horizonLabel}</> : ', YTD'}). Click a row on the left to drill into an area's projects.</div>
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
function MoversView({ scope, fxMap, areaOptions, year, asOfMonth, asOfLabel, startLabel, forecastActive, horizonMonth, horizonLabel, registerPrint }: {
  scope: Scope; fxMap: Map<string, number | null>; areaOptions: { areaId: string; label: string }[]
  year: number; asOfMonth: number; asOfLabel: string; startLabel: string
  forecastActive: boolean; horizonMonth: number; horizonLabel: string
  registerPrint: (fn: (() => void) | null) => void
}) {
  const ALL = '__ALL__', MINIMAL = 100_000   // "minimal mover" = |CFO| under 0.1m
  const [areaId, setAreaId] = useState<string>(ALL)
  const [moverFilter, setMoverFilter] = useState<'both' | 'pos' | 'neg'>('both')
  const [tierFilter, setTierFilter] = useState<'all' | 'main' | 'secondary'>('all')  // mainstream vs secondary (is_primary from Nexus)
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
  const [fcCells, setFcCells] = useState<(CfCell & { project_code: string | null; currency?: string })[]>([])
  const [loading, setLoading] = useState(false)
  const [payMaps, setPayMaps] = useState<PayablesMaps | null>(null)
  const [bookBal, setBookBal] = useState<Map<string, Map<number, number>>>(new Map())
  const decP = (year - 1) * 100 + 12, asOfP = year * 100 + asOfMonth

  useEffect(() => { fetchPayablesMaps().then(setPayMaps).catch(() => setPayMaps(null)) }, [])
  useEffect(() => { fetchPayablesBookBalances([decP, asOfP]).then(setBookBal).catch(() => setBookBal(new Map())) }, [decP, asOfP])
  useEffect(() => {
    if (!scope.primaryVersion) { setCells([]); setFcCells([]); return }
    let cancel = false; setLoading(true)
    const cfArea = areaId === ALL ? undefined : areaId
    Promise.all([
      fetchProjectCells({ version: scope.primaryVersion, cfArea, fromYear: year, fromMonth: 1, toYear: year, toMonth: asOfMonth }),
      forecastActive && asOfMonth < 12
        ? fetchProjectCells({ version: scope.primaryVersion, cfArea, fromYear: year, fromMonth: asOfMonth + 1, toYear: year, toMonth: horizonMonth })
        : Promise.resolve([] as typeof cells),
    ])
      .then(([act, fc]) => { if (!cancel) { setCells(act); setFcCells(fc) } })
      .catch(() => { if (!cancel) { setCells([]); setFcCells([]) } })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [areaId, scope.primaryVersion, year, asOfMonth, forecastActive, horizonMonth])

  const opCodes = useMemo(() => new Set(scope.lines.filter(l => l.category === 'Operation' || l.category === 'Claims').map(l => l.line_code)), [scope.lines])
  const areaLabelOf = (a: string) => areaOptions.find(o => o.areaId === a)?.label || a

  // Per-project net cash from operations (USD) + payables + mainstream flag —
  // built by the shared helper so the screen and the print package agree.
  const rows = useMemo<MoverRow[]>(() =>
    buildMoverRows({ cells, fcCells, opCodes, fxMap, payMaps, bookBal, decP, asOfP, forecastActive }),
    [cells, fcCells, opCodes, fxMap, payMaps, bookBal, decP, asOfP, forecastActive])

  const nPrimary = useMemo(() => rows.filter(r => r.isPrimary).length, [rows])
  const shown = useMemo(() => {
    let r = tierFilter === 'main' ? rows.filter(x => x.isPrimary)
      : tierFilter === 'secondary' ? rows.filter(x => !x.isPrimary)
      : rows
    return moverFilter === 'pos' ? r.filter(x => x.netOps > 0)
      : moverFilter === 'neg' ? r.filter(x => x.netOps < 0)
      : r
  }, [rows, moverFilter, tierFilter])
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
        fcNetOps: forecastActive ? items.reduce((t, r) => t + (r.fcNetOps ?? 0), 0) : undefined,
        payStart: hasPay ? ps : null, payEnd: hasPay ? pe : null,
        items: [...items].sort((a, b) => b.netOps - a.netOps),
      }
    }).sort((a, b) => Math.abs(b.netOps) - Math.abs(a.netOps))
  }, [kept, forecastActive])

  const grand = useMemo(() => {
    let netOps = 0, fcNetOps = 0, ps = 0, pe = 0, hasPay = false
    for (const r of kept) { netOps += r.netOps; fcNetOps += (r.fcNetOps ?? 0); if (r.payStart != null || r.payEnd != null) { ps += r.payStart ?? 0; pe += r.payEnd ?? 0; hasPay = true } }
    return { netOps, fcNetOps: forecastActive ? fcNetOps : undefined, payStart: hasPay ? ps : null, payEnd: hasPay ? pe : null }
  }, [kept, forecastActive])

  const toggle = (key: string) => setSelected(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  const ignoreSelected = () => { setIgnored(prev => new Set([...prev, ...selected])); setSelected(new Set()) }
  const ignoreMinimal = () => setIgnored(prev => new Set([...prev, ...kept.filter(r => Math.abs(r.netOps) < MINIMAL).map(r => r.key)]))
  const resetIgnored = () => { setIgnored(new Set()); setSelected(new Set()) }
  const nMinimal = kept.filter(r => Math.abs(r.netOps) < MINIMAL).length

  const areaLabel = areaId === ALL ? 'All areas' : areaLabelOf(areaId)
  const payD = (s: number | null, e: number | null) => (s != null && e != null) ? e - s : null

  // Print. Two shapes:
  //   • foldSecondary=false → the on-screen view (every kept project listed, honouring
  //     the tier/mover filters + collapsed areas).
  //   • foldSecondary=true  → Amr's "main projects only" cut: MAINSTREAM projects listed
  //     in full, every other project folded into ONE "Secondary projects" line per area
  //     so the area subtotal + grand total still reconcile to the full figure.
  const printMovers = (foldSecondary = false) => {
    const w = window.open('', '_blank'); if (!w) return
    const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
    const cell = (v: number | null) => `<td class="r ${cls(v)}">${fMm(v)}</td>`
    const fcell = (v: number | null | undefined) => forecastActive ? `<td class="r fc ${cls(v)}">${fMm(v)}</td>` : ''
    const dcell = (v: number | null) => `<td class="r ${cls(v)}">${fMd(v)}</td>`
    const sumPay = (arr: MoverRow[]) => { let s = 0, e = 0, has = false; for (const r of arr) if (r.payStart != null || r.payEnd != null) { s += r.payStart ?? 0; e += r.payEnd ?? 0; has = true } return { s: has ? s : null, e: has ? e : null } }

    type PRow = { code: string; star: boolean; netOps: number; fcNetOps?: number; payStart: number | null; payEnd: number | null; sec?: boolean }
    type PCard = { label: string; count: string; rows: PRow[]; subNet: number; subFc?: number; subPayStart: number | null; subPayEnd: number | null }

    let cards: PCard[], chartRows: { label: string; value: number; forecast?: number }[], headNote: string
    let gNet = 0, gFc = 0, gPayStart: number | null = null, gPayEnd: number | null = null, gN = 0, gMain = 0
    if (foldSecondary) {
      // Base = all tiers in scope, honouring mover filter + ignored (NOT the tier filter).
      const base = rows.filter(r => !ignored.has(r.key)).filter(r =>
        moverFilter === 'pos' ? r.netOps > 0 : moverFilter === 'neg' ? r.netOps < 0 : true)
      const byArea = new Map<string, MoverRow[]>()
      for (const r of base) { const a = byArea.get(r.area) ?? []; a.push(r); byArea.set(r.area, a) }
      cards = [...byArea.entries()].map(([area, items]) => {
        const primary = items.filter(r => r.isPrimary).sort((a, b) => b.netOps - a.netOps)
        const secondary = items.filter(r => !r.isPrimary)
        const ap = sumPay(items), sp = sumPay(secondary)
        const prows: PRow[] = primary.map(r => ({ code: r.code, star: true, netOps: r.netOps, fcNetOps: r.fcNetOps, payStart: r.payStart, payEnd: r.payEnd }))
        if (secondary.length) prows.push({ code: `Secondary projects`, star: false, sec: true,
          netOps: secondary.reduce((t, r) => t + r.netOps, 0),
          fcNetOps: forecastActive ? secondary.reduce((t, r) => t + (r.fcNetOps ?? 0), 0) : undefined,
          payStart: sp.s, payEnd: sp.e })
        return {
          label: areaLabelOf(area), count: `${primary.length} main${secondary.length ? ` · ${secondary.length} sec` : ''}`,
          rows: prows,
          subNet: items.reduce((t, r) => t + r.netOps, 0),
          subFc: forecastActive ? items.reduce((t, r) => t + (r.fcNetOps ?? 0), 0) : undefined,
          subPayStart: ap.s, subPayEnd: ap.e,
        }
      }).sort((a, b) => Math.abs(b.subNet) - Math.abs(a.subNet))
      const gp = sumPay(base)
      gNet = base.reduce((t, r) => t + r.netOps, 0); gFc = forecastActive ? base.reduce((t, r) => t + (r.fcNetOps ?? 0), 0) : 0
      gPayStart = gp.s; gPayEnd = gp.e; gN = base.length; gMain = base.filter(r => r.isPrimary).length
      chartRows = cards.flatMap(c => c.rows.filter(r => !r.sec)).map(r => ({ label: r.code, value: r.netOps, forecast: forecastActive ? (r.fcNetOps ?? 0) : undefined }))
      headNote = `Mainstream projects · secondary folded per area`
    } else {
      cards = groups.map(g => ({
        label: g.label, count: `${g.items.length}`,
        rows: collapsed.has(g.area) ? [] : g.items.map(r => ({ code: r.code, star: r.isPrimary, netOps: r.netOps, fcNetOps: r.fcNetOps, payStart: r.payStart, payEnd: r.payEnd })),
        subNet: g.netOps, subFc: forecastActive ? g.fcNetOps : undefined, subPayStart: g.payStart, subPayEnd: g.payEnd,
      }))
      gNet = grand.netOps; gFc = forecastActive ? (grand.fcNetOps ?? 0) : 0; gPayStart = grand.payStart; gPayEnd = grand.payEnd
      gN = kept.length; gMain = kept.filter(r => r.isPrimary).length
      chartRows = kept.map(r => ({ label: r.code, value: r.netOps, forecast: forecastActive ? (r.fcNetOps ?? 0) : undefined }))
      headNote = tierFilter === 'main' ? 'Mainstream projects' : tierFilter === 'secondary' ? 'Secondary projects' : `${kept.length} projects`
    }

    // Compact payables headers so they never wrap: "Dec 2025" → "Dec '25".
    const shortPd = (l: string) => l.replace(/\s*20(\d\d)\b/, " '$1")
    const thead = `<thead><tr><th>Project</th><th class="r">Net</th>${forecastActive ? '<th class="r fc">Fcst</th>' : ''}<th class="r">${shortPd(startLabel)}</th><th class="r">${shortPd(asOfLabel)}</th><th class="r">Δ</th></tr></thead>`
    // A card with a single line (one project, or only a folded "Secondary" line) is
    // its own total — drop the redundant subtotal row, but keep the header row so its
    // numbers align with every other card.
    const cardHtml = (c: PCard) => {
      if (c.rows.length === 1) {
        const r = c.rows[0]
        return `
        <div class="pcard pcard--one">
          <div class="pcard-h"><span class="pcard-name">${esc(c.label)}</span>${r.star ? '<span class="star">★</span>' : r.sec ? `<span class="k">${esc(c.count)}</span>` : ''}</div>
          <table class="pct">${thead}<tbody>
            <tr class="one ${r.sec ? 'sec' : ''}"><td class="p">${esc(r.code)}</td>${cell(r.netOps)}${fcell(r.fcNetOps)}${cell(r.payStart)}${cell(r.payEnd)}${dcell(payD(r.payStart, r.payEnd))}</tr>
          </tbody></table>
        </div>`
      }
      return `
      <div class="pcard">
        <div class="pcard-h"><span class="pcard-name">${esc(c.label)}</span><span class="k">${esc(c.count)}</span></div>
        <table class="pct">${thead}
        <tbody>
          ${c.rows.length ? c.rows.map(r => `<tr class="${r.sec ? 'sec' : ''}"><td class="p">${esc(r.code)}${r.star ? ' <span class="star">★</span>' : ''}</td>${cell(r.netOps)}${fcell(r.fcNetOps)}${cell(r.payStart)}${cell(r.payEnd)}${dcell(payD(r.payStart, r.payEnd))}</tr>`).join('')
            : '<tr class="sec"><td class="p">Collapsed</td><td colspan="5"></td></tr>'}
          <tr class="sub"><td>Subtotal</td>${cell(c.subNet)}${fcell(c.subFc)}${cell(c.subPayStart)}${cell(c.subPayEnd)}${dcell(payD(c.subPayStart, c.subPayEnd))}</tr>
        </tbody></table>
      </div>`
    }

    const filt = moverFilter !== 'both' ? ` (${moverFilter === 'pos' ? 'positive' : 'negative'})` : ''
    const sub = forecastActive
      ? `${esc(areaLabel)} · net cash from operations · actual Jan–${asOfLabel} · forecast to ${horizonLabel} · USD millions · ${headNote}${filt}`
      : `${esc(areaLabel)} · net cash from operations · Jan–${asOfLabel} · USD millions · ${headNote}${filt}`
    const totStr = `${gMain} main · ${gN} project${gN === 1 ? '' : 's'}`
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Cash Flow — Projects by area</title><style>
      @page { size: A4 landscape; margin: 6mm; }
      * { box-sizing: border-box; } html, body { height: 100%; }
      body { font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; color: #141414; margin: 0; display: flex; flex-direction: column; }
      header { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #E10020; padding-bottom: 7px; margin-bottom: 9px; flex: none; }
      header img { height: 30px; } header h1 { font-size: 15px; margin: 0; font-weight: 700; } .sub { font-size: 9.5px; color: #64748b; }
      .brand { margin-left: auto; font-size: 11px; font-weight: 700; color: #E10020; text-transform: uppercase; letter-spacing: .5px; }
      .ptotal { flex: none; display: flex; align-items: baseline; gap: 16px; background: #141414; color: #fff; border-radius: 7px; padding: 7px 13px; margin-bottom: 10px; font-size: 10.5px; }
      .ptotal b { font-size: 12px; } .ptotal .lbl { color: #9aa4b2; text-transform: uppercase; letter-spacing: .4px; font-size: 8px; font-weight: 700; margin-right: 5px; }
      .ptotal .neg { color: #ff7a8a; } .ptotal .pos { color: #6ee7a8; }
      /* All cards flow as a full-width masonry; the chart is the LAST block, so it
         settles at the bottom of the last (right-most) column — i.e. bottom-right. */
      .pflow { flex: 1; columns: 300px; column-gap: 12px; min-height: 0; }
      .pchart { break-inside: avoid; page-break-inside: avoid; margin-top: 2px; }
      .pchart svg { width: 100%; height: auto; }
      .pcard { break-inside: avoid; page-break-inside: avoid; border: 1px solid #e2e8f0; border-radius: 7px; overflow: hidden; margin: 0 0 11px; }
      .pcard-h { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; background: #f1f4f8; border-bottom: 1px solid #e2e8f0; padding: 5px 9px; }
      .pcard-name { font-weight: 800; text-transform: uppercase; font-size: 11.5px; letter-spacing: .3px; }
      /* table-layout:fixed + equal numeric column widths → numbers align across every card */
      .pct { width: 100%; border-collapse: collapse; font-size: 11.5px; table-layout: fixed; }
      .pct th { text-align: left; font-size: 8.5px; text-transform: uppercase; letter-spacing: .3px; color: #94a3b8; font-weight: 700; border-bottom: 1px solid #e2e8f0; padding: 2.5px 6px; }
      .pct th.r, .pct td.r { text-align: right; font-variant-numeric: tabular-nums; width: 50px; }
      .pct th.r { white-space: nowrap; }
      .pct td { padding: 2.5px 6px; }
      .pct td.p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pct td.fc, .pct th.fc { color: #9a7b3c; } .pct td.fc.neg { color: #E10020; opacity: .8; } .pct td.fc.pos { color: #057a55; opacity: .8; }
      .pct tr.sec td { color: #64748b; font-style: italic; }
      .pct tr.sub td { font-weight: 800; border-top: 1.4px solid #141414; }
      .pcard--one .pct tr.one td { font-weight: 700; } .pcard--one .pct tr.one.sec td { font-weight: 600; font-style: italic; color: #64748b; }
      .star { color: #E10020; font-style: normal; } .k { color: #94a3b8; font-weight: 600; font-size: 8.5px; }
      .neg { color: #E10020; } .pos { color: #057a55; }
    </style></head><body>
      <header><img src="${location.origin}/ccc-logo.png" alt="CCC"/><div><h1>Cash Flow Report — Projects by area</h1><div class="sub">${sub}</div></div><div class="brand">Treasury</div></header>
      <div class="pflow">${cards.map(cardHtml).join('')}${chartRows.length ? `<div class="pchart">${areaBarsSvg(chartRows, undefined, { zoom: 1.05, maxRows: 26 })}</div>` : ''}</div>
      <script>window.onload=function(){window.print()}</script></body></html>`
    w.document.write(html); w.document.close()
  }
  // Keep the top-bar Print button wired to the current on-screen view.
  useEffect(() => { registerPrint(kept.length ? () => printMovers(false) : null); return () => registerPrint(null) })

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
        {nPrimary > 0 && (
          <div className="crp-movers" role="group" aria-label="Show which project tier">
            <span className="crp-pick-l">Tier</span>
            {([['all', 'All'], ['main', 'Mainstream'], ['secondary', 'Secondary']] as const).map(([k, l]) => (
              <button key={k} className={`crp-moverbtn ${tierFilter === k ? 'active' : ''} ${k === 'main' ? 'crp-tier-main' : ''}`}
                title={k === 'main' ? 'Only mainstream projects (flagged in Nexus)' : k === 'secondary' ? 'Only secondary projects' : 'Every project'}
                onClick={() => setTierFilter(k)}>{l}</button>
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
                {forecastActive && <th className="r crp-fc">Forecast</th>}
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
                    {forecastActive && <td className={`r crp-fc ${cls(g.fcNetOps)}`}>{fMm(g.fcNetOps)}</td>}
                    <td className={`r crp-sep-l ${cls(g.payStart)}`}>{fMm(g.payStart)}</td>
                    <td className={`r ${cls(g.payEnd)}`}>{fMm(g.payEnd)}</td>
                    <td className={`r ${cls(payD(g.payStart, g.payEnd))}`}>{fMd(payD(g.payStart, g.payEnd))}</td>
                  </tr>,
                  ...(collapsed.has(g.area) ? [] : g.items.map(r => (
                    <tr className={`crp-projtr ${selected.has(r.key) ? 'sel' : ''}`} key={r.key}>
                      <td className="crp-ck"><input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} title="Select to ignore" /></td>
                      <td className="crp-projtd">{r.code}{r.isPrimary && <span className="crp-star" title="Mainstream project">★</span>}</td>
                      <td className={`r ${cls(r.netOps)}`}>{fMm(r.netOps)}</td>
                      {forecastActive && <td className={`r crp-fc ${cls(r.fcNetOps)}`}>{fMm(r.fcNetOps)}</td>}
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
                  {forecastActive && <td className={`r crp-fc ${cls(grand.fcNetOps)}`}>{fMm(grand.fcNetOps)}</td>}
                  <td className={`r crp-sep-l ${cls(grand.payStart)}`}>{fMm(grand.payStart)}</td>
                  <td className={`r ${cls(grand.payEnd)}`}>{fMm(grand.payEnd)}</td>
                  <td className={`r ${cls(payD(grand.payStart, grand.payEnd))}`}>{fMd(payD(grand.payStart, grand.payEnd))}</td>
                </tr>
              </tbody>
            </table>}
          <div className="crp-note">Net cash from operations (receipts − payments, USD, Jan–{asOfLabel}) — same basis as the Area page{forecastActive ? <>. <b>Forecast</b> = net operations to {horizonLabel}</> : null}. Grouped by area with an area subtotal; use <b>Movers</b> to isolate positive or negative and sort by size. Payables = the project's CCC-share trade payables from its mapped Midas books ({startLabel} → {asOfLabel}); blank = not yet mapped to a book. Δ positive = paid down.</div>
        </div>

        <div className="crp-card">
          <div className="crp-card-h">Net cash from operations <span>· top project movers{forecastActive ? ' · actual + forecast' : ''}</span></div>
          <Svg html={areaBarsSvg(kept.map(r => ({ label: r.code, value: r.netOps, forecast: forecastActive ? (r.fcNetOps ?? 0) : undefined })), undefined, { maxRows: 16 })} />
          <div className="crp-note">Green = cash generated, crimson = consumed (USD{forecastActive ? <>). <b>Solid</b> = actual (Jan–{asOfLabel}); <b>faded</b> = forecast (to {horizonLabel}</> : ', Jan–' + asOfLabel}). Top 16 projects by size; the rest rolled into “Other”.</div>
        </div>
      </div>
    </div>
  )
}

/* ── Project view — line items × actual months (USD) ────────────────────────── */
function ProjectView({ scope, fxMap, areaOptions, projArea, setProjArea, year, asOfMonth, asOfLabel, forecastActive, horizonMonth, horizonLabel }: {
  scope: Scope; fxMap: Map<string, number | null>; areaOptions: { areaId: string; label: string }[]
  projArea: string; setProjArea: (id: string) => void; year: number; asOfMonth: number; asOfLabel: string
  forecastActive: boolean; horizonMonth: number; horizonLabel: string
}) {
  const ALL = '__ALL__', SEP = ''
  const areaId = projArea || areaOptions[0]?.areaId || ''
  const allMode = areaId === ALL
  const [cells, setCells] = useState<(CfCell & { project_code: string | null; currency?: string })[]>([])
  const [fcCells, setFcCells] = useState<(CfCell & { project_code: string | null; currency?: string })[]>([])
  const [project, setProject] = useState<string>('')   // holds the composite key (area|code)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)   // last-clicked row for shift-range
  const [loading, setLoading] = useState(false)
  const [moverFilter, setMoverFilter] = useState<'both' | 'pos' | 'neg'>('both')   // movers list: both / positive / negative

  useEffect(() => {
    if (!scope.primaryVersion || (!allMode && !areaId)) { setCells([]); setFcCells([]); return }
    let cancel = false; setLoading(true)
    const cfArea = allMode ? undefined : areaId
    Promise.all([
      fetchProjectCells({ version: scope.primaryVersion, cfArea, fromYear: year, fromMonth: 1, toYear: year, toMonth: asOfMonth }),
      forecastActive && asOfMonth < 12
        ? fetchProjectCells({ version: scope.primaryVersion, cfArea, fromYear: year, fromMonth: asOfMonth + 1, toYear: year, toMonth: horizonMonth })
        : Promise.resolve([] as typeof cells),
    ])
      .then(([act, fc]) => { if (!cancel) { setCells(act); setFcCells(fc); setProject(''); setSelected(new Set()) } })
      .catch(() => { if (!cancel) { setCells([]); setFcCells([]) } })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [areaId, allMode, scope.primaryVersion, year, asOfMonth, forecastActive, horizonMonth])

  // Trade-payables crosswalk (book -> project via canonical) + the selected
  // project's monthly payables balance (CCC share), from the trial balance.
  const [payMaps, setPayMaps] = useState<PayablesMaps | null>(null)
  useEffect(() => { fetchPayablesMaps().then(setPayMaps).catch(() => setPayMaps(null)) }, [])
  const [paySeries, setPaySeries] = useState<{ period: number; usd: number }[]>([])
  const [payBooks, setPayBooks] = useState(0)

  // Actual months (Jan–asOf) for the ranking/actual figures; dispMonths extends
  // through the forecast horizon for the per-month chart + matrix.
  const months = useMemo(() => Array.from({ length: asOfMonth }, (_, i) => i + 1), [asOfMonth])
  const dispMonths = useMemo(() => Array.from({ length: forecastActive ? horizonMonth : asOfMonth }, (_, i) => i + 1), [forecastActive, horizonMonth, asOfMonth])
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

  // Forecast net cash movement per project (flow lines, USD), keyed like ranking —
  // drives the faded extension on each project's bar in the ranked list.
  const fcNetByKey = useMemo(() => {
    const m = new Map<string, number>()
    if (forecastActive) for (const c of fcCells) {
      const code = c.project_code; if (!code) continue
      if (!flowCodes.has(c.line_code)) continue
      const r = rateOf(c.currency); if (r == null) continue
      const key = c.area + SEP + code
      m.set(key, (m.get(key) ?? 0) + c.value * r)
    }
    return m
  }, [forecastActive, fcCells, flowCodes, fxMap])

  // Movers filter — `ranking` is sorted by |net| desc (biggest movers first), so
  // filtering by sign keeps that order: top gainers, or top drainers. Drives the
  // list, the top-N picks, and which project the detail panel defaults to.
  const shown = useMemo(() =>
    moverFilter === 'pos' ? ranking.filter(r => r.net > 0)
    : moverFilter === 'neg' ? ranking.filter(r => r.net < 0)
    : ranking, [ranking, moverFilter])
  const maxAbs = Math.max(1, ...shown.map(r => Math.max(Math.abs(r.net), Math.abs(r.net + (fcNetByKey.get(r.key) ?? 0)))))
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
    // actual cells + (when a horizon is selected) the forecast tail — so the
    // matrix + chart carry the forecast months, faded, past the as-of divider.
    const src = forecastActive ? [...cells, ...fcCells] : cells
    for (const c of src) {
      if (c.area !== area || c.project_code !== code) continue
      if (c.currency && c.currency !== 'USD') cur = c.currency
      const r = rateOf(c.currency); if (r == null) { ok = false; continue }
      let m = perCode.get(c.line_code); if (!m) { m = new Map(); perCode.set(c.line_code, m) }
      m.set(c.month, (m.get(c.month) ?? 0) + c.value * r)
    }
    return { matrix: buildStatementMatrix(perCode, scope.lines, dispMonths), currency: cur, fxOk: ok, area, code }
  }
  const { matrix, currency, fxOk } = useMemo(() => matrixFor(sel), [cells, fcCells, forecastActive, sel, fxMap, scope.lines, dispMonths])
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
      // Trade-payables balance movement for this project (Dec → as-of), aligned to
      // dispMonths — forecast months have no TB payables (actual only) → null.
      let payables: import('./reportPrint').ProjectPrint['payables']
      const cid = payMaps?.cfCodeToCanon.get(x.code.toUpperCase())
      const books = cid ? (payMaps?.canonToBooks.get(cid) ?? []) : []
      if (books.length) {
        const s = await fetchPayablesForBooks(books, fromP, toP)
        const byP = new Map(s.map(p => [p.period, p.usd]))
        const monthly = dispMonths.map(m => byP.has(year * 100 + m) ? byP.get(year * 100 + m)! : null)
        const start = byP.has(fromP) ? byP.get(fromP)! : null
        const last = [...monthly].reverse().find(v => v != null) ?? null
        payables = { monthly, start, change: last != null && start != null ? last - start : null }
      }
      return { areaLabel: areaLabelOf(x.area), project: x.code, currency: x.currency, asOfLabel, months: dispMonths, matrix: x.matrix, payables, actualCount: forecastActive ? asOfMonth : undefined, horizonLabel: forecastActive ? horizonLabel : undefined }
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
          <div className="crp-sub">{areaLabel} · monthly{forecastActive ? <> actual Jan–{asOfLabel} · forecast to {horizonLabel}</> : <> actuals Jan–{asOfLabel}</>} · USD millions · {shown.length}{moverFilter !== 'both' ? ` ${moverFilter === 'pos' ? 'positive' : 'negative'}` : ''} project{shown.length === 1 ? '' : 's'}</div>
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
                  <div className="crp-projbar">
                    <div className={`crp-projbar-fill ${r.net < 0 ? 'neg' : 'pos'}`} style={{ width: `${(Math.abs(r.net) / maxAbs) * 100}%` }} />
                    {forecastActive && Math.abs(fcNetByKey.get(r.key) ?? 0) >= 1 && <div className={`crp-projbar-fill crp-projbar-fill--fc ${(fcNetByKey.get(r.key) ?? 0) < 0 ? 'neg' : 'pos'}`} style={{ width: `${(Math.abs(fcNetByKey.get(r.key) ?? 0) / maxAbs) * 100}%` }} />}
                  </div>
                  <div className={`crp-projval ${cls(r.net)}`}>{fMm(r.net)}</div>
                </div>
              )
            })}
            {shown.length === 0 ? <div className="crp-note crp-note--empty">{ranking.length === 0 ? 'No project-grain cash flow for this scope.' : `No ${moverFilter === 'pos' ? 'positive' : 'negative'} movers in this scope.`}</div> : null}
          </div>
          <div className="crp-note"><span className="crp-bigdot" /> Big movers (largest cash movement) — the ones worth printing. Use <b>Top 5/10/20</b> above, or tick projects (shift-click for a range), then “Print selected”. Bars USD, net of the elapsed months{forecastActive ? <> (<b>faded</b> = forecast to {horizonLabel})</> : null}.</div>
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
                    <div className="crp-chart-cap">Net cash movement <span>· by month{forecastActive ? ' · incl. forecast' : ''}</span></div>
                    <KpiBand compact cards={[
                      { label: `Net cash movement · ${forecastActive ? 'full year' : 'YTD'}`, value: fMm(matrix.netTotal), cls: cls(matrix.netTotal) },
                      { label: 'Net from operations', value: fMm(secNet('Operations')), cls: cls(secNet('Operations')) },
                      { label: 'Net financing', value: fMm(secNet('Bank Financing')), cls: cls(secNet('Bank Financing')) },
                    ]} />
                    <Svg html={netTrendSvg(dispMonths.map(m => MONTHS[m - 1]), matrix.netMovement, undefined, forecastActive ? asOfMonth : undefined)} />
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
                    {dispMonths.map(m => <th key={m} className={`r ${forecastActive && m > asOfMonth ? 'crp-fc' : ''} ${forecastActive && m === asOfMonth + 1 ? 'crp-fc-seam' : ''}`}>{MONTHS[m - 1]}</th>)}
                    <th className="r crp-sep-l">{forecastActive ? 'Total' : 'YTD'}</th>
                  </tr></thead>
                  <tbody>
                    {matrix.sections.map(sec => <MatrixSectionRows key={sec.label} sec={sec} months={dispMonths} asOfMonth={forecastActive ? asOfMonth : 99} />)}
                    <tr className="crp-total">
                      <td>Net cash movement</td>
                      {dispMonths.map((m, i) => <td key={i} className={`r ${forecastActive && m > asOfMonth ? 'crp-fc' : ''} ${forecastActive && m === asOfMonth + 1 ? 'crp-fc-seam' : ''} ${cls(matrix.netMovement[i])}`}>{fMm(matrix.netMovement[i])}</td>)}
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

function MatrixSectionRows({ sec, months, asOfMonth = 99 }: { sec: MatrixSection; months: number[]; asOfMonth?: number }) {
  const fcCls = (i: number) => `${months[i] > asOfMonth ? 'crp-fc' : ''} ${months[i] === asOfMonth + 1 ? 'crp-fc-seam' : ''}`
  const row = (label: string, monthly: number[], total: number, klass: string) => (
    <tr className={klass}>
      <td className={klass === '' ? 'crp-item' : ''}>{label}</td>
      {monthly.map((v, i) => <td key={i} className={`r ${fcCls(i)} ${cls(v)}`}>{fMm(v)}</td>)}
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
