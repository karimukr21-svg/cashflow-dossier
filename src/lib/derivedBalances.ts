/* Balances for cash position — STATED where the source has them, derived across gaps.
 *
 *   opening[ym]  = stated Opening Balance at ym, else (ym === first ? anchor : closing[prevYM])
 *   closing[ym]  = stated Ending Balance at ym,  else opening[ym] + sum(Receipts + Payments)[ym]
 *
 * Why prefer stated: a pure flow-chain (anchor at the first month in scope + roll flows
 * forward) has two failure modes the source doesn't — (1) it DRIFTS from the file when the
 * flows don't perfectly reconcile to the stated balances (consolidation plugs, JV shares),
 * and (2) it MOVES with the selected period, because the anchor is whatever month is first
 * in view. Reading the source's stated Opening/Ending Balance line at each month fixes both:
 * a stated month is period-independent and ties the file. We re-anchor at every stated month
 * and only chain flows across months that have no stated balance (so areas whose source
 * carries no balance rows still work). Loans/Overdrafts are separate tracks (stored directly).
 */

import type { CfCell, CfLine } from './queries'

export type DerivedBalances = {
  openingByYM: Map<number, number>
  closingByYM: Map<number, number>
  movementByYM: Map<number, number>
}

export function computeDerivedBalances(opts: {
  cells: CfCell[]
  lines: CfLine[]
  fromYear: number; fromMonth: number; toYear: number; toMonth: number
}): DerivedBalances {
  const { cells, lines, fromYear, fromMonth, toYear, toMonth } = opts

  const lineByCode = new Map<string, CfLine>()
  for (const l of lines) lineByCode.set(l.line_code, l)

  const fromYM = fromYear * 100 + fromMonth
  const toYM = toYear * 100 + toMonth

  /* Collect per-ym: the source's STATED opening/ending balance lines, and the flow
   * movement (receipts + payments). Stated balances are preferred; flows fill gaps. */
  const statedOpenByYM = new Map<number, number>()
  const statedCloseByYM = new Map<number, number>()
  const movementByYM = new Map<number, number>()
  for (const c of cells) {
    const ym = c.year * 100 + c.month
    if (ym < fromYM || ym > toYM) continue
    const line = lineByCode.get(c.line_code)
    if (!line) continue
    if (line.category === 'Opening Balance')
      statedOpenByYM.set(ym, (statedOpenByYM.get(ym) || 0) + c.value)
    else if (line.category === 'Ending Balance')
      statedCloseByYM.set(ym, (statedCloseByYM.get(ym) || 0) + c.value)
    else if (line.nature === 'Receipts' || line.nature === 'Payments')
      movementByYM.set(ym, (movementByYM.get(ym) || 0) + c.value)
  }

  /* Chain forward, re-anchoring on any stated balance so displayed values tie the file
   * and don't drift with the selected period. */
  const anchor = statedOpenByYM.get(fromYM) ?? 0
  const openingByYM = new Map<number, number>()
  const closingByYM = new Map<number, number>()
  let prevClosing = anchor
  let y = fromYear, m = fromMonth
  while (y < toYear || (y === toYear && m <= toMonth)) {
    const ym = y * 100 + m
    const opening = statedOpenByYM.has(ym) ? statedOpenByYM.get(ym)!
                  : (ym === fromYM ? anchor : prevClosing)
    const movement = movementByYM.get(ym) || 0
    const closing = statedCloseByYM.has(ym) ? statedCloseByYM.get(ym)!
                  : opening + movement
    openingByYM.set(ym, opening)
    closingByYM.set(ym, closing)
    prevClosing = closing
    m++
    if (m > 12) { m = 1; y++ }
  }

  return { openingByYM, closingByYM, movementByYM }
}

/* Given a column (matches fn), find the first and last (y,m) it covers in
 * the scope. Used to render Opening at column-start, Closing at column-end.
 *
 * Returns null if the column covers no months in scope (shouldn't happen
 * with buildColumns output but guarded). */
export function getColumnYMEndpoints(
  matches: (y: number, m: number) => boolean,
  fromYear: number, fromMonth: number, toYear: number, toMonth: number,
): { first: number; last: number } | null {
  let first = 0, last = 0
  let y = fromYear, m = fromMonth
  while (y < toYear || (y === toYear && m <= toMonth)) {
    if (matches(y, m)) {
      const ym = y * 100 + m
      if (first === 0) first = ym
      last = ym
    }
    m++
    if (m > 12) { m = 1; y++ }
  }
  if (first === 0) return null
  return { first, last }
}
