import { useEffect, useMemo, useState } from 'react'
import { useScenario } from '../lib/ScenarioContext'
import { fetchActuals, fetchForecasts, type CanonicalArea, type CfCell, type CfLine } from '../lib/queries'
import {
  EMPTY_DELTA, logEvent, updateScenarioDelta,
  type BulkAction, type DeltaPayload,
} from '../lib/scenario'
import {
  lineCodesForNature, opReset, opScale, opShift,
  type NatureFilter,
} from '../lib/scenarioBulkOps'

type Props = {
  areas: CanonicalArea[]
  lines: CfLine[]
  primaryVersionCode: string
  /* Period the user is currently viewing — used as defaults for scale range */
  fromYear: number; fromMonth: number; toYear: number; toMonth: number
  /* Latest actual month — bulk ops should only touch forecast months. */
  latestActualYM: number
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function BulkOpsPanel(props: Props) {
  const { areas, lines, primaryVersionCode, fromYear, fromMonth, toYear, toMonth, latestActualYM } = props
  const {
    activeId, savedScenario, workingDelta, setWorkingDelta, resetWorking, exitToBaseline,
  } = useScenario()

  /* Baseline cells in the dossier's full period scope. Fetched on mount;
   * refetched if scope changes. */
  const [baseline, setBaseline] = useState<CfCell[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (activeId === 'baseline') return
    let cancel = false
    setLoading(true)
    Promise.all([
      fetchActuals({ fromYear, fromMonth, toYear, toMonth }),
      fetchForecasts({ version: primaryVersionCode, fromYear, fromMonth, toYear, toMonth }),
    ])
      .then(([a, f]) => {
        if (cancel) return
        const all: CfCell[] = []
        for (const r of a) all.push({ area: r.area, line_code: r.line_code, year: r.year, month: r.month, value: r.value })
        for (const r of f) all.push({ area: r.area, line_code: r.line_code, year: r.year, month: r.month, value: r.value })
        setBaseline(all)
      })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [activeId, primaryVersionCode, fromYear, fromMonth, toYear, toMonth])

  /* ── Form state for each op ──────────────────────────────────────────── */

  const firstArea = areas[0]?.area_id || ''
  const [shiftArea, setShiftArea] = useState(firstArea)
  const [shiftMonths, setShiftMonths] = useState(1)
  const [shiftNature, setShiftNature] = useState<NatureFilter>('all')

  const [scaleArea, setScaleArea] = useState(firstArea)
  const [scaleFromYM, setScaleFromYM] = useState(latestActualYM + 1)
  const [scaleToYM, setScaleToYM] = useState(toYear * 100 + toMonth)
  const [scalePct, setScalePct] = useState(-15)
  const [scaleNature, setScaleNature] = useState<NatureFilter>('receipts')

  const [resetArea, setResetArea] = useState(firstArea)

  /* If areas load late, seed defaults once */
  useEffect(() => {
    if (firstArea && !shiftArea) setShiftArea(firstArea)
    if (firstArea && !scaleArea) setScaleArea(firstArea)
    if (firstArea && !resetArea) setResetArea(firstArea)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstArea])

  const areaById = useMemo(() => new Map(areas.map(a => [a.area_id, a])), [areas])
  const cfAreasFor = (areaId: string): Set<string> => {
    const a = areaById.get(areaId)
    return new Set(a ? a.cf_areas : [])
  }

  /* ── Op handlers ──────────────────────────────────────────────────────── */

  const guardForecastOnly = (fromYM: number): boolean => {
    if (fromYM <= latestActualYM) {
      const ok = confirm(
        `This op would touch months ≤ latest actual (${monthLabel(latestActualYM)}). ` +
        `Bulk ops on closed periods can mislead. Continue?`
      )
      return ok
    }
    return true
  }

  const onShift = () => {
    if (!baseline || !shiftArea) return
    const fromYM = Math.max(latestActualYM + 1, fromYear * 100 + fromMonth)
    if (!guardForecastOnly(fromYM)) return
    const next = opShift({
      payload: workingDelta,
      baseline,
      cfAreas: cfAreasFor(shiftArea),
      lineCodes: lineCodesForNature(lines, shiftNature),
      fromYM,
      toYM: toYear * 100 + toMonth,
      monthsShifted: shiftMonths,
      meta: { area: shiftArea, nature: shiftNature },
    })
    setWorkingDelta(next)
    logEvent('bulk_op', {
      scenario_id: activeId === 'baseline' ? null : activeId,
      meta: { action: 'shift', area: shiftArea, months: shiftMonths, nature: shiftNature },
    })
  }

  const onScale = () => {
    if (!baseline || !scaleArea) return
    if (!guardForecastOnly(scaleFromYM)) return
    const next = opScale({
      payload: workingDelta,
      baseline,
      cfAreas: cfAreasFor(scaleArea),
      lineCodes: lineCodesForNature(lines, scaleNature),
      fromYM: scaleFromYM,
      toYM: scaleToYM,
      pct: scalePct / 100,
      meta: { area: scaleArea, nature: scaleNature },
    })
    setWorkingDelta(next)
    logEvent('bulk_op', {
      scenario_id: activeId === 'baseline' ? null : activeId,
      meta: { action: 'scale', area: scaleArea, pct: scalePct, nature: scaleNature, from: scaleFromYM, to: scaleToYM },
    })
  }

  const onReset = () => {
    if (!resetArea) return
    const next = opReset({
      payload: workingDelta,
      cfAreas: cfAreasFor(resetArea),
      meta: { area: resetArea },
    })
    setWorkingDelta(next)
    logEvent('bulk_op', {
      scenario_id: activeId === 'baseline' ? null : activeId,
      meta: { action: 'reset', area: resetArea },
    })
  }

  /* Undo: remove the last action and re-derive cells by replaying remaining
   * actions over baseline. For Step 5 this is the simplest correct model;
   * Step 11 polish can do per-op deltas if perf is an issue. */
  const onUndo = () => {
    if (workingDelta.bulk_actions.length === 0) return
    const remaining = workingDelta.bulk_actions.slice(0, -1)
    let replayed: DeltaPayload = savedScenario?.delta_payload ?? EMPTY_DELTA
    if (!baseline) {
      /* No baseline yet — just drop the last action and any cells. */
      setWorkingDelta({ cells: [], bulk_actions: remaining })
      return
    }
    for (const a of remaining) {
      replayed = replayAction(replayed, a, baseline, lines, areas)
    }
    setWorkingDelta(replayed)
  }

  const onSave = async () => {
    if (activeId === 'baseline' || !savedScenario) {
      alert('No active scenario to save into. Create one from the Scenario pill first.')
      return
    }
    setBusy(true)
    try {
      const updated = await updateScenarioDelta({
        id: savedScenario.id,
        delta_payload: workingDelta,
      })
      logEvent('save', { scenario_id: updated.id, meta: { cells: updated.delta_payload.cells.length } })
      /* Saved scenario updates via the next loadScenario; for now we just
       * clear unsaved-dot signal by leaving working as-is — Step 6 wires
       * full refresh. */
      alert('Saved.')
    } catch (e: any) {
      alert('Save failed: ' + (e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  const onDiscard = () => {
    const total = workingDelta.cells.length
    if (total === 0) { exitToBaseline(); return }
    if (!confirm(`Discard ${total} unsaved cells and return to baseline?`)) return
    logEvent('discard', { scenario_id: activeId === 'baseline' ? null : activeId })
    exitToBaseline()
  }

  if (activeId === 'baseline') return null

  return (
    <aside className="bulk-panel">
      <header className="bulk-panel-head">
        <div className="bulk-panel-title">{savedScenario?.name || 'Loading…'}</div>
        <div className="bulk-panel-meta">
          Baseline {savedScenario?.baseline_version_code}
          {' · '}{workingDelta.cells.length} Δ cells
        </div>
        <div className="bulk-panel-actions">
          <button onClick={onSave} disabled={busy} className="bulk-btn primary">Save</button>
          <button onClick={resetWorking} disabled={busy} className="bulk-btn">Reset</button>
          <button onClick={onDiscard} disabled={busy} className="bulk-btn danger">× Discard</button>
        </div>
      </header>

      {loading && <div className="bulk-loading">Loading baseline cells…</div>}

      <section className="bulk-section">
        <div className="bulk-section-title">Shift area flows</div>
        <label>Area
          <select value={shiftArea} onChange={e => setShiftArea(e.target.value)}>
            {areas.map(a => <option key={a.area_id} value={a.area_id}>{a.display_name}</option>)}
          </select>
        </label>
        <label>Months
          <input type="number" value={shiftMonths} onChange={e => setShiftMonths(Number(e.target.value) || 0)} step={1} />
        </label>
        <label>Scope
          <select value={shiftNature} onChange={e => setShiftNature(e.target.value as NatureFilter)}>
            <option value="all">All flows</option>
            <option value="receipts">Receipts only</option>
            <option value="payments">Payments only</option>
          </select>
        </label>
        <button className="bulk-btn primary" onClick={onShift} disabled={loading || !baseline}>Apply</button>
      </section>

      <section className="bulk-section">
        <div className="bulk-section-title">Scale area flows</div>
        <label>Area
          <select value={scaleArea} onChange={e => setScaleArea(e.target.value)}>
            {areas.map(a => <option key={a.area_id} value={a.area_id}>{a.display_name}</option>)}
          </select>
        </label>
        <label>Range
          <span className="bulk-range">
            <select value={scaleFromYM} onChange={e => setScaleFromYM(Number(e.target.value))}>
              {ymOptions(latestActualYM + 1, toYear * 100 + toMonth).map(ym => (
                <option key={ym} value={ym}>{monthLabel(ym)}</option>
              ))}
            </select>
            →
            <select value={scaleToYM} onChange={e => setScaleToYM(Number(e.target.value))}>
              {ymOptions(latestActualYM + 1, toYear * 100 + toMonth).map(ym => (
                <option key={ym} value={ym}>{monthLabel(ym)}</option>
              ))}
            </select>
          </span>
        </label>
        <label>Adjust
          <span className="bulk-pct-row">
            <input type="number" value={scalePct} onChange={e => setScalePct(Number(e.target.value) || 0)} step={5} />
            <span>%</span>
          </span>
        </label>
        <label>Scope
          <select value={scaleNature} onChange={e => setScaleNature(e.target.value as NatureFilter)}>
            <option value="all">All flows</option>
            <option value="receipts">Receipts only</option>
            <option value="payments">Payments only</option>
          </select>
        </label>
        <button className="bulk-btn primary" onClick={onScale} disabled={loading || !baseline}>Apply</button>
      </section>

      <section className="bulk-section">
        <div className="bulk-section-title">Reset to baseline</div>
        <label>Area
          <select value={resetArea} onChange={e => setResetArea(e.target.value)}>
            {areas.map(a => <option key={a.area_id} value={a.area_id}>{a.display_name}</option>)}
          </select>
        </label>
        <button className="bulk-btn" onClick={onReset}>Reset area cells</button>
      </section>

      <section className="bulk-section">
        <div className="bulk-section-title">History (last 10)</div>
        {workingDelta.bulk_actions.length === 0 && <div className="bulk-empty">No ops applied yet.</div>}
        {workingDelta.bulk_actions.slice(-10).reverse().map((a, i, arr) => (
          <div key={`${a.applied_at}-${i}`} className="bulk-history-row">
            <span className="bulk-history-label">{summarizeAction(a)}</span>
            {i === 0 && (
              <button className="bulk-undo" onClick={onUndo} title="Undo last op">↶ undo</button>
            )}
            {/* avoid stale-closure warning on arr */}
            {arr && null}
          </div>
        ))}
      </section>
    </aside>
  )
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function monthLabel(ym: number): string {
  const y = Math.floor(ym / 100)
  const m = ym % 100
  return `${MONTH_NAMES[m - 1]} ${y}`
}

function ymOptions(fromYM: number, toYM: number): number[] {
  const out: number[] = []
  let ym = fromYM
  while (ym <= toYM) {
    out.push(ym)
    const m = ym % 100
    const y = Math.floor(ym / 100)
    ym = m === 12 ? (y + 1) * 100 + 1 : ym + 1
  }
  return out
}

function summarizeAction(a: BulkAction): string {
  if (a.action === 'shift_forward' || a.action === 'shift_backward') {
    const sign = (a.months_shifted ?? 0) >= 0 ? '+' : ''
    return `Shift ${a.area} · ${sign}${a.months_shifted}m`
  }
  if (a.action === 'apply_pct') {
    const pct = a.pct ? `${(a.pct * 100).toFixed(0)}%` : '?'
    return `Scale ${a.area} · ${pct}`
  }
  if (a.action === 'reset') return `Reset ${a.area} to baseline`
  return a.action
}

/* Replay a single action over a payload + baseline. Used by undo. */
function replayAction(
  payload: DeltaPayload,
  a: BulkAction,
  baseline: CfCell[],
  lines: CfLine[],
  areas: CanonicalArea[],
): DeltaPayload {
  const area = areas.find(x => x.area_id === a.area)
  if (!area) return payload
  const cfAreas = new Set(area.cf_areas)
  if (a.action === 'shift_forward' || a.action === 'shift_backward') {
    return opShift({
      payload, baseline, cfAreas,
      lineCodes: lineCodesForNature(lines, 'all'),
      fromYM: 0, toYM: 99999999,
      monthsShifted: a.months_shifted ?? 0,
      meta: { area: a.area || '', nature: 'all' },
    })
  }
  if (a.action === 'apply_pct') {
    return opScale({
      payload, baseline, cfAreas,
      lineCodes: lineCodesForNature(lines, 'all'),
      fromYM: a.month_from ?? 0,
      toYM: a.month_to ?? 99999999,
      pct: a.pct ?? 0,
      meta: { area: a.area || '', nature: 'all' },
    })
  }
  if (a.action === 'reset') {
    return opReset({ payload, cfAreas, meta: { area: a.area || '' } })
  }
  return payload
}
