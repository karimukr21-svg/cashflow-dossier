import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { supabase } from '@/lib/supabase'
import { cccGridTheme } from '@/lib/agGridSetup'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const cycleLabel = (v: any) => `${MONTHS[(v.cycle_month || 1) - 1] || ''} ${v.cycle_year}`
const ym = (y: number, m: number) => y * 100 + m
const periodField = (y: number, m: number) => `p_${y}_${m}`
const periodLabel = (y: number, m: number) => `${MONTHS[m - 1]} ${String(y).slice(2)}`

function asOfYm(dateStr: any) {
  if (!dateStr) return 0
  const d = new Date(dateStr)
  return ym(d.getUTCFullYear(), d.getUTCMonth() + 1)
}

// Adjust — edit the open version's forecast cells in place (AG Grid native editors).
// Every change goes through cf_edit_forecast, which sets the app.user/app.edit_reason
// GUCs so the existing trigger writes an old->new/who/when/why row to cf_forecasts_history.
// Actuals are a separate table and are never shown here — they stay locked.
export default function AdjustForecasts({ canManage }: { canManage: boolean }) {
  const [versions, setVersions] = useState<any[]>([])
  const [version, setVersion] = useState('')
  const [areas, setAreas] = useState<string[]>([])
  const [area, setArea] = useState('')
  const [rowData, setRowData] = useState<any[]>([])
  const [periods, setPeriods] = useState<any[]>([])   // [{year,month}]
  const [loading, setLoading] = useState(false)
  const [reason, setReason] = useState('')
  const [status, setStatus] = useState<any>(null)     // { kind:'ok'|'err'|'busy', msg }
  const [actor, setActor] = useState('dossier')
  const gridRef = useRef<any>(null)

  const verRow = versions.find(v => v.version_code === version) || null
  const asof = asOfYm(verRow?.as_of_date)

  // who is editing (for the audit trail)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setActor(data?.user?.email || 'dossier'))
  }, [])

  // versions for the picker (active only)
  useEffect(() => {
    supabase.from('cf_versions').select('*')
      .order('cycle_year', { ascending: false })
      .order('cycle_month', { ascending: false })
      .order('version_no', { ascending: true })
      .then(({ data, error }) => {
        if (error) { console.error(error); return }
        const list = (data || []).filter((v: any) => v.is_active)
        setVersions(list)
        if (list.length && !version) {
          const cur = list.find((v: any) => v.is_current) || list[0]
          setVersion(cur.version_code)
        }
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // areas in the selected version
  useEffect(() => {
    if (!version) { setAreas([]); setArea(''); return }
    supabase.from('cf_forecasts').select('area').eq('version', version).eq('scenario_code', 'Forecast')
      .then(({ data }) => {
        const uniq = Array.from(new Set((data || []).map((r: any) => r.area))).sort() as string[]
        setAreas(uniq)
        setArea(prev => (uniq.includes(prev) ? prev : (uniq[0] || '')))
      })
  }, [version])

  const loadGrid = useCallback(async () => {
    if (!version || !area) { setRowData([]); setPeriods([]); return }
    setLoading(true)
    const [{ data: fc }, { data: lines }, { data: projs }] = await Promise.all([
      supabase.from('cf_forecasts')
        .select('project_code,line_code,year,month,value')
        .eq('version', version).eq('area', area).eq('scenario_code', 'Forecast'),
      supabase.from('cf_lines').select('line_code,description,sort_order'),
      supabase.from('cf_projects').select('project_code,display_name').eq('area', area),
    ])
    const lineMap = new Map((lines || []).map((l: any) => [l.line_code, l]))
    const projMap = new Map((projs || []).map((p: any) => [p.project_code, p.display_name]))

    const periodSet = new Map<number, any>()
    const rows = new Map<string, any>()
    for (const r of (fc || [])) {
      periodSet.set(ym(r.year, r.month), { year: r.year, month: r.month })
      const key = `${r.project_code}__${r.line_code}`
      if (!rows.has(key)) {
        const l: any = lineMap.get(r.line_code)
        rows.set(key, {
          project_code: r.project_code,
          project_name: projMap.get(r.project_code) || r.project_code,
          line_code: r.line_code,
          line_desc: l?.description || r.line_code,
          line_sort: l?.sort_order ?? 9999,
        })
      }
      rows.get(key)![periodField(r.year, r.month)] = Number(r.value)
    }
    const periodList = Array.from(periodSet.values()).sort((a, b) => ym(a.year, a.month) - ym(b.year, b.month))
    const rowList = Array.from(rows.values()).sort((a, b) =>
      a.project_name.localeCompare(b.project_name) || a.line_sort - b.line_sort || a.line_code.localeCompare(b.line_code))
    setPeriods(periodList)
    setRowData(rowList)
    setLoading(false)
  }, [version, area])

  useEffect(() => { loadGrid() }, [loadGrid])

  const numFmt = (p: any) => (p.value == null || p.value === '' ? '' :
    Number(p.value).toLocaleString(undefined, { maximumFractionDigits: 0 }))

  const columnDefs = useMemo(() => {
    const cols: any[] = [
      { headerName: 'Project', field: 'project_name', pinned: 'left', width: 160,
        tooltipField: 'project_code', cellClass: 'cfm-grid-dim' },
      { headerName: 'Line', field: 'line_desc', pinned: 'left', width: 200,
        tooltipField: 'line_code', cellClass: 'cfm-grid-dim' },
    ]
    for (const p of periods) {
      const editable = canManage && ym(p.year, p.month) > asof
      cols.push({
        headerName: periodLabel(p.year, p.month),
        field: periodField(p.year, p.month),
        width: 96,
        type: 'rightAligned',
        editable,
        cellEditor: 'agNumberCellEditor',
        valueFormatter: numFmt,
        valueParser: (q: any) => (q.newValue === '' || q.newValue == null ? null : Number(q.newValue)),
        cellClassRules: {
          'cfm-cell-locked': () => !editable,
          'cfm-cell-edit': () => editable,
          'cfm-cell-neg': (q: any) => Number(q.value) < 0,
        },
      })
    }
    return cols
  }, [periods, asof, canManage])

  const defaultColDef = useMemo(() => ({ resizable: true, sortable: true, suppressMovable: true }), [])

  const onCellValueChanged = useCallback(async (e: any) => {
    const field = e.colDef.field
    if (!field?.startsWith('p_')) return
    const [, ys, ms] = field.split('_')
    const year = Number(ys), month = Number(ms)
    const newValue = e.newValue === '' || e.newValue == null ? null : Number(e.newValue)
    const oldValue = e.oldValue ?? null
    if (newValue == null || Number.isNaN(newValue)) {
      e.node.setDataValue(field, oldValue)  // revert blanks/garbage
      return
    }
    if (Number(newValue) === Number(oldValue)) return
    setStatus({ kind: 'busy', msg: 'Saving…' })
    const { error } = await supabase.rpc('cf_edit_forecast', {
      p_version: version, p_area: area,
      p_project_code: e.data.project_code, p_line_code: e.data.line_code,
      p_year: year, p_month: month, p_new_value: newValue,
      p_actor: actor, p_reason: reason.trim() || null,
    })
    if (error) {
      e.node.setDataValue(field, oldValue)
      setStatus({ kind: 'err', msg: `Save failed: ${error.message}` })
      return
    }
    setStatus({ kind: 'ok', msg: `Saved ${e.data.line_code} ${periodLabel(year, month)} → ${Number(newValue).toLocaleString()}` })
  }, [version, area, actor, reason])

  const handleFreeze = async () => {
    if (!canManage || !version) return
    const label = prompt(
      `Freeze "${version}" as a labeled snapshot in cycle ${verRow ? cycleLabel(verRow) : ''}.\n` +
      `A new version row is created with all forecasts copied; this version is left unchanged.\n\n` +
      `Label (e.g. Final, Adopted, Board June 2026):`, 'Final')
    if (label === null) return
    if (!label.trim()) { alert('A label is required.'); return }
    setStatus({ kind: 'busy', msg: 'Freezing…' })
    const { data, error } = await supabase.rpc('cf_freeze_version', {
      p_source_version: version, p_label: label.trim(), p_actor: actor,
    })
    if (error) { setStatus({ kind: 'err', msg: `Freeze failed: ${error.message}` }); return }
    const res = Array.isArray(data) ? data[0] : data
    setStatus({ kind: 'ok', msg: `Frozen → ${res.new_version} (“${res.final_label}”), ${Number(res.forecast_rows_cloned).toLocaleString()} rows copied.` })
    // refresh the version list so the new snapshot appears
    const { data: vs } = await supabase.from('cf_versions').select('*')
      .order('cycle_year', { ascending: false }).order('cycle_month', { ascending: false }).order('version_no', { ascending: true })
    setVersions((vs || []).filter((v: any) => v.is_active))
  }

  return (
    <div className="cfm-adjust">
      <div className="cfm-adjust-bar">
        <label className="cfm-field">
          <span>Version</span>
          <select value={version} onChange={e => setVersion(e.target.value)}>
            {versions.map(v => (
              <option key={v.version_code} value={v.version_code}>
                {v.version_code}{v.final_label ? ` · ${v.final_label}` : ''}{v.is_current ? ' · current' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="cfm-field">
          <span>Area</span>
          <select value={area} onChange={e => setArea(e.target.value)}>
            {areas.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="cfm-field cfm-field-grow">
          <span>Reason for edits (logged)</span>
          <input type="text" value={reason} onChange={e => setReason(e.target.value)}
            placeholder="e.g. Treasury re-phasing per Tony, June review" disabled={!canManage} />
        </label>
        {canManage && (
          <button className="cfm-btn cfm-btn-primary cfm-btn-sm" onClick={handleFreeze} disabled={!version}
            title="Clone this version to a new labeled snapshot in the same cycle">
            Freeze as labeled version
          </button>
        )}
      </div>

      <div className="cfm-adjust-note">
        {canManage
          ? <>Editable cells are periods after <strong>{verRow?.as_of_date || '—'}</strong> (the forward forecast). Earlier periods are settled and locked. Every edit is logged.</>
          : <>Read-only — adjusting forecasts needs the Treasury role.</>}
        {status && <span className={`cfm-adjust-status cfm-as-${status.kind}`}>{status.msg}</span>}
      </div>

      {loading ? (
        <div className="cfm-empty">Loading forecast cells…</div>
      ) : rowData.length === 0 ? (
        <div className="cfm-empty">No forecast rows for this version / area.</div>
      ) : (
        <div className="cfm-grid-wrap">
          <AgGridReact
            ref={gridRef}
            theme={cccGridTheme}
            rowData={rowData}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            onCellValueChanged={onCellValueChanged}
            stopEditingWhenCellsLoseFocus
            tooltipShowDelay={300}
            enableCellTextSelection
          />
        </div>
      )}
    </div>
  )
}
