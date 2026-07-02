import { subgroupMatchesArea, type CfCell, type CanonicalArea, type CfLine, type PayablesTrajRow } from '@/lib/queries'
import { flowSections } from '@/lib/cfTaxonomy'

/* Shared model for the Cash Flow Report — used by both the screen (CashReport)
 * and the print builder (reportPrint), so grouping/aggregation is defined once. */

export type AreaAgg = {
  areaId: string; label: string; currency: string; fxOk: boolean; hasCf: boolean
  lineUsd: Map<string, number>; netOps: number
  payStart: number | null; payEnd: number | null; hasPay: boolean
  matched: boolean
}

/** Aggregate cash flow (→USD) and trade-payables position per area, and flag
 *  which areas are "matched" — present on both sides (cash flow + a payables
 *  mapping) and FX-convertible — so Group/Area cover the same set. */
export function buildModel(
  cells: (CfCell & { currency?: string })[], payTraj: PayablesTrajRow[],
  fxMap: Map<string, number | null>, areas: CanonicalArea[], cfToCanonical: Map<string, CanonicalArea>,
  lines: CfLine[], year: number, asOf: number,
): Map<string, AreaAgg> {
  const OP = new Set(['Operation', 'Claims'])
  const lineCat = new Map(lines.map(l => [l.line_code, l.category]))
  const periodStart = (year - 1) * 100 + 12, periodEnd = asOf

  const byArea = new Map<string, AreaAgg>()
  const ensure = (areaId: string, label: string): AreaAgg => {
    let a = byArea.get(areaId)
    if (!a) { a = { areaId, label, currency: 'USD', fxOk: true, hasCf: false, lineUsd: new Map(), netOps: 0, payStart: null, payEnd: null, hasPay: false, matched: false }; byArea.set(areaId, a) }
    return a
  }

  for (const c of cells) {
    const can = cfToCanonical.get(c.area)
    if (!can) continue
    const cur = c.currency || 'USD'
    const agg = ensure(can.area_id, can.display_name)
    agg.hasCf = true
    if (cur !== 'USD') agg.currency = cur
    const rate = cur === 'USD' ? 1 : (fxMap.get(cur) ?? null)
    if (rate == null) { agg.fxOk = false; continue }
    agg.lineUsd.set(c.line_code, (agg.lineUsd.get(c.line_code) ?? 0) + c.value * rate)
  }
  for (const agg of byArea.values()) {
    let n = 0
    for (const [lc, v] of agg.lineUsd) if (OP.has(lineCat.get(lc) || '')) n += v
    agg.netOps = n
  }

  for (const r of payTraj) {
    if (r.period !== periodStart && r.period !== periodEnd) continue
    for (const a of areas) {
      if (!subgroupMatchesArea(r.subgroup, a.area_id)) continue
      const agg = ensure(a.area_id, a.display_name)
      if (r.period === periodStart) agg.payStart = (agg.payStart ?? 0) + r.usdTotal
      else agg.payEnd = (agg.payEnd ?? 0) + r.usdTotal
      agg.hasPay = true
      break
    }
  }

  for (const agg of byArea.values())
    agg.matched = agg.hasCf && agg.fxOk && agg.hasPay && (agg.payStart != null || agg.payEnd != null)
  return byArea
}

/* ── Line grouping ──────────────────────────────────────────────────────────
 * Roll the ~40 granular cf lines up to a handful of boardroom buckets, keeping
 * receipts and payments distinct. Keyed by line_code → { label, order }; any
 * code not listed falls back to its own description (so a new line still shows,
 * never silently vanishes). Editable here — one place. */
