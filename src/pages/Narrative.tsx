import { useEffect, useMemo, useState } from 'react'
import { fetchActuals, fetchForecasts, type CfCell, type CfLine, type CanonicalArea } from '@/lib/queries'
import { computeDerivedBalances } from '@/lib/derivedBalances'
import { fmt } from '@/lib/format'
import type { Scope } from './Dossier'
import { buildNarrativeHtml } from './narrativePrint'

/* ── The narrative cash-flow story ─────────────────────────────────────────
 * Karim's brief: a page that "tells a story", not tables. Seven beats, in
 * plain English, at Group / Area / Project grain:
 *   1. how much we started with         (opening cash, start of year)
 *   2. how much we expected to receive  (full-year inflow plan)
 *   3. how much we had to pay            (full-year outflow plan)
 *   4. how much we actually received     (actuals so far)
 *   5. how much we actually paid          (actuals so far)
 *   6. how much our position moved        (net cash consumed / generated YTD)
 *   7. what we expect till year-end       (forecast remainder → projected close)
 * Then the drill: where the money goes (by section / line) and, at group, by
 * area. Reads the canonical project-grain store; native currency per area.
 */

type Mode = 'group' | 'area'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export type NarrativeData = {
  opening: number | null
  yearEnd: number | null
  recvFull: number; payFull: number
  recvYTD: number; payYTD: number
  netYTD: number
  recvRem: number; payRem: number
  netRem: number
  // where it goes: payments by section, receipts by section (full year)
  paySections: { label: string; value: number }[]
  recvSections: { label: string; value: number }[]
  // group only: net position per area (YTD net movement)
  byArea: { name: string; opening: number | null; netYTD: number; yearEnd: number | null }[]
}

export default function Narrative({ scope }: { scope: Scope }) {
  const year = Math.floor(scope.latestActualYM / 100)
  const asOf = scope.latestActualYM
  const asOfMonth = asOf % 100
  const asOfLabel = `${MONTHS[asOfMonth - 1]} ${year}`

  const sortedAreas = useMemo(
    () => [...scope.areas].sort((a, b) => a.sort_order - b.sort_order),
    [scope.areas])

  const [mode, setMode] = useState<Mode>('area')
  const [areaId, setAreaId] = useState<string>('')
  // Default the area to one with pushed data (KSA = the verified showcase),
  // else the first area, once the catalog is loaded.
  useEffect(() => {
    if (areaId || sortedAreas.length === 0) return
    const seed = sortedAreas.find(a => a.cf_areas.includes('KSA')) || sortedAreas[0]
    setAreaId(seed.area_id)
  }, [sortedAreas, areaId])

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
        setCurrency(mode === 'group' ? 'mixed' : (a[0]?.currency || f[0]?.currency || ''))
      } finally { if (!cancel) setLoading(false) }
    })()
    return () => { cancel = true }
  }, [mode, areaId, scope.primaryVersion, year, (cfAreas || []).join('|')])

  const data = useMemo<NarrativeData>(() =>
    computeNarrative(actuals, forecasts, scope.lines, year, asOf, mode, scope.cfToCanonical),
    [actuals, forecasts, scope.lines, year, asOf, mode, scope.cfToCanonical])

  const scopeLabel = mode === 'group' ? 'the Group' : (selArea?.display_name || 'area')

  const print = () => {
    const w = window.open('', '_blank')
    if (!w) return
    w.document.write(buildNarrativeHtml(data, { scopeLabel, year, asOfLabel, mode, currency }))
    w.document.close()
  }

  return (
    <div className="narr">
      <div className="narr-toolbar no-print">
        <div className="narr-grain">
          <button className={`narr-pill ${mode === 'group' ? 'active' : ''}`}
                  onClick={() => setMode('group')}>Group</button>
          <button className={`narr-pill ${mode === 'area' ? 'active' : ''}`}
                  onClick={() => { setMode('area'); if (!areaId && sortedAreas[0]) setAreaId(sortedAreas[0].area_id) }}>
            Area
          </button>
          {mode === 'area' && (
            <select className="narr-select" value={areaId} onChange={e => setAreaId(e.target.value)}>
              {sortedAreas.map(a => <option key={a.area_id} value={a.area_id}>{a.display_name}</option>)}
            </select>
          )}
        </div>
        <button className="narr-print-btn" onClick={print}>Print</button>
      </div>

      {loading ? (
        <div className="placeholder-box">Loading…</div>
      ) : (
        <NarrativeBody data={data} scopeLabel={scopeLabel} year={year} asOfLabel={asOfLabel} mode={mode} currency={currency} />
      )}
    </div>
  )
}

/* All narrative figures display in millions of the native currency. */
const fM = (v: number | null | undefined) => v == null ? '—' : fmt(v / 1e6, { decimals: 1 })
function unitLine(mode: Mode, currency: string): string {
  if (mode === 'group') return 'figures in millions · native currencies summed — USD consolidation via the FX layer is in progress'
  return `figures in ${currency || 'local currency'} millions`
}

/* The story body — also the print template's source of truth (kept simple
 * so the print HTML can mirror it). */
