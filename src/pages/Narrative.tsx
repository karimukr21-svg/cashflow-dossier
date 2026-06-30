import { useEffect, useMemo, useState } from 'react'
import {
  fetchActuals, fetchForecasts, fetchPopulatedCfAreas,
  type CfCell, type CfLine, type CanonicalArea,
} from '@/lib/queries'
import { computeDerivedBalances } from '@/lib/derivedBalances'
import { isDebtStock, flowSections } from '@/lib/cfTaxonomy'
import { fmt } from '@/lib/format'
import type { Scope } from './Dossier'
import { buildNarrativeHtml } from './narrativePrint'
import { buildLiquidChart } from './narrativeChart'

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

  const scopeLabel = mode === 'group' ? 'the Group' : (selArea?.display_name || 'area')
  const unit = `${currency || (mode === 'group' ? 'mixed' : 'local')} millions`

  const print = () => {
    const w = window.open('', '_blank')
    if (!w) return
    w.document.write(buildNarrativeHtml(data, { scopeLabel, year, asOfLabel, mode, unit, months: MONTHS }))
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
        </div>
        <button className="cnr-print-btn" onClick={print}>Print</button>
      </div>

      {loading
        ? <div className="placeholder-box">Loading…</div>
        : <ChairmanReport d={data} scopeLabel={scopeLabel} year={year} asOfLabel={asOfLabel} unit={unit} mode={mode} />}
    </div>
  )
}

/* ── helpers ────────────────────────────────────────────────────────────── */
const fM = (v: number | null | undefined) => v == null ? '—' : fmt(v / 1e6, { decimals: 1 })
const fMs = (v: number | null | undefined) => {
  if (v == null) return '—'
  const r = Math.round((v / 1e6) * 10) / 10
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return r < 0 ? `(${s})` : `+${s}`
}
const sign = (v: number | null | undefined) => (v == null || v === 0) ? '' : (v < 0 ? 'neg' : 'pos')

/* ── the report ─────────────────────────────────────────────────────────── */
function ChairmanReport({ d, scopeLabel, year, asOfLabel, unit, mode }: {
  d: NarrativeData; scopeLabel: string; year: number; asOfLabel: string; unit: string; mode: Mode
}) {
  const liqSwing = (d.yearEnd ?? 0) - (d.now ?? 0)
  const decRetire = d.debtEnd - d.liabilities[10]
  const plateau = Math.round((d.liabilities.slice(0, 11).reduce((a, b) => a + b, 0) / 11) / 1e6 / 50) * 50
  const liqSwingCap = liqSwing >= 0 ? `Liquid funds build by year-end` : `Liquid funds drawn down over the year`

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

      {/* Region 2 — hero: liquid funds position */}
      <div className="cnr-hero">
        <div className="cnr-hero-eyebrow">Liquid funds position</div>
        <div className="cnr-hero-row">
          <div className="cnr-hero-pt">
            <div className={`cnr-hero-num ${sign(d.now)}`}>{fM(d.now)}</div>
            <div className="cnr-hero-cap">Today · {asOfLabel}</div>
          </div>
          <div className="cnr-hero-arrow">→</div>
          <div className="cnr-hero-pt">
            <div className={`cnr-hero-num ${sign(d.yearEnd)}`}>{fM(d.yearEnd)}</div>
            <div className="cnr-hero-cap">Forecast · Dec {year}</div>
          </div>
          <div className="cnr-hero-unit">{unit.replace(' millions', ' m')}</div>
          <div className="cnr-hero-swing">
            <div className={`cnr-swing-num ${sign(liqSwing)}`}>{fMs(liqSwing)}</div>
            <div className="cnr-swing-cap">{liqSwingCap} · cash only, before financing &amp; payables</div>
          </div>
        </div>
      </div>

      {/* Region 3 — liquid funds across the year (clean, not netted with debt) */}
      <div className="cnr-chartwrap">
        <div className="cnr-chart-head">
          <div className="cnr-chart-title">Liquid funds across {year} <span>· cash on hand, month by month</span></div>
          <div className="cnr-legend">
            <span className="cnr-leg"><i className="cnr-leg-nf" />Liquid funds</span>
            <span className="cnr-leg"><i className="cnr-leg-fc" />Forecast</span>
          </div>
        </div>
        <div className="cnr-chart" dangerouslySetInnerHTML={{ __html: buildLiquidChart({
          months: MONTHS, liquid: d.cashClosing, asOfMonth: d.asOfMonth,
        }) }} />
      </div>

      {/* Region 4 — position summary: liquid funds / financing / payables, kept separate */}
      <div className="cnr-owe-head">Position summary <span>· liquid funds, financing &amp; payables — kept separate</span></div>
      <div className="cnr-strip">
        <StatCol label="Liquid funds" from={d.now} to={d.yearEnd}
          note={`Cash on hand · ${fMs(liqSwing)} over the year`} />
        <StatCol label="Loans &amp; overdrafts" from={-Math.abs(d.debtNow)} to={-Math.abs(d.debtEnd)} bothNeg
          note={`Financing · held ≈ ${plateau}m all year · ${fMs(decRetire)} in Dec`} />
        <StatCol label="Payables (suppliers + subcontractors)" pending
          note="Trade liabilities · awaiting Amr's figures" />
        <StatCol label="Full-year flow" single={d.recvFull}
          note={`Receipts vs ${fM(Math.abs(d.payFull))} payments · net ${fMs(d.recvFull + d.payFull)}`} />
      </div>

      {/* Region 5 — bottom line */}
      <div className="cnr-bottomline">
        <span className="cnr-bl-tag">Bottom line</span>
        <span className="cnr-bl-text">{bottomLine(d, scopeLabel)}</span>
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

function StatCol({ label, from, to, single, note, bothNeg, pending }: {
  label: string; from?: number | null; to?: number | null; single?: number; note: string; bothNeg?: boolean; pending?: boolean
}) {
  return (
    <div className="cnr-stat">
      <div className="cnr-stat-label" dangerouslySetInnerHTML={{ __html: label }} />
      <div className="cnr-stat-val">
        {pending ? (
          <span className="cnr-stat-pending">Pending</span>
        ) : single !== undefined ? (
          <span className="pos">{fM(single)}</span>
        ) : (
          <>
            <span className={bothNeg ? 'neg' : sign(from)}>{fM(from)}</span>
            <span className="cnr-stat-arrow">→</span>
            <span className={bothNeg ? 'neg' : sign(to)}>{fM(to)}</span>
          </>
        )}
      </div>
      <div className="cnr-stat-note">{note}</div>
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

function bottomLine(d: NarrativeData, scopeLabel: string): string {
  let lowIdx = 0; d.cashClosing.forEach((v, i) => { if (v < d.cashClosing[lowIdx]) lowIdx = i })
  const dip = d.cashClosing[lowIdx] < (d.now ?? 0)
    ? ` It dips to ${fM(d.cashClosing[lowIdx])}m in ${MONTHS[lowIdx]} before recovering,`
    : ``
  return `${cap(scopeLabel)} holds ${fM(d.now)}m of liquid cash today,${dip} and is forecast to build to ${fM(d.yearEnd)}m by year-end. `
    + `Set against this, loans and overdrafts of ${fM(d.debtNow)}m are paid down to ${fM(d.debtEnd)}m by December. `
    + `Payables to suppliers and subcontractors are tracked separately — figures pending.`
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

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
