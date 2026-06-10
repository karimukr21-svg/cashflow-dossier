import { useEffect, useMemo, useState } from 'react'
import { fetchActuals, fetchForecasts, type CfCell } from '@/lib/queries'
import { fmt, classNum } from '@/lib/format'
import StackedArea from '@/charts/StackedArea'
import DivergingBars from '@/charts/DivergingBars'
import type { Scope } from './Dossier'

/* Debt Position
 * ─────────────
 * Answers: "what do we owe, where, and how does it move — historically and
 * forward?" Stocks from accum_loans / accum_od (per-month balances straight
 * from Tony's sheets), movements from the bf_* Bank Financing flow lines.
 * Actual months and forecast months share the chart with a dashed seam.
 */

type Props = { scope: Scope }

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const LOAN_DRAWN = 'bf_recpt_loans'
const LOAN_SETTLED = 'bf_pay_loans'
const OD_DRAWN = 'bf_recpt_od'
const OD_SETTLED = 'bf_pay_od'
const ACCUM_LOANS = 'accum_loans'
const ACCUM_OD = 'accum_od'

export default function DebtPosition({ scope }: Props) {
  const year = scope.toYear
  const [actuals, setActuals] = useState<CfCell[]>([])
  const [forecasts, setForecasts] = useState<CfCell[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancel = false
    setLoading(true)
    Promise.all([
      fetchActuals({ fromYear: year, fromMonth: 1, toYear: year, toMonth: 12 }),
      fetchForecasts({ version: scope.primaryVersion, fromYear: year, fromMonth: 1, toYear: year, toMonth: 12 }),
    ])
      .then(([a, f]) => {
        if (cancel) return
        setActuals(a)
        setForecasts(f)
      })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [year, scope.primaryVersion])

  const model = useMemo(() => {
    if (loading) return null
    const loansByM = Array(12).fill(0)
    const odByM = Array(12).fill(0)
    const hasStockByM = Array(12).fill(false)
    const mov = {
      loanDrawn: Array(12).fill(0), loanSettled: Array(12).fill(0),
      odDrawn: Array(12).fill(0), odSettled: Array(12).fill(0),
    }
    const perArea = new Map<string, { loans: number; od: number; ym: number }>()
    let lastActualM = 0

    const process = (r: CfCell, isActual: boolean) => {
      const m = r.month - 1
      if (r.line_code === ACCUM_LOANS || r.line_code === ACCUM_OD) {
        if (r.line_code === ACCUM_LOANS) loansByM[m] += Math.abs(r.value)
        else odByM[m] += Math.abs(r.value)
        hasStockByM[m] = true
        if (isActual && r.month > lastActualM) lastActualM = r.month

        /* per-area ranking uses the latest ACTUAL balance (matches the
         * "current" KPI month, not the December forecast) */
        if (isActual) {
          const canonical = scope.cfToCanonical.get(r.area)
          if (canonical) {
            const ym = r.year * 100 + r.month
            let s = perArea.get(canonical.area_id)
            if (!s || ym > s.ym) { s = { loans: 0, od: 0, ym }; perArea.set(canonical.area_id, s) }
            if (s.ym === ym) {
              if (r.line_code === ACCUM_LOANS) s.loans += Math.abs(r.value)
              else s.od += Math.abs(r.value)
            }
          }
        }
        return
      }
      if (r.line_code === LOAN_DRAWN) mov.loanDrawn[m] += r.value
      else if (r.line_code === LOAN_SETTLED) mov.loanSettled[m] += r.value
      else if (r.line_code === OD_DRAWN) mov.odDrawn[m] += r.value
      else if (r.line_code === OD_SETTLED) mov.odSettled[m] += r.value
    }
    for (const r of actuals) process(r, true)
    for (const r of forecasts) process(r, false)

    /* months that actually carry stock data drive the chart */
    const monthIdx = hasStockByM.map((has, i) => has ? i : -1).filter(i => i >= 0)
    const labels = monthIdx.map(i => MONTH_NAMES[i])
    const loanVals = monthIdx.map(i => loansByM[i])
    const odVals = monthIdx.map(i => odByM[i])
    const seamIndex = lastActualM > 0 ? monthIdx.indexOf(lastActualM - 1) : null

    const currentM = lastActualM > 0 ? lastActualM - 1 : (monthIdx[0] ?? 0)
    const lastM = monthIdx.length ? monthIdx[monthIdx.length - 1] : 0

    const ranked = scope.areas
      .map(a => {
        const s = perArea.get(a.area_id)
        if (!s) return null
        const total = s.loans + s.od
        if (total < 0.5) return null
        return { areaId: a.area_id, label: a.display_name, loans: s.loans, od: s.od, total }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((x, y) => y.total - x.total)

    return {
      labels, loanVals, odVals, seamIndex, monthIdx, mov,
      current: { loans: loansByM[currentM], od: odByM[currentM], month: currentM },
      yearEnd: { loans: loansByM[lastM], od: odByM[lastM], month: lastM },
      ranked,
    }
  }, [loading, actuals, forecasts, scope.areas, scope.cfToCanonical])

  if (loading || !model) return <div className="placeholder-box">Loading…</div>

  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0)
  const netByM = model.monthIdx.map(i =>
    model.mov.loanDrawn[i] + model.mov.loanSettled[i] + model.mov.odDrawn[i] + model.mov.odSettled[i])

  return (
    <div className="heatmap-page">
      <h1>Debt Position</h1>
      <div className="heatmap-subtitle">
        Loan + overdraft balances and movements · {year} · actuals through {MONTH_NAMES[model.current.month]}
      </div>

      <div className="heatmap-kpis">
        <div className="heatmap-kpi">
          <div className="heatmap-kpi-label">Loans · {MONTH_NAMES[model.current.month]}</div>
          <div className="heatmap-kpi-value neg">{fmt(model.current.loans)}</div>
        </div>
        <div className="heatmap-kpi">
          <div className="heatmap-kpi-label">Overdrafts · {MONTH_NAMES[model.current.month]}</div>
          <div className="heatmap-kpi-value neg">{fmt(model.current.od)}</div>
        </div>
        <div className="heatmap-kpi">
          <div className="heatmap-kpi-label">Total debt · {MONTH_NAMES[model.current.month]}</div>
          <div className="heatmap-kpi-value neg">{fmt(model.current.loans + model.current.od)}</div>
        </div>
        <div className="heatmap-kpi">
          <div className="heatmap-kpi-label">Year-end forecast debt</div>
          <div className="heatmap-kpi-value neg">{fmt(model.yearEnd.loans + model.yearEnd.od)}</div>
        </div>
      </div>

      <div className="sum-section">
        <h3>Debt balances over the year</h3>
        <StackedArea
          labels={model.labels}
          series={[
            { name: 'Loans', color: '#c81e1e', values: model.loanVals },
            { name: 'Overdrafts', color: '#d97706', values: model.odVals },
          ]}
          seamIndex={model.seamIndex}
        />
      </div>

      <div className="sum-section">
        <h3>Movements · drawn vs settled</h3>
        <table className="cf-table" style={{ maxWidth: 980 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Movement</th>
              {model.monthIdx.map(i => <th key={i}>{MONTH_NAMES[i]}</th>)}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {([
              ['Loans drawn', model.monthIdx.map(i => model.mov.loanDrawn[i])],
              ['Loans settled', model.monthIdx.map(i => model.mov.loanSettled[i])],
              ['Overdrafts drawn', model.monthIdx.map(i => model.mov.odDrawn[i])],
              ['Overdrafts settled', model.monthIdx.map(i => model.mov.odSettled[i])],
            ] as [string, number[]][]).map(([label, vals]) => (
              <tr key={label}>
                <td style={{ textAlign: 'left' }}>{label}</td>
                {vals.map((v, i) => <td key={i} className={classNum(v)}>{fmt(v)}</td>)}
                <td className={classNum(sum(vals))}>{fmt(sum(vals))}</td>
              </tr>
            ))}
            <tr className="total">
              <td style={{ textAlign: 'left' }}>Net banking finance</td>
              {netByM.map((v, i) => <td key={i} className={classNum(v)}>{fmt(v)}</td>)}
              <td className={classNum(sum(netByM))}>{fmt(sum(netByM))}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="sum-section">
        <h3>Debt by area · latest balance</h3>
        <DivergingBars
          rows={model.ranked.map(r => ({
            key: r.areaId,
            label: r.label,
            neg: r.total,
            net: r.total,
          }))}
          negHeader="Loans + Overdrafts"
          showNet
        />
      </div>
    </div>
  )
}
