import { useEffect, useMemo, useState } from 'react'
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

export default function LabelsManager({ canManage }: { canManage: boolean }) {
  const [lines, setLines] = useState<Line[]>([])
  const [aliases, setAliases] = useState<Alias[]>([])
  const [pending, setPending] = useState<{ label: string; runs: string[] }[]>([])
  const [q, setQ] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newCode, setNewCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showChart, setShowChart] = useState(false)

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
      .sort((a, b) => a.label.localeCompare(b.label)))
  }
  useEffect(() => { load() }, [])

  const lineByCode = useMemo(
    () => Object.fromEntries(lines.map(l => [l.line_code, l])) as Record<string, Line>,
    [lines])

  const linesByCat = useMemo(() => {
    const m: Record<string, Line[]> = {}
    for (const l of lines) if (l.is_active) (m[l.category] ??= []).push(l)
    return m
  }, [lines])

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
  const filtered = aliases.filter(a =>
    !ql || a.alias_description.toLowerCase().includes(ql) ||
    a.line_code.toLowerCase().includes(ql) ||
    (lineByCode[a.line_code]?.description ?? '').toLowerCase().includes(ql))

  // group filtered aliases by category for display
  const byCat = useMemo(() => {
    const m: Record<string, Alias[]> = {}
    for (const a of filtered) (m[a.alias_category] ??= []).push(a)
    return m
  }, [filtered])

  const LineSelect = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <select className="cfm-lbl-select" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">— map to line —</option>
      {Object.entries(linesByCat).map(([cat, ls]) => (
        <optgroup key={cat} label={cat}>
          {ls.map(l => (
            <option key={l.line_code} value={l.line_code}>
              {l.nature} · {l.description}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )

  return (
    <div className="cfm-labels">
      <p className="cfm-lbl-intro">
        Map an area's local label onto a canonical line. New mappings apply the next
        time that area is re-staged.
      </p>
      {err && <div className="cfm-lbl-err">{err}</div>}

      {/* pending: labels that didn't map across open runs */}
      {canManage && pending.length > 0 && (
        <section className="cfm-lbl-pending">
          <h4>Didn't map ({pending.length}) — needs a mapping</h4>
          <div className="cfm-lbl-pending-list">
            {pending.map(p => (
              <PendingRow key={p.label} label={p.label} areas={p.runs}
                LineSelect={LineSelect} onAdd={addAlias} busy={busy} />
            ))}
          </div>
        </section>
      )}

      {/* add a mapping manually */}
      {canManage && (
        <section className="cfm-lbl-add">
          <input className="cfm-lbl-text" placeholder="Label exactly as it appears in the file"
            value={newLabel} onChange={e => setNewLabel(e.target.value)} />
          <LineSelect value={newCode} onChange={setNewCode} />
          <button className="cfm-btn" disabled={busy || !newLabel.trim() || !newCode}
            onClick={() => addAlias(newLabel, newCode)}>Add mapping</button>
        </section>
      )}

      {/* existing mappings */}
      <section className="cfm-lbl-list">
        <div className="cfm-lbl-search">
          <input placeholder="Search mappings…" value={q} onChange={e => setQ(e.target.value)} />
          <span className="cfm-lbl-count">{filtered.length} of {aliases.length}</span>
        </div>
        {Object.entries(byCat).map(([cat, as]) => (
          <div key={cat} className="cfm-lbl-cat">
            <div className="cfm-lbl-cat-h">{cat}</div>
            {as.map(a => (
              <div key={a.alias_category + a.alias_nature + a.alias_description} className="cfm-lbl-row">
                <span className="cfm-lbl-alias">{a.alias_description}</span>
                <span className="cfm-lbl-arrow">→</span>
                <span className="cfm-lbl-target">
                  {a.alias_nature} · {lineByCode[a.line_code]?.description ?? a.line_code}
                </span>
                {canManage && (
                  <button className="cfm-lbl-del" title="Delete mapping"
                    onClick={() => delAlias(a)}>✕</button>
                )}
              </div>
            ))}
          </div>
        ))}
      </section>

      {/* chart of lines reference */}
      <section className="cfm-lbl-chart">
        <button className="cfm-sr-toggle" onClick={() => setShowChart(s => !s)}>
          <span className="cfm-sr-caret">{showChart ? '▾' : '▸'}</span>
          Chart of lines ({lines.filter(l => l.is_active).length})
        </button>
        {showChart && (
          <div className="cfm-lbl-chart-body">
            {Object.entries(linesByCat).map(([cat, ls]) => (
              <div key={cat} className="cfm-lbl-cat">
                <div className="cfm-lbl-cat-h">{cat}</div>
                {ls.map(l => (
                  <div key={l.line_code} className="cfm-lbl-row cfm-lbl-row-ref">
                    <span className="cfm-lbl-alias">{l.nature} · {l.description}</span>
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

function PendingRow({ label, areas, LineSelect, onAdd, busy }: {
  label: string; areas: string[]
  LineSelect: (p: { value: string; onChange: (v: string) => void }) => JSX.Element
  onAdd: (label: string, code: string) => void; busy: boolean
}) {
  const [code, setCode] = useState('')
  return (
    <div className="cfm-lbl-pending-row">
      <span className="cfm-lbl-alias">{label}</span>
      <span className="cfm-lbl-areas">{areas.join(', ')}</span>
      <LineSelect value={code} onChange={setCode} />
      <button className="cfm-btn" disabled={busy || !code} onClick={() => onAdd(label, code)}>Map</button>
    </div>
  )
}
