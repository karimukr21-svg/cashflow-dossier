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

/** Bucket definitions per section (the grouping skeleton), keeping the member
 *  line_codes so both the single-column statement and the monthly matrix roll
 *  the same buckets. */
type BucketDef = { label: string; order: number; codes: string[] }
export type SectionDef = { label: string; receipts: BucketDef[]; payments: BucketDef[] }

export function groupSections(lines: CfLine[]): SectionDef[] {
  const linesByCat = new Map<string, CfLine[]>()
  for (const l of lines) { if (l.nature === 'Balance') continue; const a = linesByCat.get(l.category) || []; a.push(l); linesByCat.set(l.category, a) }
  const defs = (secLines: CfLine[], nature: 'Receipts' | 'Payments'): BucketDef[] => {
    const m = new Map<string, BucketDef>()
    for (const l of secLines) {
      if (l.nature !== nature) continue
      const g = LINE_GROUPS[l.line_code]
      const label = g?.label ?? l.description
      const order = g?.order ?? l.sort_order
      let b = m.get(label)
      if (!b) { b = { label, order, codes: [] }; m.set(label, b) }
      b.codes.push(l.line_code); b.order = Math.min(b.order, order)
    }
    return [...m.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  }
  return flowSections(lines).map(sec => {
    const secLines = sec.categories.flatMap(c => linesByCat.get(c) || [])
    return { label: sec.label, receipts: defs(secLines, 'Receipts'), payments: defs(secLines, 'Payments') }
  })
}

/** Build the grouped cash-flow statement: sections → receipts[] then payments[]
 *  (each rolled to LINE_GROUPS buckets), with per-nature subtotals + section net
 *  and an overall net cash movement. */
export function buildStatement(lineUsd: Map<string, number>, lines: CfLine[]): { sections: StmtSection[]; netMovement: number } {
  const sum = (codes: string[]) => codes.reduce((t, c) => t + (lineUsd.get(c) ?? 0), 0)
  const out: StmtSection[] = []
  let netMovement = 0
  for (const sec of groupSections(lines)) {
    const receipts = sec.receipts.map(b => ({ label: b.label, value: sum(b.codes) })).filter(b => Math.abs(b.value) >= THRESH)
    const payments = sec.payments.map(b => ({ label: b.label, value: sum(b.codes) })).filter(b => Math.abs(b.value) >= THRESH)
    if (receipts.length === 0 && payments.length === 0) continue
    const recTotal = receipts.reduce((t, b) => t + b.value, 0)
    const payTotal = payments.reduce((t, b) => t + b.value, 0)
    const net = recTotal + payTotal
    netMovement += net
    out.push({ label: sec.label, receipts, payments, recTotal, payTotal, net })
  }
  return { sections: out, netMovement }
}

export type MatrixBucket = { label: string; monthly: number[]; total: number }
export type MatrixSection = { label: string; receipts: MatrixBucket[]; payments: MatrixBucket[]; recTotal: number[]; payTotal: number[]; net: number[]; netTot: number }

/** Monthly matrix version of the statement: same buckets, one value per month
 *  (in `months` order) + a YTD total. `perCode` = line_code → (month → USD). */
export function buildStatementMatrix(perCode: Map<string, Map<number, number>>, lines: CfLine[], months: number[]): { sections: MatrixSection[]; netMovement: number[]; netTotal: number } {
  const monthlyOf = (codes: string[]) => months.map(m => codes.reduce((t, c) => t + (perCode.get(c)?.get(m) ?? 0), 0))
  const sumRows = (rows: MatrixBucket[]) => months.map((_, i) => rows.reduce((t, r) => t + r.monthly[i], 0))
  const out: MatrixSection[] = []
  const netMovement = months.map(() => 0)
  let netTotal = 0
  for (const sec of groupSections(lines)) {
    const mk = (defs: BucketDef[]): MatrixBucket[] => defs.map(b => {
      const monthly = monthlyOf(b.codes)
      return { label: b.label, monthly, total: monthly.reduce((a, c) => a + c, 0) }
    }).filter(b => Math.abs(b.total) >= THRESH)
    const receipts = mk(sec.receipts), payments = mk(sec.payments)
    if (receipts.length === 0 && payments.length === 0) continue
    const recTotal = sumRows(receipts), payTotal = sumRows(payments)
    const net = months.map((_, i) => recTotal[i] + payTotal[i])
    net.forEach((v, i) => netMovement[i] += v)
    const netTot = net.reduce((a, c) => a + c, 0)
    netTotal += netTot
    out.push({ label: sec.label, receipts, payments, recTotal, payTotal, net, netTot })
  }
  return { sections: out, netMovement, netTotal }
}
