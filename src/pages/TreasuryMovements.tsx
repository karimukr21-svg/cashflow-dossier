import { useEffect, useState } from 'react'
import { fetchActuals, fetchForecasts } from '@/lib/queries'
import { fmt, classNum } from '@/lib/format'
import type { Scope } from './Dossier'

type Row = {
  area: string
  receivedActual: number
  receivedForecast: number
  receivedTotal: number
  sentActual: number
  sentForecast: number
  sentTotal: number
  net: number
}

export default function TreasuryMovements({ scope }: { scope: Scope }) {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [asOf, setAsOf] = useState<string>('')

  useEffect(() => {
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        // Find line_codes for Receipts/Within Group/Treasury and Payments/Within Group/Treasury
        const receiveLine = scope.lines.find(l =>
          l.nature === 'Receipts' && l.category === 'Within Group' && l.description === 'Treasury')?.line_code
        const sendLine = scope.lines.find(l =>
          l.nature === 'Payments' && l.category === 'Within Group' && l.description === 'Treasury')?.line_code

        const [actuals, forecasts] = await Promise.all([
          fetchActuals({
            fromYear: scope.fromYear, fromMonth: scope.fromMonth,
            toYear: scope.toYear, toMonth: scope.toMonth,
          }),
          fetchForecasts({
            version: scope.primaryVersion,
            fromYear: scope.fromYear, fromMonth: scope.fromMonth,
            toYear: scope.toYear, toMonth: scope.toMonth,
          }),
        ])
        if (cancel) return

        const map = new Map<string, Row>()
        const get = (areaId: string, label: string) => {
          if (!map.has(areaId)) map.set(areaId, {
            area: label, receivedActual: 0, receivedForecast: 0, receivedTotal: 0,
            sentActual: 0, sentForecast: 0, sentTotal: 0, net: 0,
          })
          return map.get(areaId)!
        }

        actuals.forEach(c => {
          const ca = scope.cfToCanonical.get(c.area); if (!ca) return
          const r = get(ca.area_id, ca.display_name)
          if (c.line_code === receiveLine) r.receivedActual += c.value
          if (c.line_code === sendLine) r.sentActual += c.value
        })
        forecasts.forEach(c => {
          const ca = scope.cfToCanonical.get(c.area); if (!ca) return
          const r = get(ca.area_id, ca.display_name)
          if (c.line_code === receiveLine) r.receivedForecast += c.value
          if (c.line_code === sendLine) r.sentForecast += c.value
        })
        // Sent values are stored negative — flip sign for display ("how much sent")
        map.forEach(r => {
          r.sentActual = -r.sentActual
          r.sentForecast = -r.sentForecast
          r.receivedTotal = r.receivedActual + r.receivedForecast
          r.sentTotal = r.sentActual + r.sentForecast
          r.net = r.receivedTotal - r.sentTotal
        })

        // Sort by canonical order so Operations → Subsidiaries → Area Items
        const areaOrder = new Map(scope.areas.map((a, i) => [a.display_name, i]))
        const arr = [...map.values()]
          .filter(r => Math.abs(r.receivedTotal) + Math.abs(r.sentTotal) > 0.5)
          .sort((a, b) => (areaOrder.get(a.area) ?? 99) - (areaOrder.get(b.area) ?? 99))
        setRows(arr)

        // As-of for caption
        const a = actuals.reduce((m, c) => Math.max(m, c.year * 100 + c.month), 0)
        if (a) setAsOf(`${Math.floor(a/100)}-${String(a%100).padStart(2,'0')}`)
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [scope.primaryVersion, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth, scope.lines])

  if (loading) return <div className="placeholder-box">Loading…</div>

  const total = rows.reduce((acc, r) => ({
    receivedActual: acc.receivedActual + r.receivedActual,
    receivedForecast: acc.receivedForecast + r.receivedForecast,
    receivedTotal: acc.receivedTotal + r.receivedTotal,
    sentActual: acc.sentActual + r.sentActual,
    sentForecast: acc.sentForecast + r.sentForecast,
    sentTotal: acc.sentTotal + r.sentTotal,
    net: acc.net + r.net,
  }), { receivedActual: 0, receivedForecast: 0, receivedTotal: 0,
        sentActual: 0, sentForecast: 0, sentTotal: 0, net: 0 })

  return (
    <div>
      <h1>Treasury Movements</h1>
      <div className="sub">
        Period {scope.fromYear}-{String(scope.fromMonth).padStart(2,'0')} → {scope.toYear}-{String(scope.toMonth).padStart(2,'0')}
        {' · '}Actual through {asOf || '—'}
        {' · '}Forecast version <b>{scope.primaryVersion}</b>
        {' · USD K'}
      </div>

      <table className="cf-table">
        <thead>
          <tr>
            <th className="label">Area</th>
            <th>Received Actual</th>
            <th>Received Forecast</th>
            <th>Received Total</th>
            <th>Sent Actual</th>
            <th>Sent Forecast</th>
            <th>Sent Total</th>
            <th>Net (Recv − Sent)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.area}>
              <td className="label">{r.area}</td>
              <td className={classNum(r.receivedActual)}>{fmt(r.receivedActual)}</td>
              <td className={classNum(r.receivedForecast)}>{fmt(r.receivedForecast)}</td>
              <td className={classNum(r.receivedTotal)}>{fmt(r.receivedTotal)}</td>
              <td className={classNum(r.sentActual)}>{fmt(r.sentActual)}</td>
              <td className={classNum(r.sentForecast)}>{fmt(r.sentForecast)}</td>
              <td className={classNum(r.sentTotal)}>{fmt(r.sentTotal)}</td>
              <td className={classNum(r.net)}>{fmt(r.net)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="total">
            <td className="label">Group total</td>
            <td className={classNum(total.receivedActual)}>{fmt(total.receivedActual)}</td>
            <td className={classNum(total.receivedForecast)}>{fmt(total.receivedForecast)}</td>
            <td className={classNum(total.receivedTotal)}>{fmt(total.receivedTotal)}</td>
            <td className={classNum(total.sentActual)}>{fmt(total.sentActual)}</td>
            <td className={classNum(total.sentForecast)}>{fmt(total.sentForecast)}</td>
            <td className={classNum(total.sentTotal)}>{fmt(total.sentTotal)}</td>
            <td className={classNum(total.net)}>{fmt(total.net)}</td>
          </tr>
        </tfoot>
      </table>

      <p style={{ fontSize: 12, color: 'var(--mute)', marginTop: 12 }}>
        Treasury inflows = Within Group / Treasury receipts. Outflows = Within Group / Treasury payments (shown as positive "Sent" magnitude). Net &gt; 0 means area is a net receiver of treasury support; Net &lt; 0 means net sender.
      </p>
    </div>
  )
}
