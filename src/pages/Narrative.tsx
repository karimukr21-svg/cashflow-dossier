import { useEffect, useMemo, useState } from 'react'
import {
  fetchActuals, fetchForecasts, fetchPopulatedCfAreas, fetchPayables, fetchFxRate,
  type CfCell, type CfLine, type CanonicalArea,
} from '@/lib/queries'
import { computeDerivedBalances } from '@/lib/derivedBalances'
import { isDebtStock, flowSections } from '@/lib/cfTaxonomy'
import { fmt } from '@/lib/format'
import type { Scope } from './Dossier'
import { buildNarrativeHtml } from './narrativePrint'
import { buildCashStoryChart } from './narrativeChart'

/* ── The Chairman cash-flow story ──────────────────────────────────────────
 * A full-width, single-screen executive read of one area's (or the Group's)
 * cash flow for the year: the net-funds transformation (deficit→surplus), the
 * year in one trajectory shape (net funds over the debt band), a before→after
 * stat strip, and a one-sentence bottom line. Everything is derived from the
 * canonical store; the reporting year + as-of follow the selected version.
 * Detailed line breakdowns stay as an optional analyst block below the fold. */

type Mode = 'group' | 'area'
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export type NarrativeData = {
  asOfMonth: number
  opening: number | null; now: number | null; yearEnd: number | null
  cashClosing: number[]; liabilities: number[]; netFunds: number[]   // 12 each
  recvFull: number; payFull: number; recvYTD: number; payYTD: number
  netYTD: number; recvRem: number; payRem: number; netRem: number
  debtOpen: number; debtNow: number; debtEnd: number
  nfOpen: number; nfNow: number; nfEnd: number
  debtPeak: number; minNf: { idx: number; value: number }
  paySections: { label: string; value: number }[]
  recvSections: { label: string; value: number }[]
}

