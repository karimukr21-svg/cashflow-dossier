import { useEffect, useState } from 'react'
import { fetchActuals, fetchForecasts } from '@/lib/queries'
import { fmt, classNum } from '@/lib/format'
import type { Scope } from './Dossier'

type Row = {
  area: string;
  loansNewActual: number; loansNewForecast: number;
  loansRepaidActual: number; loansRepaidForecast: number;
  netMovement: number;
  closingLoans: number; closingOd: number; closingTotalDebt: number;
}

export default function LoansOverdrafts({ scope }: { scope: Scope }) {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const code = (nature: string, cat: string, desc: string) =>
          scope.lines.find(l => l.nature === nature && l.category === cat && l.description === desc)?.line_code

        const recpLoans = code('Receipts', 'Bank Financing', 'Loans')
        const payLoans = code('Payments', 'Bank Financing', 'Loans')
        const recpOd = code('Receipts', 'Bank Financing', 'Overdrafts')
        const payOd = code('Payments', 'Bank Financing', 'Overdrafts')
        const accumLoans = code('Balance', 'Accumulated Loans', 'Loans')
        const accumOd = code('Balance', 'Overdrafts', 'Overdrafts')

        const [actuals, forecasts] = await Promise.all([
          fetchActuals({ fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth }),
          fetchForecasts({ version: scope.primaryVersion, fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth }),
        ])
        if (cancel) return

        const map = new Map<string, Row>()
        const get = (a: string) => {
          if (!map.has(a)) map.set(a, {
            area: a, loansNewActual: 0, loansNewForecast: 0,
            loansRepaidActual: 0, loansRepaidForecast: 0, netMovement: 0,
            closingLoans: 0, closingOd: 0, closingTotalDebt: 0,
          })
          return map.get(a)!
        }

        // Loans drawn = Receipts; Loans repaid = -Payments (Payments are negative)
        actuals.forEach(c => {
          const r = get(c.area)
          if (c.line_code === recpLoans) r.loansNewActual += c.value
          if (c.line_code === payLoans) r.loansRepaidActual += -c.value
        })
        forecasts.forEach(c => {
          const r = get(c.area)
          if (c.line_code === recpLoans) r.loansNewForecast += c.value
          if (c.line_code === payLoans) r.loansRepaidForecast += -c.value
        })

        // Closing balances: take the last cell in scope (highest year-month) per area per balance line.
        const lastFor = (cells: any[], area: string, line: string) => {
          let best: any = null
          cells.forEach(c => {
            if (c.area !== area || c.line_code !== line) return
            if (!best || (c.year * 100 + c.month) > (best.year * 100 + best.month)) best = c
          })
          return best ? best.value : 0
        }
        const allCells = [...actuals, ...forecasts]
        ;[...new Set(allCells.map(c => c.area))].forEach(a => {
          const r = get(a)
          r.closingLoans = accumLoans ? lastFor(allCells, a, accumLoans) : 0
          r.closingOd = accumOd ? lastFor(allCells, a, accumOd) : 0
          r.closingTotalDebt = r.closingLoans + r.closingOd
        })

        map.forEach(r => { r.netMovement = (r.loansNewActual + r.loansNewForecast) - (r.loansRepaidActual + r.loansRepaidForecast) })

        const arr = [...map.values()]
          .filter(r => Math.abs(r.loansNewActual) + Math.abs(r.loansNewForecast) +
                       Math.abs(r.loansRepaidActual) + Math.abs(r.loansRepaidForecast) +
                       Math.abs(r.closingTotalDebt) > 0.5)
          .sort((a, b) => a.area.localeCompare(b.area))
        setRows(arr)
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [scope.primaryVersion, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth, scope.lines])

  if (loading) return <div className="placeholder-box">Loading…</div>

  const totals = rows.reduce((acc, r) => ({
    loansNewActual: acc.loansNewActual + r.loansNewActual,
    loansNewForecast: acc.loansNewForecast + r.loansNewForecast,
    loansRepaidActual: acc.loansRepaidActual + r.loansRepaidActual,
    loansRepaidForecast: acc.loansRepaidForecast + r.loansRepaidForecast,
    netMovement: acc.netMovement + r.netMovement,
    closingLoans: acc.closingLoans + r.closingLoans,
    closingOd: acc.closingOd + r.closingOd,
    closingTotalDebt: acc.closingTotalDebt + r.closingTotalDebt,
  }), { loansNewActual: 0, loansNewForecast: 0, loansRepaidActual: 0, loansRepaidForecast: 0,
        netMovement: 0, closingLoans: 0, closingOd: 0, closingTotalDebt: 0 })

  return (
    <div>
      <h1>Loans & Overdrafts</h1>
      <div className="sub">
        Period {scope.fromYear}-{String(scope.fromMonth).padStart(2,'0')} → {scope.toYear}-{String(scope.toMonth).padStart(2,'0')}
        {' · '}Forecast version <b>{scope.primaryVersion}</b>{' · USD K'}
      </div>

      <table className="cf-table">
        <thead>
          <tr>
            <th className="label">Area</th>
            <th>Drawn Actual</th>
            <th>Drawn Forecast</th>
            <th>Repaid Actual</th>
            <th>Repaid Forecast</th>
            <th>Net Movement</th>
            <th>Closing Loans</th>
            <th>Closing OD</th>
            <th>Closing Total Debt</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.area}>
              <td className="label">{r.area}</td>
              <td className={classNum(r.loansNewActual)}>{fmt(r.loansNewActual)}</td>
              <td className={classNum(r.loansNewForecast)}>{fmt(r.loansNewForecast)}</td>
              <td className={classNum(r.loansRepaidActual)}>{fmt(r.loansRepaidActual)}</td>
              <td className={classNum(r.loansRepaidForecast)}>{fmt(r.loansRepaidForecast)}</td>
              <td className={classNum(r.netMovement)}>{fmt(r.netMovement)}</td>
              <td className={classNum(r.closingLoans)}>{fmt(r.closingLoans)}</td>
              <td className={classNum(r.closingOd)}>{fmt(r.closingOd)}</td>
              <td className={classNum(r.closingTotalDebt)}>{fmt(r.closingTotalDebt)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="total">
            <td className="label">Group total</td>
            <td className={classNum(totals.loansNewActual)}>{fmt(totals.loansNewActual)}</td>
            <td className={classNum(totals.loansNewForecast)}>{fmt(totals.loansNewForecast)}</td>
            <td className={classNum(totals.loansRepaidActual)}>{fmt(totals.loansRepaidActual)}</td>
            <td className={classNum(totals.loansRepaidForecast)}>{fmt(totals.loansRepaidForecast)}</td>
            <td className={classNum(totals.netMovement)}>{fmt(totals.netMovement)}</td>
            <td className={classNum(totals.closingLoans)}>{fmt(totals.closingLoans)}</td>
            <td className={classNum(totals.closingOd)}>{fmt(totals.closingOd)}</td>
            <td className={classNum(totals.closingTotalDebt)}>{fmt(totals.closingTotalDebt)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