export const LINE_GROUPS: Record<string, { label: string; order: number }> = {
  // Operations — receipts
  oper_recpt_progress:  { label: 'Progress billings', order: 1 },
  oper_recpt_advance:   { label: 'Advances', order: 2 },
  oper_recpt_retention: { label: 'Retention', order: 3 },
  claims_recpt:         { label: 'Claims', order: 4 },
  oper_recpt_jv:        { label: 'Other receipts', order: 9 },
  oper_recpt_others:    { label: 'Other receipts', order: 9 },
  oper_recpt_vat:       { label: 'Other receipts', order: 9 },
  // Operations — payments
  oper_pay_salaries:      { label: 'Salaries & wages', order: 1 },
  oper_pay_wages:         { label: 'Salaries & wages', order: 1 },
  oper_pay_suppliers_for: { label: 'Suppliers, subcontractors & PMV', order: 2 },
  oper_pay_suppliers_loc: { label: 'Suppliers, subcontractors & PMV', order: 2 },
  oper_pay_subcontract:   { label: 'Suppliers, subcontractors & PMV', order: 2 },
  oper_pay_pmv:           { label: 'Suppliers, subcontractors & PMV', order: 2 },
  oper_pay_overheads:     { label: 'Overheads', order: 3 },
  oper_pay_capex:         { label: 'Capital expenditure', order: 4 },
  oper_pay_vat:           { label: 'Taxes (VAT & CIT)', order: 5 },
  oper_pay_cit:           { label: 'Taxes (VAT & CIT)', order: 5 },
  oper_pay_jv:            { label: 'Other payments', order: 9 },
  oper_pay_others:        { label: 'Other payments', order: 9 },
  // New Sales
  newsales_recpt_advance:  { label: 'New sales receipts', order: 1 },
  newsales_recpt_main:     { label: 'New sales receipts', order: 1 },
  newsales_recpt_other:    { label: 'New sales receipts', order: 1 },
  newsales_recpt_interest: { label: 'New sales receipts', order: 1 },
  newsales_recpt_loans:    { label: 'New sales receipts', order: 1 },
  newsales_pay_main:       { label: 'New sales payments', order: 1 },
  // Interest
  interest_recpt: { label: 'Interest received', order: 1 },
  interest_pay:   { label: 'Interest paid', order: 1 },
  // Non-operational
  nonop_recpt: { label: 'Non-operational receipts', order: 1 },
  nonop_pay:   { label: 'Non-operational payments', order: 1 },
  // Within Group
  wg_recpt_within_area:  { label: 'Within-group receipts', order: 1 },
  wg_recpt_moa:          { label: 'Within-group receipts', order: 1 },
  wg_recpt_outside_area: { label: 'Within-group receipts', order: 1 },
  wg_recpt_treasury:     { label: 'Within-group receipts', order: 1 },
  treasury_recpt_areas:  { label: 'Within-group receipts', order: 1 },
  wg_pay_within_area:    { label: 'Within-group payments', order: 1 },
  wg_pay_outside_area:   { label: 'Within-group payments', order: 1 },
  wg_pay_moa:            { label: 'Within-group payments', order: 1 },
  wg_pay_treasury:       { label: 'Within-group payments', order: 1 },
  treasury_pay_areas:    { label: 'Within-group payments', order: 1 },
  // Bank Financing
  bf_recpt_loans:      { label: 'Financing received', order: 1 },
  bf_recpt_discounted: { label: 'Financing received', order: 1 },
  bf_recpt_od:         { label: 'Financing received', order: 1 },
  bf_pay_loans:        { label: 'Financing repaid', order: 1 },
  bf_pay_discounted:   { label: 'Financing repaid', order: 1 },
  bf_pay_od:           { label: 'Financing repaid', order: 1 },
}

export type StmtBucket = { label: string; value: number }
export type StmtSection = { label: string; receipts: StmtBucket[]; payments: StmtBucket[]; recTotal: number; payTotal: number; net: number }

const THRESH = 50_000   // hide buckets that round to 0.0m

/** Build the grouped cash-flow statement: sections → receipts[] then payments[]
 *  (each rolled to LINE_GROUPS buckets), with per-nature subtotals + section net
 *  and an overall net cash movement. */
export function buildStatement(lineUsd: Map<string, number>, lines: CfLine[]): { sections: StmtSection[]; netMovement: number } {
  const linesByCat = new Map<string, CfLine[]>()
  for (const l of lines) { if (l.nature === 'Balance') continue; const a = linesByCat.get(l.category) || []; a.push(l); linesByCat.set(l.category, a) }

  const roll = (secLines: CfLine[], nature: 'Receipts' | 'Payments'): StmtBucket[] => {
    const m = new Map<string, { value: number; order: number }>()
    for (const l of secLines) {
      if (l.nature !== nature) continue
      const g = LINE_GROUPS[l.line_code]
      const label = g?.label ?? l.description
      const order = g?.order ?? l.sort_order
      const cur = m.get(label) || { value: 0, order }
      cur.value += lineUsd.get(l.line_code) ?? 0
      cur.order = Math.min(cur.order, order)
      m.set(label, cur)
    }
    return [...m.entries()]
      .map(([label, x]) => ({ label, value: x.value, order: x.order }))
      .filter(b => Math.abs(b.value) >= THRESH)
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
      .map(({ label, value }) => ({ label, value }))
  }

  const out: StmtSection[] = []
  let netMovement = 0
  for (const sec of flowSections(lines)) {
    const secLines = sec.categories.flatMap(c => linesByCat.get(c) || [])
    const receipts = roll(secLines, 'Receipts'), payments = roll(secLines, 'Payments')
    if (receipts.length === 0 && payments.length === 0) continue
    const recTotal = receipts.reduce((t, b) => t + b.value, 0)
    const payTotal = payments.reduce((t, b) => t + b.value, 0)
    const net = recTotal + payTotal
    netMovement += net
    out.push({ label: sec.label, receipts, payments, recTotal, payTotal, net })
  }
  return { sections: out, netMovement }
}
