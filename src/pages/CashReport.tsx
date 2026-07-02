import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import {
  fetchActuals, fetchForecasts, fetchPayablesTrajectory, fetchFxRate, fetchProjectCells,
  fetchAccountGroups, fetchGroupAccounts, subgroupMatchesArea,
  type CfCell, type PayablesTrajRow, type GroupDef, type GroupAccount,
} from '@/lib/queries'
import { fmt, fmtDelta } from '@/lib/format'
import { buildModel, buildStatement, buildStatementMatrix, type AreaAgg, type StmtSection, type MatrixSection } from './reportModel'
import { buildReportHtml, buildProjectsPrintHtml, type PrintDisp } from './reportPrint'
import { waterfallSvg, areaBarsSvg, netTrendSvg } from './reportCharts'
import type { Scope } from './Dossier'

/* ── The Cash Flow Report ───────────────────────────────────────────────────
 * The first compiled report, three grains:
 *  • Group  — cash-flow line items (actual to date) + a separated trade-
 *             payables position (Start Dec / End Apr / Δ). Filterable to an area.
 *  • Area   — one row per area: net cash from operations + payables Start/End/Δ.
 *  • Project— line items × actual months (single area or All-areas).
 * Group + Area are scoped to MATCHED areas only — areas that carry BOTH pushed
 * cash-flow data AND a trade-payables mapping (via the org_chart→area name
 * crosswalk) AND an FX rate — so the two halves cover the same set.
 *
 * CURRENCY + DENOMINATION toggles (for value verification against the source
 * Excel files): the board default is USD in millions. On a single area (Group
 * filtered to one area, or a specific Project area) the display can flip to
 * LOCAL currency — the raw native cf_forecasts value with NO FX applied — so it
 * ties to the coordinator's native-currency sheet. The denomination (millions /
 * '000 / units) is a display divisor. Trade payables come from the TB and are
 * USD-only — always labelled USD regardless of the currency toggle. */

type Level = 'group' | 'area' | 'project' | 'coverage' | 'definitions'
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

/* Display denomination — divisor + decimals + labels. cf values are stored in
 * FULL native units (the '000 source files were normalised ×1000 at stage), so
 * millions = /1e6 (the board view), '000 = /1e3, units = /1. */
type Denom = 'm' | 'k' | 'u'
const DENOM: Record<Denom, { div: number; dec: number; word: string; sfx: string; btn: string }> = {
  m: { div: 1e6, dec: 1, word: 'millions', sfx: 'm', btn: 'Millions' },
  k: { div: 1e3, dec: 1, word: "'000",     sfx: '',  btn: "'000" },
  u: { div: 1,   dec: 0, word: '',          sfx: '',  btn: 'Units' },
}
const makeFmt = (d: Denom) => {
  const { div, dec } = DENOM[d]
  return {
    fMm: (v: number | null | undefined) => v == null ? '—' : fmt(v / div, { decimals: dec }),
    fMd: (v: number | null | undefined) => v == null ? '—' : fmtDelta(v / div, { decimals: dec }),
  }
}
const unitLabel = (cur: string, d: Denom) => DENOM[d].word ? `${cur} ${DENOM[d].word}` : cur
const printDisp = (d: Denom, lineCur: string, payCur = 'USD'): PrintDisp =>
  ({ div: DENOM[d].div, dec: DENOM[d].dec, lineUnit: unitLabel(lineCur, d), payUnit: unitLabel(payCur, d) })

// Formatter context — keyed on denomination so the divisor reaches every view
// (statement rows, matrix, payables, cashwalk) without threading fMm everywhere.
type Fmt = ReturnType<typeof makeFmt>
const FmtCtx = createContext<Fmt>(makeFmt('m'))
const useFmt = () => useContext(FmtCtx)

