import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '@/lib/supabase'
import { makeDisp, DENOM, type Denom, useTopbarExtras } from '@/lib/displayFmt'
import type { Scope } from './Dossier'

/* Adjustments (read-only) — a Cash Flow lens showing WHAT was changed on the
 * selected version versus the faithful area files. It reads the adjustment
 * ledger (cf_adjustment_actions + cf_adjustment_legs) for scope.primaryVersion.
 *
 * ORIG has no adjustments (empty state). ADJ shows Tony's edits: one card per
 * ACTION (Adjust / Reclass / Reschedule), grouped by area, with its signed USD
 * legs, a per-area net, and a group total. A balanced action (legs sum to 0) is
 * a cash-neutral reclass/reschedule; otherwise the net is the cash change.
 *
 * Editing lives in the "Adjust" module — this surface is read-only. */

type Action = {
  id: string
  base_version: string
  area: string
  action_type: 'adjust' | 'reclass' | 'reschedule' | 'import'
  intent: 'set' | 'add'
  input_amount: number | null
  note: string | null
  actor: string | null
  created_at: string
}
type Leg = {
  action_id: string
  area: string
  line_code: string
  year: number
  month: number
  delta_usd: number
  role: 'single' | 'from' | 'to'
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monLabel = (m: number, y: number) => `${MON[m - 1] || '?'} ’${String(y).slice(2)}`

const TYPE_LABEL: Record<Action['action_type'], string> = {
  adjust: 'Adjust', reclass: 'Reclass', reschedule: 'Reschedule', import: 'Import',
}

export default function AdjustmentsView({ scope }: { scope: Scope }) {
  const [actions, setActions] = useState<Action[]>([])
  const [legs, setLegs] = useState<Leg[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const version = scope.primaryVersion

  // Denomination toggle (Millions / '000 / Units), portaled into the top bar.
  const [denom, setDenom] = useState<Denom>(() => (localStorage.getItem('dossier-adj-denom-v1') as Denom) || 'u')
  useEffect(() => { try { localStorage.setItem('dossier-adj-denom-v1', denom) } catch { /* ignore */ } }, [denom])
  const disp = useMemo(() => makeDisp(1, denom), [denom])
  const slot = useTopbarExtras()

  useEffect(() => {
    let alive = true
    setLoading(true); setErr(null)
    ;(async () => {
      const act = await supabase
        .from('cf_adjustment_actions')
        .select('id, base_version, area, action_type, intent, input_amount, note, actor, created_at')
        .eq('base_version', version)
        .eq('is_active', true)
        .order('area')
      if (!alive) return
      if (act.error) { setErr(act.error.message); setLoading(false); return }
      const acts = (act.data ?? []) as Action[]
      setActions(acts)
      if (acts.length === 0) { setLegs([]); setLoading(false); return }
      const lg = await supabase
        .from('cf_adjustment_legs')
        .select('action_id, area, line_code, year, month, delta_usd, role')
        .in('action_id', acts.map(a => a.id))
      if (!alive) return
      if (lg.error) { setErr(lg.error.message); setLoading(false); return }
      setLegs((lg.data ?? []) as Leg[])
      setLoading(false)
    })()
    return () => { alive = false }
  }, [version])

  // line_code -> human description
  const lineDesc = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of scope.lines) m.set(l.line_code, l.description)
    return (code: string) => m.get(code) ?? code
  }, [scope.lines])

  const legsByAction = useMemo(() => {
    const m = new Map<string, Leg[]>()
    for (const l of legs) {
      const arr = m.get(l.action_id) ?? []
      arr.push(l); m.set(l.action_id, arr)
    }
    return m
  }, [legs])

  // Group actions by area, preserving the ledger's area sort.
  const byArea = useMemo(() => {
    const m = new Map<string, Action[]>()
    for (const a of actions) {
      const arr = m.get(a.area) ?? []
      arr.push(a); m.set(a.area, arr)
    }
    return [...m.entries()]
  }, [actions])

  const areaNet = (area: string) =>
    legs.filter(l => l.area === area).reduce((s, l) => s + Number(l.delta_usd || 0), 0)
  const groupNet = legs.reduce((s, l) => s + Number(l.delta_usd || 0), 0)

  const signParts = (v: number) => {
    if (Math.abs(v) < 0.5) return { cls: 'zero', txt: '—' }
    return { cls: v > 0 ? 'up' : 'down', txt: (v > 0 ? '+' : '−') + disp(Math.abs(v)) }
  }

  const controls = (
    <>
      <div className="ctrl" style={{ marginLeft: 8 }}><label>Units</label></div>
      <div className="pill-row">
        {(['m', 'k', 'u'] as Denom[]).map(d => (
          <button key={d} className={`pill-btn ${denom === d ? 'active' : ''}`} onClick={() => setDenom(d)}>{DENOM[d].btn}</button>
        ))}
      </div>
    </>
  )

  const gp = signParts(groupNet)

  return (
    <div className="adjv">
      {slot && createPortal(controls, slot)}

      <header className="adjv-head">
        <div className="adjv-head-t">
          <h1>Adjustments</h1>
          <p className="adjv-sub">
            What Treasury changed on <b>{version}</b> versus the faithful area files. Read-only —
            editing lives in the Adjust module.
          </p>
        </div>
        {!loading && actions.length > 0 && (
          <div className="adjv-grouptotal">
            <span className="adjv-gt-l">Group net adjustment</span>
            <span className={`adjv-gt-v ${gp.cls}`}>{gp.txt}</span>
            <span className="adjv-gt-s">{actions.length} adjustment{actions.length === 1 ? '' : 's'} · {byArea.length} area{byArea.length === 1 ? '' : 's'}</span>
          </div>
        )}
      </header>

      {err && <div className="adjv-err">Couldn’t load the adjustment ledger: {err}</div>}
      {loading && <div className="adjv-empty">Loading…</div>}

      {!loading && !err && actions.length === 0 && (
        <div className="adjv-none">
          <div className="adjv-none-mark">✓</div>
          <div>
            <h2>No adjustments on this version</h2>
            <p>
              <b>{version}</b> is a faithful extraction of the area files — nothing has been
              re-stated. Adjustments are recorded on the Adjusted (ADJ) version.
            </p>
          </div>
        </div>
      )}

      {!loading && !err && byArea.map(([area, acts]) => {
        const an = signParts(areaNet(area))
        return (
          <section className="adjv-area" key={area}>
            <div className="adjv-area-head">
              <h2>{area}</h2>
              <span className="adjv-area-net">
                Net <b className={an.cls}>{an.txt}</b>
              </span>
            </div>
            <div className="adjv-cards">
              {acts.map(a => {
                const al = legsByAction.get(a.id) ?? []
                const net = al.reduce((s, l) => s + Number(l.delta_usd || 0), 0)
                const neutral = Math.abs(net) < 0.5
                const isMove = a.action_type === 'reclass' || a.action_type === 'reschedule'
                const np = signParts(net)

                // Column set = the union of months across the action's legs.
                const monthMap = new Map<string, { y: number; m: number }>()
                for (const l of al) monthMap.set(`${l.year}-${l.month}`, { y: l.year, m: l.month })
                const months = [...monthMap.values()].sort((x, y) => (x.y - y.y) || (x.m - y.m))

                // Rows = one per (line, role). Reclass/reschedule surface a From/To
                // tag; a plain Adjust has no tag. Each cell is that month's signed delta.
                type Row = { line: string; role: Leg['role']; byMonth: Map<string, number>; net: number }
                const rowMap = new Map<string, Row>()
                for (const l of al) {
                  const key = `${l.line_code}|${l.role}`
                  const r = rowMap.get(key) ?? { line: lineDesc(l.line_code), role: l.role, byMonth: new Map(), net: 0 }
                  const mk = `${l.year}-${l.month}`
                  r.byMonth.set(mk, (r.byMonth.get(mk) ?? 0) + Number(l.delta_usd || 0))
                  r.net += Number(l.delta_usd || 0)
                  rowMap.set(key, r)
                }
                // From-rows first (the source), then To, then singles.
                const roleRank = { from: 0, to: 1, single: 2 } as const
                const rows = [...rowMap.values()].sort((x, y) => roleRank[x.role] - roleRank[y.role])

                const fromLines = [...new Set(al.filter(l => l.role === 'from').map(l => lineDesc(l.line_code)))]
                const toLines = [...new Set(al.filter(l => l.role === 'to').map(l => lineDesc(l.line_code)))]

                return (
                  <article className="adjv-card" key={a.id}>
                    <div className="adjv-card-top">
                      <span className={`adjv-type adjv-type--${a.action_type}`}>{TYPE_LABEL[a.action_type]}</span>
                      {isMove && fromLines.length > 0 && (
                        <span className="adjv-headline">
                          {fromLines.join(', ')} <span className="adjv-arrow">→</span> {toLines.join(', ')}
                        </span>
                      )}
                      <span className={`adjv-cash ${neutral ? 'neutral' : np.cls}`}>
                        {neutral ? 'Cash-neutral' : `Cash ${np.txt}`}
                      </span>
                    </div>

                    <div className="adjv-tablewrap">
                      <table className="adjv-table">
                        <thead>
                          <tr>
                            <th className="adjv-th-line">Line</th>
                            {months.map((mm, i) => <th key={i} className="adjv-num">{monLabel(mm.m, mm.y)}</th>)}
                            <th className="adjv-num adjv-th-net">Net</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, ri) => {
                            const rn = signParts(r.net)
                            return (
                              <tr key={ri}>
                                <td className="adjv-td-line">
                                  {isMove && <span className={`adjv-roletag adjv-roletag--${r.role}`}>{r.role === 'from' ? 'From' : r.role === 'to' ? 'To' : ''}</span>}
                                  {r.line}
                                </td>
                                {months.map((mm, ci) => {
                                  const v = r.byMonth.get(`${mm.y}-${mm.m}`)
                                  if (v === undefined) return <td key={ci} className="adjv-num adjv-blank">·</td>
                                  const sp = signParts(v)
                                  return <td key={ci} className={`adjv-num ${sp.cls}`}>{sp.txt}</td>
                                })}
                                <td className={`adjv-num adjv-td-net ${rn.cls}`}>{rn.txt}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    {a.note && <p className="adjv-note"><span className="adjv-note-lbl">Why</span>{a.note}</p>}
                  </article>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
