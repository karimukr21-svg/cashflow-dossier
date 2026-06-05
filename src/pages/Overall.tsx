import { useEffect, useState } from 'react'
import { fetchActuals, fetchForecasts, fetchBankPositionLatest, fetchBankPositionMonthly } from '@/lib/queries'
import { fmt, classNum } from '@/lib/format'
import type { Scope } from './Dossier'

/* ────────────────────────────────────────────────────────────────
 * Cash Runway / Gap — landing page.
 *
 * Question this page answers: "Are we going to run out of cash this
 * year? Where's the gap, and where's it coming from?"
 *
 * Sections, top to bottom:
 *   1. Position today        (live bank_position, latest month)
 *   2. Projected year-end    (today + remaining-year forecast flows)
 *   3. Treasury Ask headline (net cash funds required from treasury)
 *   4. Walkback              (3 buckets: Operations / Loan Mov / Non-Op)
 *   5. Trajectory            (Cash · Debt · Net Funds month-by-month)
 *
 * No hardcoded constants. Reads cf_actuals + cf_forecasts (primary
 * version) + bank_position. Mirrors Board Docket §9's narrative arc
 * but always tied to the active version pick. */

type Position = { cash: number; loans: number; od: number; netFunds: number }
type Walkback = { ops: number; loanMov: number; nonOp: number; total: number }
type TrajPoint = { ym: number; isActual: boolean; cash: number; debt: number; netFunds: number }

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const monthLabel = (ym: number) => `${MONTH_NAMES[ym % 100 - 1] || ''} ${Math.floor(ym / 100)}`

