import { useState, useEffect, useMemo } from 'react'
import { supabase } from '@/lib/supabase'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const cycleKeyOf = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`
const cycleLabelOf = (y: number, m: number) => `${MONTHS[(m || 1) - 1] || ''} ${y}`
const periodLabel = (y: number, m: number) => `${MONTHS[m - 1]} ${String(y).slice(2)}`

function fmtNum(v: any) {
  if (v == null) return '-'
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
function fmtTs(d: any) {
  if (!d) return '-'
  try { return new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) }
  catch { return '-' }
}

const VERDICT_LABEL: Record<string, string> = { tie: 'Ties', break: 'Breaks', no_total: 'No total', single_area: 'Single', unknown: '—' }
const STATUS_LABEL: Record<string, string> = { open: 'Open', pushed: 'Pushed', published: 'Published', discarded: 'Discarded' }

// Logs — the Manage-mode audit trail. Two streams, both filterable by cycle/version:
//   Uploads        — cf_import_runs (who/when/which file + reconciliation result per upload)
//   Forecast edits — cf_forecasts_history (old->new/who/when/why, written by cf_edit_forecast)
export default function ForecastLogs() {
  const [versions, setVersions] = useState<any[]>([])
  const [runs, setRuns] = useState<any[]>([])
  const [edits, setEdits] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('edits')     // edits | uploads
  const [cycle, setCycle] = useState('all')
  const [version, setVersion] = useState('all')

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      const [{ data: vs }, { data: rs }, { data: es }] = await Promise.all([
        supabase.from('cf_versions').select('version_code,cycle_year,cycle_month,version_no,final_label'),
        supabase.from('cf_import_runs').select('*').order('created_at', { ascending: false }),
        supabase.from('cf_forecasts_history')
          .select('id,version,area,project_code,line_code,year,month,old_value,new_value,changed_by,reason,changed_at')
          .order('changed_at', { ascending: false }).limit(1000),
      ])
      if (!alive) return
      setVersions(vs || [])
      setRuns(rs || [])
      setEdits(es || [])
      setLoading(false)
    })()
    return () => { alive = false }
  }, [])

  // version_code -> cycle key, for filtering the edit stream by cycle
  const verCycle = useMemo(() => {
    const m = new Map<string, string>()
    for (const v of versions) m.set(v.version_code, cycleKeyOf(v.cycle_year, v.cycle_month))
    return m
  }, [versions])

  const cycleOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const v of versions) {
      const k = cycleKeyOf(v.cycle_year, v.cycle_month)
      if (!seen.has(k)) seen.set(k, cycleLabelOf(v.cycle_year, v.cycle_month))
    }
    return Array.from(seen.entries()).sort((a, b) => b[0].localeCompare(a[0]))
  }, [versions])

  const versionOptions = useMemo(() => {
    return versions
      .filter(v => cycle === 'all' || cycleKeyOf(v.cycle_year, v.cycle_month) === cycle)
      .sort((a, b) => cycleKeyOf(b.cycle_year, b.cycle_month).localeCompare(cycleKeyOf(a.cycle_year, a.cycle_month)) || a.version_no - b.version_no)
      .map(v => v.version_code)
  }, [versions, cycle])

  // keep version filter valid when cycle changes
  useEffect(() => {
    if (version !== 'all' && !versionOptions.includes(version)) setVersion('all')
  }, [versionOptions, version])

  const filteredRuns = useMemo(() => runs.filter(r => {
    if (cycle !== 'all' && cycleKeyOf(r.cycle_year, r.cycle_month) !== cycle) return false
    if (version !== 'all' && r.pushed_version_code !== version && r.proposed_version !== version) return false
    return true
  }), [runs, cycle, version])

  const filteredEdits = useMemo(() => edits.filter(e => {
    if (version !== 'all' && e.version !== version) return false
    if (cycle !== 'all' && verCycle.get(e.version) !== cycle) return false
    return true
  }), [edits, cycle, version, verCycle])

  return (
    <div className="cfm-logs">
      <div className="cfm-runs-bar">
        <div className="cfm-filter">
          <button className={`cfm-chip ${view === 'edits' ? 'is-active' : ''}`} onClick={() => setView('edits')}>
            Forecast edits{filteredEdits.length ? ` (${filteredEdits.length})` : ''}
          </button>
          <button className={`cfm-chip ${view === 'uploads' ? 'is-active' : ''}`} onClick={() => setView('uploads')}>
            Uploads{filteredRuns.length ? ` (${filteredRuns.length})` : ''}
          </button>
        </div>
        <span style={{ flex: 1 }} />
        <label className="cfm-field cfm-field-inline">
          <span>Cycle</span>
          <select value={cycle} onChange={e => setCycle(e.target.value)}>
            <option value="all">All cycles</option>
            {cycleOptions.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        <label className="cfm-field cfm-field-inline">
          <span>Version</span>
          <select value={version} onChange={e => setVersion(e.target.value)}>
            <option value="all">All versions</option>
            {versionOptions.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      </div>

      {loading && <div className="cfm-empty">Loading logs…</div>}

      {!loading && view === 'edits' && (
        filteredEdits.length === 0
          ? <div className="cfm-empty">No forecast edits for this filter.</div>
          : (
            <table className="cfm-breaks-table cfm-log-table">
              <thead>
                <tr>
                  <th>When</th><th>Version</th><th>Area</th><th>Project</th><th>Line</th><th>Period</th>
                  <th className="num">Old</th><th className="num">New</th><th className="num">Δ</th><th>By</th><th>Why</th>
                </tr>
              </thead>
              <tbody>
                {filteredEdits.map(e => {
                  const delta = Number(e.new_value) - Number(e.old_value)
                  return (
                    <tr key={e.id}>
                      <td>{fmtTs(e.changed_at)}</td>
                      <td className="mono">{e.version}</td>
                      <td>{e.area}</td>
                      <td className="mono">{e.project_code}</td>
                      <td className="mono">{e.line_code}</td>
                      <td>{periodLabel(e.year, e.month)}</td>
                      <td className="num">{fmtNum(e.old_value)}</td>
                      <td className="num">{fmtNum(e.new_value)}</td>
                      <td className={`num ${delta < 0 ? 'neg' : (delta > 0 ? 'pos' : '')}`}>{delta ? fmtNum(delta) : '—'}</td>
                      <td className="cfm-log-by">{e.changed_by || '-'}</td>
                      <td className="cfm-log-why" title={e.reason || ''}>{e.reason || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )
      )}

      {!loading && view === 'uploads' && (
        filteredRuns.length === 0
          ? <div className="cfm-empty">No uploads for this filter.</div>
          : (
            <table className="cfm-breaks-table cfm-log-table">
              <thead>
                <tr>
                  <th>When</th><th>Area</th><th>File</th><th>Cycle → version</th><th>Status</th>
                  <th>Reconcile</th><th className="num">Breaks</th><th className="num">Unmatched</th><th>By</th>
                </tr>
              </thead>
              <tbody>
                {filteredRuns.map(r => (
                  <tr key={r.run_id}>
                    <td>{fmtTs(r.created_at)}</td>
                    <td>{r.area}</td>
                    <td className="cfm-log-file" title={r.source_file}>{r.source_file}</td>
                    <td className="mono">{cycleKeyOf(r.cycle_year, r.cycle_month)} → {r.pushed_version_code || r.proposed_version}</td>
                    <td><span className={`cfm-status cfm-status-${r.status}`}>{STATUS_LABEL[r.status] || r.status}</span></td>
                    <td><span className={`cfm-verdict cfm-verdict-${r.recon_status}`}>{VERDICT_LABEL[r.recon_status] || r.recon_status}</span></td>
                    <td className="num">{r.recon_n_breaks || 0}</td>
                    <td className="num">{r.n_unmatched_labels || 0}</td>
                    <td className="cfm-log-by">{r.created_by || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}
    </div>
  )
}