function NarrativeBody({ data, scopeLabel, year, asOfLabel, mode, currency }: {
  data: NarrativeData; scopeLabel: string; year: number; asOfLabel: string; mode: Mode; currency: string
}) {
  const d = data
  const consumed = d.netYTD < 0
  const projUp = (d.yearEnd ?? 0) >= (d.opening ?? 0)

  return (
    <div className="narr-page">
      <div className="narr-head">
        <h1>The cash flow story — {scopeLabel}</h1>
        <div className="narr-sub">Year {year} · actuals through {asOfLabel}, forecast to year-end · {unitLine(mode, currency)}</div>
      </div>

      <div className="narr-beats">
        <Beat n="01" lead="We started the year with"
              value={d.opening} accent="ink"
              tail="in cash on hand." />

        <Beat n="02" lead={`Across ${year} we expect to bring in`}
              value={d.recvFull} accent="pos"
              tail="from operations, claims and financing." />

        <Beat n="03" lead="And we have liabilities to pay of"
              value={-Math.abs(d.payFull)} accent="neg"
              tail="over the same year." />

        <div className="narr-divider"><span>So far ({asOfLabel})</span></div>

        <Beat n="04" lead="We have actually received"
              value={d.recvYTD} accent="pos"
              tail={`— ${pct(d.recvYTD, d.recvFull)} of the year's expected inflow.`} />

        <Beat n="05" lead="And we have actually paid"
              value={-Math.abs(d.payYTD)} accent="neg"
              tail={`— ${pct(Math.abs(d.payYTD), Math.abs(d.payFull))} of the year's liabilities.`} />

        <Beat n="06" lead={consumed ? 'Our net position has fallen by' : 'Our net position has risen by'}
              value={d.netYTD} accent={consumed ? 'neg' : 'pos'}
              tail={consumed
                ? 'over the period — this gap was funded from cash and borrowing.'
                : 'over the period — the period generated cash.'} />

        <div className="narr-divider"><span>Looking ahead</span></div>

        <Beat n="07" lead="For the rest of the year we still expect to net"
              value={d.netRem} accent={d.netRem < 0 ? 'neg' : 'pos'}
              tail={`, ending ${year} at a projected cash position of`} />

        <div className="narr-bottomline">
          <div className="narr-bl-label">Projected year-end cash</div>
          <div className={`narr-bl-value ${projUp ? 'pos' : 'neg'}`}>{fM(d.yearEnd)}</div>
          <div className="narr-bl-note">
            from {fM(d.opening)} at the start of {year} — a {projUp ? 'rise' : 'drawdown'} of {fM(Math.abs((d.yearEnd ?? 0) - (d.opening ?? 0)))}.
          </div>
        </div>
      </div>

      {/* Where the money goes */}
      <div className="narr-where">
        <div className="narr-where-col">
          <h3>Where the money goes <span>· payments, full year</span></h3>
          <BarList items={d.paySections} tone="neg" />
        </div>
        <div className="narr-where-col">
          <h3>Where it comes from <span>· receipts, full year</span></h3>
          <BarList items={d.recvSections} tone="pos" />
        </div>
      </div>

      {mode === 'group' && d.byArea.length > 0 && (
        <div className="narr-byarea">
          <h3>By area <span>· net cash movement so far ({asOfLabel})</span></h3>
          <table className="narr-area-table">
            <thead><tr><th>Area</th><th>Opened {year}</th><th>Net so far</th><th>Proj. year-end</th></tr></thead>
            <tbody>
              {d.byArea.map(a => (
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td className={cls(a.opening)}>{fM(a.opening)}</td>
                  <td className={cls(a.netYTD)}>{fM(a.netYTD)}</td>
                  <td className={cls(a.yearEnd)}>{fM(a.yearEnd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="narr-foot">
        Source: canonical project-grain cash-flow store · reconciled to the Treasury consolidated master.
        {mode === 'group' && ' Group figures sum native-currency areas — USD consolidation via the FX layer is in progress.'}
      </div>
    </div>
  )
}

function Beat({ n, lead, value, tail, accent }: {
  n: string; lead: string; value: number | null; tail: string; accent: 'pos' | 'neg' | 'ink'
}) {
  return (
    <div className="narr-beat">
      <div className="narr-beat-n">{n}</div>
      <div className="narr-beat-body">
        <span className="narr-beat-lead">{lead} </span>
        <span className={`narr-beat-val ${accent}`}>{fM(value)}</span>
        <span className="narr-beat-lead"> {tail}</span>
      </div>
    </div>
  )
}

function BarList({ items, tone }: { items: { label: string; value: number }[]; tone: 'pos' | 'neg' }) {
  const max = Math.max(1, ...items.map(i => Math.abs(i.value)))
  return (
    <div className="narr-bars">
      {items.length === 0 && <div className="narr-bars-empty">No data.</div>}
      {items.map(i => (
        <div key={i.label} className="narr-bar-row">
          <div className="narr-bar-label">{i.label}</div>
          <div className="narr-bar-track">
            <div className={`narr-bar-fill ${tone}`} style={{ width: `${(Math.abs(i.value) / max) * 100}%` }} />
          </div>
          <div className={`narr-bar-val ${tone}`}>{fM(Math.abs(i.value))}</div>
        </div>
      ))}
    </div>
  )
}

function pct(part: number, whole: number): string {
  if (!whole) return '—'
  const p = Math.round((part / whole) * 100)
  return `${p}%`
}
function cls(v: number | null): string {
  if (v == null || v === 0) return 'num'
  return v < 0 ? 'num neg' : 'num pos'
}

/* ── computation ─────────────────────────────────────────────────────────── */
export function computeNarrative(
  actuals: CfCell[], forecasts: CfCell[], lines: CfLine[],
  year: number, asOf: number, mode: Mode,
  cfToCanonical: Map<string, CanonicalArea>,
): NarrativeData {
  const lineByCode = new Map<string, CfLine>()
  for (const l of lines) lineByCode.set(l.line_code, l)
  const ym = (c: CfCell) => c.year * 100 + c.month
  const natureOf = (c: CfCell) => lineByCode.get(c.line_code)?.nature
  const catOf = (c: CfCell) => lineByCode.get(c.line_code)?.category || ''

  const sumIf = (rows: CfCell[], pred: (c: CfCell) => boolean) =>
    rows.reduce((t, c) => pred(c) ? t + c.value : t, 0)

  const isR = (c: CfCell) => natureOf(c) === 'Receipts'
  const isP = (c: CfCell) => natureOf(c) === 'Payments'

  /* The elapsed-vs-remaining split is by PERIOD (month ≤ as-of), not by
   * table: pre-publish, the as-submitted actuals for elapsed months live in
   * cf_forecasts, and cf_actuals is empty until a version is published. Merge
   * both, letting a published actual override the forecast for the same cell. */
  const cellKey = (c: CfCell) => `${c.area}|${c.line_code}|${c.year}|${c.month}`
  const merged = new Map<string, CfCell>()
  for (const c of forecasts) merged.set(cellKey(c), c)
  for (const c of actuals) merged.set(cellKey(c), c)
  const all = [...merged.values()]

  // Full-year plan
  const recvFull = sumIf(all, isR)
  const payFull = sumIf(all, isP)
  // Elapsed (so far): months at or before the as-of cutover
  const recvYTD = sumIf(all, c => isR(c) && ym(c) <= asOf)
  const payYTD = sumIf(all, c => isP(c) && ym(c) <= asOf)
  const netYTD = recvYTD + payYTD
  // Remaining (forecast to year-end)
  const recvRem = sumIf(all, c => isR(c) && ym(c) > asOf)
  const payRem = sumIf(all, c => isP(c) && ym(c) > asOf)
  const netRem = recvRem + payRem

  // Derived opening / year-end cash (full year chain)
  const derived = computeDerivedBalances({
    cells: all, lines, fromYear: year, fromMonth: 1, toYear: year, toMonth: 12,
  })
  const opening = derived.openingByYM.get(year * 100 + 1) ?? null
  const yearEnd = derived.closingByYM.get(year * 100 + 12) ?? null

  // Where it goes — by section (full year)
  const SECTION_CATS: [string, string[]][] = [
    ['Operations', ['Operation', 'Claims']],
    ['New sales', ['New Sales']],
    ['Interest', ['Interest']],
    ['Non-operational', ['Non Operational']],
    ['Within group', ['Within Group']],
    ['Bank financing', ['Bank Financing']],
  ]
  const sectionSum = (rows: CfCell[], cats: string[], pred: (c: CfCell) => boolean) =>
    sumIf(rows, c => cats.includes(catOf(c)) && pred(c))
  const paySections = SECTION_CATS
    .map(([label, cats]) => ({ label, value: sectionSum(all, cats, isP) }))
    .filter(s => Math.abs(s.value) > 0.5)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
  const recvSections = SECTION_CATS
    .map(([label, cats]) => ({ label, value: sectionSum(all, cats, isR) }))
    .filter(s => Math.abs(s.value) > 0.5)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))

  // Group: per-area net movement so far + opening/year-end
  let byArea: NarrativeData['byArea'] = []
  if (mode === 'group') {
    const areaKey = (c: CfCell) => cfToCanonical.get(c.area)?.display_name || c.area
    const names = [...new Set(all.map(areaKey))]
    byArea = names.map(name => {
      const aRows = all.filter(c => areaKey(c) === name)
      const der = computeDerivedBalances({
        cells: aRows, lines, fromYear: year, fromMonth: 1, toYear: year, toMonth: 12,
      })
      return {
        name,
        opening: der.openingByYM.get(year * 100 + 1) ?? null,
        netYTD: sumIf(aRows, c => (isR(c) || isP(c)) && ym(c) <= asOf),
        yearEnd: der.closingByYM.get(year * 100 + 12) ?? null,
      }
    }).sort((a, b) => (a.netYTD) - (b.netYTD))
  }

  return { opening, yearEnd, recvFull, payFull, recvYTD, payYTD, netYTD, recvRem, payRem, netRem, paySections, recvSections, byArea }
}