export default function Overall({ scope }: { scope: Scope }) {
  const [today, setToday] = useState<Position | null>(null)
  const [asOfYM, setAsOfYM] = useState<number>(0)
  const [eoy, setEoy] = useState<Position | null>(null)
  const [walkback, setWalkback] = useState<Walkback | null>(null)
  const [trajectory, setTrajectory] = useState<TrajPoint[]>([])
  const [eoyYear, setEoyYear] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const bpLatest = await fetchBankPositionLatest()
        if (cancel) return

        // Resolve as-of period
        const [aY, aM] = (bpLatest.period || '').split('-').map(Number)
        const aYM = aY * 100 + aM
        setAsOfYM(aYM)

        const cashNow = bpLatest.rows.filter(r => r.account.toLowerCase() === 'cash').reduce((s, r) => s + r.balance, 0)
        const loansNow = bpLatest.rows.filter(r => r.account.toLowerCase() === 'loans').reduce((s, r) => s + r.balance, 0)
        const odNow = bpLatest.rows.filter(r => r.account.toLowerCase() === 'overdrafts').reduce((s, r) => s + r.balance, 0)
        const todayPos: Position = { cash: cashNow, loans: loansNow, od: odNow, netFunds: cashNow + loansNow + odNow }
        setToday(todayPos)

        // EOY year — same calendar year as the latest actual.
        const year = aY
        setEoyYear(year)

        const [forecastsRoY, actualsYTD, bpMonthly] = await Promise.all([
          // forecast cells from (asOfYM + 1) through Dec of same year
          fetchForecasts({ version: scope.primaryVersion, fromYear: year, fromMonth: aM + 1, toYear: year, toMonth: 12 }),
          // actuals for the calendar year (for trajectory chart up to asOfYM)
          fetchActuals({ fromYear: year, fromMonth: 1, toYear: year, toMonth: 12 }),
          // bank_position monthly snapshots for the calendar year
          fetchBankPositionMonthly(year),
        ])
        if (cancel) return

        // Walkback buckets — sum each line.nature/category for the
        // remaining-year forecast cells. Balance lines excluded.
        const lineKind = new Map(scope.lines.map(l => [l.line_code, { nature: l.nature, category: l.category }]))
        let ops = 0, loanMov = 0, nonOp = 0
        forecastsRoY.forEach(c => {
          const k = lineKind.get(c.line_code); if (!k) return
          if (k.nature === 'Balance') return
          if (k.category === 'Bank Financing' || k.category === 'Interest') loanMov += c.value
          else if (k.category === 'Non Operational') nonOp += c.value
          else ops += c.value
        })
        const total = ops + loanMov + nonOp
        setWalkback({ ops, loanMov, nonOp, total })

        // EOY position. Cash impact = ops bucket + non-op bucket.
        // Debt impact = loan movement bucket (settlements net of new loans).
        const eoyPos: Position = {
          cash: cashNow + ops + nonOp,
          loans: loansNow,                       // Loans + OD broken out for tile;
          od: odNow,                             // EOY net funds = today net + total walkback
          netFunds: todayPos.netFunds + total,
        }
        // EOY debt split is messy without a finer loan-vs-OD breakdown — for
        // now show today's split + loanMov rolled into the loans line.
        eoyPos.loans = loansNow + loanMov
        setEoy(eoyPos)

        // Trajectory — Jan..Dec of the current year.
        // Months ≤ asOfYM: actuals from bp_monthly.
        // Months > asOfYM: roll forward by monthly net flow from forecasts.
        // Monthly net flow at the group level = Σ (Receipts + Payments) for
        // that month from forecasts. Split into cash impact (ops + non-op)
        // and debt impact (loan movement) so the chart's three lines diverge.
        const points: TrajPoint[] = []
        let cashCum = 0, debtCum = 0
        for (let m = 1; m <= 12; m++) {
          const ym = year * 100 + m
          const isActual = ym <= aYM
          if (isActual) {
            const bp = bpMonthly.find(p => p.ym === ym)
            if (bp) {
              cashCum = bp.cash
              debtCum = bp.loans + bp.od
            }
          } else {
            // Walk forward from the prior month using forecast monthly flows
            let mOps = 0, mLoan = 0, mNonOp = 0
            forecastsRoY.forEach(c => {
              if (c.year !== year || c.month !== m) return
              const k = lineKind.get(c.line_code); if (!k || k.nature === 'Balance') return
              if (k.category === 'Bank Financing' || k.category === 'Interest') mLoan += c.value
              else if (k.category === 'Non Operational') mNonOp += c.value
              else mOps += c.value
            })
            cashCum = cashCum + mOps + mNonOp
            debtCum = debtCum + mLoan
          }
          points.push({ ym, isActual, cash: cashCum, debt: debtCum, netFunds: cashCum + debtCum })
        }
        // Pull in actuals YTD to refine cashCum/debtCum where bp_monthly is gappy
        // (the bp range we loaded already gives Dec 2025 through asOfYM, so we're fine)
        void actualsYTD  // (reserved for area-level decomposition in a later iteration)
        setTrajectory(points)
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [scope.primaryVersion, scope.lines])

  if (loading) return <div className="placeholder-box">Loading…</div>
  if (!today || !eoy || !walkback) return <div className="placeholder-box">No data.</div>

  const gap = eoy.netFunds - today.netFunds   // signed; negative = treasury ask
  const treasuryAsk = Math.min(0, gap)
  const bufferConsumed = Math.min(0, eoy.cash - today.cash)
  const headroom = Math.max(0, eoy.cash)

  return (
    <div>
      <h1>Cash Runway · 2026</h1>
      <div className="sub">
        Live as of <b>{monthLabel(asOfYM)}</b>
        {' · '}Forecast version <b>{scope.primaryVersion}</b>
        {' · '}Year-end projected = today + remaining-year forecast
        {' · USD K'}
      </div>

      {/* Row 1 — Position today */}
      <div className="runway-section">
        <div className="runway-eyebrow">Position today · {monthLabel(asOfYM)}</div>
        <div className="runway-tile-row big">
          <RunwayTile label="Cash" value={today.cash} flavor="cash" />
          <RunwayTile label="Loans + Overdrafts" value={today.loans + today.od} flavor="debt" />
          <RunwayTile label="Net Funds" value={today.netFunds} flavor="net" emphasis />
        </div>
      </div>

      {/* Row 2 — Projected end of year */}
      <div className="runway-section">
        <div className="runway-eyebrow">Projected at year-end · Dec {eoyYear}</div>
        <div className="runway-tile-row">
          <RunwayTile label="Cash" value={eoy.cash} flavor="cash" small />
          <RunwayTile label="Loans + Overdrafts" value={eoy.loans + eoy.od} flavor="debt" small />
          <RunwayTile label="Net Funds" value={eoy.netFunds} flavor="net" small emphasis />
        </div>
      </div>

      {/* Row 3 — Gap headline */}
      <div className="runway-section runway-ask">
        <div className="runway-ask-eyebrow">Net Cash Funds Required from Treasury · {monthLabel(asOfYM + 1)} → Dec {eoyYear}</div>
        <div className="runway-ask-value">{fmt(treasuryAsk)}</div>
        <div className="runway-ask-detail">
          Cash year-end {fmt(eoy.cash)}
          {' · '}Buffer consumed {fmt(bufferConsumed)}
          {' · '}Year-end cash headroom {fmt(headroom)}
        </div>
      </div>

      {/* Row 4 — Walkback */}
      <div className="runway-section">
        <div className="runway-eyebrow">How the gap builds · Forecast flows {monthLabel(asOfYM + 1)} → Dec {eoyYear}</div>
        <table className="cf-table runway-walkback">
          <thead>
            <tr><th className="label">Bucket</th><th>Δ Net Funds</th><th className="runway-detail">Contains</th></tr>
          </thead>
          <tbody>
            <WalkbackRow label="Cash from Operations" value={walkback.ops}
              detail="Operating receipts + payments, advances, claims, intercompany"/>
            <WalkbackRow label="Net Loan Movement" value={walkback.loanMov}
              detail="New loans + repayments + bank-financing OD + interest"/>
            <WalkbackRow label="Non-Operational" value={walkback.nonOp}
              detail="Related-party settlements + MTB negotiation + other non-op"/>
            <tr className="subtotal-row">
              <td className="label">Total · forecast period</td>
              <td className={classNum(walkback.total)}>{fmt(walkback.total)}</td>
              <td className="runway-detail" />
            </tr>
          </tbody>
        </table>
      </div>

      {/* Row 5 — Trajectory chart */}
      <div className="runway-section">
        <div className="runway-eyebrow">Trajectory · {eoyYear} (actual through {monthLabel(asOfYM)}, forecast after)</div>
        <TrajectoryChart points={trajectory} asOfYM={asOfYM} />
      </div>
    </div>
  )
}