export default function Narrative({ scope }: { scope: Scope }) {
  // Reporting year + as-of derive from the SELECTED version (not a global scan).
  const selVer = scope.versions?.find(v => v.version_code === scope.primaryVersion)
  const year = selVer?.cycle_year ?? Math.floor(scope.latestActualYM / 100)
  const [ay, am] = (selVer?.as_of_date ?? '').split('-').map(Number)
  const asOf = ay && am ? ay * 100 + am : scope.latestActualYM
  const asOfMonth = asOf % 100
  const asOfLabel = `${MONTHS[asOfMonth - 1] ?? ''} ${year}`

  const sortedAreas = useMemo(
    () => [...scope.areas].sort((a, b) => a.sort_order - b.sort_order),
    [scope.areas])

  const [mode, setMode] = useState<Mode>('area')
  const [areaId, setAreaId] = useState<string>('')

  // Default to the first area (in sort order) that actually carries pushed data
  // for the selected version — derived, not a hardcoded showcase.
  useEffect(() => {
    if (areaId || sortedAreas.length === 0 || !scope.primaryVersion) return
    let cancel = false
    ;(async () => {
      try {
        const populated = await fetchPopulatedCfAreas(scope.primaryVersion)
        if (cancel) return
        const seed = sortedAreas.find(a => a.cf_areas.some(c => populated.has(c))) || sortedAreas[0]
        setAreaId(seed.area_id)
      } catch {
        if (!cancel) setAreaId(sortedAreas[0].area_id)
      }
    })()
    return () => { cancel = true }
  }, [sortedAreas, areaId, scope.primaryVersion])

  const selArea: CanonicalArea | undefined =
    mode === 'area' ? sortedAreas.find(a => a.area_id === areaId) : undefined
  const cfAreas = mode === 'area' ? (selArea?.cf_areas || []) : undefined

  const [actuals, setActuals] = useState<CfCell[]>([])
  const [forecasts, setForecasts] = useState<CfCell[]>([])
  const [currency, setCurrency] = useState<string>('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (mode === 'area' && !areaId) return
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const [a, f] = await Promise.all([
          fetchActuals({ fromYear: year, fromMonth: 1, toYear: year, toMonth: 12, cfAreas }),
          fetchForecasts({ version: scope.primaryVersion, fromYear: year, fromMonth: 1, toYear: year, toMonth: 12, cfAreas }),
        ])
        if (cancel) return
        setActuals(a); setForecasts(f)
        const curs = new Set([...a, ...f].map(r => r.currency).filter(Boolean) as string[])
        setCurrency(mode === 'group' ? (curs.size > 1 ? 'mixed' : [...curs][0] || '') : ([...curs][0] || ''))
      } finally { if (!cancel) setLoading(false) }
    })()
    return () => { cancel = true }
  }, [mode, areaId, scope.primaryVersion, year, (cfAreas || []).join('|')])

  const data = useMemo<NarrativeData>(() =>
    computeNarrative(actuals, forecasts, scope.lines, year, asOf, mode, scope.cfToCanonical),
    [actuals, forecasts, scope.lines, year, asOf, mode, scope.cfToCanonical])

  // Payables (Midas BS group 212) — a separate point-in-time obligation balance.
  const [payablesRaw, setPayablesRaw] = useState<{ localValue: number | null; usdValue: number; nativeCurrency: string } | null>(null)
  useEffect(() => {
    if (mode === 'area' && !selArea) { setPayablesRaw(null); return }
    let cancel = false
    ;(async () => {
      try {
        const p = await fetchPayables({ canonicalAreaId: mode === 'area' ? selArea?.area_id : undefined, period: asOf })
        if (!cancel) setPayablesRaw(p)
      } catch { if (!cancel) setPayablesRaw(null) }
    })()
    return () => { cancel = true }
  }, [mode, selArea?.area_id, asOf])

  // Currency display toggle (area mode): native local or USD via gacc.fx_rates.
  const [ccy, setCcy] = useState<'local' | 'usd'>('local')
  const [fxRate, setFxRate] = useState<number | null>(null)
  useEffect(() => {
    if (mode !== 'area' || !currency) { setFxRate(null); return }
    let cancel = false
    const asOfDate = selVer?.as_of_date || `${year}-${String(asOfMonth).padStart(2, '0')}-01`
    fetchFxRate(currency, asOfDate).then(r => { if (!cancel) setFxRate(r) }).catch(() => { if (!cancel) setFxRate(null) })
    return () => { cancel = true }
  }, [mode, currency, selVer?.as_of_date])

  const useUsd = mode === 'group' || (ccy === 'usd' && !!fxRate)
  const rate = mode === 'group' ? 1 : (useUsd && fxRate ? fxRate : 1)
  const dispData = useMemo(() => rate === 1 ? data : scaleData(data, rate), [data, rate])
  const dispCurrency = mode === 'group' ? (currency || 'mixed') : (useUsd ? 'USD' : (currency || 'local'))
  const unit = `${dispCurrency} millions`

  // Resolve payables to the display currency.
  const payables = useMemo<{ value: number; currency: string } | null>(() => {
    if (!payablesRaw) return null
    if (useUsd) return { value: payablesRaw.usdValue, currency: 'USD' }
    if (payablesRaw.localValue != null && payablesRaw.nativeCurrency === currency)
      return { value: payablesRaw.localValue, currency: currency }
    return { value: payablesRaw.usdValue, currency: 'USD' }
  }, [payablesRaw, useUsd, currency])

  const scopeLabel = mode === 'group' ? 'the Group' : (selArea?.display_name || 'area')

  const print = () => {
    const w = window.open('', '_blank')
    if (!w) return
    w.document.write(buildNarrativeHtml(dispData, { scopeLabel, year, asOfLabel, mode, unit, months: MONTHS, payables }))
    w.document.close()
  }

  return (
    <div className="cnr">
      <div className="cnr-toolbar no-print">
        <div className="cnr-grain">
          <button className={`cnr-pill ${mode === 'group' ? 'active' : ''}`} onClick={() => setMode('group')}>Group</button>
          <button className={`cnr-pill ${mode === 'area' ? 'active' : ''}`} onClick={() => setMode('area')}>Area</button>
          {mode === 'area' && (
            <select className="cnr-select" value={areaId} onChange={e => setAreaId(e.target.value)}>
              {sortedAreas.map(a => <option key={a.area_id} value={a.area_id}>{a.display_name}</option>)}
            </select>
          )}
          {mode === 'area' && fxRate && currency && currency !== 'USD' && (
            <div className="cnr-ccytoggle">
              <button className={ccy === 'local' ? 'active' : ''} onClick={() => setCcy('local')}>{currency}</button>
              <button className={ccy === 'usd' ? 'active' : ''} onClick={() => setCcy('usd')}>USD</button>
            </div>
          )}
        </div>
        <button className="cnr-print-btn" onClick={print}>Print</button>
      </div>

      {loading
        ? <div className="placeholder-box">Loading…</div>
        : <ChairmanReport d={dispData} scopeLabel={scopeLabel} year={year} asOfLabel={asOfLabel} unit={unit} mode={mode} payables={payables} />}
    </div>
  )
}

