/* Bulk-op compute functions. Pure — given baseline cells + an op definition,
 * return a new DeltaPayload with the op applied.
 *
 * The ops library covers the CFO mental model:
 *   - Shift area flows forward/backward by N months
 *   - Scale area flows in a date range by ±X%
 *   - Reset area cells to baseline
 *
 * Each op also pushes a bulk_actions entry for the History panel + undo.
 */

import type { CfCell, CfLine } from './queries'
import type { BulkAction, CellDelta, DeltaPayload } from './scenario'

export type NatureFilter = 'all' | 'receipts' | 'payments'

function cellKey(area: string, line_code: string, year: number, month: number): string {
  return `${area}${line_code}${year}${month}`
}

/* Build a base set of cells in the scope to operate over. Filters:
 *   - cfAreas: Tony labels (resolved by caller from canonical area)
 *   - lineCodes: keep only these (resolved by caller from nature filter)
 *   - inDateRange (inclusive): year/month between [fromYM, toYM]
 */
function filterBase(
  baseline: CfCell[],
  cfAreas: Set<string>,
  lineCodes: Set<string>,
  fromYM: number, toYM: number,
): CfCell[] {
  return baseline.filter(c => {
    if (!cfAreas.has(c.area)) return false
    if (!lineCodes.has(c.line_code)) return false
    const ym = c.year * 100 + c.month
    return ym >= fromYM && ym <= toYM
  })
}

export function lineCodesForNature(lines: CfLine[], nature: NatureFilter): Set<string> {
  const out = new Set<string>()
  for (const l of lines) {
    if (l.nature === 'Balance') continue
    if (nature === 'receipts' && l.nature !== 'Receipts') continue
    if (nature === 'payments' && l.nature !== 'Payments') continue
    out.add(l.line_code)
  }
  return out
}

/* ── Shift ─────────────────────────────────────────────────────────────── */

export function opShift(opts: {
  payload: DeltaPayload
  baseline: CfCell[]
  cfAreas: Set<string>
  lineCodes: Set<string>
  fromYM: number
  toYM: number
  monthsShifted: number  // +1 = forward (Jul → Aug), -1 = backward
  meta: { area: string; nature: NatureFilter }
}): DeltaPayload {
  const { payload, baseline, cfAreas, lineCodes, fromYM, toYM, monthsShifted, meta } = opts
  if (monthsShifted === 0) return payload

  const inScope = filterBase(baseline, cfAreas, lineCodes, fromYM, toYM)
  /* Index by (area, line_code, ym) for both source (read original) and
   * destination (write shifted) lookups. */
  const baselineByKey = new Map<string, number>()
  for (const c of baseline) baselineByKey.set(cellKey(c.area, c.line_code, c.year, c.month), c.value)

  /* Merge existing payload cells into a working map so multiple ops compose. */
  const next = new Map<string, CellDelta>()
  for (const c of payload.cells) next.set(cellKey(c.area, c.line_code, c.year, c.month), c)

  for (const c of inScope) {
    const newMonthAbs = c.month + monthsShifted
    const newYear = c.year + Math.floor((newMonthAbs - 1) / 12)
    const newMonth = ((newMonthAbs - 1) % 12 + 12) % 12 + 1
    /* Destination cell receives this baseline value */
    const dstKey = cellKey(c.area, c.line_code, newYear, newMonth)
    const dstBaseline = baselineByKey.get(dstKey) || 0
    next.set(dstKey, {
      area: c.area, line_code: c.line_code, year: newYear, month: newMonth,
      baseline_value: dstBaseline,
      scenario_value: c.value,
    })
    /* Source cell becomes whatever the cell N months earlier was (or 0). */
    const srcMonthAbs = c.month - monthsShifted
    const srcYear = c.year + Math.floor((srcMonthAbs - 1) / 12)
    const srcMonth = ((srcMonthAbs - 1) % 12 + 12) % 12 + 1
    const srcKey = cellKey(c.area, c.line_code, c.year, c.month)
    const srcBaseline = c.value
    const srcReplacement = baselineByKey.get(cellKey(c.area, c.line_code, srcYear, srcMonth)) || 0
    next.set(srcKey, {
      area: c.area, line_code: c.line_code, year: c.year, month: c.month,
      baseline_value: srcBaseline,
      scenario_value: srcReplacement,
    })
  }

  const action: BulkAction = {
    action: monthsShifted > 0 ? 'shift_forward' : 'shift_backward',
    area: meta.area,
    months_shifted: monthsShifted,
    applied_at: new Date().toISOString(),
  }
  return {
    cells: Array.from(next.values()),
    bulk_actions: [...payload.bulk_actions, action],
  }
}

/* ── Scale ─────────────────────────────────────────────────────────────── */

export function opScale(opts: {
  payload: DeltaPayload
  baseline: CfCell[]
  cfAreas: Set<string>
  lineCodes: Set<string>
  fromYM: number
  toYM: number
  pct: number  // -0.15 = -15%
  meta: { area: string; nature: NatureFilter }
}): DeltaPayload {
  const { payload, baseline, cfAreas, lineCodes, fromYM, toYM, pct, meta } = opts
  if (pct === 0) return payload

  const inScope = filterBase(baseline, cfAreas, lineCodes, fromYM, toYM)
  const factor = 1 + pct
  const next = new Map<string, CellDelta>()
  for (const c of payload.cells) next.set(cellKey(c.area, c.line_code, c.year, c.month), c)
  for (const c of inScope) {
    const k = cellKey(c.area, c.line_code, c.year, c.month)
    next.set(k, {
      area: c.area, line_code: c.line_code, year: c.year, month: c.month,
      baseline_value: c.value,
      scenario_value: c.value * factor,
    })
  }
  const action: BulkAction = {
    action: 'apply_pct',
    area: meta.area,
    pct,
    month_from: fromYM,
    month_to: toYM,
    applied_at: new Date().toISOString(),
  }
  return {
    cells: Array.from(next.values()),
    bulk_actions: [...payload.bulk_actions, action],
  }
}

/* ── Reset ─────────────────────────────────────────────────────────────── */

export function opReset(opts: {
  payload: DeltaPayload
  cfAreas: Set<string>
  meta: { area: string }
}): DeltaPayload {
  const { payload, cfAreas, meta } = opts
  const cells = payload.cells.filter(c => !cfAreas.has(c.area))
  const action: BulkAction = {
    action: 'reset',
    area: meta.area,
    applied_at: new Date().toISOString(),
  }
  return {
    cells,
    bulk_actions: [...payload.bulk_actions, action],
  }
}

/* ── Undo ──────────────────────────────────────────────────────────────── */

/* Pop the last bulk_action and rebuild the cells array by re-applying all
 * actions from the beginning. Simple and correct; the alternative (track
 * each op's cell footprint) is more state to wrong-foot.
 *
 * Caller passes baseline + a re-apply function that takes (payload, action)
 * and returns a new payload. We don't store enough metadata to re-apply
 * arbitrary actions here — instead the caller has the ops library and the
 * last action object, so re-application happens at the panel level.
 *
 * For Step 5 we use a simpler model: undo just removes the last action AND
 * the cells whose scenario_value is now ambiguous. Since each op records
 * which area + nature it touched, undo can roll back by re-running the
 * remaining actions over baseline. This is exposed via undoLast in the
 * panel, not a pure function here.
 */
