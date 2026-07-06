import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { usePersistedState } from '@/lib/persist'
import StagingReview from './StagingReview'

const STATUS_LABEL: Record<string, string> = {
  open: 'Unassigned', pushed: 'Pushed', published: 'Published', discarded: 'Discarded',
}
const VERDICT_LABEL: Record<string, string> = {
  tie: 'Ties ✓', break: 'Breaks', no_total: 'No area total',
  single_area: 'Single entity', unknown: '—',
}

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
  // Persisted across unmount so leaving the tab/module and returning keeps the
  // reviewer's place (the panel unmounts this component on sub-tab switch).
  const [filter, setFilter] = usePersistedState<string>('cfm.runs.filter', 'unassigned')
  const [expanded, setExpanded] = usePersistedState<string | null>('cfm.runs.expanded', null)
  const [busy, setBusy] = useState<string | null>(null)          // run_id currently pushing/discarding
  const [upload, setUpload] = useState<any>({ name: '', state: 'idle', msg: '' }) // idle|busy|ok|err
  const [reapplyTok, setReapplyTok] = useState<Record<string, number>>({})  // run_id -> remount nonce
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

  const toggle = (run: any) => {
    setExpanded(expanded === run.run_id ? null : run.run_id)
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

  // Re-parse the run's stored file, picking up line mappings added since staging.
  // Keeps the Included/Ignored sheet selection; rewrites the staged rows in place.
  const handleReapply = async (run: any) => {
    if (!canManage) return
    setBusy(run.run_id)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const r = await fetch('/api/cf-restage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify({ run_id: run.run_id }),
      })
      const json = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(json.error || `re-apply failed (${r.status})`)
      await fetchRuns()
      setReapplyTok(t => ({ ...t, [run.run_id]: (t[run.run_id] || 0) + 1 }))  // force the review to remount
    } catch (err: any) {
      alert('Re-apply failed: ' + (err.message || err))
    } finally {
      setBusy(null)
    }
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
                {run.recon_status && run.recon_status !== 'unknown' && (
                  <span
                    className={`cfm-run-verdict cfm-run-verdict-${run.recon_status === 'tie' ? 'ok' : run.recon_status === 'break' ? 'off' : 'neutral'}`}
                    title={
                      run.recon_status === 'tie' ? 'Reconciles to the area total'
                      : run.recon_status === 'break' ? `${run.recon_n_breaks || 0} line(s) don’t reconcile to the area total`
                      : VERDICT_LABEL[run.recon_status] || run.recon_status
                    }
                  >
                    {run.recon_status === 'tie'
                      ? '✓ Ties'
                      : run.recon_status === 'break'
                        ? `✕ Breaks${run.recon_n_breaks ? ` ${run.recon_n_breaks}` : ''}`
                        : VERDICT_LABEL[run.recon_status] || run.recon_status}
                  </span>
                )}
                {run.status !== 'open' && (
                  <span className={`cfm-status cfm-status-${run.status}`}>{STATUS_LABEL[run.status] || run.status}</span>
                )}
                <span className="cfm-run-meta">
                  {run.n_projects} proj · {fmtNum(total)} rows · {run.currency}
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
                        {run.status === 'open' && (
                          <button
                            className="cfm-btn cfm-btn-ghost cfm-reapply"
                            disabled={busy === run.run_id}
                            title="Re-parse the original file, applying any line mappings you've added. Keeps your Included/Ignored sheet selection."
                            onClick={() => handleReapply(run)}
                          >
                            {busy === run.run_id ? 'Re-applying…' : '↻ Re-apply mappings'}
                          </button>
                        )}
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

                  <StagingReview key={`${run.run_id}:${reapplyTok[run.run_id] || 0}`}
                                 runId={run.run_id} currency={run.currency} run={run}
                                 lines={lines} canManage={canManage}
                                 onIncludedChange={(inc) => setRuns(rs => rs.map(r =>
                                   r.run_id === run.run_id ? { ...r, included_sheets: inc } : r))} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
