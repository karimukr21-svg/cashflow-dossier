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
 * Shape: a SUMMARY layer first — a before → adjustments → after bridge on the
 * cycle year, then the movement broken down by category and by area — and the
 * per-action detail below it, collapsed by area so the page opens as one screen
 * rather than a scroll. (It grew to 26 actions / ~245 legs on JUN2026-ADJ, at
 * which point a flat list stops communicating anything.)
 *
 * ORIG has no adjustments (empty state). ADJ shows Tony's edits: one card per
 * ACTION (Adjust / Reclass / Reschedule), as a per-line × per-month table with a
 * per-line and per-area net. The note sits to the right of each adjustment and is
 * editable in place (super-admin write, RLS-gated).
 *
 * PRINT follows the on-screen expand/collapse exactly: collapsed = a one-page
 * summary, "Expand all" = the full document. */

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
/* One aggregated cell of the version: base_usd = the faithful extraction,
 * delta_usd = this version's ledger, value_usd = the two combined. Read from
 * v_cf_adjusted_full so the bridge cannot drift from the ledger below it. */
type VCell = { area: string; line_code: string; month: number; base_usd: number; delta_usd: number; value_usd: number }

/* Balance (STOCK) lines. These carry a level forward month to month, so their legs must
 * never be summed along the month axis — see the isStock/stockLevel notes below. */
const STOCK_LINES = new Set(['opening_balance', 'ending_balance', 'accum_loans', 'accum_od'])

/* Statement order for the category summary. Claims is kept OUT of Operations here
 * (the report folds it in) because a claims re-forecast is usually the single
 * largest adjustment on a cycle and burying it inside Operations hides the driver. */
