import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'

const STATUS_LABEL: Record<string, string> = {
  open: 'Open', pushed: 'Pushed', published: 'Published', discarded: 'Discarded',
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

export default function ImportRunsManager({ canManage }: { canManage: boolean }) {
  const [runs, setRuns] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('active') // active = open+pushed
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, any>>({})  // run_id -> { breaks, loading }
  const [busy, setBusy] = useState<string | null>(null)          // run_id currently pushing/discarding
  const [upload, setUpload] = useState<any>({ name: '', state: 'idle', msg: '' }) // idle|busy|ok|err
  const fileRef = useRef<HTMLInputElement | null>(null)

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

  useEffect(() => { fetchRuns() }, [fetchRuns])

  const visible = runs.filter(r => {
    if (statusFilter === 'all') return true
    if (statusFilter === 'active') return r.status === 'open' || r.status === 'pushed'
    return r.status === statusFilter
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

  const handlePush = async (run: any) => {
    if (!canManage) return
    const ok = window.confirm(
      `Push ${run.area} (${run.source_file}) into version "${run.proposed_version}"?\n\n` +
      `Loads ${(run.n_actual_rows + run.n_forecast_rows).toLocaleString()} staged rows into the ` +
      `cycle's forecast. This does NOT change actuals yet — Publish does that.`
    )
    if (!ok) return
    setBusy(run.run_id)
    const { data: { user } } = await supabase.auth.getUser()
    const { data, error } = await supabase.rpc('cf_push_run', {
      p_run_id: run.run_id, p_actor: user?.email || 'dossier',
    })
    setBusy(null)
    if (error) { alert('Push failed: ' + error.message); return }
    const v = Array.isArray(data) ? data[0] : data
    alert(`Pushed into ${v?.version_code}. ${fmtNum(v?.rows_loaded)} rows loaded ` +
          `(${fmtNum(v?.elapsed_period_rows)} elapsed periods ready to publish).`)
    await fetchRuns()
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
    setUpload({ name: file.name, state: 'busy', msg: 'Parsing + reconciling on the server…' })
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
             `${fmtNum(json.n_actual_rows + json.n_forecast_rows)} rows · ` +
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
              .xlsx — parsed, reconciled to AREA TOTAL, and staged as an open run for review.
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
          {['active', 'open', 'pushed', 'published', 'all'].map(s => (
            <button
              key={s}
              className={`cfm-chip ${statusFilter === s ? 'is-active' : ''}`}
              onClick={() => setStatusFilter(s)}
            >
              {s === 'active' ? 'Active' : (STATUS_LABEL[s] || 'All')}
            </button>
          ))}
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
          return (
            <div key={run.run_id} className={`cfm-run ${isOpen ? 'is-open' : ''}`}>
              <div className="cfm-run-row" onClick={() => toggle(run)}>
                <span className="cfm-run-caret">{isOpen ? '▾' : '▸'}</span>
                <span className="cfm-run-area">{run.area}</span>
                <span className={`cfm-status cfm-status-${run.status}`}>{STATUS_LABEL[run.status]}</span>
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
                  <div className="cfm-detail-grid">
                    <div><span className="cfm-dl">Cycle</span>{run.cycle_year}-{String(run.cycle_month).padStart(2, '0')} → {run.proposed_version}</div>
                    <div><span className="cfm-dl">As of</span>{fmtDate(run.as_of_date)}</div>
                    <div><span className="cfm-dl">Actual / Forecast</span>{fmtNum(run.n_actual_rows)} / {fmtNum(run.n_forecast_rows)}</div>
                    <div><span className="cfm-dl">Target sheet</span>{run.recon_target_sheet || '—'}</div>
                    <div><span className="cfm-dl">Max |Δ|</span>{fmtNum(run.recon_max_abs_diff)}</div>
                    <div><span className="cfm-dl">Staged</span>{fmtDate(run.created_at)}</div>
                  </div>

                  <UnmatchedLabels summary={run.recon_summary} />

                  <div className="cfm-breaks">
                    <div className="cfm-breaks-head">Reconciliation breaks — Σ projects vs {run.recon_target_sheet || 'area total'} ({run.currency})</div>
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

                  {canManage && run.status !== 'published' && run.status !== 'discarded' && (
                    <div className="cfm-run-actions">
                      <button
                        className="cfm-btn cfm-btn-primary"
                        disabled={busy === run.run_id}
                        onClick={() => handlePush(run)}
                      >
                        {busy === run.run_id ? 'Pushing…' : (run.status === 'pushed' ? 'Re-push version' : 'Push as version')}
                      </button>
                      <button
                        className="cfm-btn cfm-btn-ghost"
                        disabled={busy === run.run_id}
                        onClick={() => handleDiscard(run)}
                      >
                        Discard
                      </button>
                      {run.status === 'pushed' && run.pushed_version_code && (
                        <span className="cfm-pushed-note">
                          Loaded into <strong>{run.pushed_version_code}</strong> — publish it in Cycles &amp; versions.
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function UnmatchedLabels({ summary }: { summary: any }) {
  const labels = summary?.unmatched_labels
  if (!labels || Object.keys(labels).length === 0) return null
  const entries = Object.entries(labels).sort((a: any, b: any) => b[1] - a[1])
  return (
    <div className="cfm-unmatched">
      <span className="cfm-unmatched-head">Unmatched labels (not staged):</span>
      {entries.map(([lab, n]: any) => (
        <span key={lab} className="cfm-unmatched-pill" title={`${n}×`}>{lab}{n > 1 ? ` ×${n}` : ''}</span>
      ))}
    </div>
  )
}
