import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'

/* Adjustments — the Manage-module home for Treasury's edits to the ADJUSTED
 * forecast. The editable ledger (cf_adjustment_actions + cf_adjustment_legs)
 * and the computed view (v_cf_adjusted = materialized ADJ + Σ active legs) are
 * LIVE in the database. This panel reads them read-only for now; the full
 * Adjust / Reclass / Reschedule editor is the next build.
 *
 * Model (one primitive, three friendly verbs):
 *   Adjust      — change one number (a correction or an addition)
 *   Reclass     — move an amount to another line, same month
 *   Reschedule  — push an amount forward/back to another month, same line
 * Each gesture is one ACTION whose signed USD LEGS land in the ledger with
 * who/when/why — that ledger is both the audit trail and the drift report.
 */

type AdjRow = {
  base_version: string
  area: string
  value_usd: number
  delta_usd: number
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(n))

export default function AdjustmentsPanel({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<AdjRow[]>([])
  const [actions, setActions] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      const [adj, act] = await Promise.all([
        supabase.from('v_cf_adjusted').select('base_version, area, value_usd, delta_usd'),
        supabase.from('cf_adjustment_actions').select('id', { count: 'exact', head: true }).eq('is_active', true),
      ])
      if (!alive) return
      if (adj.error) { setErr(adj.error.message); setLoading(false); return }
      setRows((adj.data ?? []) as AdjRow[])
      setActions(act.count ?? 0)
      setLoading(false)
    })()
    return () => { alive = false }
  }, [])

  const byArea = useMemo(() => {
    const m = new Map<string, { value: number; adjusted: number }>()
    for (const r of rows) {
      const e = m.get(r.area) ?? { value: 0, adjusted: 0 }
      e.value += Number(r.value_usd) || 0
      e.adjusted += Number(r.delta_usd) || 0
      m.set(r.area, e)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [rows])

  const version = rows[0]?.base_version ?? 'APR2026-ADJ'

  return (
    <div className="cfm-body">
      <div className="adj-intro">
        <h3>Adjustments editor <span className="adj-soon">next build</span></h3>
        <p>
          Treasury edits the <b>adjusted forecast</b> here instead of in Excel — one primitive,
          three verbs, a full audit trail. The ledger and the computed adjusted view are already
          live in the database; the editing surface lands next.
        </p>
        <div className="adj-verbs">
          <div className="adj-verb"><b>Adjust</b><span>change one number — a correction or an addition</span></div>
          <div className="adj-verb"><b>Reclass</b><span>move an amount to another line, same month</span></div>
          <div className="adj-verb"><b>Reschedule</b><span>push an amount forward or back to another month</span></div>
        </div>
      </div>

      <div className="adj-status">
        <span className="adj-pill">Version <b>{version}</b></span>
        <span className="adj-pill">Adjustments logged <b>{loading ? '…' : actions}</b></span>
        <span className="adj-pill">
          {canManage ? 'You can edit once the surface ships' : 'Read-only — Treasury role required'}
        </span>
      </div>

      {err && <div className="adj-err">Couldn’t load adjusted figures: {err}</div>}

      <div className="adj-tablewrap">
        <table className="adj-table">
          <thead>
            <tr><th>Area</th><th>Adjusted forecast (USD)</th><th>Net adjustment vs base (USD)</th></tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={3} className="adj-empty">Loading…</td></tr>}
            {!loading && byArea.map(([area, e]) => (
              <tr key={area}>
                <td>{area}</td>
                <td className="adj-num">{fmt(e.value)}</td>
                <td className={`adj-num ${e.adjusted > 0.5 ? 'up' : e.adjusted < -0.5 ? 'down' : 'zero'}`}>
                  {Math.abs(e.adjusted) < 0.5 ? '—' : (e.adjusted > 0 ? '+' : '−') + fmt(Math.abs(e.adjusted))}
                </td>
              </tr>
            ))}
            {!loading && byArea.length === 0 && <tr><td colSpan={3} className="adj-empty">No adjusted figures found.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
