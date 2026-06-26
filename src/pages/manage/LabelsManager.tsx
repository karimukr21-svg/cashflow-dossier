import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

// Labels & mappings — manage the chart of cash-flow lines and the aliases that map
// each area's local label onto a canonical line. Adding an alias here makes the
// parser recognise that label on the next re-stage (load_ref live-merges aliases).
type Line = {
  line_code: string; nature: string; category: string
  description: string; sort_order: number; is_active: boolean
}
type Alias = {
  alias_description: string; alias_nature: string
  alias_category: string; line_code: string; notes: string | null
}

// nature → small accent (kept restrained, within the CCC slate/crimson language)
const NATURE_CLASS: Record<string, string> = {
  Receipts: 'is-rcpt', Payments: 'is-pay', Balance: 'is-bal',
}
function natureClass(n: string) { return NATURE_CLASS[n] ?? 'is-bal' }
// the three natures, in cash-flow-statement order (mirrors how the source sheets group)
const NATURES = ['Receipts', 'Payments', 'Balance']

export default function LabelsManager({ canManage }: { canManage: boolean }) {
  const [lines, setLines] = useState<Line[]>([])
  const [aliases, setAliases] = useState<Alias[]>([])
  const [pending, setPending] = useState<{ label: string; runs: string[] }[]>([])
  const [q, setQ] = useState('')
  const [catFilter, setCatFilter] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [newCode, setNewCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [showChart, setShowChart] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const [{ data: L }, { data: A }, { data: R }] = await Promise.all([
      supabase.from('cf_lines').select('*').order('category').order('sort_order'),
      supabase.from('cf_line_aliases').select('*').order('alias_category').order('alias_description'),
      supabase.from('cf_import_runs').select('area,recon_summary').eq('status', 'open'),
    ])
    setLines((L as Line[]) ?? [])
    setAliases((A as Alias[]) ?? [])
    // aggregate the labels that didn't map across all open runs
    const agg: Record<string, Set<string>> = {}
    for (const run of (R as any[]) ?? []) {
      const um = run.recon_summary?.unmatched_labels ?? {}
      for (const label of Object.keys(um)) (agg[label] ??= new Set()).add(run.area)
    }
    setPending(Object.entries(agg)
      .map(([label, runs]) => ({ label, runs: [...runs] }))
      // most-impactful first: labels failing across many areas float to the top
      .sort((a, b) => b.runs.length - a.runs.length || a.label.localeCompare(b.label)))
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const flashOk = (msg: string) => {
    setFlash(msg)
    window.setTimeout(() => setFlash(null), 2600)
  }

  const lineByCode = useMemo(
    () => Object.fromEntries(lines.map(l => [l.line_code, l])) as Record<string, Line>,
    [lines])

  const linesByCat = useMemo(() => {
    const m: Record<string, Line[]> = {}
    for (const l of lines) if (l.is_active) (m[l.category] ??= []).push(l)
    return m
  }, [lines])
  const activeLines = useMemo(() => lines.filter(l => l.is_active), [lines])

  // already-mapped labels (lower-cased) → for inline duplicate validation on the add form
  const aliasKeys = useMemo(
    () => new Set(aliases.map(a => a.alias_description.toLowerCase())),
    [aliases])
  const dupOnAdd = newLabel.trim() && aliasKeys.has(newLabel.trim().toLowerCase())

  const addAlias = async (label: string, code: string) => {
    const lbl = label.trim()
    const line = lineByCode[code]
    if (!lbl || !line) return
    setBusy(true); setErr(null)
    const { error } = await supabase.from('cf_line_aliases').insert({
      alias_description: lbl, alias_nature: line.nature,
      alias_category: line.category, line_code: code, notes: 'added via Labels page',
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setNewLabel(''); setNewCode('')
    flashOk(`Mapped "${lbl}" → ${line.description}`)
    load()
  }

  const delAlias = async (a: Alias) => {
    if (!confirm(`Delete mapping "${a.alias_description}" → ${a.line_code}?`)) return
    setErr(null)
    const { error } = await supabase.from('cf_line_aliases').delete()
      .eq('alias_description', a.alias_description)
      .eq('alias_nature', a.alias_nature)
      .eq('alias_category', a.alias_category)
    if (error) { setErr(error.message); return }
    load()
  }

  const ql = q.toLowerCase()
  const filtered = aliases.filter(a => {
    if (catFilter && a.alias_category !== catFilter) return false
    return !ql || a.alias_description.toLowerCase().includes(ql) ||
      a.line_code.toLowerCase().includes(ql) ||
      (lineByCode[a.line_code]?.description ?? '').toLowerCase().includes(ql)
  })

  // statement-ish category order, derived from the chart's sort_order
  const catOrder = useMemo(() => {
    const min: Record<string, number> = {}
    for (const l of lines) min[l.category] = Math.min(min[l.category] ?? Infinity, l.sort_order)
    return min
  }, [lines])
  const groupByCat = (arr: Alias[]) => {
    const m: Record<string, Alias[]> = {}
    for (const a of arr) (m[a.alias_category] ??= []).push(a)
    return Object.entries(m).sort((x, y) =>
      (catOrder[x[0]] ?? 999) - (catOrder[y[0]] ?? 999) || x[0].localeCompare(y[0]))
  }

  // categories present in the alias set, for the filter chips (with counts)
  const aliasCats = useMemo(() => {
    const m: Record<string, number> = {}
    for (const a of aliases) m[a.alias_category] = (m[a.alias_category] ?? 0) + 1
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0]))
  }, [aliases])

  const multiArea = pending.filter(p => p.runs.length > 1).length

  return (
    <div className="cfm-labels">
      <p className="cfm-lbl-intro">
        Map an area's local label onto a canonical line. New mappings apply the next
        time that area is re-staged.
      </p>
      {err && <div className="cfm-lbl-err">{err}</div>}
      {flash && <div className="cfm-lbl-flash"><span className="cfm-lbl-flash-tick">✓</span>{flash}</div>}

      {/* ── triage queue: labels that didn't map across open runs ── */}
      {canManage && (
        <section className="cfm-lbl-pending">
          <header className="cfm-lbl-pending-head">
            <span className="cfm-lbl-pending-title">Didn't map</span>
            {!loading && pending.length > 0 && (
              <>
                <span className="cfm-lbl-pending-count">{pending.length}</span>
                {multiArea > 0 && (
                  <span className="cfm-lbl-pending-sub">{multiArea} across multiple areas</span>
                )}
              </>
            )}
          </header>
          {loading ? (
            <div className="cfm-lbl-pending-empty">Loading…</div>
          ) : pending.length === 0 ? (
            <div className="cfm-lbl-pending-empty is-clear">
              <span className="cfm-lbl-pending-tick">✓</span>
              Every label in the open runs is mapping cleanly — nothing to triage.
            </div>
          ) : (
            <div className="cfm-lbl-pending-list">
              {pending.map(p => (
                <PendingRow key={p.label} label={p.label} areas={p.runs}
                  lines={activeLines} onAdd={addAlias} busy={busy} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── add a mapping manually ── */}
      {canManage && (
        <section className="cfm-lbl-add">
          <div className="cfm-lbl-add-head">Add a mapping</div>
          <div className="cfm-lbl-add-row">
            <label className="cfm-lbl-fld cfm-lbl-fld-grow">
              <span>Local label</span>
              <input className="cfm-lbl-text" placeholder="Exactly as it appears in the file"
                value={newLabel} onChange={e => setNewLabel(e.target.value)} />
            </label>
            <span className="cfm-lbl-add-to">→</span>
            <label className="cfm-lbl-fld">
              <span>Canonical line</span>
              <LinePicker lines={activeLines} value={newCode} onChange={setNewCode} />
            </label>
            <button className="cfm-btn cfm-lbl-add-btn"
              disabled={busy || !newLabel.trim() || !newCode || !!dupOnAdd}
              onClick={() => addAlias(newLabel, newCode)}>Add mapping</button>
          </div>
          {dupOnAdd && (
            <div className="cfm-lbl-add-warn">
              "{newLabel.trim()}" is already mapped — edit or delete it in the list below.
            </div>
          )}
        </section>
      )}

      {/* ── existing mappings ── */}
      <section className="cfm-lbl-list">
        <div className="cfm-lbl-list-head">
          <h4 className="cfm-lbl-list-title">
            Mappings <span className="cfm-lbl-count">{filtered.length}{filtered.length !== aliases.length ? ` of ${aliases.length}` : ''}</span>
          </h4>
          <div className="cfm-lbl-search">
            <span className="cfm-lbl-search-ico">⌕</span>
            <input placeholder="Search label, line or code…" value={q} onChange={e => setQ(e.target.value)} />
            {q && <button className="cfm-lbl-search-x" onClick={() => setQ('')} title="Clear">✕</button>}
          </div>
        </div>

        {aliasCats.length > 1 && (
          <div className="cfm-lbl-chips">
            <button className={`cfm-lbl-chip ${!catFilter ? 'is-active' : ''}`}
              onClick={() => setCatFilter(null)}>All</button>
            {aliasCats.map(([cat, n]) => (
              <button key={cat} className={`cfm-lbl-chip ${catFilter === cat ? 'is-active' : ''}`}
                onClick={() => setCatFilter(catFilter === cat ? null : cat)}>
                {cat}<span className="cfm-lbl-chip-n">{n}</span>
              </button>
            ))}
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="cfm-lbl-list-empty">
            {aliases.length === 0 ? 'No mappings yet.' : 'No mappings match your search.'}
          </div>
        ) : (
          <div className="cfm-lbl-natcols">
            {NATURES.map(nat => {
              const items = filtered.filter(a => a.alias_nature === nat)
              return (
                <div key={nat} className="cfm-lbl-natcol">
                  <div className={`cfm-lbl-natcol-h ${natureClass(nat)}`}>
                    <span className="cfm-lbl-natcol-name">{nat}</span>
                    <span className="cfm-lbl-natcol-n">{items.length}</span>
                  </div>
                  <div className="cfm-lbl-natcol-body">
                    {items.length === 0 ? (
                      <div className="cfm-lbl-natcol-empty">—</div>
                    ) : (
                      groupByCat(items).map(([cat, as]) => (
                        <div key={cat} className="cfm-lbl-natgroup">
                          <div className="cfm-lbl-natgroup-h">{cat}</div>
                          {as.map(a => {
                            const line = lineByCode[a.line_code]
                            return (
                              <div key={a.alias_category + a.alias_nature + a.alias_description}
                                className="cfm-lbl-maprow2">
                                <div className="cfm-lbl-maprow2-top">
                                  <span className="cfm-lbl-alias">{a.alias_description}</span>
                                  {canManage && (
                                    <button className="cfm-lbl-del" title="Delete mapping"
                                      onClick={() => delAlias(a)}>✕</button>
                                  )}
                                </div>
                                <div className="cfm-lbl-maprow2-tgt">
                                  <span className="cfm-lbl-arrow">→</span>
                                  {line?.description ?? a.line_code}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── chart of lines reference ── */}
      <section className="cfm-lbl-chart">
        <button className="cfm-lbl-chart-toggle" onClick={() => setShowChart(s => !s)}>
          <span className="cfm-sr-caret">{showChart ? '▾' : '▸'}</span>
          Chart of lines
          <span className="cfm-lbl-chart-n">{activeLines.length}</span>
        </button>
        {showChart && (
          <div className="cfm-lbl-chart-body">
            {Object.entries(linesByCat).map(([cat, ls]) => (
              <div key={cat} className="cfm-lbl-cat">
                <div className="cfm-lbl-cat-h">{cat}<span className="cfm-lbl-cat-n">{ls.length}</span></div>
                {ls.map(l => (
                  <div key={l.line_code} className="cfm-lbl-row cfm-lbl-row-ref">
                    <span className={`cfm-lbl-nature ${natureClass(l.nature)}`}>{l.nature}</span>
                    <span className="cfm-lbl-ref-desc">{l.description}</span>
                    <span className="cfm-lbl-code">{l.line_code}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function PendingRow({ label, areas, lines, onAdd, busy }: {
  label: string; areas: string[]; lines: Line[]
  onAdd: (label: string, code: string) => void; busy: boolean
}) {
  const [code, setCode] = useState('')
  const multi = areas.length > 1
  return (
    <div className={`cfm-lbl-pending-row ${multi ? 'is-multi' : ''}`}>
      <div className="cfm-lbl-pending-id">
        <span className="cfm-lbl-alias">{label}</span>
        <div className="cfm-lbl-areas">
          {areas.map(a => <span key={a} className="cfm-lbl-area-chip">{a}</span>)}
        </div>
      </div>
      <div className="cfm-lbl-pending-map">
        <LinePicker lines={lines} value={code} onChange={setCode} compact />
        <button className="cfm-btn cfm-btn-sm" disabled={busy || !code}
          onClick={() => onAdd(label, code)}>Map</button>
      </div>
    </div>
  )
}

// ── searchable canonical-line picker (replaces the long native <select>) ──
function LinePicker({ lines, value, onChange, compact }: {
  lines: Line[]; value: string; onChange: (v: string) => void; compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const byCode = useMemo(
    () => Object.fromEntries(lines.map(l => [l.line_code, l])) as Record<string, Line>, [lines])
  const sel = value ? byCode[value] : undefined

  const groups = useMemo(() => {
    const ql = q.toLowerCase()
    const m: Record<string, Line[]> = {}
    for (const l of lines) {
      if (ql && !l.description.toLowerCase().includes(ql) &&
        !l.category.toLowerCase().includes(ql) &&
        !l.nature.toLowerCase().includes(ql) &&
        !l.line_code.toLowerCase().includes(ql)) continue
      (m[l.category] ??= []).push(l)
    }
    return Object.entries(m)
  }, [lines, q])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setQ('') }
    }
    document.addEventListener('mousedown', onDoc)
    inputRef.current?.focus()
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const pick = (code: string) => { onChange(code); setOpen(false); setQ('') }

  return (
    <div className={`cfm-lpick ${compact ? 'is-compact' : ''}`} ref={ref}>
      <button type="button" className={`cfm-lpick-btn ${sel ? 'has-val' : ''}`}
        onClick={() => setOpen(o => !o)}>
        {sel ? (
          <span className="cfm-lpick-val">
            <span className={`cfm-lbl-nature ${natureClass(sel.nature)}`}>{sel.nature}</span>
            <span className="cfm-lpick-desc">{sel.description}</span>
          </span>
        ) : <span className="cfm-lpick-ph">map to line…</span>}
        <span className="cfm-lpick-caret">▾</span>
      </button>
      {open && (
        <div className="cfm-lpick-pop">
          <div className="cfm-lpick-search">
            <input ref={inputRef} placeholder="Filter lines…" value={q}
              onChange={e => setQ(e.target.value)} />
          </div>
          <div className="cfm-lpick-list">
            {groups.length === 0 && <div className="cfm-lpick-none">No lines match.</div>}
            {groups.map(([cat, ls]) => (
              <div key={cat} className="cfm-lpick-group">
                <div className="cfm-lpick-group-h">{cat}</div>
                {ls.map(l => (
                  <button type="button" key={l.line_code}
                    className={`cfm-lpick-opt ${l.line_code === value ? 'is-sel' : ''}`}
                    onClick={() => pick(l.line_code)}>
                    <span className={`cfm-lbl-nature ${natureClass(l.nature)}`}>{l.nature}</span>
                    <span className="cfm-lpick-opt-desc">{l.description}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
