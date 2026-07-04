import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchLines, fetchVersions, type CfLine, type CfVersion } from '@/lib/queries'

/* Adjustments editor — Treasury edits the ADJUSTED forecast here instead of
 * in Excel. Reads v_cf_adjusted_full (base + Σ active legs, area grain, USD)
 * and writes the ledger (cf_adjustment_actions + cf_adjustment_legs).
 *
 * One primitive, three verbs (design validated by prototype 2026-07-03):
 *   Adjust      — change one number (Set to / Add-subtract)      → 1 leg
 *   Reclass     — move an amount to another line, same month     → 2 legs
 *   Reschedule  — push an amount to another month, same line     → 2 legs
 * Every gesture is one ACTION with who/when/why; the log below is the audit
 * trail, and Undo deactivates the action (legs vanish from every surface).
 * Carry-forward: a new version starts by offering the previous version's
 * adjustments as a Repeat/Skip checklist — each repeatable once. */

type Cell = { area: string; line_code: string; year: number; month: number; base_usd: number; delta_usd: number; value_usd: number }
type Action = {
  id: string
  base_version: string
  area: string
  action_type: 'adjust' | 'reclass' | 'reschedule' | 'import'
  intent: 'set' | 'add'
  input_amount: number | null
  note: string | null
  actor: string | null
  source_batch: string | null
  created_at: string
  is_active: boolean
}
type Leg = { action_id: string; area: string; line_code: string; year: number; month: number; delta_usd: number; role: 'single' | 'from' | 'to' }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monLabel = (m: number, y: number) => `${MON[m - 1] || '?'} ’${String(y).slice(2)}`
const TYPE_LABEL: Record<Action['action_type'], string> = { adjust: 'Adjust', reclass: 'Reclass', reschedule: 'Reschedule', import: 'Import' }

type Denom = 'm' | 'k' | 'u'
const DENOMS: Record<Denom, { div: number; dec: number; btn: string; unit: string }> = {
  m: { div: 1e6, dec: 2, btn: 'Millions', unit: 'USD m' },
  k: { div: 1e3, dec: 0, btn: "'000", unit: "USD '000" },
  u: { div: 1, dec: 0, btn: 'Units', unit: 'USD' },
}

/** Page through PostgREST's row cap. */
async function fetchPaged<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  const SIZE = 1000
  for (let p = 0; p < 40; p++) {
    const { data, error } = await build(p * SIZE, (p + 1) * SIZE - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < SIZE) break
  }
  return out
}

