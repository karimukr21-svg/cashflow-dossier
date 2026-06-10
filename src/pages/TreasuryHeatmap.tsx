import { useEffect, useMemo, useState } from 'react'
import {
  fetchActuals, fetchBankPositionMonthly, fetchForecasts,
  type CfCell,
} from '@/lib/queries'
import { applyDeltaToCell } from '@/lib/scenario'
import { useScenario } from '@/lib/ScenarioContext'
import DivergingBars from '@/charts/DivergingBars'
import type { Scope } from './Dossier'

/* Treasury Heatmap — Step 8
 * ─────────────────────────
 * Stacked horizontal bars (inflows on top, outflows on bottom) with a cash
 * position waveform between. One column per month. Scenario-aware via the
 * ScenarioContext delta layer.
 *
 * Crunch detection: position waveform colors deep red when within 1 month
 * buffer of zero, amber when within 3 months, green with headroom.
 *
 * Data:
 *   cf_actuals + cf_forecasts → per-area per-month inflow / outflow split
 *   bank_position             → anchor for the position waveform
 */

type AreaSeries = {
  areaName: string         // display label
  color: string
  inflows: number[]        // 12-length, $ amounts
  outflows: number[]       // 12-length, $ amounts (positive magnitudes)
}

type Props = {
  scope: Scope
  onSelectArea: (areaId: string) => void
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/* Deterministic 8-color palette cycled by area index. Operations / Subsidiaries /
 * Corporate get distinct hue ranges. */
const PALETTE = [
  '#0b7a55', '#1d6fdc', '#a4459a', '#c7861d',
  '#057a55', '#314ec5', '#7c3aed', '#dc6a13',
  '#0e9384', '#3b82f6', '#9333ea', '#ea580c',
  '#10b981', '#6366f1', '#a855f7', '#f59e0b',
]

export default function TreasuryHeatmap({ scope, onSelectArea }: Props) {
  const year = scope.toYear  // use the end-of-scope year
  const { workingIndex, savedIndex } = useScenario()

  const [actuals, setActuals] = useState<CfCell[]>([])
  const [forecasts, setForecasts] = useState<CfCell[]>([])
  const [bankMonthly, setBankMonthly] = useState<{ ym: number; cash: number; netFunds: number }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancel = false
    setLoading(true)
    Promise.all([
      fetchActuals({ fromYear: year, fromMonth: 1, toYear: year, toMonth: 12 }),
      fetchForecasts({ version: scope.primaryVersion, fromYear: year, fromMonth: 1, toYear: year, toMonth: 12 }),
      fetchBankPositionMonthly(year),
    ])
      .then(([a, f, b]) => {
        if (cancel) return
        setActuals(a.map(r => ({ area: r.area, line_code: r.line_code, year: r.year, month: r.month, value: r.value })))
        setForecasts(f.map(r => ({ area: r.area, line_code: r.line_code, year: r.year, month: r.month, value: r.value })))
        setBankMonthly(b.map(r => ({ ym: r.ym, cash: r.cash, netFunds: r.netFunds })))
      })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [year, scope.primaryVersion])

  const lineByCode = useMemo(() => new Map(scope.lines.map(l => [l.line_code, l])), [scope.lines])

  /* Build per-area inflow/outflow arrays, applying scenario delta. Group by
   * canonical area (so 16 series at country grain, not 200). */
  const series = useMemo(() => {
    if (loading) return [] as AreaSeries[]
    const byArea = new Map<string, { inflows: number[]; outflows: number[] }>()
    const ensure = (areaId: string) => {
      let s = byArea.get(areaId)
      if (!s) { s = { inflows: Array(12).fill(0), outflows: Array(12).fill(0) }; byArea.set(areaId, s) }
      return s
    }
    const process = (r: CfCell) => {
      const line = lineByCode.get(r.line_code)
      if (!line || line.nature === 'Balance') return
      /* Treasury's own aggregate mirror rows (received-from / paid-to areas)
       * restate flows the area-side wg_*_treasury rows already carry — keep
       * them out of the stacks so group totals aren't inflated. They feed
       * the exchange section instead. */
      if (r.line_code.startsWith('treasury_')) return
      const canonical = scope.cfToCanonical.get(r.area)
      if (!canonical) return
      const v = applyDeltaToCell(workingIndex, savedIndex, r.area, r.line_code, r.year, r.month, r.value)
      const m = r.month - 1
      const s = ensure(canonical.area_id)
      if (line.nature === 'Receipts') s.inflows[m] += v
      else if (line.nature === 'Payments') s.outflows[m] += Math.abs(v)  // positive magnitude for stacking
    }
    for (const r of actuals) process(r)
    for (const r of forecasts) process(r)

    const out: AreaSeries[] = []
    let colorIdx = 0
    for (const a of scope.areas) {
      const s = byArea.get(a.area_id)
      if (!s) continue
      const hasFlow = s.inflows.some(v => v !== 0) || s.outflows.some(v => v !== 0)
      if (!hasFlow) continue
      out.push({
        areaName: a.display_name,
        color: PALETTE[colorIdx % PALETTE.length],
        inflows: s.inflows,
        outflows: s.outflows,
      })
      colorIdx++
    }
    return out
  }, [loading, actuals, forecasts, lineByCode, scope.cfToCanonical, scope.areas, workingIndex, savedIndex])

  /* Column totals + axis scaling */
  const monthlyTotals = useMemo(() => {
    const inflowTot = Array(12).fill(0)
    const outflowTot = Array(12).fill(0)
    for (const s of series) {
      for (let m = 0; m < 12; m++) {
        inflowTot[m] += s.inflows[m]
        outflowTot[m] += s.outflows[m]
      }
    }
    const maxIn = Math.max(...inflowTot, 1)
    const maxOut = Math.max(...outflowTot, 1)
    const maxBar = Math.max(maxIn, maxOut)
    return { inflowTot, outflowTot, maxBar }
  }, [series])

  /* Position waveform — anchor at last bank_position period, then run
   * cumulative net flow forward. */
  const position = useMemo(() => {
    const out: { ym: number; value: number }[] = []
    if (loading) return out

    const bankByYM = new Map(bankMonthly.map(b => [b.ym, b.netFunds]))
    const orderedBankYMs = [...bankByYM.keys()].sort((a, b) => a - b)
    const lastBankYM = orderedBankYMs.length ? orderedBankYMs[orderedBankYMs.length - 1] : null

    let running = lastBankYM !== null ? (bankByYM.get(lastBankYM) || 0) : 0

    for (let m = 1; m <= 12; m++) {
      const ym = year * 100 + m
      if (bankByYM.has(ym)) {
        running = bankByYM.get(ym)!
      } else if (lastBankYM !== null && ym > lastBankYM) {
        /* Forecast period — add net cash flow this month */
        const net = (monthlyTotals.inflowTot[m - 1] || 0) - (monthlyTotals.outflowTot[m - 1] || 0)
        running = running + net
      }
      out.push({ ym, value: running })
    }
    return out
  }, [loading, bankMonthly, monthlyTotals, year])

  /* Areas ↔ Treasury exchange.
   * Headline totals from Treasury's own sheet rows (treasury_recpt_areas /
   * treasury_pay_areas — Tony's "TREASURY RECEIPTS - FROM AREAS" lines).
   * Per-area split from the area-side wg_recpt_treasury / wg_pay_treasury. */
  const exchange = useMemo(() => {
    let fromAreas = 0   // Treasury received from areas
    let toAreas = 0     // Treasury paid to areas (magnitude)
    const perArea = new Map<string, { provided: number; received: number }>()
    const process = (r: CfCell) => {
      const v = applyDeltaToCell(workingIndex, savedIndex, r.area, r.line_code, r.year, r.month, r.value)
      if (r.line_code === 'treasury_recpt_areas') fromAreas += v
      else if (r.line_code === 'treasury_pay_areas') toAreas += Math.abs(v)
      else if (r.line_code === 'wg_pay_treasury' || r.line_code === 'wg_recpt_treasury') {
        const canonical = scope.cfToCanonical.get(r.area)
        if (!canonical) return
        let s = perArea.get(canonical.area_id)
        if (!s) { s = { provided: 0, received: 0 }; perArea.set(canonical.area_id, s) }
        if (r.line_code === 'wg_pay_treasury') s.provided += Math.abs(v)
        else s.received += v
      }
    }
    for (const r of actuals) process(r)
    for (const r of forecasts) process(r)
    const rows = scope.areas
      .filter(a => perArea.has(a.area_id))
      .map(a => {
        const s = perArea.get(a.area_id)!
        return { areaId: a.area_id, label: a.display_name, provided: s.provided, received: s.received, net: s.provided - s.received }
      })
      .sort((x, y) => Math.abs(y.net) - Math.abs(x.net))
    return { fromAreas, toAreas, rows }
  }, [actuals, forecasts, scope.areas, scope.cfToCanonical, workingIndex, savedIndex])

  const posMax = useMemo(() => Math.max(...position.map(p => Math.abs(p.value)), 1), [position])

  const minPosMonth = useMemo(() => {
    if (!position.length) return null
    return position.reduce((min, p) => p.value < min.value ? p : min, position[0])
  }, [position])

  if (loading) return <div className="placeholder-box">Loading…</div>

  /* Header KPIs */
  const totalIn = monthlyTotals.inflowTot.reduce((s, v) => s + v, 0)
  const totalOut = monthlyTotals.outflowTot.reduce((s, v) => s + v, 0)

  return (
    <div className="heatmap-page">
      <h1>Treasury</h1>
      <div className="heatmap-subtitle">
        What areas provided vs received · monthly flow stacks · cash position ·
        {' '}{year} · {series.length} active areas
      </div>

      {/* ── Areas ↔ Treasury exchange ───────────────────────────── */}
      <div className="heatmap-kpis">
        <div className="heatmap-kpi">
          <div className="heatmap-kpi-label">Areas → Treasury</div>
          <div className="heatmap-kpi-value pos">{fmtMoney(exchange.fromAreas)}</div>
        </div>
        <div className="heatmap-kpi">
          <div className="heatmap-kpi-label">Treasury → Areas</div>
          <div className="heatmap-kpi-value neg">{fmtMoney(exchange.toAreas)}</div>
        </div>
        <div className="heatmap-kpi">
          <div className="heatmap-kpi-label">Net to Treasury</div>
          <div className={`heatmap-kpi-value ${(exchange.fromAreas - exchange.toAreas) >= 0 ? 'pos' : 'neg'}`}>
            {fmtMoney(exchange.fromAreas - exchange.toAreas)}
          </div>
        </div>
      </div>

      {exchange.rows.length > 0 && (
        <div className="sum-section">
          <h3>Exchange with Treasury by area · {year}</h3>
          <DivergingBars
            rows={exchange.rows.map(r => ({
              key: r.areaId,
              label: r.label,
              neg: r.received,
              pos: r.provided,
              net: r.net,
              onClick: () => onSelectArea(r.areaId),
            }))}
            negHeader="Received from Treasury"
            posHeader="Provided to Treasury"
            showNet
            fmtValue={fmtMoney}
          />
        </div>
      )}

      <div className="sum-section">
        <h3>Monthly flows by area · position waveform</h3>
      </div>
      <div className="heatmap-kpis">
        <div className="heatmap-kpi">
          <div className="heatmap-kpi-label">Total inflows</div>
          <div className="heatmap-kpi-value pos">{fmtMoney(totalIn)}</div>
        </div>
        <div className="heatmap-kpi">
          <div className="heatmap-kpi-label">Total outflows</div>
          <div className="heatmap-kpi-value neg">{fmtMoney(totalOut)}</div>
        </div>
        <div className="heatmap-kpi">
          <div className="heatmap-kpi-label">Net</div>
          <div className={`heatmap-kpi-value ${(totalIn - totalOut) >= 0 ? 'pos' : 'neg'}`}>
            {fmtMoney(totalIn - totalOut)}
          </div>
        </div>
        {minPosMonth && (
          <div className="heatmap-kpi">
            <div className="heatmap-kpi-label">Lowest position month</div>
            <div className={`heatmap-kpi-value ${minPosMonth.value < 0 ? 'neg' : ''}`}>
              {MONTH_NAMES[(minPosMonth.ym % 100) - 1]} · {fmtMoney(minPosMonth.value)}
            </div>
          </div>
        )}
      </div>

      <div className="heatmap-grid">
        {/* Top — inflow stacks */}
        <div className="heatmap-band heatmap-band-in">
          {Array.from({ length: 12 }).map((_, m) => (
            <div key={`in-${m}`} className="heatmap-col">
              <StackedBar
                segments={series.map(s => ({ color: s.color, value: s.inflows[m], name: s.areaName }))}
                maxValue={monthlyTotals.maxBar}
                direction="up"
              />
            </div>
          ))}
        </div>

        {/* Middle — month labels + position waveform */}
        <div className="heatmap-axis">
          <div className="heatmap-axis-line" />
          {position.map((p, i) => (
            <div key={p.ym} className="heatmap-col heatmap-axis-col">
              <div className="heatmap-month-label">{MONTH_NAMES[i]}</div>
              <div
                className={`heatmap-pos-dot ${posTier(p.value, posMax)}`}
                style={{ bottom: `${50 + (p.value / posMax) * 40}%` }}
                title={`${MONTH_NAMES[i]} · ${fmtMoney(p.value)}`}
              />
            </div>
          ))}
        </div>

        {/* Bottom — outflow stacks (visually mirrored downward) */}
        <div className="heatmap-band heatmap-band-out">
          {Array.from({ length: 12 }).map((_, m) => (
            <div key={`out-${m}`} className="heatmap-col">
              <StackedBar
                segments={series.map(s => ({ color: s.color, value: s.outflows[m], name: s.areaName }))}
                maxValue={monthlyTotals.maxBar}
                direction="down"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="heatmap-legend">
        {series.map(s => (
          <button
            key={s.areaName}
            className="heatmap-legend-chip"
            onClick={() => {
              const id = scope.areas.find(a => a.display_name === s.areaName)?.area_id
              if (id) onSelectArea(id)
            }}
            title={`Open ${s.areaName} drill`}
          >
            <span className="heatmap-legend-swatch" style={{ background: s.color }} />
            <span>{s.areaName}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function StackedBar({
  segments, maxValue, direction,
}: {
  segments: { color: string; value: number; name: string }[]
  maxValue: number
  direction: 'up' | 'down'
}) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const pct = Math.min(100, (total / maxValue) * 100)
  if (total === 0) return <div className="heatmap-stack-empty" />
  return (
    <div
      className={`heatmap-stack ${direction === 'up' ? 'stack-up' : 'stack-down'}`}
      style={{ height: `${pct}%` }}
      title={fmtMoney(total)}
    >
      {segments.filter(s => s.value > 0).map((s, i) => (
        <div
          key={i}
          className="heatmap-stack-seg"
          style={{
            background: s.color,
            height: `${(s.value / total) * 100}%`,
          }}
          title={`${s.name} · ${fmtMoney(s.value)}`}
        />
      ))}
    </div>
  )
}

function posTier(value: number, posMax: number): string {
  /* Tier the position dot color: deep red near zero/negative, amber within
   * 30% of max, green with headroom. */
  if (value < 0) return 'pos-neg'
  if (value < posMax * 0.1) return 'pos-low'
  if (value < posMax * 0.3) return 'pos-mid'
  return 'pos-high'
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n)
  let v: string
  if (abs >= 1e9) v = `${(n / 1e9).toFixed(1)}B`
  else if (abs >= 1e6) v = `${(n / 1e6).toFixed(1)}M`
  else if (abs >= 1e3) v = `${(n / 1e3).toFixed(0)}K`
  else v = n.toFixed(0)
  return v
}
