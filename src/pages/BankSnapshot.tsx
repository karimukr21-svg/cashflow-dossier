import { useEffect, useState } from 'react'
import { fetchBankPositionLatest, type BankPositionRow } from '@/lib/queries'
import { fmt, classNum } from '@/lib/format'

type Pivot = { area: string; cash: number; loans: number; od: number; jvCash: number; blocked: number; net: number }

export default function BankSnapshot() {
  const [rows, setRows] = useState<Pivot[]>([])
  const [period, setPeriod] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const { period, rows } = await fetchBankPositionLatest()
        if (cancel) return
        setPeriod(period)

        // Pivot: area -> { account: balance }
        const map = new Map<string, Pivot>()
        const get = (a: string) => {
          if (!map.has(a)) map.set(a, { area: a, cash: 0, loans: 0, od: 0, jvCash: 0, blocked: 0, net: 0 })
          return map.get(a)!
        }
        rows.forEach((r: BankPositionRow) => {
          const p = get(r.area)
          const acc = r.account.toLowerCase()
          if (acc === 'cash') p.cash += r.balance
          else if (acc === 'loans') p.loans += r.balance
          else if (acc === 'overdrafts') p.od += r.balance
          else if (acc.includes('jv')) p.jvCash += r.balance
          else if (acc.includes('block')) p.blocked += r.balance
        })
        map.forEach(p => { p.net = p.cash + p.loans + p.od })

        setRows([...map.values()].sort((a, b) => a.area.localeCompare(b.area)))
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [])

  if (loading) return <div className="placeholder-box">Loading bank position…</div>

  const t = rows.reduce((acc, r) => ({
    cash: acc.cash + r.cash, loans: acc.loans + r.loans, od: acc.od + r.od,
    jvCash: acc.jvCash + r.jvCash, blocked: acc.blocked + r.blocked, net: acc.net + r.net,
  }), { cash: 0, loans: 0, od: 0, jvCash: 0, blocked: 0, net: 0 })

  return (
    <div>
      <h1>Bank Position</h1>
      <div className="sub">
        Snapshot as of <b>{period}</b>{' · '}USD K{' · '}Loans + OD stored negative.
      </div>

      <div className="kpi-strip">
        <div className="kpi"><div className="l">Cash</div><div className={`v ${classNum(t.cash).split(' ')[1] || ''}`}>{fmt(t.cash)}</div></div>
        <div className="kpi"><div className="l">Loans</div><div className={`v ${classNum(t.loans).split(' ')[1] || ''}`}>{fmt(t.loans)}</div></div>
        <div className="kpi"><div className="l">Overdrafts</div><div className={`v ${classNum(t.od).split(' ')[1] || ''}`}>{fmt(t.od)}</div></div>
        <div className="kpi"><div className="l">Net Funds</div><div className={`v ${classNum(t.net).split(' ')[1] || ''}`}>{fmt(t.net)}</div></div>
      </div>

      <table className="cf-table">
        <thead>
          <tr>
            <th className="label">Area</th>
            <th>Cash</th>
            <th>Loans</th>
            <th>OD</th>
            <th>JV Cash</th>
            <th>Blocked</th>
            <th>Net Funds</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.area}>
              <td className="label">{r.area}</td>
              <td className={classNum(r.cash)}>{fmt(r.cash)}</td>
              <td className={classNum(r.loans)}>{fmt(r.loans)}</td>
              <td className={classNum(r.od)}>{fmt(r.od)}</td>
              <td className={classNum(r.jvCash)}>{fmt(r.jvCash)}</td>
              <td className={classNum(r.blocked)}>{fmt(r.blocked)}</td>
              <td className={classNum(r.net)}>{fmt(r.net)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="total">
            <td className="label">Group total</td>
            <td className={classNum(t.cash)}>{fmt(t.cash)}</td>
            <td className={classNum(t.loans)}>{fmt(t.loans)}</td>
            <td className={classNum(t.od)}>{fmt(t.od)}</td>
            <td className={classNum(t.jvCash)}>{fmt(t.jvCash)}</td>
            <td className={classNum(t.blocked)}>{fmt(t.blocked)}</td>
            <td className={classNum(t.net)}>{fmt(t.net)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