export default function AdjustmentsPanel({ canManage }: { canManage: boolean }) {
  const [versions, setVersions] = useState<(CfVersion & { label?: string | null })[]>([])
  const [lines, setLines] = useState<CfLine[]>([])
  const [version, setVersion] = useState<string>('')
  const [areas, setAreas] = useState<string[]>([])
  const [area, setArea] = useState<string>('')
  const [cells, setCells] = useState<Cell[]>([])
  const [actions, setActions] = useState<Action[]>([])       // all actions on the version (active + undone)
  const [legs, setLegs] = useState<Leg[]>([])                 // legs of the active actions
  const [priorActions, setPriorActions] = useState<Action[]>([])
  const [priorLegs, setPriorLegs] = useState<Leg[]>([])
  const [priorVersion, setPriorVersion] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [gridLoading, setGridLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [denom, setDenom] = useState<Denom>('m')
  const [logAllAreas, setLogAllAreas] = useState(false)
  const [editor, setEditor] = useState<{ line: CfLine; year: number; month: number } | null>(null)
  const [actorEmail, setActorEmail] = useState<string>('')

  const d = DENOMS[denom]
  const fmt = (v: number) => {
    const x = v / d.div
    const s = new Intl.NumberFormat('en-US', { minimumFractionDigits: d.dec, maximumFractionDigits: d.dec }).format(Math.abs(x))
    return v < 0 ? `(${s})` : s
  }

  /* ── bootstrap: versions + lines + actor ─────────────────────────── */
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [vs, ls, auth] = await Promise.all([fetchVersions(), fetchLines(), supabase.auth.getUser()])
        if (!alive) return
        setVersions(vs)
        setLines(ls.filter(l => l.is_active))
        setActorEmail(auth.data.user?.email ?? '')
        // default to the version that carries ledger actions, else newest ADJ, else newest
        const { data: withActs } = await supabase
          .from('cf_adjustment_actions').select('base_version').eq('is_active', true).limit(200)
        if (!alive) return
        const actVers = new Set(((withActs ?? []) as { base_version: string }[]).map(r => r.base_version))
        const def =
          vs.find(v => actVers.has(v.version_code))?.version_code ??
          vs.find(v => v.version_code.includes('ADJ'))?.version_code ??
          vs[0]?.version_code ?? ''
        setVersion(def)
      } catch (e) {
        if (alive) setErr((e as Error).message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  /* ── per-version: areas + ledger + carry-forward source ──────────── */
  async function loadVersionScope(v: string) {
    // areas actually populated on this version (forecast rows are area grain on ADJ)
    const areaRows = await fetchPaged<{ area: string }>((f, t) =>
      supabase.from('cf_forecasts').select('area').eq('version', v).range(f, t))
    const act = await supabase
      .from('cf_adjustment_actions')
      .select('id, base_version, area, action_type, intent, input_amount, note, actor, source_batch, created_at, is_active')
      .eq('base_version', v)
      .order('created_at', { ascending: false })
    if (act.error) throw new Error(act.error.message)
    const acts = (act.data ?? []) as Action[]
    const activeIds = acts.filter(a => a.is_active).map(a => a.id)
    let lg: Leg[] = []
    if (activeIds.length) {
      const r = await supabase
        .from('cf_adjustment_legs')
        .select('action_id, area, line_code, year, month, delta_usd, role')
        .in('action_id', activeIds)
      if (r.error) throw new Error(r.error.message)
      lg = (r.data ?? []) as Leg[]
    }
    const aset = [...new Set([...areaRows.map(r => r.area), ...acts.map(a => a.area)])].sort()
    setAreas(aset)
    setActions(acts)
    setLegs(lg)
    setArea(prev => (prev && aset.includes(prev) ? prev : aset[0] ?? ''))

    // carry-forward source: the most recent OTHER version with active actions
    const { data: others, error: oErr } = await supabase
      .from('cf_adjustment_actions')
      .select('id, base_version, area, action_type, intent, input_amount, note, actor, source_batch, created_at, is_active')
      .neq('base_version', v)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(200)
    if (oErr) throw new Error(oErr.message)
    const oActs = (others ?? []) as Action[]
    const src = oActs[0]?.base_version ?? ''
    const srcActs = oActs.filter(a => a.base_version === src)
    setPriorVersion(src)
    setPriorActions(srcActs)
    if (srcActs.length) {
      const r = await supabase
        .from('cf_adjustment_legs')
        .select('action_id, area, line_code, year, month, delta_usd, role')
        .in('action_id', srcActs.map(a => a.id))
      if (r.error) throw new Error(r.error.message)
      setPriorLegs((r.data ?? []) as Leg[])
    } else setPriorLegs([])
  }

  useEffect(() => {
    if (!version) return
    let alive = true
    setErr(null)
    loadVersionScope(version).catch(e => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  /* ── per-area grid cells ─────────────────────────────────────────── */
  async function loadCells(v: string, a: string) {
    setGridLoading(true)
    try {
      const rows = await fetchPaged<Cell>((f, t) =>
        supabase.from('v_cf_adjusted_full')
          .select('area, line_code, year, month, base_usd, delta_usd, value_usd')
          .eq('version', v).eq('area', a).range(f, t))
      setCells(rows)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setGridLoading(false)
    }
  }
  useEffect(() => {
    if (version && area) void loadCells(version, area)
    else setCells([])
  }, [version, area])

  async function refreshAll() {
    if (!version) return
    await loadVersionScope(version)
    if (area) await loadCells(version, area)
  }

  /* ── derived grid model ──────────────────────────────────────────── */
  const ver = versions.find(v => v.version_code === version)
  const asOf = ver?.as_of_date ? new Date(ver.as_of_date + 'T00:00:00') : null
  const isElapsed = (y: number, m: number) =>
    !!asOf && (y < asOf.getFullYear() || (y === asOf.getFullYear() && m <= asOf.getMonth() + 1))

  const lineByCode = useMemo(() => new Map(lines.map(l => [l.line_code, l])), [lines])

  const months = useMemo(() => {
    const s = new Map<string, { y: number; m: number }>()
    for (const c of cells) s.set(`${c.year}-${c.month}`, { y: c.year, m: c.month })
    return [...s.values()].sort((a, b) => a.y - b.y || a.m - b.m)
  }, [cells])

  const cellMap = useMemo(() => {
    const m = new Map<string, Cell>()
    for (const c of cells) m.set(`${c.line_code}|${c.year}-${c.month}`, c)
    return m
  }, [cells])

  // rows: active lines with any value or delta in this area, in chart order, grouped by category
  const gridRows = useMemo(() => {
    const used = new Set<string>()
    for (const c of cells) if (Math.abs(c.value_usd) > 0.5 || Math.abs(c.delta_usd) > 0.5 || Math.abs(c.base_usd) > 0.5) used.add(c.line_code)
    const rows = lines.filter(l => used.has(l.line_code))
    const out: { cat: string; lines: CfLine[] }[] = []
    for (const l of rows) {
      const last = out[out.length - 1]
      if (last && last.cat === l.category) last.lines.push(l)
      else out.push({ cat: l.category, lines: [l] })
    }
    return out
  }, [cells, lines])

  const areaNetDelta = useMemo(
    () => cells.filter(c => lineByCode.get(c.line_code)?.nature !== 'Balance')
      .reduce((s, c) => s + Number(c.delta_usd || 0), 0),
    [cells, lineByCode])

  const activeActions = actions.filter(a => a.is_active)
  const logActions = logAllAreas ? activeActions : activeActions.filter(a => a.area === area)
  const legsByAction = useMemo(() => {
    const m = new Map<string, Leg[]>()
    for (const l of legs) { const arr = m.get(l.action_id) ?? []; arr.push(l); m.set(l.action_id, arr) }
    return m
  }, [legs])
  const priorLegsByAction = useMemo(() => {
    const m = new Map<string, Leg[]>()
    for (const l of priorLegs) { const arr = m.get(l.action_id) ?? []; arr.push(l); m.set(l.action_id, arr) }
    return m
  }, [priorLegs])

  // carried = an ACTIVE action on this version tagged carry:<prior action id>
  const carriedIds = useMemo(() => {
    const s = new Set<string>()
    for (const a of actions) {
      if (a.is_active && a.source_batch?.startsWith('carry:')) s.add(a.source_batch.slice(6))
    }
    return s
  }, [actions])

  /* ── mutations ───────────────────────────────────────────────────── */
  async function writeAction(
    input: {
      action_type: Action['action_type']
      intent: Action['intent']
      input_amount: number
      note: string
      legs: Omit<Leg, 'action_id'>[]
      source_batch?: string
      area?: string
    },
  ) {
    setSaving(true)
    setErr(null)
    try {
      const { data, error } = await supabase
        .from('cf_adjustment_actions')
        .insert({
          base_version: version,
          area: input.area ?? area,
          action_type: input.action_type,
          intent: input.intent,
          input_amount: input.input_amount,
          note: input.note || null,
          actor: actorEmail || null,
          source_batch: input.source_batch ?? null,
          is_active: true,
        })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      const actionId = (data as { id: string }).id
      const { error: le } = await supabase
        .from('cf_adjustment_legs')
        .insert(input.legs.map(l => ({ ...l, action_id: actionId })))
      if (le) {
        // don't leave a legless action behind
        await supabase.from('cf_adjustment_actions').delete().eq('id', actionId)
        throw new Error(le.message)
      }
      setEditor(null)
      await refreshAll()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function undoAction(id: string) {
    setSaving(true)
    setErr(null)
    try {
      const { error } = await supabase.from('cf_adjustment_actions').update({ is_active: false }).eq('id', id)
      if (error) throw new Error(error.message)
      await refreshAll()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function repeatAction(prior: Action) {
    const pls = priorLegsByAction.get(prior.id) ?? []
    if (!pls.length) return
    await writeAction({
      action_type: prior.action_type,
      intent: prior.intent,
      input_amount: Number(prior.input_amount ?? 0),
      note: prior.note ?? '',
      area: prior.area,
      source_batch: `carry:${prior.id}`,
      legs: pls.map(l => ({ area: l.area, line_code: l.line_code, year: l.year, month: l.month, delta_usd: l.delta_usd, role: l.role })),
    })
  }

  /* ── render ──────────────────────────────────────────────────────── */
  if (loading) return <div className="cfm-body"><div className="adj-empty-pad">Loading…</div></div>

  const netP = Math.abs(areaNetDelta) < 0.5 ? null : areaNetDelta > 0
  const showCarry = !!priorVersion && priorVersion !== version && priorActions.some(a => !carriedIds.has(a.id))

  return (
    <div className="cfm-body adje">
      <div className="adje-toolbar">
        <label className="adje-ctl">
          <span>Version</span>
          <select value={version} onChange={e => setVersion(e.target.value)}>
            {versions.map(v => (
              <option key={v.version_code} value={v.version_code}>{v.version_code}</option>
            ))}
          </select>
        </label>
        <label className="adje-ctl">
          <span>Area</span>
          <select value={area} onChange={e => setArea(e.target.value)}>
            {areas.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <div className="adje-denoms">
          {(['m', 'k', 'u'] as Denom[]).map(k => (
            <button key={k} className={`adje-denom ${denom === k ? 'is-active' : ''}`} onClick={() => setDenom(k)}>{DENOMS[k].btn}</button>
          ))}
        </div>
        <span className="adje-spacer" />
        <div className="adje-net" title="Sum of this area's active adjustment legs on flow lines">
          <span>Net adjustment · {area || '—'}</span>
          <b className={netP === null ? 'zero' : netP ? 'up' : 'down'}>
            {netP === null ? '—' : (areaNetDelta > 0 ? '+' : '−') + fmt(Math.abs(areaNetDelta))}
          </b>
        </div>
      </div>

      {version.includes('ORIG') && (
        <div className="adje-hint">
          <b>{version}</b> is the faithful extraction of the area files — adjustments conventionally live on the ADJ version.
        </div>
      )}
      {!canManage && <div className="adje-hint">Read-only — editing needs the Treasury role.</div>}
      {err && <div className="adj-err">{err}</div>}

      {showCarry && (
        <details className="adje-carry" open={activeActions.length === 0}>
          <summary>
            Carry forward from <b>{priorVersion}</b>
            <span>{priorActions.filter(a => !carriedIds.has(a.id)).length} of {priorActions.length} not yet repeated — each repeats once, then it's a normal adjustment you can undo</span>
          </summary>
          <div className="adje-carry-list">
            {priorActions.map(p => {
              const pls = priorLegsByAction.get(p.id) ?? []
              const net = pls.reduce((s, l) => s + Number(l.delta_usd || 0), 0)
              const carried = carriedIds.has(p.id)
              const lineNames = [...new Set(pls.map(l => lineByCode.get(l.line_code)?.description ?? l.line_code))]
              return (
                <div className={`adje-carry-row ${carried ? 'is-done' : ''}`} key={p.id}>
                  <span className={`adjv-type adjv-type--${p.action_type}`}>{TYPE_LABEL[p.action_type]}</span>
                  <span className="adje-carry-area">{p.area}</span>
                  <span className="adje-carry-desc" title={p.note ?? ''}>
                    {lineNames.join(' → ')}
                    {p.note ? <em> — {p.note}</em> : null}
                  </span>
                  <span className={`adje-carry-net ${Math.abs(net) < 0.5 ? 'zero' : net > 0 ? 'up' : 'down'}`}>
                    {Math.abs(net) < 0.5 ? 'Cash-neutral' : (net > 0 ? '+' : '−') + fmt(Math.abs(net))}
                  </span>
                  {carried ? (
                    <span className="adje-carried">Repeated ✓</span>
                  ) : canManage ? (
                    <button className="adje-repeat" disabled={saving} onClick={() => repeatAction(p)}>Repeat here</button>
                  ) : null}
                </div>
              )
            })}
          </div>
        </details>
      )}

      <div className="adje-gridwrap">
        {gridLoading && <div className="adje-gridload">Loading {area}…</div>}
        {!gridLoading && gridRows.length === 0 && <div className="adje-gridload">No figures for {area || 'this area'} on {version}.</div>}
        {!gridLoading && gridRows.length > 0 && (
          <table className="adje-grid">
            <thead>
              <tr>
                <th className="adje-th-line">Line · {d.unit}</th>
                {months.map(mm => (
                  <th key={`${mm.y}-${mm.m}`} className={`adje-num ${isElapsed(mm.y, mm.m) ? 'is-actual' : ''}`}>
                    {monLabel(mm.m, mm.y)}
                    {isElapsed(mm.y, mm.m) && <span className="adje-a" title="Elapsed — actuals">A</span>}
                  </th>
                ))}
                <th className="adje-num adje-th-fy">FY {ver?.cycle_year ?? ''}</th>
              </tr>
            </thead>
            <tbody>
              {gridRows.map(g => (
                [
                  <tr key={`h-${g.cat}`} className="adje-cat"><td colSpan={months.length + 2}>{g.cat}</td></tr>,
                  ...g.lines.map(l => {
                    const fy = l.nature === 'Balance'
                      ? null
                      : months.filter(mm => mm.y === ver?.cycle_year)
                          .reduce((s, mm) => s + Number(cellMap.get(`${l.line_code}|${mm.y}-${mm.m}`)?.value_usd || 0), 0)
                    const rowTouched = months.some(mm => Math.abs(Number(cellMap.get(`${l.line_code}|${mm.y}-${mm.m}`)?.delta_usd || 0)) > 0.5)
                    return (
                      <tr key={l.line_code}>
                        <td className={`adje-td-line ${rowTouched ? 'is-touched' : ''}`} title={l.line_code}>{l.description}</td>
                        {months.map(mm => {
                          const c = cellMap.get(`${l.line_code}|${mm.y}-${mm.m}`)
                          const v = Number(c?.value_usd || 0)
                          const dl = Number(c?.delta_usd || 0)
                          const touched = Math.abs(dl) > 0.5
                          return (
                            <td
                              key={`${mm.y}-${mm.m}`}
                              className={`adje-num adje-cell ${touched ? 'is-touched' : ''} ${canManage ? 'is-editable' : ''}`}
                              title={touched
                                ? `Base ${fmt(Number(c?.base_usd || 0))} → adjusted ${fmt(v)} (Δ ${dl > 0 ? '+' : '−'}${fmt(Math.abs(dl))})`
                                : undefined}
                              onClick={canManage ? () => setEditor({ line: l, year: mm.y, month: mm.m }) : undefined}
                            >
                              {Math.abs(v) < 0.5 ? <span className="adje-zero">·</span> : fmt(v)}
                            </td>
                          )
                        })}
                        <td className={`adje-num adje-td-fy ${rowTouched ? 'is-touched' : ''}`}>
                          {fy === null ? '—' : Math.abs(fy) < 0.5 ? '·' : fmt(fy)}
                        </td>
                      </tr>
                    )
                  }),
                ]
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="adje-log">
        <div className="adje-log-head">
          <h4>Adjustments on {version}</h4>
          <label className="adje-log-all">
            <input type="checkbox" checked={logAllAreas} onChange={e => setLogAllAreas(e.target.checked)} />
            All areas
          </label>
        </div>
        {logActions.length === 0 && (
          <div className="adje-log-none">
            None yet{logAllAreas ? '' : ` for ${area}`} — click any cell in the grid to make the first one.
          </div>
        )}
        {logActions.map(a => {
          const als = legsByAction.get(a.id) ?? []
          const net = als.reduce((s, l) => s + Number(l.delta_usd || 0), 0)
          const parts = als
            .slice()
            .sort((x, y) => (x.role === 'from' ? 0 : x.role === 'to' ? 1 : 2) - (y.role === 'from' ? 0 : y.role === 'to' ? 1 : 2))
            .map(l => {
              const nm = lineByCode.get(l.line_code)?.description ?? l.line_code
              const dv = Number(l.delta_usd || 0)
              return `${nm} · ${monLabel(l.month, l.year)} ${dv > 0 ? '+' : '−'}${fmt(Math.abs(dv))}`
            })
          return (
            <div className="adje-log-row" key={a.id}>
              <span className={`adjv-type adjv-type--${a.action_type}`}>{TYPE_LABEL[a.action_type]}</span>
              {logAllAreas && <span className="adje-carry-area">{a.area}</span>}
              <span className="adje-log-desc" title={parts.join('  |  ')}>
                {parts.join('  →  ')}
                {a.note ? <em> — {a.note}</em> : null}
              </span>
              <span className={`adje-carry-net ${Math.abs(net) < 0.5 ? 'zero' : net > 0 ? 'up' : 'down'}`}>
                {Math.abs(net) < 0.5 ? 'Cash-neutral' : (net > 0 ? '+' : '−') + fmt(Math.abs(net))}
              </span>
              <span className="adje-log-meta">{a.actor ? a.actor.split('@')[0] : '—'} · {new Date(a.created_at).toLocaleDateString()}</span>
              {canManage && <button className="adje-undo" disabled={saving} onClick={() => undoAction(a.id)}>Undo</button>}
            </div>
          )
        })}
      </div>

      {editor && (
        <VerbModal
          key={`${editor.line.line_code}-${editor.year}-${editor.month}`}
          line={editor.line}
          year={editor.year}
          month={editor.month}
          area={area}
          cellMap={cellMap}
          months={months}
          lines={lines}
          denom={denom}
          fmt={fmt}
          saving={saving}
          onClose={() => setEditor(null)}
          onSave={writeAction}
        />
      )}
    </div>
  )
}

/* ── the three-verb editor modal ─────────────────────────────────────── */

function VerbModal({
  line, year, month, area, cellMap, months, lines, denom, fmt, saving, onClose, onSave,
}: {
  line: CfLine
  year: number
  month: number
  area: string
  cellMap: Map<string, Cell>
  months: { y: number; m: number }[]
  lines: CfLine[]
  denom: Denom
  fmt: (v: number) => string
  saving: boolean
  onClose: () => void
  onSave: (input: {
    action_type: Action['action_type']
    intent: Action['intent']
    input_amount: number
    note: string
    legs: Omit<Leg, 'action_id'>[]
  }) => Promise<void>
}) {
  const isBalance = line.nature === 'Balance'
  const [verb, setVerb] = useState<'adjust' | 'reclass' | 'reschedule'>('adjust')
  const [mode, setMode] = useState<'set' | 'add'>('set')
  const [amtStr, setAmtStr] = useState('')
  const [note, setNote] = useState('')
  const [destLine, setDestLine] = useState('')
  const [destMonth, setDestMonth] = useState('')

  const d = DENOMS[denom]
  const cur = Number(cellMap.get(`${line.line_code}|${year}-${month}`)?.value_usd || 0)
  const isNew = Math.abs(cur) < 0.5

  // input is typed in the current display unit
  const amt = (() => {
    const n = parseFloat(amtStr.replace(/[,\s]/g, ''))
    return Number.isFinite(n) ? n * d.div : NaN
  })()

  const destLineObj = lines.find(l => l.line_code === destLine)
  const destCellV = verb === 'reclass' && destLine
    ? Number(cellMap.get(`${destLine}|${year}-${month}`)?.value_usd || 0)
    : verb === 'reschedule' && destMonth
      ? Number(cellMap.get(`${line.line_code}|${destMonth}`)?.value_usd || 0)
      : 0

  // reclass destinations: flow lines only, source excluded, chart order
  const destLines = useMemo(
    () => lines.filter(l => l.nature !== 'Balance' && l.line_code !== line.line_code),
    [lines, line.line_code])
  const destMonths = months.filter(mm => !(mm.y === year && mm.m === month))

  const legDelta = verb === 'adjust' ? (mode === 'set' ? amt - cur : amt) : amt

  const valid =
    Number.isFinite(amt) &&
    (verb === 'adjust'
      ? Math.abs(legDelta) > 0.5
      : Math.abs(amt) > 0.5 && (verb === 'reclass' ? !!destLine : !!destMonth))

  async function save() {
    if (!valid) return
    if (verb === 'adjust') {
      await onSave({
        action_type: 'adjust',
        intent: mode,
        input_amount: amt,
        note,
        legs: [{ area, line_code: line.line_code, year, month, delta_usd: legDelta, role: 'single' }],
      })
    } else if (verb === 'reclass') {
      await onSave({
        action_type: 'reclass',
        intent: 'add',
        input_amount: amt,
        note,
        legs: [
          { area, line_code: line.line_code, year, month, delta_usd: -amt, role: 'from' },
          { area, line_code: destLine, year, month, delta_usd: amt, role: 'to' },
        ],
      })
    } else {
      const [dy, dm] = destMonth.split('-').map(Number)
      await onSave({
        action_type: 'reschedule',
        intent: 'add',
        input_amount: amt,
        note,
        legs: [
          { area, line_code: line.line_code, year, month, delta_usd: -amt, role: 'from' },
          { area, line_code: line.line_code, year: dy, month: dm, delta_usd: amt, role: 'to' },
        ],
      })
    }
  }

  return (
    <div className="pm-modal-bg" onClick={onClose}>
      <div className="pm-modal adje-modal" onClick={e => e.stopPropagation()}>
        <div className="pm-modal-h">
          <div><b>{line.description}</b> · {monLabel(month, year)} · {area}</div>
          <div className="pm-modal-co">
            Adjusted now: <b>{isNew ? '— (empty — this makes a new entry)' : fmt(cur)}</b>
            {isBalance && ' · balance line — Adjust only'}
          </div>
          <button className="pm-modal-x" onClick={onClose}>×</button>
        </div>

        <div className="adje-verbs">
          {(['adjust', 'reclass', 'reschedule'] as const).map(v => (
            <button
              key={v}
              className={`adje-verbtab ${verb === v ? 'is-active' : ''}`}
              disabled={v !== 'adjust' && isBalance}
              title={v !== 'adjust' && isBalance ? 'Balance lines can only be adjusted in place' : undefined}
              onClick={() => setVerb(v)}
            >
              {TYPE_LABEL[v]}
              <span>{v === 'adjust' ? 'change this number' : v === 'reclass' ? 'move to another line' : 'move to another month'}</span>
            </button>
          ))}
        </div>

        <div className="adje-form">
          {verb === 'adjust' && (
            <div className="adje-mode">
              <label><input type="radio" checked={mode === 'set'} onChange={() => setMode('set')} /> Set to</label>
              <label><input type="radio" checked={mode === 'add'} onChange={() => setMode('add')} /> Add / subtract</label>
            </div>
          )}

          <label className="adje-field">
            <span>{verb === 'adjust' ? (mode === 'set' ? `New value (${d.unit})` : `Amount to add (${d.unit}, negative subtracts)`) : `Amount to move (${d.unit})`}</span>
            <input
              autoFocus
              inputMode="decimal"
              placeholder="0"
              value={amtStr}
              onChange={e => setAmtStr(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && valid && !saving) void save(); if (e.key === 'Escape') onClose() }}
            />
          </label>

          {verb === 'reclass' && (
            <label className="adje-field">
              <span>To line (same month)</span>
              <select value={destLine} onChange={e => setDestLine(e.target.value)}>
                <option value="">— pick a line —</option>
                {destLines.map(l => (
                  <option key={l.line_code} value={l.line_code}>{l.category} · {l.description}</option>
                ))}
              </select>
            </label>
          )}

          {verb === 'reschedule' && (
            <label className="adje-field">
              <span>To month (same line)</span>
              <select value={destMonth} onChange={e => setDestMonth(e.target.value)}>
                <option value="">— pick a month —</option>
                {destMonths.map(mm => (
                  <option key={`${mm.y}-${mm.m}`} value={`${mm.y}-${mm.m}`}>{monLabel(mm.m, mm.y)}</option>
                ))}
              </select>
            </label>
          )}

          {valid && (
            <div className="adje-preview">
              {verb === 'adjust' && (
                <>This cell: {fmt(cur)} → <b>{fmt(cur + legDelta)}</b> <em>(leg {legDelta > 0 ? '+' : '−'}{fmt(Math.abs(legDelta))})</em></>
              )}
              {verb === 'reclass' && destLineObj && (
                <>
                  {line.description}: {fmt(cur)} → <b>{fmt(cur - amt)}</b>
                  <span className="adje-prev-arrow">→</span>
                  {destLineObj.description}: {fmt(destCellV)} → <b>{fmt(destCellV + amt)}</b>
                  <em>(cash-neutral)</em>
                </>
              )}
              {verb === 'reschedule' && destMonth && (
                <>
                  {monLabel(month, year)}: {fmt(cur)} → <b>{fmt(cur - amt)}</b>
                  <span className="adje-prev-arrow">→</span>
                  {monLabel(Number(destMonth.split('-')[1]), Number(destMonth.split('-')[0]))}: {fmt(destCellV)} → <b>{fmt(destCellV + amt)}</b>
                  <em>(cash-neutral)</em>
                </>
              )}
            </div>
          )}

          <label className="adje-field">
            <span>Note — why (recommended; it becomes the audit trail)</span>
            <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Tony's within-group elimination for May" />
          </label>

          <div className="adje-actions">
            <button className="adje-save" disabled={!valid || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : `Save ${TYPE_LABEL[verb].toLowerCase()}`}
            </button>
            <button className="adje-cancel" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  )
}
