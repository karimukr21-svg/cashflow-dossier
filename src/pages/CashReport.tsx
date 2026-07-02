import { useEffect, useMemo, useState } from 'react'
import {
  fetchActuals, fetchForecasts, fetchPayablesTrajectory, fetchFxRate,
  type CfCell, type PayablesTrajRow,
} from '@/lib/queries'
import { fmt, fmtDelta } from '@/lib/format'
import { buildModel, buildStatement, type AreaAgg, type StmtSection } from './reportModel'
import { buildReportHtml } from './reportPrint'
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
        : level === 'area' ? <AreaView matched={matched} year={year} asOfLabel={asOfLabel} startLabel={startLabel} onSelectArea={onSelectArea} />
        : <StubView level={level} />}
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

  return (
    <div className="crp-page">
      <div className="crp-head">
        <div>
          <h1>Cash Flow Report — {scopeLabel}</h1>
          <div className="crp-sub">Actual to date · Jan–{asOfLabel} · USD millions{groupArea ? '' : ` · ${matched.length} matched areas`}</div>
        </div>
        <div className="crp-brand"><span className="crp-glyph">C</span> CCC · Treasury</div>
      </div>

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

        {/* Separated payables position */}
        <div className="crp-card crp-card--pos">
          <div className="crp-card-h">Trade payables <span>· position</span></div>
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
function AreaView({ matched, year, asOfLabel, startLabel, onSelectArea }: {
  matched: AreaAgg[]; year: number; asOfLabel: string; startLabel: string; onSelectArea?: (id: string) => void
}) {
  const tot = matched.reduce((t, a) => ({
    netOps: t.netOps + a.netOps, payStart: t.payStart + (a.payStart ?? 0), payEnd: t.payEnd + (a.payEnd ?? 0),
  }), { netOps: 0, payStart: 0, payEnd: 0 })
  const totDelta = tot.payEnd - tot.payStart

  return (
    <div className="crp-page">
      <div className="crp-head">
        <div>
          <h1>Cash Flow Report — Areas</h1>
          <div className="crp-sub">Actual to date · Jan–{asOfLabel} · USD millions · {matched.length} matched areas</div>
        </div>
        <div className="crp-brand"><span className="crp-glyph">C</span> CCC · Treasury</div>
      </div>

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
              <tr key={a.areaId} className="crp-clickable" onClick={() => onSelectArea?.(a.areaId)} title="Open area / projects">
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
        <div className="crp-note">Net cash from operations (receipts − payments, USD-converted). Payables = trade_payables (Midas TB). Δ positive = paid down. Click an area to drill to its projects (next pass).</div>
      </div>
    </div>
  )
}

function StubView({ level }: { level: Level }) {
  const msg = level === 'project'
    ? 'Project grain — cash-flow line items × actual months (USD). Building in the next pass.'
    : level === 'coverage'
      ? 'Coverage — which areas are matched (cash flow ↔ payables) and which are not yet mapped. Building in the next pass.'
      : 'Definitions — the account groups and exactly which accounts feed trade_payables, for the inclusion discussion with Amr. Building in the next pass.'
  return <div className="crp-page"><div className="crp-card"><div className="crp-note crp-note--empty">{msg}</div></div></div>
}
