import { useEffect, useState } from 'react'
import { fetchActuals, fetchForecasts } from '@/lib/queries'
import { fmt, classNum } from '@/lib/format'
import type { Scope } from './Dossier'

type Row = {
  area: string;
  receiptsActual: number; receiptsForecast: number;
  paymentsActual: number; paymentsForecast: number;
  netActual: number; netForecast: number; netTotal: number;
}

export default function Operations({ scope }: { scope: Scope }) {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const operLines = new Set(scope.lines.filter(l => l.category === 'Operation').map(l => l.line_code))

        const [actuals, forecasts] = await Promise.all([
          fetchActuals({ fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth }),
          fetchForecasts({ version: scope.primaryVersion, fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth }),
        ])
        if (cancel) return

        const lineKindMap = new Map(scope.lines.map(l => [l.line_code, l.nature]))
        const map = new Map<string, Row>()
        const get = (areaId: string, label: string) => {
          if (!map.has(areaId)) map.set(areaId, {
            area: label, receiptsActual: 0, receiptsForecast: 0,
            paymentsActual: 0, paymentsForecast: 0,
            netActual: 0, netForecast: 0, netTotal: 0,
          })
          return map.get(areaId)!
        }

        actuals.forEach(c => {
          if (!operLines.has(c.line_code)) return
          const ca = scope.cfToCanonical.get(c.area); if (!ca) return
          const r = get(ca.area_id, ca.display_name)
          const kind = lineKindMap.get(c.line_code)
          if (kind === 'Receipts') r.receiptsActual += c.value
          else if (kind === 'Payments') r.paymentsActual += c.value
        })
        forecasts.forEach(c => {
          if (!operLines.has(c.line_code)) return
          const ca = scope.cfToCanonical.get(c.area); if (!ca) return
          const r = get(ca.area_id, ca.display_name)
          const kind = lineKindMap.get(c.line_code)
          if (kind === 'Receipts') r.receiptsForecast += c.value
          else if (kind === 'Payments') r.paymentsForecast += c.value
        })
        map.forEach(r => {
          r.netActual = r.receiptsActual + r.paymentsActual
          r.netForecast = r.receiptsForecast + r.paymentsForecast
          r.netTotal = r.netActual + r.netForecast
        })

        /* Sort by canonical group_name then sort_order so the table reads
         * Operations → Subsidiaries → Area Items (Corporate) → Contingency. */
        const areaOrder = new Map(scope.areas.map((a, i) => [a.display_name, i]))
        const arr = [...map.values()]
          .filter(r => Math.abs(r.receiptsActual + r.receiptsForecast + r.paymentsActual + r.paymentsForecast) > 0.5)
          .sort((a, b) => (areaOrder.get(a.area) ?? 99) - (areaOrder.get(b.area) ?? 99))
        setRows(arr)
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [scope.primaryVersion, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth, scope.lines])

  if (loading) return <div className="placeholder-box">Loading…</div>

  const t = rows.reduce((a, r) => ({
    receiptsActual: a.receiptsActual + r.receiptsActual,
    receiptsForecast: a.receiptsForecast + r.receiptsForecast,
    paymentsActual: a.paymentsActual + r.paymentsActual,
    paymentsForecast: a.paymentsForecast + r.paymentsForecast,
    netActual: a.netActual + r.netActual,
    netForecast: a.netForecast + r.netForecast,
    netTotal: a.netTotal + r.netTotal,
  }), { receiptsActual: 0, receiptsForecast: 0, paymentsActual: 0, paymentsForecast: 0,
        netActual: 0, netForecast: 0, netTotal: 0 })

  return (
    <div>
      <h1>Operations</h1>
      <div className="sub">
        Operating Receipts vs Payments by area. Net &gt; 0 = self-sustaining operating cash; Net &lt; 0 = needs funding.
        {' · '}Period {scope.fromYear}-{String(scope.fromMonth).padStart(2,'0')} → {scope.toYear}-{String(scope.toMonth).padStart(2,'0')}
        {' · '}USD K
      </div>

      <table className="cf-table">
        <thead>
          <tr>
            <th className="label">Area</th>
            <th>Receipts Actual</th>
            <th>Receipts Forecast</th>
            <th>Payments Actual</th>
            <th>Payments Forecast</th>
            <th>Net Actual</th>
            <th>Net Forecast</th>
            <th>Net Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.area}>
              <td className="label">{r.area}</td>
              <td className={classNum(r.receiptsActual)}>{fmt(r.receiptsActual)}</td>
              <td className={classNum(r.receiptsForecast)}>{fmt(r.receiptsForecast)}</td>
              <td className={classNum(r.paymentsActual)}>{fmt(r.paymentsActual)}</td>
              <td className={classNum(r.paymentsForecast)}>{fmt(r.paymentsForecast)}</td>
              <td className={classNum(r.netActual)}>{fmt(r.netActual)}</td>
              <td className={classNum(r.netForecast)}>{fmt(r.netForecast)}</td>
              <td className={classNum(r.netTotal)}>{fmt(r.netTotal)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="total">
            <td className="label">Group total</td>
            <td className={classNum(t.receiptsActual)}>{fmt(t.receiptsActual)}</td>
            <td className={classNum(t.receiptsForecast)}>{fmt(t.receiptsForecast)}</td>
            <td className={classNum(t.paymentsActual)}>{fmt(t.paymentsActual)}</td>
            <td className={classNum(t.paymentsForecast)}>{fmt(t.paymentsForecast)}</td>
            <td className={classNum(t.netActual)}>{fmt(t.netActual)}</td>
            <td className={classNum(t.netForecast)}>{fmt(t.netForecast)}</td>
            <td className={classNum(t.netTotal)}>{fmt(t.netTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