const CAT_ORDER = ['Operation', 'Claims', 'Interest', 'Non Operational', 'Within Group', 'Bank Financing']

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
  const [cells, setCells] = useState<VCell[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Editable notes — draft per action, saved on blur against the original.
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({})
  const original = useRef<Record<string, string>>({})
  const [savedId, setSavedId] = useState<string | null>(null)

  // Detail is collapsed by area — the page opens on the summary.
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const version = scope.primaryVersion
  const meta = useMemo(
    () => scope.versions.find(v => v.version_code === version),
    [scope.versions, version])
  const cycleYear = meta?.cycle_year ?? scope.toYear
  // Elapsed vs forecast boundary — the version's own as-of month.
  const asOfMonth = meta?.as_of_date ? Number(meta.as_of_date.slice(5, 7)) : 12

  // Denomination toggle (Millions / '000 / Units), portaled into the top bar.
  const [denom, setDenom] = useState<Denom>(() => (localStorage.getItem('dossier-adj-denom-v1') as Denom) || 'u')
  useEffect(() => { try { localStorage.setItem('dossier-adj-denom-v1', denom) } catch { /* ignore */ } }, [denom])
  const disp = useMemo(() => makeDisp(1, denom), [denom])
  const slot = useTopbarExtras()

  useEffect(() => {
    let alive = true
    setLoading(true); setErr(null); setOpen({})
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
      if (acts.length === 0) { setLegs([]); setCells([]); setLoading(false); return }

      const lg = await supabase
        .from('cf_adjustment_legs')
        .select('action_id, area, line_code, year, month, delta_usd, role')
        .in('action_id', acts.map(a => a.id))
      if (!alive) return
      if (lg.error) { setErr(lg.error.message); setLoading(false); return }
      setLegs((lg.data ?? []) as Leg[])

      // The version's own cells, for the before → after bridge. ~3.5k rows for a
      // full cycle year, so page past PostgREST's 1000-row default rather than
      // silently truncating the bridge (which would still LOOK plausible).
      const PAGE = 1000
      const all: VCell[] = []
      for (let from = 0; ; from += PAGE) {
        const r = await supabase
          .from('v_cf_adjusted_full')
          .select('area, line_code, month, base_usd, delta_usd, value_usd')
          .eq('version', version).eq('year', cycleYear)
          .range(from, from + PAGE - 1)
        if (!alive) return
        if (r.error) { setErr(r.error.message); break }
        const batch = (r.data ?? []) as VCell[]
        all.push(...batch)
        if (batch.length < PAGE) break
      }
      setCells(all)
      setLoading(false)
    })()
    return () => { alive = false }
  }, [version, cycleYear])

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

  const lineCat = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of scope.lines) m.set(l.line_code, l.category)
    return (code: string) => m.get(code) ?? 'Other'
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

  /* ── Summary ─────────────────────────────────────────────────────────────── */

  // Bridge: the version's flow cells, before vs after the ledger.
  const bridge = useMemo(() => {
    let base = 0, delta = 0
    for (const c of cells) {
      if (isStock(c.line_code)) continue
      base += Number(c.base_usd || 0); delta += Number(c.delta_usd || 0)
    }
    return { base, delta, adj: base + delta }
  }, [cells])

  // By category — base and adjusted from the cells, the movement split
  // elapsed vs forecast from the ledger (the same legs the detail renders).
  const byCat = useMemo(() => {
    const m = new Map<string, { base: number; elapsed: number; forecast: number }>()
    const get = (k: string) => {
      let r = m.get(k); if (!r) { r = { base: 0, elapsed: 0, forecast: 0 }; m.set(k, r) }
      return r
    }
    for (const c of cells) {
      if (isStock(c.line_code)) continue
      get(lineCat(c.line_code)).base += Number(c.base_usd || 0)
    }
    for (const l of legs) {
      if (isStock(l.line_code)) continue
      const r = get(lineCat(l.line_code))
      if (l.month <= asOfMonth) r.elapsed += Number(l.delta_usd || 0)
      else r.forecast += Number(l.delta_usd || 0)
    }
    const rank = (k: string) => { const i = CAT_ORDER.indexOf(k); return i < 0 ? 99 : i }
    return [...m.entries()]
      .map(([name, v]) => ({ name, ...v, move: v.elapsed + v.forecast, adj: v.base + v.elapsed + v.forecast }))
      .filter(r => Math.abs(r.base) > 0.5 || Math.abs(r.move) > 0.5)
      .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
  }, [cells, legs, lineCat, asOfMonth])

  // By area — movement only, ranked by size. Areas with no cash movement
  // (pure presentation reclasses) still list, at the bottom, marked neutral.
  const byAreaSum = useMemo(() => {
    const m = new Map<string, { elapsed: number; forecast: number; actions: number }>()
    for (const [area, acts] of byArea) m.set(area, { elapsed: 0, forecast: 0, actions: acts.length })
    for (const l of legs) {
      if (isStock(l.line_code)) continue
      const r = m.get(l.area); if (!r) continue
      if (l.month <= asOfMonth) r.elapsed += Number(l.delta_usd || 0)
      else r.forecast += Number(l.delta_usd || 0)
    }
    return [...m.entries()]
      .map(([area, v]) => ({ area, ...v, net: v.elapsed + v.forecast }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.area.localeCompare(b.area))
  }, [byArea, legs, asOfMonth])

  const maxAreaNet = useMemo(
    () => Math.max(1, ...byAreaSum.map(a => Math.abs(a.net))), [byAreaSum])

  const neutralCount = useMemo(
    () => actions.filter(a => Math.abs(flowNet(legsByAction.get(a.id) ?? [])) < 0.5).length,
    [actions, legsByAction])

  // Balance re-levellings are excluded from every net above — surface them so
  // they are not silently invisible.
  const stockNote = useMemo(() => {
    const st = legs.filter(l => isStock(l.line_code))
    if (!st.length) return null
    const areas = [...new Set(st.map(l => l.area))]
    const byAreaLevel = areas.map(a => stockLevel(st.filter(l => l.area === a && l.line_code === 'opening_balance')))
    const total = byAreaLevel.reduce((s, v) => s + v, 0)
    return { areas, total }
  }, [legs])

  const totals = useMemo(() => {
    const elapsed = legs.filter(l => !isStock(l.line_code) && l.month <= asOfMonth)
      .reduce((s, l) => s + Number(l.delta_usd || 0), 0)
    return { elapsed, forecast: groupNet - elapsed }
  }, [legs, asOfMonth, groupNet])

  /* ── formatting ──────────────────────────────────────────────────────────── */

  // Deltas: negatives in parentheses, positives keep a + to read as a movement.
  const signParts = (v: number) => {
    if (Math.abs(v) < 0.5) return { cls: 'zero', txt: '—' }
    if (v < 0) return { cls: 'down', txt: `(${disp(Math.abs(v))})` }
    return { cls: 'up', txt: `+${disp(v)}` }
  }
  // Levels (base / adjusted): no + prefix — these are positions, not movements.
  const absParts = (v: number) => {
    if (Math.abs(v) < 0.5) return { cls: 'zero', txt: '—' }
    if (v < 0) return { cls: 'down', txt: `(${disp(Math.abs(v))})` }
    return { cls: 'up', txt: disp(v) }
  }

  const allOpen = byArea.length > 0 && byArea.every(([a]) => open[a])
  const toggleAll = () => {
    const next: Record<string, boolean> = {}
    if (!allOpen) for (const [a] of byArea) next[a] = true
    setOpen(next)
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
  const hasData = !loading && !err && actions.length > 0

  return (
    <div className="adjv">
      {slot && createPortal(controls, slot)}

      <div className="adjv-printhead">
        <span className="adjv-ph-t">Adjustments · {version}</span>
        <span className="adjv-ph-s">Net cash movement {cycleYear} · all areas · USD {DENOM[denom].word}</span>
      </div>

      <header className="adjv-head">
        <div className="adjv-head-t">
          <h1>Adjustments</h1>
          <p className="adjv-head-sub">
            What was changed on <b>{version}</b> versus the faithful area files.
          </p>
        </div>
        {hasData && (
          <div className="adjv-grouptotal">
            <span className="adjv-gt-l">Group net adjustment</span>
            <span className={`adjv-gt-v ${gp.cls}`}>{gp.txt}</span>
            <span className="adjv-gt-s">
              {actions.length} adjustment{actions.length === 1 ? '' : 's'} · {byArea.length} area{byArea.length === 1 ? '' : 's'}
              {neutralCount > 0 && <> · {neutralCount} cash-neutral</>}
            </span>
          </div>
        )}
        <button className="adjv-print" onClick={() => window.print()} title="Print / save as PDF — prints what is open below">Print</button>
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

      {hasData && (
        <>
          {/* ── the bridge: before → adjustments → after ── */}
          <section className="adjv-bridge">
            <div className="adjv-br-pt">
              <span className="adjv-br-l">Before adjustments</span>
              <span className={`adjv-br-v ${absParts(bridge.base).cls}`}>{absParts(bridge.base).txt}</span>
              <span className="adjv-br-s">faithful area files</span>
            </div>
            <div className="adjv-br-arrow">
              <span className={signParts(bridge.delta).cls}>{signParts(bridge.delta).txt}</span>
              <i>adjustments</i>
            </div>
            <div className="adjv-br-pt">
              <span className="adjv-br-l">After adjustments</span>
              <span className={`adjv-br-v ${absParts(bridge.adj).cls}`}>{absParts(bridge.adj).txt}</span>
              <span className="adjv-br-s">{version}</span>
            </div>
            <div className="adjv-br-cap">
              Net cash movement · {cycleYear} · all areas
              <span>
                {signParts(totals.elapsed).txt} on actuals (to {MON[asOfMonth - 1]})
                {' · '}
                {signParts(totals.forecast).txt} on forecast
              </span>
            </div>
          </section>

          {/* ── two-up summary: by category | by area ── */}
          <section className="adjv-sum2">
            <div className="adjv-sumcard">
              <h3>By category</h3>
              <table className="adjv-sumtable">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th className="adjv-num">Before</th>
                    <th className="adjv-num">Actuals</th>
                    <th className="adjv-num">Forecast</th>
                    <th className="adjv-num adjv-th-net">After</th>
                  </tr>
                </thead>
                <tbody>
                  {byCat.map(r => {
                    const e = signParts(r.elapsed), f = signParts(r.forecast)
                    return (
                      <tr key={r.name}>
                        <td className="adjv-sum-l">{r.name}</td>
                        <td className={`adjv-num ${absParts(r.base).cls}`}>{absParts(r.base).txt}</td>
                        <td className={`adjv-num ${e.cls}`}>{e.txt}</td>
                        <td className={`adjv-num ${f.cls}`}>{f.txt}</td>
                        <td className={`adjv-num adjv-td-net ${absParts(r.adj).cls}`}>{absParts(r.adj).txt}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="adjv-sum-l">Net</td>
                    <td className={`adjv-num ${absParts(bridge.base).cls}`}>{absParts(bridge.base).txt}</td>
                    <td className={`adjv-num ${signParts(totals.elapsed).cls}`}>{signParts(totals.elapsed).txt}</td>
                    <td className={`adjv-num ${signParts(totals.forecast).cls}`}>{signParts(totals.forecast).txt}</td>
                    <td className={`adjv-num adjv-td-net ${absParts(bridge.adj).cls}`}>{absParts(bridge.adj).txt}</td>
                  </tr>
                </tfoot>
              </table>
              {stockNote && (
                <p className="adjv-sum-foot">
                  Excludes {stockNote.areas.join(', ')} balance re-levelling of{' '}
                  <b>{signParts(stockNote.total).txt}</b> — a stock, carried forward, not a cash flow.
                </p>
              )}
            </div>

            <div className="adjv-sumcard">
              <h3>By area</h3>
              <div className="adjv-arealist">
                {byAreaSum.filter(a => Math.abs(a.net) >= 0.5).map(a => {
                  const n = signParts(a.net)
                  const pct = Math.round((Math.abs(a.net) / maxAreaNet) * 100)
                  return (
                    <button
                      key={a.area}
                      className="adjv-arearow"
                      onClick={() => {
                        setOpen(o => ({ ...o, [a.area]: true }))
                        document.getElementById(`adjv-area-${a.area.replace(/\W+/g, '-')}`)
                          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }}
                      title="Jump to the detail"
                    >
                      <span className="adjv-ar-name">{a.area}</span>
                      <span className="adjv-ar-bar">
                        <i className={n.cls} style={{ width: `${Math.max(pct, 2)}%` }} />
                      </span>
                      <span className={`adjv-ar-v ${n.cls}`}>{n.txt}</span>
                    </button>
                  )
                })}
              </div>
              {/* Areas whose adjustments net to zero carry no cash signal — a full
                * ranked row each is noise, so they collapse to one line. */}
              {byAreaSum.some(a => Math.abs(a.net) < 0.5) && (
                <p className="adjv-sum-foot">
                  <b>Cash-neutral</b> (presentation only):{' '}
                  {byAreaSum.filter(a => Math.abs(a.net) < 0.5).map(a => a.area).join(' · ')}
                </p>
              )}
            </div>
          </section>

          <div className="adjv-detail-head">
            <h3>Detail</h3>
            <span className="adjv-detail-hint">Print shows what is open</span>
            <button className="adjv-expand" onClick={toggleAll}>
              {allOpen ? 'Collapse all' : 'Expand all'}
            </button>
          </div>
        </>
      )}

      {hasData && byArea.map(([area, acts]) => {
        const an = signParts(areaNet(area))
        const isOpen = !!open[area]
        return (
          <section className={`adjv-area ${isOpen ? 'is-open' : ''}`} key={area} id={`adjv-area-${area.replace(/\W+/g, '-')}`}>
            <button className="adjv-area-head" onClick={() => setOpen(o => ({ ...o, [area]: !isOpen }))}>
              <span className="adjv-chev" aria-hidden>{isOpen ? '▾' : '▸'}</span>
              <span className="adjv-area-name">{area}</span>
              <span className="adjv-area-count">{acts.length} adjustment{acts.length === 1 ? '' : 's'}</span>
              <span className="adjv-area-net">
                Net <b className={an.cls}>{an.txt}</b>
              </span>
            </button>
            {isOpen && (
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
            )}
          </section>
        )
      })}
    </div>
  )
}
