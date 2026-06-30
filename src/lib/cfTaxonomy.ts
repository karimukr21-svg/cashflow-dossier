import type { CfLine } from './queries'

/* Single source of truth for cash-flow line classification, so a cf_lines
 * catalog rename is caught in ONE place instead of silently zeroing a figure
 * scattered across components. Classification is by category today (cf_lines
 * carries no structural role flag yet); centralise it here. */

export const DEBT_STOCK_CATEGORIES = ['Accumulated Loans', 'Overdrafts'] as const
export const OPENING_CATEGORY = 'Opening Balance'
export const ENDING_CATEGORY = 'Ending Balance'

/** Liability stocks (accumulated loans + overdrafts) — point-in-time balances. */
export const isDebtStock = (l: CfLine) => DEBT_STOCK_CATEGORIES.includes(l.category as any)
export const isOpeningAnchor = (l: CfLine) => l.category === OPENING_CATEGORY
export const isBalanceLine = (l: CfLine) => l.nature === 'Balance'

/** Flow sections for the optional analyst breakdown, derived from whatever
 * flow categories the catalog actually carries (ordered by sort_order) rather
 * than a hardcoded map — a new/renamed category shows up instead of vanishing.
 * Claims fold into Operations to match how the statement reads. */
export function flowSections(lines: CfLine[]): { label: string; categories: string[] }[] {
  const order = new Map<string, number>()
  for (const l of lines) {
    if (l.nature === 'Balance') continue
    const cur = order.get(l.category)
    if (cur === undefined || l.sort_order < cur) order.set(l.category, l.sort_order)
  }
  const cats = [...order.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0])
  const sections: { label: string; categories: string[] }[] = []
  for (const c of cats) {
    if (c === 'Claims') continue // folds into Operations
    if (c === 'Operation') sections.push({ label: 'Operations', categories: ['Operation', 'Claims'] })
    else sections.push({ label: c, categories: [c] })
  }
  return sections
}