/* ── helpers ────────────────────────────────────────────────────────────── */
/* Scale every monetary field by an FX rate (native → USD), so screen + print
 * render the converted figures with the normal formatters. */
function scaleData(d: NarrativeData, r: number): NarrativeData {
  const s = (v: number | null) => v == null ? v : v * r
  return {
    ...d,
    opening: s(d.opening), now: s(d.now), yearEnd: s(d.yearEnd),
    cashClosing: d.cashClosing.map(v => v * r), liabilities: d.liabilities.map(v => v * r), netFunds: d.netFunds.map(v => v * r),
    recvFull: d.recvFull * r, payFull: d.payFull * r, recvYTD: d.recvYTD * r, payYTD: d.payYTD * r,
    netYTD: d.netYTD * r, recvRem: d.recvRem * r, payRem: d.payRem * r, netRem: d.netRem * r,
    debtOpen: d.debtOpen * r, debtNow: d.debtNow * r, debtEnd: d.debtEnd * r,
    nfOpen: d.nfOpen * r, nfNow: d.nfNow * r, nfEnd: d.nfEnd * r,
    debtPeak: d.debtPeak * r, minNf: { idx: d.minNf.idx, value: d.minNf.value * r },
    paySections: d.paySections.map(x => ({ ...x, value: x.value * r })),
    recvSections: d.recvSections.map(x => ({ ...x, value: x.value * r })),
  }
}

const fM = (v: number | null | undefined) => v == null ? '—' : fmt(v / 1e6, { decimals: 1 })
const fMs = (v: number | null | undefined) => {
  if (v == null) return '—'
  const r = Math.round((v / 1e6) * 10) / 10
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return r < 0 ? `(${s})` : `+${s}`
}
const sign = (v: number | null | undefined) => (v == null || v === 0) ? '' : (v < 0 ? 'neg' : 'pos')

