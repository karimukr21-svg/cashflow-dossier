import { useEffect, useState } from 'react'
import { fetchActuals, fetchForecasts, fetchBankPositionLatest } from '@/lib/queries'
import { fmt, classNum } from '@/lib/format'
import type { Scope } from './Dossier'

type Totals = {
  receiptsAct: number; receiptsFct: number;
  paymentsAct: number; paymentsFct: number;
  netAct: number; netFct: number;
}

type AreaRow = {
  area: string;
  receiptsTotal: number;
  paymentsTotal: number;
  net: number;
}

export default function Overall({ scope }: { scope: Scope }) {
  const [totals, setTotals] = useState<Totals | null>(null)
  const [topNet, setTopNet] = useState<AreaRow[]>([])
  const [bank, setBank] = useState<{ period: string; cash: number; loans: number; od: number; net: number } | null>(null)
  const [reconStatus, setReconStatus] = useState<{ ok: number; bad: number; rows: { area: string; year: number; delta: number }[] }>({ ok: 0, bad: 0, rows: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const [actuals, forecasts, bp] = await Promise.all([
          fetchActuals({ fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth }),
          fetchForecasts({ version: scope.primaryVersion, fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth }),
          fetchBankPositionLatest(),
        ])
        if (cancel) return

        const lineKind = new Map(scope.lines.map(l => [l.line_code, l.nature]))
        let t: Totals = { receiptsAct: 0, receiptsFct: 0, paymentsAct: 0, paymentsFct: 0, netAct: 0, netFct: 0 }
        const perArea = new Map<string, AreaRow>()
        const getArea = (areaId: string, label: string) => {
          if (!perArea.has(areaId)) perArea.set(areaId, { area: label, receiptsTotal: 0, paymentsTotal: 0, net: 0 })
          return perArea.get(areaId)!
        }

        actuals.forEach(c => {
          const k = lineKind.get(c.line_code)
          const ca = scope.cfToCanonical.get(c.area); if (!ca) return
          const r = getArea(ca.area_id, ca.display_name)
          if (k === 'Receipts') { t.receiptsAct += c.value; r.receiptsTotal += c.value }
          else if (k === 'Payments') { t.paymentsAct += c.value; r.paymentsTotal += c.value }
        })
        forecasts.forEach(c => {
          const k = lineKind.get(c.line_code)
          const ca = scope.cfToCanonical.get(c.area); if (!ca) return
          const r = getArea(ca.area_id, ca.display_name)
          if (k === 'Receipts') { t.receiptsFct += c.value; r.receiptsTotal += c.value }
          else if (k === 'Payments') { t.paymentsFct += c.value; r.paymentsTotal += c.value }
        })
        t.netAct = t.receiptsAct + t.paymentsAct
        t.netFct = t.receiptsFct + t.paymentsFct
        perArea.forEach(r => { r.net = r.receiptsTotal + r.paymentsTotal })
        setTotals(t)

        const arr = [...perArea.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
        setTopNet(arr.slice(0, 6))

        // Bank position summary
        const cash = bp.rows.filter(r => r.account.toLowerCase() === 'cash').reduce((s, r) => s + r.balance, 0)
        const loans = bp.rows.filter(r => r.account.toLowerCase() === 'loans').reduce((s, r) => s + r.balance, 0)
        const od = bp.rows.filter(r => r.account.toLowerCase() === 'overdrafts').reduce((s, r) => s + r.balance, 0)
        setBank({ period: bp.period, cash, loans, od, net: cash + loans + od })

        /* Reconciliation pass — per (cf_area, year). Done at the cf-area
         * grain because that's where the opening/ending balance integrity
         * applies, then display labels resolve through cfToCanonical. */
        const openingByAreaYear = new Map<string, number>()
        const closingByAreaYear = new Map<string, { val: number; ym: number }>()
        const flowsByAreaYear = new Map<string, number>()
        actuals.forEach(c => {
          const k = `${c.area}|${c.year}`
          if (c.line_code === 'opening_balance' && c.month === 1) openingByAreaYear.set(k, c.value)
          if (c.line_code === 'ending_balance') {
            const cur = closingByAreaYear.get(k)
            const ym = c.year * 100 + c.month
            if (!cur || ym > cur.ym) closingByAreaYear.set(k, { val: c.value, ym })
          }
          const kind = lineKind.get(c.line_code)
          if (kind === 'Receipts' || kind === 'Payments') {
            flowsByAreaYear.set(k, (flowsByAreaYear.get(k) || 0) + c.value)
          }
        })
        let ok = 0, bad = 0
        const badRows: { area: string; year: number; delta: number }[] = []
        openingByAreaYear.forEach((opening, k) => {
          const closing = closingByAreaYear.get(k)
          const flow = flowsByAreaYear.get(k) || 0
          if (closing == null) return
          const delta = (opening + flow) - closing.val
          if (Math.abs(delta) <= 1) ok += 1
          else {
            bad += 1
            const [cfArea, y] = k.split('|')
            const ca = scope.cfToCanonical.get(cfArea)
            if (ca) badRows.push({ area: ca.display_name, year: +y, delta })
          }
        })
        setReconStatus({ ok, bad, rows: badRows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5) })
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [scope.primaryVersion, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth, scope.lines])

  if (loading) return <div className="placeholder-box">Loading…</div>

  return (
    <div>
      <h1>Overall</h1>

      {/* Group KPI strip */}
      {totals && (
        <div className="kpi-strip">
          <div className="kpi">
            <div className="l">Receipts (Act + Fct)</div>
            <div className={`v ${classNum(totals.receiptsAct + totals.receiptsFct).split(' ')[1] || ''}`}>{fmt(totals.receiptsAct + totals.receiptsFct)}</div>
            <div className="d">Act {fmt(totals.receiptsAct)} · Fct {fmt(totals.receiptsFct)}</div>
          </div>
          <div className="kpi">
            <div className="l">Payments (Act + Fct)</div>
            <div className={`v ${classNum(totals.paymentsAct + totals.paymentsFct).split(' ')[1] || ''}`}>{fmt(totals.paymentsAct + totals.paymentsFct)}</div>
            <div className="d">Act {fmt(totals.paymentsAct)} · Fct {fmt(totals.paymentsFct)}</div>
          </div>
          <div className="kpi">
            <div className="l">Net (Period)</div>
            <div className={`v ${classNum(totals.netAct + totals.netFct).split(' ')[1] || ''}`}>{fmt(totals.netAct + totals.netFct)}</div>
            <div className="d">Act {fmt(totals.netAct)} · Fct {fmt(totals.netFct)}</div>
          </div>
          {bank && (
            <div className="kpi">
              <div className="l">Net Funds (live)</div>
              <div className={`v ${classNum(bank.net).split(' ')[1] || ''}`}>{fmt(bank.net)}</div>
              <div className="d">As of {bank.period}</div>
            </div>
          )}
        </div>
      )}

      <div className="two-col">
        <div className="bp-card">
          <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 500 }}>Top 6 areas by absolute net flow</h3>
          <table className="cf-table">
            <thead>
              <tr><th className="label">Area</th><th>Receipts</th><th>Payments</th><th>Net</th></tr>
            </thead>
            <tbody>
              {topNet.map(r => (
                <tr key={r.area}>
                  <td className="label">{r.area}</td>
                  <td className={classNum(r.receiptsTotal)}>{fmt(r.receiptsTotal)}</td>
                  <td className={classNum(r.paymentsTotal)}>{fmt(r.paymentsTotal)}</td>
                  <td className={classNum(r.net)}>{fmt(r.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bp-card">
          <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 500 }}>Reconciliation status</h3>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <span className="pill ok">{reconStatus.ok} ties</span>
            <span className="pill bad">{reconStatus.bad} off</span>
          </div>
          {reconStatus.bad > 0 ? (
            <table className="cf-table">
              <thead>
                <tr><th className="label">Area</th><th>Year</th><th>Δ</th></tr>
              </thead>
              <tbody>
                {reconStatus.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="label">{r.area}</td>
                    <td>{r.year}</td>
                    <td className={classNum(r.delta)}>{fmt(r.delta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--mute)' }}>All area-years in scope reconcile within tolerance.</div>
          )}
        </div>
      </div>
    </div>
  )
}
