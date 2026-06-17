import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const cycleKey = (v: any) => `${v.cycle_year}-${String(v.cycle_month).padStart(2, '0')}`
const cycleLabel = (v: any) => `${MONTHS[(v.cycle_month || 1) - 1] || ''} ${v.cycle_year}`

function fmtDate(d: any) {
  if (!d) return '-'
  try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) }
  catch { return '-' }
}
function fmtNum(v: any) {
  if (v == null) return '-'
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function CycleVersionManager({ canManage }: { canManage: boolean }) {
  const [versions, setVersions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(() => {
    try { return localStorage.getItem('cfm_versions_show_inactive') !== '0' } catch { return true }
  })
  const [compareMode, setCompareMode] = useState(false)
  const [picked, setPicked] = useState<string[]>([])      // up to 2 version_codes
  const [compare, setCompare] = useState<any>(null)        // { a, b, rows, loading }

  const fetchVersions = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('cf_versions')
      .select('*')
      .order('cycle_year', { ascending: false })
      .order('cycle_month', { ascending: false })
      .order('version_no', { ascending: true })
    if (error) console.error('cf_versions', error)
    else setVersions(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchVersions() }, [fetchVersions])

  const toggleShowInactive = () => {
    setShowInactive(v => {
      const next = !v
      try { localStorage.setItem('cfm_versions_show_inactive', next ? '1' : '0') } catch { /* noop */ }
      return next
    })
  }

  const visible = showInactive ? versions : versions.filter(v => v.is_active)
  const inactiveCount = versions.filter(v => !v.is_active).length

  const groups = (() => {
    const m = new Map<string, any[]>()
    for (const v of visible) {
      const k = cycleKey(v)
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(v)
    }
    return Array.from(m.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([k, rows]) => ({ key: k, label: cycleLabel(rows[0]), rows }))
  })()

  const handleSetCurrent = async (v: any) => {
    if (!canManage || v.is_current) return
    setBusy(v.version_code)
    // one in-force version per cycle
    await supabase.from('cf_versions').update({ is_current: false })
      .eq('cycle_year', v.cycle_year).eq('cycle_month', v.cycle_month)
    const { error } = await supabase.from('cf_versions').update({ is_current: true })
      .eq('version_code', v.version_code)
    setBusy(null)
    if (error) alert('Error: ' + error.message)
    await fetchVersions()
  }

  const handleToggleActive = async (v: any) => {
    if (!canManage) return
    setBusy(v.version_code)
    const { error } = await supabase.from('cf_versions')
      .update({ is_active: !v.is_active }).eq('version_code', v.version_code)
    setBusy(null)
    if (error) alert('Error: ' + error.message)
    await fetchVersions()
  }

  const handleFinalLabel = async (v: any) => {
    if (!canManage) return
    const next = prompt(
      'Tag this version as final / adopted.\nExamples: Final, Adopted, Board June 2026.\nLeave empty to clear.',
      v.final_label || ''
    )
    if (next === null) return
    const value = next.trim()
    const { error } = await supabase.from('cf_versions')
      .update({ final_label: value === '' ? null : value }).eq('version_code', v.version_code)
    if (error) alert('Error: ' + error.message)
    await fetchVersions()
  }

  const handlePublish = async (v: any) => {
    if (!canManage) return
    const ok = window.confirm(
      `Publish "${v.version_code}" (cycle ${cycleLabel(v)})?\n\n` +
      `This promotes every period up to ${fmtDate(v.as_of_date)} into the continuous ` +
      `actuals series, supersedes the legacy area-grain actuals for those cells ` +
      `(reversible — backed up), sets this as the cycle's current version, and stamps it published.\n\n` +
      `Actuals are extended. This is the deliberate actualization step.`
    )
    if (!ok) return
    setBusy(v.version_code)
    const { data: { user } } = await supabase.auth.getUser()
    const { data, error } = await supabase.rpc('cf_publish_version', {
      p_version_code: v.version_code, p_actor: user?.email || 'dossier',
    })
    setBusy(null)
    if (error) { alert('Publish failed: ' + error.message); return }
    alert(`Published ${v.version_code}. ${fmtNum(data)} actuals rows committed/updated.`)
    await fetchVersions()
  }

  const togglePick = (code: string) => {
    setPicked(prev => {
      if (prev.includes(code)) return prev.filter(c => c !== code)
      if (prev.length >= 2) return [prev[1], code]
      return [...prev, code]
    })
  }

  const runCompare = async () => {
    if (picked.length !== 2) return
    const [a, b] = picked
    setCompare({ a, b, loading: true, rows: [] })
    const [ra, rb] = await Promise.all([
      supabase.rpc('cf_version_area_totals', { p_version: a }),
      supabase.rpc('cf_version_area_totals', { p_version: b }),
    ])
    const ma = new Map((ra.data || []).map((r: any) => [r.area, r]))
    const mb = new Map((rb.data || []).map((r: any) => [r.area, r]))
    const areas = Array.from(new Set([...ma.keys(), ...mb.keys()])).sort()
    const rows = areas.map(area => {
      const va = Number((ma.get(area) as any)?.total || 0)
      const vb = Number((mb.get(area) as any)?.total || 0)
      return { area, va, vb, delta: vb - va }
    })
    setCompare({ a, b, loading: false, rows })
  }

  return (
    <div className="cfm-versions">
      <div className="cfm-runs-bar">
        <button
          className={`cfm-chip ${compareMode ? 'is-active' : ''}`}
          onClick={() => { setCompareMode(m => !m); setPicked([]); setCompare(null) }}
        >
          Compare versions
        </button>
        {compareMode && (
          <button className="cfm-btn cfm-btn-primary cfm-btn-sm" disabled={picked.length !== 2} onClick={runCompare}>
            Compare {picked.length}/2
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          className={`cfm-chip ${showInactive ? '' : 'is-off'}`}
          onClick={toggleShowInactive}
        >
          {showInactive ? '◉' : '○'} {showInactive ? 'Hide inactive' : 'Show inactive'}
          {inactiveCount > 0 && <span className="cfm-chip-count">({inactiveCount})</span>}
        </button>
      </div>

      {compare && (
        <div className="cfm-compare">
          <div className="cfm-compare-head">
            Forecast totals by area — <strong>{compare.a}</strong> vs <strong>{compare.b}</strong>
            <button className="cfm-compare-close" onClick={() => setCompare(null)}>×</button>
          </div>
          {compare.loading ? <div className="cfm-empty-sm">Loading…</div> : (
            <table className="cfm-breaks-table">
              <thead><tr><th>Area</th><th className="num">{compare.a}</th><th className="num">{compare.b}</th><th className="num">Δ (drift)</th></tr></thead>
              <tbody>
                {compare.rows.map((r: any) => (
                  <tr key={r.area}>
                    <td>{r.area}</td>
                    <td className="num">{fmtNum(r.va)}</td>
                    <td className="num">{fmtNum(r.vb)}</td>
                    <td className={`num ${r.delta < 0 ? 'neg' : (r.delta > 0 ? 'pos' : '')}`}>{r.delta ? fmtNum(r.delta) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {loading && <div className="cfm-empty">Loading versions…</div>}
      {!loading && groups.length === 0 && <div className="cfm-empty">No cash flow versions yet.</div>}

      <table className="cfm-ver-table">
        <thead>
          <tr>
            {compareMode && <th className="cfm-ver-pick" />}
            <th>Version</th><th>#</th><th>As of</th><th>Source</th><th>Loaded</th>
            <th className="cfm-ver-c">Current</th><th className="cfm-ver-c">Active</th><th>Final</th><th>Published</th><th />
          </tr>
        </thead>
        <tbody>
          {groups.map(group => (
            <React.Fragment key={group.key}>
              <tr className="cfm-ver-grouphead">
                <th colSpan={compareMode ? 11 : 10}>
                  <span className="cfm-ver-cyclebadge">{group.label}</span>
                  <span className="cfm-ver-cyclecount">{group.rows.length} version{group.rows.length > 1 ? 's' : ''}</span>
                </th>
              </tr>
              {group.rows.map((v: any) => (
                <tr key={v.version_code} className={!v.is_active ? 'inactive' : ''}>
                  {compareMode && (
                    <td className="cfm-ver-pick">
                      <input type="checkbox" checked={picked.includes(v.version_code)} onChange={() => togglePick(v.version_code)} />
                    </td>
                  )}
                  <td className="mono" title={v.version_code}>{v.version_code}</td>
                  <td>{v.version_no}</td>
                  <td>{fmtDate(v.as_of_date)}</td>
                  <td className="cfm-ver-src" title={v.source_file || ''}>{v.source_file || '-'}</td>
                  <td>{fmtDate(v.loaded_at)}</td>
                  <td className="cfm-ver-c">
                    <button
                      className={`cfm-radio ${v.is_current ? 'on' : ''}`}
                      disabled={!canManage || busy === v.version_code}
                      onClick={() => handleSetCurrent(v)}
                      title={v.is_current ? 'Current in-force version' : 'Set as current for this cycle'}
                    >{v.is_current ? '●' : '○'}</button>
                  </td>
                  <td className="cfm-ver-c">
                    <button
                      className={`coord-active-toggle ${v.is_active ? 'on' : 'off'}`}
                      disabled={!canManage || busy === v.version_code}
                      onClick={() => handleToggleActive(v)}
                    ><span className="coord-active-knob" /></button>
                  </td>
                  <td>
                    {v.final_label ? (
                      <button className="coord-final-pill" disabled={!canManage} onClick={() => handleFinalLabel(v)}>{v.final_label}</button>
                    ) : (
                      <button className="coord-final-add" disabled={!canManage} onClick={() => handleFinalLabel(v)}>+ Final</button>
                    )}
                  </td>
                  <td className="cfm-ver-pub">
                    {v.published_at
                      ? <span className="cfm-pub-yes" title={`by ${v.published_by || '-'}`}>{fmtDate(v.published_at)}</span>
                      : <span className="cfm-pub-no">—</span>}
                  </td>
                  <td>
                    {canManage && (
                      <button
                        className="cfm-btn cfm-btn-publish cfm-btn-sm"
                        disabled={busy === v.version_code}
                        onClick={() => handlePublish(v)}
                        title="Promote elapsed periods into the actuals series"
                      >
                        {busy === v.version_code ? '…' : (v.published_at ? 'Re-publish' : 'Publish')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}
