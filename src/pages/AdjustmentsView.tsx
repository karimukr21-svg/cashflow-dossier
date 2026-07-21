import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '@/lib/supabase'
import { useRole, canManageCashFlow } from '@/lib/role'
import { makeDisp, DENOM, type Denom, useTopbarExtras } from '@/lib/displayFmt'
import type { Scope } from './Dossier'

/* Adjustments — a Cash Flow lens showing WHAT was changed on the selected
 * version versus the faithful area files. It reads the adjustment ledger
 * (cf_adjustment_actions + cf_adjustment_legs) for scope.primaryVersion.
 *
 * ORIG has no adjustments (empty state). ADJ shows Tony's edits: one card per
 * ACTION (Adjust / Reclass / Reschedule), grouped by area, as a per-line ×
 * per-month table with a per-line and per-area net. The note sits to the right
 * of each adjustment and is editable in place (super-admin write, RLS-gated). */

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

/* Balance (STOCK) lines. These carry a level forward month to month, so their legs must
 * never be summed along the month axis — see the isStock/stockLevel notes below. */
const STOCK_LINES = new Set(['opening_balance', 'ending_balance', 'accum_loans', 'accum_od'])

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monLabel = (m: number, y: number) => `${MON[m - 1] || '?'} ’${String(y).slice(2)}`

const TYPE_LABEL: Record<Action['action_type'], string> = {
  adjust: 'Adjust', reclass: 'Reclass', reschedule: 'Reschedule', import: 'Import',
}