// default (USD millions) formatter — Definitions view is a fixed reference.
const fMm = (v: number | null | undefined) => v == null ? '—' : fmt(v / 1e6, { decimals: 1 })
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
  const [ccy, setCcy] = useState<'usd' | 'local'>('usd')   // display currency (board default = USD)
  const [denom, setDenom] = useState<Denom>('m')           // display denomination (board default = millions)

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

  // Single-area context for the Local toggle: the area whose native currency the
  // display can flip to. Group = the filtered area; Project = the selected area
  // (undefined for the group total and for the Project "All areas" view).
  const activeArea = level === 'group' ? groupArea
    : level === 'project' ? (projArea || projAreaOptions[0]?.areaId || '') : ''
  const activeCur = activeArea ? (model.get(activeArea)?.currency ?? 'USD') : null
  const localAvail = (level === 'group' || level === 'project') && !!activeArea && !!activeCur && activeCur !== 'USD'
  const effLocal = ccy === 'local' && localAvail
  const curLabel = effLocal ? (activeCur as string) : 'USD'

  const tabs: { key: Level; label: string }[] = [
    { key: 'group', label: 'Group' }, { key: 'area', label: 'Area' }, { key: 'project', label: 'Project' },
    { key: 'coverage', label: 'Coverage' }, { key: 'definitions', label: 'Definitions' },
  ]
  const canPrint = level === 'group' || level === 'area'
  const showToggles = level === 'group' || level === 'area' || level === 'project'

  const print = () => {
    const w = window.open('', '_blank'); if (!w) return
    let html = ''
    if (level === 'area') {
      const areaRows = matched.map(a => ({ label: a.label, netOps: a.netOps, payStart: a.payStart, payEnd: a.payEnd }))
      const areaTotals = matched.reduce((t, a) => ({ netOps: t.netOps + a.netOps, payStart: t.payStart + (a.payStart ?? 0), payEnd: t.payEnd + (a.payEnd ?? 0) }), { netOps: 0, payStart: 0, payEnd: 0 })
      html = buildReportHtml({ level: 'area', scopeLabel: 'Areas', year, asOfLabel, startLabel, areaRows, areaTotals, matchedCount: matched.length, disp: printDisp(denom, 'USD') })
    } else {
      const { scopeLabel, lineUsd, lineLocal, payStart, payEnd, hasPay, startCash, endCash, startLocal, endLocal } = aggregateScope(model, matched, groupArea)
      html = buildReportHtml({
        level: 'group', scopeLabel, year, asOfLabel, startLabel, matchedCount: groupArea ? undefined : matched.length,
        statement: buildStatement(effLocal ? lineLocal : lineUsd, scope.lines), payStart, payEnd, hasPay,
        startCash: effLocal ? startLocal : startCash, endCash: effLocal ? endLocal : endCash,
        disp: printDisp(denom, curLabel),
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
        {showToggles && (
          <div className="crp-toggles">
            <div className="crp-seg">
              <button
                className={effLocal ? 'active' : ''} disabled={!localAvail}
                onClick={() => setCcy('local')}
                title={localAvail ? 'Native currency, no FX — ties to the source Excel' : 'Local currency needs a single area (Group/All areas is a mix of currencies)'}
              >{localAvail ? activeCur : 'Local'}</button>
              <button className={!effLocal ? 'active' : ''} onClick={() => setCcy('usd')}>USD</button>
            </div>
            <div className="crp-seg">
              {(['m', 'k', 'u'] as Denom[]).map(d => (
                <button key={d} className={denom === d ? 'active' : ''} onClick={() => setDenom(d)}>{DENOM[d].btn}</button>
              ))}
            </div>
          </div>
        )}
        {canPrint && <button className="crp-print" onClick={print}>Print</button>}
      </div>

      <FmtCtx.Provider value={makeFmt(denom)}>
        {loading ? <div className="placeholder-box">Loading…</div>
          : level === 'group' ? <GroupView scope={scope} model={model} matched={matched} groupArea={groupArea} year={year} asOfLabel={asOfLabel} startLabel={startLabel} effLocal={effLocal} denom={denom} curLabel={curLabel} />
          : level === 'area' ? <AreaView matched={matched} year={year} asOfLabel={asOfLabel} startLabel={startLabel} denom={denom} onOpenProjects={(id) => { setProjArea(id); setLevel('project') }} />
          : level === 'project' ? <ProjectView scope={scope} fxMap={fxMap} areaOptions={projAreaOptions} projArea={projArea} setProjArea={setProjArea} year={year} asOfMonth={asOfMonth} asOfLabel={asOfLabel} ccy={ccy} denom={denom} />
          : level === 'coverage' ? <CoverageView scope={scope} model={model} payTraj={payTraj} />
          : <DefinitionsView period={asOf} asOfLabel={asOfLabel} />}
      </FmtCtx.Provider>
    </div>
  )
}

/* Merge the scoped areas (all matched = the Group, or one selected area) into a
 * single line→value map (both USD-converted and raw native) + payables + cash
 * position. Shared by the screen and print. */
function aggregateScope(model: Map<string, AreaAgg>, matched: AreaAgg[], groupArea: string) {
  const aggs = groupArea ? [model.get(groupArea)].filter((a): a is AreaAgg => !!a) : matched
  const lineUsd = new Map<string, number>()
  const lineLocal = new Map<string, number>()
  let payStart = 0, payEnd = 0, hasPay = false, startCash = 0, endCash = 0, startLocal = 0, endLocal = 0
  for (const a of aggs) {
    for (const [lc, v] of a.lineUsd) lineUsd.set(lc, (lineUsd.get(lc) ?? 0) + v)
    for (const [lc, v] of a.lineLocal) lineLocal.set(lc, (lineLocal.get(lc) ?? 0) + v)
    if (a.payStart != null) { payStart += a.payStart; hasPay = true }
    if (a.payEnd != null) { payEnd += a.payEnd; hasPay = true }
    startCash += a.openCash; endCash += a.endCash
    startLocal += a.openLocal; endLocal += a.endLocal
  }
  const scopeLabel = groupArea ? (model.get(groupArea)?.label || 'area') : 'the Group'
  return { scopeLabel, lineUsd, lineLocal, payStart, payEnd, hasPay, startCash, endCash, startLocal, endLocal }
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
  const { fMm } = useFmt()
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
function GroupView({ scope, model, matched, groupArea, year, asOfLabel, startLabel, effLocal, denom, curLabel }: {
  scope: Scope; model: Map<string, AreaAgg>; matched: AreaAgg[]; groupArea: string
  year: number; asOfLabel: string; startLabel: string
  effLocal: boolean; denom: Denom; curLabel: string
}) {
  const { fMm, fMd } = useFmt()
  const sfx = DENOM[denom].sfx
  const lineUnit = unitLabel(curLabel, denom)
  const payUnit = unitLabel('USD', denom)
  const chartDisp = { div: DENOM[denom].div, dec: DENOM[denom].dec }
  const { scopeLabel, lineUsd, lineLocal, payStart, payEnd, hasPay, startCash, endCash, startLocal, endLocal } = aggregateScope(model, matched, groupArea)
  const payDelta = hasPay ? payEnd - payStart : null
  const { sections, netMovement } = buildStatement(effLocal ? lineLocal : lineUsd, scope.lines)
  const secNet = (label: string) => sections.find(s => s.label === label)?.net ?? 0
  const opsNet = secNet('Operations'), finNet = secNet('Bank Financing')
  const cashStart = effLocal ? startLocal : startCash
  const cashEnd = effLocal ? endLocal : endCash
  const hasCash = Math.abs(cashStart) > 1 || Math.abs(cashEnd) > 1

  return (
    <div className="crp-page">
      <div className="crp-head">
        <div>
          <h1>Cash Flow Report — {scopeLabel}</h1>
          <div className="crp-sub">Actual to date · Jan–{asOfLabel} · {lineUnit}{groupArea ? '' : ` · ${matched.length} matched areas`}</div>
        </div>
        <div className="crp-brand"><span className="crp-glyph">C</span> CCC · Treasury</div>
      </div>

      <div className="crp-lede">
        From January to {asOfLabel}, {scopeLabel} <b className={cls(netMovement)}>{netMovement < 0 ? 'used' : 'generated'} {fMm(Math.abs(netMovement))}{sfx}</b> of cash{effLocal ? ` (${curLabel})` : ''}{hasCash ? <>, taking cash on hand from <b>{fMm(cashStart)}{sfx}</b> to <b>{fMm(cashEnd)}{sfx}</b></> : null}.
        {hasPay ? <> Trade payables (USD) moved from <b>{fMm(Math.abs(payStart))}{sfx}</b> to <b>{fMm(Math.abs(payEnd))}{sfx}</b> — <b className={cls(payDelta)}>{(payDelta ?? 0) >= 0 ? 'paid down' : 'up'} {fMm(Math.abs(payDelta ?? 0))}{sfx}</b>.</> : null}
      </div>

      {hasCash ? <div className="crp-cashwalk">
        <div className="crp-cw-pt"><div className="crp-cw-l">Starting cash · {startLabel}</div><div className={`crp-cw-v ${cls(cashStart)}`}>{fMm(cashStart)}</div></div>
        <div className="crp-cw-arrow"><span className={cls(netMovement)}>{netMovement < 0 ? '−' : '+'}{fMm(Math.abs(netMovement))}</span><i>net movement</i></div>
        <div className="crp-cw-pt"><div className="crp-cw-l">Ending cash · {asOfLabel}</div><div className={`crp-cw-v ${cls(cashEnd)}`}>{fMm(cashEnd)}</div></div>
      </div> : null}

      <KpiBand cards={[
        { label: 'Net from operations', value: fMm(opsNet), cls: cls(opsNet) },
        { label: 'Net financing', value: fMm(finNet), cls: cls(finNet) },
        { label: 'Net cash movement', value: fMm(netMovement), cls: cls(netMovement) },
        { label: `Trade payables · ${asOfLabel} · USD`, value: fMm(payEnd), cls: cls(payEnd), sub: hasPay ? `${fMd(payDelta)} since ${startLabel}` : 'not mapped' },
      ]} />

      <div className="crp-grid">
        {/* Cash flow statement */}
        <div className="crp-card">
          <div className="crp-card-h">Cash flow <span>· actual to date</span></div>
          <table className="crp-table">
            <thead><tr><th>Line item</th><th className="r">{lineUnit}</th></tr></thead>
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
            <Svg html={waterfallSvg(sections.map(s => ({ label: s.label, value: s.net })), netMovement, chartDisp)} />
          </div>

          {/* Trade payables — then vs now */}
          <div className="crp-card crp-card--pos">
            <div className="crp-card-h">Trade payables <span>· then vs now · {payUnit}</span></div>
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
  const { fMm } = useFmt()
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

/* ── Area view — one row per matched area (always USD — a mix of currencies) ─── */
function AreaView({ matched, year, asOfLabel, startLabel, denom, onOpenProjects }: {
  matched: AreaAgg[]; year: number; asOfLabel: string; startLabel: string; denom: Denom; onOpenProjects?: (id: string) => void
}) {
  const { fMm, fMd } = useFmt()
  const sfx = DENOM[denom].sfx
  const lineUnit = unitLabel('USD', denom)
  const chartDisp = { div: DENOM[denom].div, dec: DENOM[denom].dec }
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
          <div className="crp-sub">Actual to date · Jan–{asOfLabel} · {lineUnit} · {matched.length} matched areas</div>
        </div>
        <div className="crp-brand"><span className="crp-glyph">C</span> CCC · Treasury</div>
      </div>

      <div className="crp-lede">
        From January to {asOfLabel}, the matched areas <b className={cls(tot.netOps)}>{tot.netOps < 0 ? 'used' : 'generated'} {fMm(Math.abs(tot.netOps))}{sfx}</b> of cash from operations, and trade payables moved from <b>{fMm(Math.abs(tot.payStart))}{sfx}</b> to <b>{fMm(Math.abs(tot.payEnd))}{sfx}</b> — <b className={cls(totDelta)}>{totDelta >= 0 ? 'paid down' : 'up'} {fMm(Math.abs(totDelta))}{sfx}</b>.
      </div>

      <KpiBand cards={[
        { label: 'Group net from ops', value: fMm(tot.netOps), cls: cls(tot.netOps) },
        { label: `Trade payables · ${asOfLabel}`, value: fMm(tot.payEnd), cls: cls(tot.payEnd), sub: `${fMd(totDelta)} since ${startLabel}` },
        { label: 'Matched areas', value: String(matched.length) },
        { label: 'Top cash generator', value: top ? top.label : '—', sub: top ? `${fMm(top.netOps)}${sfx}` : '' },
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
          <Svg html={areaBarsSvg(matched.map(a => ({ label: a.label, value: a.netOps })), chartDisp)} />
          <div className="crp-note">Green = cash generated, crimson = cash consumed (USD, YTD). Click a row on the left to drill into an area's projects.</div>
        </div>
      </div>
    </div>
  )
}

/* ── Project view — line items × actual months (single area or All-areas) ───── */
function ProjectView({ scope, fxMap, areaOptions, projArea, setProjArea, year, asOfMonth, asOfLabel, ccy, denom }: {
  scope: Scope; fxMap: Map<string, number | null>; areaOptions: { areaId: string; label: string }[]
  projArea: string; setProjArea: (id: string) => void; year: number; asOfMonth: number; asOfLabel: string
  ccy: 'usd' | 'local'; denom: Denom
}) {
  const { fMm } = useFmt()
  const ALL = '__ALL__', SEP = ''
  const areaId = projArea || areaOptions[0]?.areaId || ''
  const allMode = areaId === ALL
  const [cells, setCells] = useState<(CfCell & { project_code: string | null; currency?: string })[]>([])
  const [project, setProject] = useState<string>('')   // holds the composite key (area|code)
  const [selected, setSelected] = useState<Set<string>>(new Set())
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

  const months = useMemo(() => Array.from({ length: asOfMonth }, (_, i) => i + 1), [asOfMonth])
  const flowCodes = useMemo(() => new Set(scope.lines.filter(l => l.nature !== 'Balance').map(l => l.line_code)), [scope.lines])

  // The area's native currency + whether we're displaying it (Local) — Local is
  // disabled in All-areas mode (mixed currencies). In Local, NO FX is applied so
  // the raw native ties to the source Excel; otherwise USD via fxMap.
  const nativeCur = useMemo(() => cells.find(c => c.currency && c.currency !== 'USD')?.currency || 'USD', [cells])
  const useLocal = ccy === 'local' && !allMode && nativeCur !== 'USD'
  const rateOf = (cur?: string) => useLocal ? 1 : ((cur || 'USD') === 'USD' ? 1 : (fxMap.get(cur || '') ?? null))
  const dispCur = useLocal ? nativeCur : 'USD'
  const lineUnit = unitLabel(dispCur, denom)
  const chartDisp = { div: DENOM[denom].div, dec: DENOM[denom].dec }
  const areaLabelOf = (a: string) => areaOptions.find(o => o.areaId === a)?.label || a

  // Rank projects by |net cash movement| (flow lines) → big movers on top.
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
  }, [cells, flowCodes, fxMap, useLocal])

  const maxAbs = Math.max(1, ...ranking.map(r => Math.abs(r.net)))
  const bigCut = maxAbs * 0.12
  const sel = project || ranking[0]?.key || ''
  const selArea = sel ? sel.slice(0, sel.indexOf(SEP)) : ''

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
  const { matrix, currency, fxOk } = useMemo(() => matrixFor(sel), [cells, sel, fxMap, scope.lines, months, useLocal])
  const areaLabel = allMode ? 'All areas' : areaLabelOf(areaId)
  const selCode = sel ? sel.slice(sel.indexOf(SEP) + 1) : ''
  const secNet = (label: string) => matrix.sections.find(s => s.label === label)?.netTot ?? 0
  const showBody = !loading && !!sel && fxOk && matrix.sections.length > 0

  const toggle = (key: string) => setSelected(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  const printProjects = (keys: string[]) => {
    const w = window.open('', '_blank'); if (!w) return
    const list = keys.map(k => matrixFor(k))
      .filter(x => x.fxOk && x.matrix.sections.length > 0)
      .map(x => ({ areaLabel: areaLabelOf(x.area), project: x.code, currency: x.currency, asOfLabel, months, matrix: x.matrix }))
    if (list.length === 0) { w.close(); return }
    w.document.write(buildProjectsPrintHtml(list, printDisp(denom, dispCur))); w.document.close()
  }

  return (
    <div className="crp-page">
      <div className="crp-head">
        <div>
          <h1>Cash Flow Report — Projects</h1>
          <div className="crp-sub">{areaLabel} · monthly actuals Jan–{asOfLabel} · {lineUnit} · {ranking.length} projects</div>
        </div>
        <div className="crp-brand"><span className="crp-glyph">C</span> CCC · Treasury</div>
      </div>

      <div className="crp-projtop no-print">
        <select className="crp-select" value={areaId} onChange={e => { setProjArea(e.target.value); setProject('') }}>
          <option value={ALL}>All areas</option>
          {areaOptions.map(a => <option key={a.areaId} value={a.areaId}>{a.label}</option>)}
        </select>
        <button className="crp-print" disabled={!showBody} onClick={() => printProjects([sel])}>Print this</button>
        <button className="crp-print" disabled={selected.size === 0} onClick={() => printProjects([...selected])}>Print selected ({selected.size})</button>
      </div>

      <div className="crp-grid crp-grid--proj">
        {/* Ranked project list — big movers on top, tick to print */}
        <div className="crp-card">
          <div className="crp-card-h">Projects <span>· by cash movement</span></div>
          <div className="crp-projlist">
            {ranking.map(r => {
              const big = Math.abs(r.net) >= bigCut
              return (
                <div key={r.key} className={`crp-projrow ${r.key === sel ? 'active' : ''}`}>
                  <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} title="Select to print" />
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
          <div className="crp-note"><span className="crp-bigdot" /> Big movers (largest cash movement) — the ones worth printing. Tick projects, then “Print selected”. Bars {dispCur}, net of the elapsed months.</div>
        </div>

        {/* Selected project detail */}
        <div className="crp-card">
          {loading ? <div className="crp-note crp-note--empty">Loading…</div>
            : !sel ? <div className="crp-note crp-note--empty">Pick a project on the left.</div>
            : !fxOk ? <div className="crp-note crp-note--empty">No FX rate for {currency} — switch to {currency} (Local), or add the rate to show USD.</div>
            : <>
                <div className="crp-card-h">{selCode} <span>· {areaLabelOf(selArea)} · {lineUnit}{!useLocal && currency !== 'USD' ? ` (from ${currency})` : ''}</span></div>
                <KpiBand cards={[
                  { label: 'Net cash movement · YTD', value: fMm(matrix.netTotal), cls: cls(matrix.netTotal) },
                  { label: 'Net from operations', value: fMm(secNet('Operations')), cls: cls(secNet('Operations')) },
                  { label: 'Net financing', value: fMm(secNet('Bank Financing')), cls: cls(secNet('Bank Financing')) },
                ]} />
                <div className="crp-svg" style={{ margin: '10px 0' }}><Svg html={netTrendSvg(months.map(m => MONTHS[m - 1]), matrix.netMovement, chartDisp)} /></div>
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
  const { fMm } = useFmt()
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
