import { useEffect, useState } from 'react'
import { fmt } from '@/lib/format'
import { logEvent } from '@/lib/scenario'
import { useScenario } from '@/lib/ScenarioContext'

type Props = {
  /* The cf_area label this cell writes to (cf_actuals.area). When the
   * canonical area folds multiple cf_areas the caller picks the first;
   * post-2026-06-05 country-grain that is == area_id anyway. */
  cfArea: string | undefined
  lineCode: string
  year: number | undefined
  month: number | undefined
  isActual: boolean
  baselineValue: number | null
  scenarioValue: number | null  // baseline + delta — what to display
  className?: string
}

/* Single-cell editor for the per-area drill. Renders a plain <td> with
 * the scenario value when:
 *   - no year/month (column is a roll-up like quarterly/yearly)
 *   - col is actuals (closed period — never editable)
 *   - no active scenario
 *   - missing cfArea bridge
 *
 * Otherwise renders an <input>. On commit, writes a CellDelta into
 * workingDelta and fires a `cell_edit` telemetry event. */
export function EditableCell(props: Props) {
  const { cfArea, lineCode, year, month, isActual, baselineValue, scenarioValue, className } = props
  const { activeId, workingDelta, setWorkingDelta } = useScenario()
  const editable = activeId !== 'baseline'
    && !isActual
    && year !== undefined
    && month !== undefined
    && cfArea !== undefined
    && cfArea !== ''

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>('')

  useEffect(() => { if (!editable) setEditing(false) }, [editable])

  if (!editable) {
    return <td className={className}>{scenarioValue == null ? '' : fmt(scenarioValue)}</td>
  }

  const onCommit = () => {
    setEditing(false)
    const parsed = Number(draft.replace(/[,_\s]/g, ''))
    if (!isFinite(parsed)) return
    if (scenarioValue !== null && parsed === scenarioValue) return  // no-op

    /* Upsert the cell delta. baseline_value records the original — used by
     * Reset and side-by-side diff. */
    const existing = workingDelta.cells.findIndex(c =>
      c.area === cfArea && c.line_code === lineCode && c.year === year && c.month === month,
    )
    const newCell = {
      area: cfArea!,
      line_code: lineCode,
      year: year!,
      month: month!,
      baseline_value: baselineValue ?? 0,
      scenario_value: parsed,
    }
    const cells = existing >= 0
      ? workingDelta.cells.map((c, i) => i === existing ? newCell : c)
      : [...workingDelta.cells, newCell]
    setWorkingDelta({ cells, bulk_actions: workingDelta.bulk_actions })
    logEvent('cell_edit', {
      scenario_id: activeId,
      meta: { area: cfArea, line_code: lineCode, year, month, from: scenarioValue, to: parsed },
    })
  }

  const isOverridden = baselineValue !== null
    && scenarioValue !== null
    && Math.abs(scenarioValue - baselineValue) > 0.001

  return (
    <td className={`${className || ''} cell-editable ${isOverridden ? 'cell-overridden' : ''}`}>
      {editing ? (
        <input
          autoFocus
          className="cell-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={onCommit}
          onKeyDown={e => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            else if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <button
          type="button"
          className="cell-edit-trigger"
          title="Click to edit forecast value"
          onClick={() => {
            setDraft(scenarioValue == null ? '' : String(Math.round(scenarioValue)))
            setEditing(true)
          }}
        >
          {scenarioValue == null ? '—' : fmt(scenarioValue)}
        </button>
      )}
    </td>
  )
}