export default function AdjustmentsView({ scope }: { scope: Scope }) {
  const role = useRole()
  const canManage = canManageCashFlow(role)

  const [actions, setActions] = useState<Action[]>([])
  const [legs, setLegs] = useState<Leg[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Editable notes — draft per action, saved on blur against the original.
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({})
  const original = useRef<Record<string, string>>({})
  const [savedId, setSavedId] = useState<string | null>(null)

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
      const nd: Record<string, string> = {}
      for (const a of acts) nd[a.id] = a.note ?? ''
      setNoteDraft(nd); original.current = { ...nd }
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

  const saveNote = async (id: string) => {
    const val = noteDraft[id] ?? ''
    if (val === (original.current[id] ?? '')) return
    const { error } = await supabase
      .from('cf_adjustment_actions')
      .update({ note: val === '' ? null : val })
      .eq('id', id)
    if (!error) {
      original.current[id] = val
      setSavedId(id)
      setTimeout(() => setSavedId(s => (s === id ? null : s)), 1600)
    } else {
      setErr(error.message)
    }
  }

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

  const byArea = useMemo(() => {
    const m = new Map<string, Action[]>()
    for (const a of actions) {
      const arr = m.get(a.area) ?? []
      arr.push(a); m.set(a.area, arr)
    }
    return [...m.entries()]
  }, [actions])

  // STOCK vs FLOW.
  // opening/ending balance and accumulated loans/overdrafts are STOCKS. A balance
  // adjustment is a LEVEL shift that is carried forward across every month, so summing it
  // down the month axis double-counts: the CC(UE) +783k opening anchor booked Jan..Dec on
  // both opening and ending reads 18,792k if you add the legs up, when the actual effect
  // is a single +783k re-levelling.
  // So: stocks never contribute to a cash net (they are not cash flows), and a stock row
  // reports its level at the latest period instead of a sum.
  const isStock = (lc: string) => STOCK_LINES.has(lc)
  const flowNet = (ls: Leg[]) =>
    ls.filter(l => !isStock(l.line_code)).reduce((s, l) => s + Number(l.delta_usd || 0), 0)
  const stockLevel = (ls: Leg[]) => {
    if (!ls.length) return 0
    const latest = Math.max(...ls.map(l => l.year * 12 + l.month))
    return ls.filter(l => l.year * 12 + l.month === latest)
      .reduce((s, l) => s + Number(l.delta_usd || 0), 0)
  }

  const areaNet = (area: string) => flowNet(legs.filter(l => l.area === area))
  const groupNet = flowNet(legs)

  // Negatives in parentheses; positives keep a + to read as a delta.
  const signParts = (v: number) => {
    if (Math.abs(v) < 0.5) return { cls: 'zero', txt: '—' }
    if (v < 0) return { cls: 'down', txt: `(${disp(Math.abs(v))})` }
    return { cls: 'up', txt: `+${disp(v)}` }
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

      <div className="adjv-printhead">Adjustments · {version}</div>

      <header className="adjv-head">
        <div className="adjv-head-t">
          <h1>Adjustments</h1>
        </div>
        {!loading && actions.length > 0 && (
          <div className="adjv-grouptotal">
            <span className="adjv-gt-l">Group net adjustment</span>
            <span className={`adjv-gt-v ${gp.cls}`}>{gp.txt}</span>
            <span className="adjv-gt-s">{actions.length} adjustment{actions.length === 1 ? '' : 's'} · {byArea.length} area{byArea.length === 1 ? '' : 's'}</span>
          </div>
        )}
        <button className="adjv-print" onClick={() => window.print()} title="Print / save as PDF">Print</button>
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
                const net = flowNet(al)   // stocks excluded — a re-levelling is not a cash flow
                const neutral = Math.abs(net) < 0.5
                const isMove = a.action_type === 'reclass' || a.action_type === 'reschedule'
                const np = signParts(net)

                const monthMap = new Map<string, { y: number; m: number }>()
                for (const l of al) monthMap.set(`${l.year}-${l.month}`, { y: l.year, m: l.month })
                const months = [...monthMap.values()].sort((x, y) => (x.y - y.y) || (x.m - y.m))

                type Row = { line: string; role: Leg['role']; byMonth: Map<string, number>; net: number; stock: boolean }
                const rowMap = new Map<string, Row>()
                const rowLegs = new Map<string, Leg[]>()
                for (const l of al) {
                  const key = `${l.line_code}|${l.role}`
                  const r = rowMap.get(key) ?? {
                    line: lineDesc(l.line_code), role: l.role, byMonth: new Map(), net: 0,
                    stock: isStock(l.line_code),
                  }
                  const mk = `${l.year}-${l.month}`
                  r.byMonth.set(mk, (r.byMonth.get(mk) ?? 0) + Number(l.delta_usd || 0))
                  rowMap.set(key, r)
                  const rl = rowLegs.get(key) ?? []; rl.push(l); rowLegs.set(key, rl)
                }
                // A stock row's "net" is its LEVEL at the latest period, not a sum of months.
                for (const [key, r] of rowMap) {
                  const ls = rowLegs.get(key) ?? []
                  r.net = r.stock ? stockLevel(ls)
                                  : ls.reduce((s, l) => s + Number(l.delta_usd || 0), 0)
                }
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
                                <td className={`adjv-num adjv-td-net ${rn.cls}`}>
                                  {rn.txt}
                                  {r.stock && (
                                    <span
                                      className="adjv-leveltag"
                                      title="Balance level carried forward — a stock, not a sum across months"
                                    >level</span>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="adjv-noteedit">
                      <div className="adjv-note-head">
                        <span>Note</span>
                        {savedId === a.id && <span className="adjv-note-saved">Saved</span>}
                      </div>
                      <textarea
                        className="adjv-note-ta"
                        value={noteDraft[a.id] ?? ''}
                        placeholder={canManage ? 'Add a note…' : '—'}
                        readOnly={!canManage}
                        onChange={e => setNoteDraft(d => ({ ...d, [a.id]: e.target.value }))}
                        onBlur={() => canManage && saveNote(a.id)}
                      />
                    </div>

                    {/* Print-only: the note as text below the table (blank notes drop out). */}
                    <p className="adjv-note-print">{noteDraft[a.id] ?? ''}</p>
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
