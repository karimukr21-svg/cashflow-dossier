/* Derived balances — semantic chain for cash position.
 *
 *   opening[ym]  = (ym === first ? anchor : closing[prevYM])
 *   closing[ym]  = opening[ym] + sum(Receipts + Payments)[ym]
 *
 * Anchor = sum of Opening Balance category line values at the first month
 * in scope (typically a single row from Tony's source).
 *
 * Loans / Overdrafts are NOT part of this chain — they're separate balance
 * tracks. Use the stored values for those rows.
 *
 * Why derived: storing closing balances per period invites internal
 * inconsistency (closing[Apr] != opening[May] in the source, etc.).
 * Deriving guarantees the chain holds and surfaces movement attribution
 * cleanly.
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

  /* Anchor: sum of Opening Balance lines at the first scoped month. */
  const fromYM = fromYear * 100 + fromMonth
  const toYM = toYear * 100 + toMonth
  let anchor = 0
  for (const c of cells) {
    const ym = c.year * 100 + c.month
    if (ym !== fromYM) continue
    const line = lineByCode.get(c.line_code)
    if (!line || line.category !== 'Opening Balance') continue
    anchor += c.value
  }

  /* Movement per ym: receipts + payments (signed values from source). */
  const movementByYM = new Map<number, number>()
  for (const c of cells) {
    const ym = c.year * 100 + c.month
    if (ym < fromYM || ym > toYM) continue
    const line = lineByCode.get(c.line_code)
    if (!line || (line.nature !== 'Receipts' && line.nature !== 'Payments')) continue
    movementByYM.set(ym, (movementByYM.get(ym) || 0) + c.value)
  }

  /* Chain forward */
  const openingByYM = new Map<number, number>()
  const closingByYM = new Map<number, number>()
  let prevClosing = anchor
  let y = fromYear, m = fromMonth
  while (y < toYear || (y === toYear && m <= toMonth)) {
    const ym = y * 100 + m
    const opening = (ym === fromYM) ? anchor : prevClosing
    const movement = movementByYM.get(ym) || 0
    const closing = opening + movement
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
