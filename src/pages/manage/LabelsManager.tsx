import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

// Labels & mappings — the canonical chart manager. Each cf_lines row is a "line"
// (its description is the MAIN label that shows in reports), grouped into the
// statement sections the areas use (Operation, New Sales, Interest, …). Under each
// line are the LOCAL labels (cf_line_aliases) the parser recognises for it.
//
// The parser matches on (tight(description), nature, category) for BOTH lines and
// aliases (load_ref live-merges them). So when a line's main label / section /
// nature is edited, we PRESERVE its old identity as an alias — files already using
// the old name keep importing. The alias-matching contract is unchanged.
type Line = {
  line_code: string; nature: string; category: string
  description: string; sort_order: number; is_active: boolean
}
type Alias = {
  alias_description: string; alias_nature: string
  alias_category: string; line_code: string; notes: string | null
}

const NATURES = ['Receipts', 'Payments', 'Balance']
const NATURE_CLASS: Record<string, string> = {
  Receipts: 'is-rcpt', Payments: 'is-pay', Balance: 'is-bal',
}
function natureClass(n: string) { return NATURE_CLASS[n] ?? 'is-bal' }

export default function LabelsManager({ canManage }: { canManage: boolean }) {
  const [lines, setLines] = useState<Line[]>([])
  const [aliases, setAliases] = useState<Alias[]>([])
  const [pending, setPending] = useState<{ label: string; runs: string[] }[]>([])
  const [q, setQ] = useState('')
  const [catFilter, setCatFilter] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // per-line interaction state
  const [editingCode, setEditingCode] = useState<string | null>(null)
  const [editDesc, setEditDesc] = useState('')
  const [editCat, setEditCat] = useState('')
  const [editNat, setEditNat] = useState('')
  const [addingCode, setAddingCode] = useState<string | null>(null)
  const [addText, setAddText] = useState('')

  const load = async () => {
    const [{ data: L }, { data: A }, { data: R }] = await Promise.all([
      supabase.from('cf_lines').select('*').order('sort_order'),
      supabase.from('cf_line_aliases').select('*').order('alias_description'),
      supabase.from('cf_import_runs').select('area,recon_summary').eq('status', 'open'),
    ])
    setLines((L as Line[]) ?? [])
    setAliases((A as Alias[]) ?? [])
    const agg: Record<string, Set<string>> = {}
    for (const run of (R as any[]) ?? []) {
      const um = run.recon_summary?.unmatched_labels ?? {}
      for (const label of Object.keys(um)) (agg[label] ??= new Set()).add(run.area)
    }
    setPending(Object.entries(agg)
      .map(([label, runs]) => ({ label, runs: [...runs] }))
      .sort((a, b) => b.runs.length - a.runs.length || a.label.localeCompare(b.label)))
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const flashOk = (msg: string) => { setFlash(msg); window.setTimeout(() => setFlash(null), 2600) }

  const activeLines = useMemo(
    () => lines.filter(l => l.is_active).sort((a, b) => a.sort_order - b.sort_order), [lines])
  const lineByCode = useMemo(
    () => Object.fromEntries(lines.map(l => [l.line_code, l])) as Record<string, Line>, [lines])
  const aliasesByCode = useMemo(() => {
    const m: Record<string, Alias[]> = {}
    for (const a of aliases) (m[a.line_code] ??= []).push(a)
    return m
  }, [aliases])

  // sections in statement order (first appearance by sort_order)
  const sections = useMemo(() => {
    const order: string[] = []
    const map: Record<string, Line[]> = {}
    for (const l of activeLines) {
      if (!map[l.category]) { map[l.category] = []; order.push(l.category) }
      map[l.category].push(l)
    }
    return order.map(cat => ({ cat, lines: map[cat] }))
  }, [activeLines])
  const categoriesList = useMemo(() => sections.map(s => s.cat), [sections])

  // search + section filter
  const ql = q.toLowerCase()
  const lineMatches = (l: Line) => {
    if (!ql) return true
    if (l.description.toLowerCase().includes(ql) || l.line_code.toLowerCase().includes(ql)) return true
    return (aliasesByCode[l.line_code] ?? []).some(a => a.alias_description.toLowerCase().includes(ql))
  }
  const visibleSections = useMemo(() => sections
    .filter(s => !catFilter || s.cat === catFilter)
    .map(s => ({ cat: s.cat, lines: s.lines.filter(lineMatches) }))
    .filter(s => s.lines.length > 0),
    [sections, catFilter, ql, aliasesByCode])
  const visibleCount = visibleSections.reduce((n, s) => n + s.lines.length, 0)

  // ── writes ──
  const insertAlias = async (text: string, line?: Line): Promise<boolean> => {
    const lbl = text.trim()
    if (!lbl || !line) return false
    setBusy(true); setErr(null)
    const { error } = await supabase.from('cf_line_aliases').insert({
      alias_description: lbl, alias_nature: line.nature, alias_category: line.category,
      line_code: line.line_code, notes: 'added via Labels page',
    })
    setBusy(false)
    if (error) {
      setErr(error.code === '23505'
        ? `"${lbl}" is already a label (it may point to a different line).` : error.message)
      return false
    }
    flashOk(`Added label "${lbl}" → ${line.description}`)
    load(); return true
  }

  const delAlias = async (a: Alias) => {
    if (!confirm(`Remove the label "${a.alias_description}"?`)) return
    setErr(null)
    const { error } = await supabase.from('cf_line_aliases').delete()
      .eq('alias_description', a.alias_description)
      .eq('alias_nature', a.alias_nature)
      .eq('alias_category', a.alias_category)
    if (error) { setErr(error.message); return }
    load()
  }

  const startEdit = (l: Line) => {
    setEditingCode(l.line_code); setEditDesc(l.description)
    setEditCat(l.category); setEditNat(l.nature); setAddingCode(null)
  }

  const saveLineEdit = async (line: Line) => {
    const desc = editDesc.trim()
    if (!desc) return
    const changed = desc !== line.description || editCat !== line.category || editNat !== line.nature
    if (!changed) { setEditingCode(null); return }
    setBusy(true); setErr(null)
    // preserve the line's OLD identity as a recognised label, so files using the
    // old name/section keep importing (parser matches on desc+nature+category)
    await supabase.from('cf_line_aliases').upsert({
      alias_description: line.description, alias_nature: line.nature,
      alias_category: line.category, line_code: line.line_code, notes: 'kept on edit',
    }, { onConflict: 'alias_description,alias_nature,alias_category', ignoreDuplicates: true })
    // if the section changed, append the line to the end of the target section's order
    let sort_order = line.sort_order
    if (editCat !== line.category) {
      const inTarget = activeLines.filter(l => l.category === editCat && l.line_code !== line.line_code)
      if (inTarget.length) sort_order = Math.max(...inTarget.map(l => l.sort_order)) + 1
    }
    const { error } = await supabase.from('cf_lines')
      .update({ description: desc, category: editCat, nature: editNat, sort_order })
      .eq('line_code', line.line_code)
    setBusy(false)
    if (error) {
      setErr(error.code === '23505'
        ? `A line "${desc}" already exists in ${editCat} · ${editNat}.` : error.message)
      return
    }
    setEditingCode(null)
    flashOk(`Updated "${desc}"`)
    load()
  }

  const doAddLabel = async (line: Line) => {
    const ok = await insertAlias(addText, line)
    if (ok) { setAddingCode(null); setAddText('') }
  }

  const multiArea = pending.filter(p => p.runs.length > 1).length

  return (
    <div className="cfm-labels">
      <p className="cfm-lbl-intro">
        Every canonical line, the section it sits in, and the local labels the parser
        recognises for it. Edit a line's main label or move it to another section, and
        add or remove its labels. Changes apply the next time an area is re-staged.
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
                {multiArea > 0 && <span className="cfm-lbl-pending-sub">{multiArea} across multiple areas</span>}
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
                  lines={activeLines} onAdd={(label, code) => insertAlias(label, lineByCode[code])} busy={busy} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── the canonical chart: sections → lines → labels ── */}
      <section className="cfm-lbl-list">
        <div className="cfm-lbl-list-head">
          <h4 className="cfm-lbl-list-title">
            Lines &amp; labels
            <span className="cfm-lbl-count">{visibleCount}{visibleCount !== activeLines.length ? ` of ${activeLines.length}` : ''}</span>
          </h4>
          <div className="cfm-lbl-search">
            <span className="cfm-lbl-search-ico">⌕</span>
            <input placeholder="Search a line or local label…" value={q} onChange={e => setQ(e.target.value)} />
            {q && <button className="cfm-lbl-search-x" onClick={() => setQ('')} title="Clear">✕</button>}
          </div>
        </div>

        <div className="cfm-lbl-chips">
          <button className={`cfm-lbl-chip ${!catFilter ? 'is-active' : ''}`}
            onClick={() => setCatFilter(null)}>All</button>
          {sections.map(s => (
            <button key={s.cat} className={`cfm-lbl-chip ${catFilter === s.cat ? 'is-active' : ''}`}
              onClick={() => setCatFilter(catFilter === s.cat ? null : s.cat)}>
              {s.cat}<span className="cfm-lbl-chip-n">{s.lines.length}</span>
            </button>
          ))}
        </div>

        {visibleSections.length === 0 ? (
          <div className="cfm-lbl-list-empty">No lines match your search.</div>
        ) : (
          <div className="cfm-cl-sections">
            {visibleSections.map(s => (
              <div key={s.cat} className="cfm-cl-section">
                <div className="cfm-cl-section-h">
                  <span>{s.cat}</span>
                  <span className="cfm-cl-section-n">{s.lines.length}</span>
                </div>
                <div className="cfm-cl-section-body">
                  {s.lines.map(line => {
                    const code = line.line_code
                    const lineAliases = aliasesByCode[code] ?? []
                    const isEditing = editingCode === code
                    return (
                      <div key={code} className={`cfm-cl-line ${isEditing ? 'is-editing' : ''}`}>
                        {isEditing ? (
                          <>
                            <div className="cfm-cl-line-main">
                              <input className="cfm-cl-edit-desc" autoFocus value={editDesc}
                                onChange={e => setEditDesc(e.target.value)} placeholder="Main label"
                                onKeyDown={e => { if (e.key === 'Escape') setEditingCode(null) }} />
                            </div>
                            <div className="cfm-cl-edit-panel">
                              <label>Section
                                <select value={editCat} onChange={e => setEditCat(e.target.value)}>
                                  {categoriesList.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                              </label>
                              <label>Nature
                                <select value={editNat} onChange={e => setEditNat(e.target.value)}>
                                  {NATURES.map(n => <option key={n} value={n}>{n}</option>)}
                                </select>
                              </label>
                              <div className="cfm-cl-edit-actions">
                                <button className="cfm-btn cfm-btn-sm" disabled={busy || !editDesc.trim()}
                                  onClick={() => saveLineEdit(line)}>Save</button>
                                <button className="cfm-btn cfm-btn-ghost cfm-btn-sm"
                                  onClick={() => setEditingCode(null)}>Cancel</button>
                              </div>
                              <div className="cfm-cl-edit-note">
                                The old name is kept as a recognised label, so files already using it still import.
                              </div>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="cfm-cl-line-main">
                              <span className={`cfm-lbl-nature ${natureClass(line.nature)}`}>{line.nature}</span>
                              <span className="cfm-cl-desc">{line.description}</span>
                              {canManage && (
                                <button className="cfm-cl-edit-btn" title="Edit main label & section"
                                  onClick={() => startEdit(line)}>✎</button>
                              )}
                            </div>
                            <div className="cfm-cl-aliases">
                              {lineAliases.map(a => (
                                <span key={a.alias_category + a.alias_nature + a.alias_description} className="cfm-cl-chip">
                                  {a.alias_description}
                                  {canManage && (
                                    <button className="cfm-cl-chip-x" title="Remove label"
                                      onClick={() => delAlias(a)}>✕</button>
                                  )}
                                </span>
                              ))}
                              {lineAliases.length === 0 && <span className="cfm-cl-noalias">no local labels yet</span>}
                              {canManage && (addingCode === code ? (
                                <span className="cfm-cl-addchip">
                                  <input autoFocus value={addText} placeholder="local label…"
                                    onChange={e => setAddText(e.target.value)}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') doAddLabel(line)
                                      if (e.key === 'Escape') { setAddingCode(null); setAddText('') }
                                    }} />
                                  <button className="cfm-btn cfm-btn-sm" disabled={busy || !addText.trim()}
                                    onClick={() => doAddLabel(line)}>Add</button>
                                </span>
                              ) : (
                                <button className="cfm-cl-addbtn"
                                  onClick={() => { setAddingCode(code); setAddText('') }}>+ label</button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
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

// ── searchable canonical-line picker (used by the triage queue) ──
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
            <span className="cfm-lpick-desc">{sel.category} · {sel.description}</span>
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