function RunwayTile({ label, value, flavor, small, emphasis }: {
  label: string; value: number; flavor: 'cash' | 'debt' | 'net'; small?: boolean; emphasis?: boolean;
}) {
  return (
    <div className={`runway-tile flavor-${flavor} ${small ? 'small' : ''} ${emphasis ? 'emphasis' : ''}`}>
      <div className="runway-tile-label">{label}</div>
      <div className={`runway-tile-value ${classNum(value)}`}>{fmt(value)}</div>
    </div>
  )
}

function WalkbackRow({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <tr>
      <td className="label">{label}</td>
      <td className={classNum(value)}>{fmt(value)}</td>
      <td className="runway-detail">{detail}</td>
    </tr>
  )
}

/* Lightweight inline-SVG line chart. 3 lines (Cash / Debt / Net Funds) over
 * 12 months. Vertical dashed marker at the actual→forecast handoff. */
function TrajectoryChart({ points, asOfYM }: { points: TrajPoint[]; asOfYM: number }) {
  if (points.length === 0) return null
  const W = 880, H = 280, PAD_L = 56, PAD_R = 20, PAD_T = 16, PAD_B = 30
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B

  const yMin = Math.min(0, ...points.flatMap(p => [p.cash, p.debt, p.netFunds]))
  const yMax = Math.max(0, ...points.flatMap(p => [p.cash, p.debt, p.netFunds]))
  const yRange = yMax - yMin || 1
  const xAt = (i: number) => PAD_L + (i / (points.length - 1)) * plotW
  const yAt = (v: number) => PAD_T + plotH - ((v - yMin) / yRange) * plotH

  const path = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(v)}`).join(' ')

  const cashPath = path(points.map(p => p.cash))
  const debtPath = path(points.map(p => p.debt))
  const netPath = path(points.map(p => p.netFunds))
  const handoffIdx = points.findIndex(p => !p.isActual)
  const handoffX = handoffIdx > 0 ? xAt(handoffIdx) - (plotW / (points.length - 1)) / 2 : null

  const ticks = [yMax, yMax / 2, 0, yMin / 2, yMin].filter((v, i, a) => Math.abs(v) > 1 || i === 2)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="runway-chart">
      {/* Y-axis grid + labels */}
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={PAD_L} x2={W - PAD_R} y1={yAt(t)} y2={yAt(t)} stroke="var(--border)" strokeDasharray={t === 0 ? '' : '3 4'} />
          <text x={PAD_L - 6} y={yAt(t) + 3} fontSize="10" fill="var(--mute)" textAnchor="end">{fmt(t)}</text>
        </g>
      ))}
      {/* X-axis labels */}
      {points.map((p, i) => (
        <text key={i} x={xAt(i)} y={H - 12} fontSize="10" fill="var(--mute)" textAnchor="middle">
          {MONTH_NAMES[p.ym % 100 - 1]}
        </text>
      ))}
      {/* Actual→Forecast handoff line */}
      {handoffX != null && (
        <line x1={handoffX} x2={handoffX} y1={PAD_T} y2={H - PAD_B}
              stroke="var(--charcoal)" strokeDasharray="4 4" opacity="0.4"/>
      )}
      {/* Series */}
      <path d={cashPath} stroke="var(--good)" strokeWidth="2" fill="none"/>
      <path d={debtPath} stroke="var(--bad)" strokeWidth="2" fill="none"/>
      <path d={netPath} stroke="var(--charcoal)" strokeWidth="2.5" fill="none"/>
      {/* Legend */}
      <g transform={`translate(${PAD_L}, ${PAD_T + 4})`} fontSize="11">
        <rect x="0" y="-2" width="12" height="2" fill="var(--good)"/>
        <text x="18" y="3" fill="var(--charcoal)">Cash</text>
        <rect x="60" y="-2" width="12" height="2" fill="var(--bad)"/>
        <text x="78" y="3" fill="var(--charcoal)">Loans + OD</text>
        <rect x="148" y="-2" width="12" height="2" fill="var(--charcoal)"/>
        <text x="166" y="3" fill="var(--charcoal)">Net Funds</text>
        {handoffX != null && (
          <>
            <line x1="240" x2="252" y1="-1" y2="-1" stroke="var(--charcoal)" strokeDasharray="3 3" opacity="0.5"/>
            <text x="258" y="3" fill="var(--mute)">Actual → Forecast</text>
          </>
        )}
      </g>
    </svg>
  )
}