/* ── the report ─────────────────────────────────────────────────────────── */
function ChairmanReport({ d, scopeLabel, year, asOfLabel, unit, mode, payables }: {
  d: NarrativeData; scopeLabel: string; year: number; asOfLabel: string; unit: string; mode: Mode;
  payables: { value: number; currency: string } | null
}) {
  const payNote = payables
    ? `Suppliers, subcontractors & taxes · as of ${asOfLabel}${payables.currency === 'USD' && !unit.startsWith('USD') ? ' (USD)' : ''}`
    : 'Trade liabilities · no Midas balance for this period'
  const fullSwing = d.nfEnd - d.nfOpen                            // net journey, opening → year-end
  const fullSwingCap = fullSwing >= 0 ? `Net funds recover over ${year}` : `Net funds erode over ${year}`
  const netFlow = d.recvFull + d.payFull
  // 13-point series for the cash-story chart: the year's opening + each month-end.
  const cash13 = [d.opening ?? 0, ...d.cashClosing]
  const net13 = [d.nfOpen, ...d.netFunds]

  return (
    <div className="cnr-page">
      {/* Region 1 — header lockup */}
      <div className="cnr-head">
        <div>
          <h1>Group Cash Flow — {scopeLabel} · {year}</h1>
          <div className="cnr-sub">Actuals through {asOfLabel} · forecast to year-end · figures in {unit}
            {mode === 'group' && unit.startsWith('mixed') ? ' (native currencies summed — USD consolidation pending the FX layer)' : ''}</div>
        </div>
        <div className="cnr-brand">
          <div className="cnr-brand-mark"><span className="cnr-glyph">C</span> CCC · Treasury</div>
          <div className="cnr-asof">AS OF {asOfLabel}</div>
        </div>
      </div>

      {/* Region 2 — hero: net liquid funds, opening → today → year-end */}
      <div className="cnr-hero">
        <div className="cnr-hero-eyebrow">Net liquid funds</div>
        <div className="cnr-hero-row">
          <div className="cnr-hero-pt">
            <div className={`cnr-hero-num sm ${sign(d.nfOpen)}`}>{fM(d.nfOpen)}</div>
            <div className="cnr-hero-cap">Start · Jan {year}</div>
          </div>
          <div className="cnr-hero-arrow">→</div>
          <div className="cnr-hero-pt">
            <div className={`cnr-hero-num ${sign(d.nfNow)}`}>{fM(d.nfNow)}</div>
            <div className="cnr-hero-cap">Today · {asOfLabel}</div>
          </div>
          <div className="cnr-hero-arrow">→</div>
          <div className="cnr-hero-pt">
            <div className={`cnr-hero-num sm ${sign(d.nfEnd)}`}>{fM(d.nfEnd)}</div>
            <div className="cnr-hero-cap">Forecast · Dec {year}</div>
          </div>
          <div className="cnr-hero-unit">{unit.replace(' millions', ' m')}</div>
          <div className="cnr-hero-swing">
            <div className={`cnr-swing-num ${sign(fullSwing)}`}>{fMs(fullSwing)}</div>
            <div className="cnr-swing-cap">{fullSwingCap} · cash less loans &amp; overdrafts</div>
          </div>
        </div>
      </div>

      {/* Region 3 — the cash story: cash held, financing band, the net line + start/today/year-end timeline */}
      <div className="cnr-chartwrap">
        <div className="cnr-chart-head">
          <div className="cnr-chart-title">The year's cash story <span>· cash held, financing, and the net position from the year's open to December</span></div>
          <div className="cnr-legend">
            <span className="cnr-leg"><i className="cnr-leg-cash" />Cash on hand</span>
            <span className="cnr-leg"><i className="cnr-leg-nf" />Net liquid funds</span>
            <span className="cnr-leg"><i className="cnr-leg-band" />Loans &amp; overdrafts</span>
            <span className="cnr-leg"><i className="cnr-leg-fc" />Forecast</span>
          </div>
        </div>
        <div className="cnr-chart" dangerouslySetInnerHTML={{ __html: buildCashStoryChart({
          months: ['', ...MONTHS], cash: cash13, net: net13, asIdx: d.asOfMonth, asOfLabel, year,
        }) }} />
      </div>

      {/* Region 4 — payables (single Midas snapshot) + full-year flow */}
      <div className="cnr-foot">
        <div className="cnr-foot-item">
          <div className="cnr-foot-label">Payables · suppliers &amp; subcontractors</div>
          <div className="cnr-foot-val">{payables
            ? <span className="neg">{fM(-Math.abs(payables.value))}</span>
            : <span className="cnr-stat-pending">Pending</span>}
            {payables && payables.currency === 'USD' && !unit.startsWith('USD') ? <span className="cnr-foot-ccy"> USD</span> : null}</div>
          <div className="cnr-foot-note">{payables
            ? `Midas balance · ${asOfLabel} snapshot only — monthly trail pending Bilal's extracts`
            : 'No Midas balance for this period'}</div>
        </div>
        <div className="cnr-foot-item">
          <div className="cnr-foot-label">Full-year cash flow</div>
          <div className="cnr-foot-val"><span className="pos">{fM(d.recvFull)}</span> in <span className="cnr-foot-sep">·</span> <span className="neg">{fM(Math.abs(d.payFull))}</span> out</div>
          <div className="cnr-foot-note">Net movement {fMs(netFlow)} over {year}</div>
        </div>
      </div>

      {/* Region 5 — bottom line */}
      <div className="cnr-bottomline">
        <span className="cnr-bl-tag">Bottom line</span>
        <span className="cnr-bl-text">{bottomLine(d, scopeLabel, payables)}</span>
      </div>

      {/* Optional analyst detail — below the chairman read */}
      <details className="cnr-detail no-print">
        <summary>Detail — where the money goes &amp; comes from (full year)</summary>
        <div className="cnr-where">
          <div><h4>Where the money goes <span>· payments</span></h4><Bars items={d.paySections} tone="neg" /></div>
          <div><h4>Where it comes from <span>· receipts</span></h4><Bars items={d.recvSections} tone="pos" /></div>
        </div>
      </details>
    </div>
  )
}


