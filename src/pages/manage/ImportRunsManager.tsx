import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import StagingReview from './StagingReview'

const STATUS_LABEL: Record<string, string> = {
  open: 'Unassigned', pushed: 'Pushed', published: 'Published', discarded: 'Discarded',
}
const VERDICT_LABEL: Record<string, string> = {
  tie: 'Ties ✓', break: 'Breaks', no_total: 'No area total',
  single_area: 'Single entity', unknown: '—',
}
const MATERIAL = new Set(['real', 'missing_in_total', 'missing_in_projects'])

function fmtNum(v: any) {
  if (v == null) return '-'
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })
}
function fmtDate(d: any) {
  if (!d) return '-'
  try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) }
  catch { return '-' }
}
function cycleKeyOf(year: any, month: any) {
  return `${year}-${String(month).padStart(2, '0')}`
}

export default function ImportRunsManager({ canManage }: { canManage: boolean }) {
  const [runs, setRuns] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('unassigned')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, any>>({})  // run_id -> { breaks, loading }
  const [busy, setBusy] = useState<string | null>(null)          // run_id currently pushing/discarding
  const [upload, setUpload] = useState<any>({ name: '', state: 'idle', msg: '' }) // idle|busy|ok|err
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Cycles + versions feed the push cascade. Uploads are cycle-agnostic now —
  // the cycle + version are chosen at push time.
  const [cycles, setCycles] = useState<any[]>([])
  const [versions, setVersions] = useState<any[]>([])      // all cf_versions
  // Per-run push cascade choices: run_id -> { cycle?: "YYYY-MM", version?: version_code | '__new__' }
  const [pushPick, setPushPick] = useState<Record<string, { cycle?: string; version?: string }>>({})
  // Canonical line catalog — feeds the inline "map an unmatched label" control.
  const [lines, setLines] = useState<any[]>([])

  const fetchRuns = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('cf_import_runs')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) console.error('cf_import_runs', error)
    else setRuns(data || [])
    setLoading(false)
  }, [])

  const fetchCycles = useCallback(async () => {
    const { data } = await supabase.from('cf_cycles').select('*')
      .order('cycle_year', { ascending: false }).order('cycle_month', { ascending: false })
    setCycles(data || [])
  }, [])

  const fetchVersions = useCallback(async () => {
    const { data } = await supabase.from('cf_versions')
      .select('version_code, label, cycle_year, cycle_month, version_no, is_current, as_of_date')
      .order('version_no', { ascending: true })
    setVersions(data || [])
  }, [])

  const fetchLines = useCallback(async () => {
    const { data } = await supabase.from('cf_lines')
      .select('line_code, category, nature, description, sort_order, is_active')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
    setLines(data || [])
  }, [])

  useEffect(() => { fetchRuns(); fetchCycles(); fetchVersions(); fetchLines() },
    [fetchRuns, fetchCycles, fetchVersions, fetchLines])

  const versionsForCycle = (year: any, month: any) =>
    versions.filter(v => v.cycle_year === year && v.cycle_month === month)

  const cycleByKey = (key: string) =>
    cycles.find(c => cycleKeyOf(c.cycle_year, c.cycle_month) === key) || null

  // Distinct stamped cycles among runs, for the filter pills.
  const stampedCycleKeys = Array.from(new Set(
    runs
      .filter(r => r.cycle_year != null && r.cycle_month != null)
      .map(r => cycleKeyOf(r.cycle_year, r.cycle_month))
  )).sort().reverse()

  const cycleLabel = (key: string) => {
    const c = cycleByKey(key)
    return c?.name || key
  }

  const visible = runs.filter(r => {
    if (filter === 'all') return r.status !== 'discarded'
    if (filter === 'unassigned') return r.status === 'open'
    // a cycle pill: "YYYY-MM"
    return r.cycle_year != null && r.cycle_month != null &&
      cycleKeyOf(r.cycle_year, r.cycle_month) === filter
  })

  const loadDetail = async (run: any) => {
    if (detail[run.run_id]) return
    setDetail(d => ({ ...d, [run.run_id]: { loading: true, breaks: [] } }))
    const { data } = await supabase
      .from('cf_recon_breaks')
      .select('line_code,nature,year,month,sum_projects,area_total,diff,classification')
      .eq('run_id', run.run_id)
    const breaks = (data || [])
      .filter((b: any) => MATERIAL.has(b.classification))
      .sort((a: any, b: any) => Math.abs(b.diff) - Math.abs(a.diff))
      .slice(0, 40)
    setDetail(d => ({ ...d, [run.run_id]: { loading: false, breaks } }))
  }

  const toggle = (run: any) => {
    const next = expanded === run.run_id ? null : run.run_id
    setExpanded(next)
    if (next) loadDetail(run)
  }

  const handleEditArea = async (run: any) => {
    if (!canManage) return
    const next = prompt('Area for this run:', run.area || '')
    if (next === null) return
    const trimmed = next.trim()
    if (!trimmed || trimmed === run.area) return
    setBusy(run.run_id)
    const { error } = await supabase.rpc('cf_set_run_area', { p_run_id: run.run_id, p_area: trimmed })
    setBusy(null)
    if (error) { alert('Set area failed: ' + error.message); return }
    await fetchRuns()
  }

  const handlePush = async (run: any) => {
    if (!canManage) return
    const pick = pushPick[run.run_id] || {}
    const cycleKey = pick.cycle
    const versionChoice = pick.version
    if (!cycleKey || !versionChoice) return
    const cycle = cycleByKey(cycleKey)
    if (!cycle) { alert('Pick a cycle.'); return }

    const { data: { user } } = await supabase.auth.getUser()
    const actor = user?.email || 'dossier'

    setBusy(run.run_id)

    // 1. Resolve the target version code (create a new labelled one if asked).
    let targetCode: string
    if (versionChoice === '__new__') {
      const label = prompt('Label for the new version (e.g. "Base", "Qatar refresh"):', '')
      if (label === null) { setBusy(null); return }
      const { data: cv, error: cvErr } = await supabase.rpc('cf_create_version', {
        p_year: cycle.cycle_year, p_month: cycle.cycle_month,
        p_label: label.trim() || null, p_actor: actor,
      })
      if (cvErr) { setBusy(null); alert('Create version failed: ' + cvErr.message); return }
      const cvRow = Array.isArray(cv) ? cv[0] : cv
      targetCode = (cvRow as any)?.version_code
      await fetchVersions()
    } else {
      targetCode = versionChoice
    }

    // 2. Area-already-in-version check.
    const { count } = await supabase
      .from('cf_forecasts')
      .select('id', { count: 'exact', head: true })
      .eq('version', targetCode)
      .eq('area', run.area)
      .eq('scenario_code', 'Forecast')
    if ((count || 0) > 0) {
      const ok = window.confirm(
        `${run.area} already exists in ${targetCode}. Replace just ${run.area}'s lines in that version?`
      )
      if (!ok) { setBusy(null); return }
    }

    // 3. Push.
    const { data, error } = await supabase.rpc('cf_push_run', {
      p_run_id: run.run_id, p_actor: actor, p_target_version: targetCode,
    })
    setBusy(null)
    if (error) { alert('Push failed: ' + error.message); return }
    const v = Array.isArray(data) ? data[0] : data
    alert(`Pushed ${v?.area} into ${v?.version_code}. ${fmtNum(v?.rows_loaded)} rows loaded ` +
          `(${fmtNum(v?.elapsed_period_rows)} elapsed periods ready to publish).`)
    setPushPick(p => { const next = { ...p }; delete next[run.run_id]; return next })
    await fetchRuns(); await fetchVersions()
  }

  const handleDiscard = async (run: any) => {
    if (!canManage) return
    if (!window.confirm(`Discard the ${run.area} run? It stays on record but is hidden from the active list.`)) return
    setBusy(run.run_id)
    const { error } = await supabase
      .from('cf_import_runs').update({ status: 'discarded' }).eq('run_id', run.run_id)
    setBusy(null)
    if (error) { alert('Error: ' + error.message); return }
    await fetchRuns()
  }

  const handleFile = async (e: any) => {
    const file = e.target.files?.[0]
    if (fileRef.current) fileRef.current.value = ''
    if (!file) return
    setUpload({ name: file.name, state: 'busy', msg: 'Parsing + reconciling…' })
    try {
      const buf = await file.arrayBuffer()
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/cf-stage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
          Authorization: `Bearer ${session?.access_token || ''}`,
        },
        body: buf,
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `stage failed (${res.status})`)
      setUpload({
        name: file.name, state: 'ok',
        msg: `Staged ${json.area}: ${VERDICT_LABEL[json.recon_status] || json.recon_status} · ` +
             `${fmtNum(json.n_rows)} rows · ` +
             `${fmtNum(json.recon_n_breaks)} breaks · ${fmtNum(json.n_unmatched_labels)} unmatched`,
      })
      await fetchRuns()
    } catch (err: any) {
      setUpload({ name: file.name, state: 'err', msg: String(err.message || err) })
    }
  }

  return (
    <div className="cfm-runs">
      {canManage && (
        <div className={`cfm-upload cfm-upload-${upload.state}`}>
          <div className="cfm-upload-main">
            <button
              className="cfm-upload-btn"
              onClick={() => fileRef.current?.click()}
              disabled={upload.state === 'busy'}
            >
              {upload.state === 'busy' ? 'Staging…' : 'Upload area file'}
            </button>
            <span className="cfm-upload-hint">
              .xlsx — parsed, reconciled to the area total, and staged unassigned for review. You choose the cycle + version when you push it.
            </span>
            <input
              ref={fileRef} type="file" accept=".xlsx,.xls"
              style={{ display: 'none' }} onChange={handleFile}
            />
          </div>
          {upload.msg && (
            <div className="cfm-upload-msg">
              <strong>{upload.name}</strong> — {upload.msg}
            </div>
          )}
        </div>
      )}

      <div className="cfm-runs-bar">
        <div className="cfm-filter">
          <button
            className={`cfm-chip ${filter === 'unassigned' ? 'is-active' : ''}`}
            onClick={() => setFilter('unassigned')}
          >
            Unassigned
          </button>
          {stampedCycleKeys.map(k => (
            <button
              key={k}
              className={`cfm-chip ${filter === k ? 'is-active' : ''}`}
              onClick={() => setFilter(k)}
            >
              {cycleLabel(k)}
            </button>
          ))}
          <button
            className={`cfm-chip ${filter === 'all' ? 'is-active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All
          </button>
        </div>
        <button className="cfm-refresh" onClick={fetchRuns} title="Refresh">↻</button>
      </div>

      {loading && <div className="cfm-empty">Loading runs…</div>}
      {!loading && visible.length === 0 && (
        <div className="cfm-empty">No import runs in this view.</div>
      )}

      <div className="cfm-run-list">
        {visible.map(run => {
          const isOpen = expanded === run.run_id
          const d = detail[run.run_id]
          const total = (run.n_actual_rows || 0) + (run.n_forecast_rows || 0)
          const pick = pushPick[run.run_id] || {}
          const cycleVersions = pick.cycle
            ? (() => { const c = cycleByKey(pick.cycle); return c ? versionsForCycle(c.cycle_year, c.cycle_month) : [] })()
            : []
          const stampedCycle = (run.cycle_year != null && run.cycle_month != null)
            ? cycleByKey(cycleKeyOf(run.cycle_year, run.cycle_month))
            : null
          return (
            <div key={run.run_id} className={`cfm-run ${isOpen ? 'is-open' : ''}`}>
              <div className="cfm-run-row" onClick={() => toggle(run)}>
                <span className="cfm-run-caret">{isOpen ? '▾' : '▸'}</span>
                <span className="cfm-run-area">{run.area}</span>
                <span className={`cfm-status cfm-status-${run.status}`}>{STATUS_LABEL[run.status] || run.status}</span>
                <span className={`cfm-verdict cfm-verdict-${run.recon_status}`}>
                  {VERDICT_LABEL[run.recon_status] || run.recon_status}
                </span>
                <span className="cfm-run-meta">
                  {run.n_projects} proj · {fmtNum(total)} rows · {run.currency}
                </span>
                <span className="cfm-run-flags">
                  {run.recon_n_breaks > 0 && (
                    <span className="cfm-flag cfm-flag-break" title="Reconciliation breaks">
                      {run.recon_n_breaks} breaks
                    </span>
                  )}
                  {run.n_unmatched_labels > 0 && (
                    <span className="cfm-flag cfm-flag-unmatched" title="Unmatched labels (dropped from staging)">
                      {run.n_unmatched_labels} unmatched
                    </span>
                  )}
                  {run.n_projects_new > 0 && (
                    <span className="cfm-flag cfm-flag-new" title="Projects new to the catalog">
                      {run.n_projects_new} new
                    </span>
                  )}
                </span>
                <span className="cfm-run-file" title={run.source_file}>{run.source_file}</span>
              </div>

              {isOpen && (
                <div className="cfm-run-detail">
                  {/* header band — destination + action up top, then evidence below */}
                  <div className="cfm-run-head-band">
                    <div className="cfm-rhb-area">
                      <span className="cfm-dl">Area</span>
                      <strong>{run.area}</strong>
                      {canManage && (
                        <button
                          className="cfm-btn cfm-btn-ghost cfm-btn-sm"
                          disabled={busy === run.run_id}
                          onClick={() => handleEditArea(run)}
                        >
                          Edit
                        </button>
                      )}
                    </div>
                    {canManage && (run.status === 'open' || run.status === 'pushed') && (
                      <div className="cfm-rhb-assign">
                        <label className="cfm-field cfm-field-inline">
                          <span>Cycle</span>
                          <select
                            value={pick.cycle ?? ''}
                            onChange={e => {
                              const v = e.target.value
                              setPushPick(p => ({ ...p, [run.run_id]: { cycle: v || undefined, version: undefined } }))
                            }}
                          >
                            <option value="">Choose a cycle…</option>
                            {cycles.map(c => {
                              const k = cycleKeyOf(c.cycle_year, c.cycle_month)
                              return (
                                <option key={k} value={k}>
                                  {c.name} · as-of {c.as_of_date}{c.is_legacy ? ' · legacy' : ''}
                                </option>
                              )
                            })}
                          </select>
                        </label>
                        <label className="cfm-field cfm-field-inline cfm-push-target">
                          <span>Version</span>
                          <select
                            value={pick.version ?? ''}
                            disabled={!pick.cycle}
                            onChange={e => {
                              const v = e.target.value
                              setPushPick(p => ({ ...p, [run.run_id]: { ...(p[run.run_id] || {}), version: v || undefined } }))
                            }}
                          >
                            <option value="">Choose a version…</option>
                            {cycleVersions.map(v => (
                              <option key={v.version_code} value={v.version_code}>
                                {v.version_code}{v.label ? ` — ${v.label}` : ''}{v.is_current ? ' ●' : ''}
                              </option>
                            ))}
                            <option value="__new__">＋ New labelled version…</option>
                          </select>
                        </label>
                        <button
                          className="cfm-btn cfm-btn-primary"
                          disabled={busy === run.run_id || !pick.cycle || !pick.version}
                          onClick={() => handlePush(run)}
                        >
                          {busy === run.run_id ? 'Pushing…' : (run.status === 'pushed' ? 'Re-push' : 'Push')}
                        </button>
                        <button
                          className="cfm-btn cfm-btn-ghost"
                          disabled={busy === run.run_id}
                          onClick={() => handleDiscard(run)}
                        >
                          Discard
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="cfm-rhb-meta">
                    {run.status === 'open'
                      ? <span>Unassigned — pick a cycle + version, then Push. Area detected from the filename — Edit if wrong.</span>
                      : <span>In <strong>{run.pushed_version_code || '—'}</strong> · {stampedCycle?.name || cycleKeyOf(run.cycle_year, run.cycle_month)}</span>}
                    <span className="cfm-rhb-meta-stat">{fmtNum(total)} rows · staged {fmtDate(run.created_at)}</span>
                    {run.status === 'pushed' && run.pushed_version_code && (
                      <span className="cfm-pushed-note">Loaded — publish it in Cycles &amp; versions.</span>
                    )}
                  </div>

                  <StagingReview runId={run.run_id} currency={run.currency} run={run} />

                  <UnmatchedLabels summary={run.recon_summary} lines={lines} canManage={canManage} />

                  <details className="cfm-recon-drill">
                    <summary>Reconciliation — Σ projects vs area total ({run.currency})</summary>
                    <div className="cfm-breaks">
                      {d?.loading && <div className="cfm-empty-sm">Loading breaks…</div>}
                      {d && !d.loading && d.breaks.length === 0 && (
                        <div className="cfm-empty-sm">No material flow breaks — projects tie to the area total.</div>
                      )}
                      {d && !d.loading && d.breaks.length > 0 && (
                        <table className="cfm-breaks-table">
                          <thead>
                            <tr><th>Line</th><th>Period</th><th>Nature</th><th className="num">Σ projects</th><th className="num">Area total</th><th className="num">Δ</th><th>Class</th></tr>
                          </thead>
                          <tbody>
                            {d.breaks.map((b: any, i: number) => (
                              <tr key={i}>
                                <td className="mono">{b.line_code}</td>
                                <td>{b.year}-{String(b.month).padStart(2, '0')}</td>
                                <td>{b.nature || '-'}</td>
                                <td className="num">{fmtNum(b.sum_projects)}</td>
                                <td className="num">{fmtNum(b.area_total)}</td>
                                <td className={`num ${b.diff < 0 ? 'neg' : 'pos'}`}>{fmtNum(b.diff)}</td>
                                <td><span className={`cfm-cls cfm-cls-${b.classification}`}>{b.classification.replace(/_/g, ' ')}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </details>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function UnmatchedLabels({ summary, lines, canManage }: {
  summary: any
  lines: { line_code: string; category: string; nature: string; description: string }[]
  canManage: boolean
}) {
  const labels = summary?.unmatched_labels
  const [open, setOpen] = useState(false)
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [done, setDone] = useState<Record<string, string>>({})   // label -> line_code mapped this session
  const [busy, setBusy] = useState<string | null>(null)
  if (!labels || Object.keys(labels).length === 0) return null
  // Tolerate the old {label: count} shape and the new {label: {count, locations}}.
  const norm = (v: any) => typeof v === 'number'
    ? { count: v, locations: [] as string[] }
    : { count: (v?.count ?? 0) as number, locations: (v?.locations ?? []) as string[] }
  const entries = Object.entries(labels)
    .map(([lab, v]) => [lab, norm(v)] as [string, { count: number; locations: string[] }])
    .sort((a, b) => b[1].count - a[1].count)

  const mapLabel = async (label: string) => {
    const code = picks[label]
    if (!code) return
    setBusy(label)
    const { error } = await supabase.rpc('cf_map_line_alias', {
      p_alias: label, p_line_code: code, p_notes: 'mapped in staging',
    })
    setBusy(null)
    if (error) { alert('Map failed: ' + error.message); return }
    setDone(d => ({ ...d, [label]: code }))
  }

  return (
    <div className="cfm-unmatched">
      <button className="cfm-sr-toggle is-warn" onClick={() => setOpen(o => !o)}>
        <span className="cfm-sr-caret">{open ? '▾' : '▸'}</span>
        Lines that didn't map ({entries.length})
      </button>
      {open && (
        <div className="cfm-unmatched-body">
          <div className="cfm-sr-cap cfm-sr-cap-sm">
            These rows were dropped from staging. Map each to a canonical line so the parser catches it next upload.
          </div>
          <div className="cfm-unmatched-list">
            {entries.map(([lab, info]) => {
              const mappedCode = done[lab]
              return (
                <div key={lab} className={`cfm-unmatched-row ${mappedCode ? 'is-mapped' : ''}`}>
                  <div className="cfm-unmatched-id">
                    <span className="cfm-unmatched-label" title={`${info.count}×`}>
                      {lab}{info.count > 1 ? ` ×${info.count}` : ''}
                    </span>
                    {info.locations.length > 0 && (
                      <span className="cfm-unmatched-locs">
                        {info.locations.map(loc => (
                          <span key={loc} className="cfm-loc-pill" title="Sheet ! cell in the source file">{loc}</span>
                        ))}
                      </span>
                    )}
                  </div>
                  {mappedCode ? (
                    <span className="cfm-unmatched-mapped">→ {mappedCode} ✓</span>
                  ) : canManage ? (
                    <span className="cfm-unmatched-map">
                      <select
                        value={picks[lab] || ''}
                        onChange={e => setPicks(p => ({ ...p, [lab]: e.target.value }))}
                      >
                        <option value="">Map to…</option>
                        {lines.map(l => (
                          <option key={l.line_code} value={l.line_code}>
                            {l.category} · {l.nature} · {l.description}
                          </option>
                        ))}
                      </select>
                      <button
                        className="cfm-btn cfm-btn-ghost cfm-btn-sm"
                        disabled={!picks[lab] || busy === lab}
                        onClick={() => mapLabel(lab)}
                      >
                        {busy === lab ? '…' : 'Map'}
                      </button>
                    </span>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