function Bars({ items, tone }: { items: { label: string; value: number }[]; tone: 'pos' | 'neg' }) {
  const max = Math.max(1, ...items.map(i => Math.abs(i.value)))
  return (
    <div className="cnr-bars">
      {items.length === 0 && <div className="cnr-bars-empty">No data.</div>}
      {items.map(i => (
        <div key={i.label} className="cnr-bar-row">
          <div className="cnr-bar-label">{i.label}</div>
          <div className="cnr-bar-track"><div className={`cnr-bar-fill ${tone}`} style={{ width: `${(Math.abs(i.value) / max) * 100}%` }} /></div>
          <div className={`cnr-bar-val ${tone}`}>{fM(Math.abs(i.value))}</div>
        </div>
      ))}
    </div>
  )
}

function bottomLine(d: NarrativeData, scopeLabel: string, payables: { value: number; currency: string } | null): string {
  const arc = d.minNf.value < (d.nfNow ?? 0)
    ? `dips to ${fM(d.minNf.value)}m in ${MONTHS[d.minNf.idx]} before recovering to`
    : (d.nfEnd >= (d.nfNow ?? 0) ? 'strengthens to' : 'eases to')
  const pay = payables
    ? `On top of this sit payables to suppliers and subcontractors of ${fM(Math.abs(payables.value))}m.`
    : `Payables to suppliers and subcontractors are tracked separately — figures pending.`
  return `After loans and overdrafts, ${scopeLabel}'s net liquid funds stand at ${fM(d.nfNow)}m today — ${fM(d.now)}m of cash against ${fM(d.debtNow)}m of loans and overdrafts. The position ${arc} ${fM(d.nfEnd)}m by year-end as cash builds and financing is paid down. ${pay}`
}

/* ── computation ────────────────────────────────────────────────────────── */
export function computeNarrative(
  actuals: CfCell[], forecasts: CfCell[], lines: CfLine[],
  year: number, asOf: number, _mode: Mode, _cfToCanonical: Map<string, CanonicalArea>,
): NarrativeData {
  const lineByCode = new Map<string, CfLine>()
  for (const l of lines) lineByCode.set(l.line_code, l)
  const ym = (c: CfCell) => c.year * 100 + c.month
  const lineOf = (c: CfCell) => lineByCode.get(c.line_code)
  const natureOf = (c: CfCell) => lineOf(c)?.nature
  const catOf = (c: CfCell) => lineOf(c)?.category || ''
  const isR = (c: CfCell) => natureOf(c) === 'Receipts'
  const isP = (c: CfCell) => natureOf(c) === 'Payments'
  const sumIf = (rows: CfCell[], pred: (c: CfCell) => boolean) =>
    rows.reduce((t, c) => pred(c) ? t + c.value : t, 0)

  // Merge: published actuals override forecasts for the same cell (pre-publish
  // the elapsed actuals live in cf_forecasts, so split by period not by table).
  const merged = new Map<string, CfCell>()
  for (const c of forecasts) merged.set(`${c.area}|${c.line_code}|${c.year}|${c.month}`, c)
  for (const c of actuals) merged.set(`${c.area}|${c.line_code}|${c.year}|${c.month}`, c)
  const all = [...merged.values()]
  const asOfMonth = asOf % 100

  const recvFull = sumIf(all, isR), payFull = sumIf(all, isP)
  const recvYTD = sumIf(all, c => isR(c) && ym(c) <= asOf), payYTD = sumIf(all, c => isP(c) && ym(c) <= asOf)
  const netYTD = recvYTD + payYTD
  const recvRem = sumIf(all, c => isR(c) && ym(c) > asOf), payRem = sumIf(all, c => isP(c) && ym(c) > asOf)
  const netRem = recvRem + payRem

  const derived = computeDerivedBalances({ cells: all, lines, fromYear: year, fromMonth: 1, toYear: year, toMonth: 12 })
  const opening = derived.openingByYM.get(year * 100 + 1) ?? null
  const yearEnd = derived.closingByYM.get(year * 100 + 12) ?? null
  const now = derived.closingByYM.get(asOf) ?? null

  // Monthly arrays (cash closing chain · liability stock · net funds)
  const debtAt = (mm: number) => sumIf(all, c => isDebtStock(lineOf(c) || ({} as CfLine)) && c.month === mm)
  const cashClosing: number[] = [], liabilities: number[] = [], netFunds: number[] = []
  for (let m = 1; m <= 12; m++) {
    const cash = derived.closingByYM.get(year * 100 + m) ?? 0
    const debt = debtAt(m)
    cashClosing.push(cash); liabilities.push(debt); netFunds.push(cash - debt)
  }

  const debtOpen = liabilities[0], debtNow = liabilities[asOfMonth - 1] ?? 0, debtEnd = liabilities[11]
  const nfOpen = (opening ?? 0) - debtOpen, nfNow = (now ?? 0) - debtNow, nfEnd = (yearEnd ?? 0) - debtEnd
  const debtPeak = Math.max(...liabilities)
  let minNf = { idx: 0, value: netFunds[0] }
  netFunds.forEach((v, i) => { if (v < minNf.value) minNf = { idx: i, value: v } })

  // optional analyst breakdown, sections derived from the catalog (not hardcoded)
  const secs = flowSections(lines)
  const secSum = (cats: string[], pred: (c: CfCell) => boolean) => sumIf(all, c => cats.includes(catOf(c)) && pred(c))
  const paySections = secs.map(s => ({ label: s.label, value: secSum(s.categories, isP) }))
    .filter(s => Math.abs(s.value) > 0.5).sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
  const recvSections = secs.map(s => ({ label: s.label, value: secSum(s.categories, isR) }))
    .filter(s => Math.abs(s.value) > 0.5).sort((a, b) => Math.abs(b.value) - Math.abs(a.value))

  return {
    asOfMonth, opening, now, yearEnd, cashClosing, liabilities, netFunds,
    recvFull, payFull, recvYTD, payYTD, netYTD, recvRem, payRem, netRem,
    debtOpen, debtNow, debtEnd, nfOpen, nfNow, nfEnd, debtPeak, minNf,
    paySections, recvSections,
  }
}
