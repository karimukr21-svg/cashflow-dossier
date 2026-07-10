import { subgroupMatchesArea, type CfCell, type CanonicalArea, type CfLine, type PayablesTrajRow, type PayablesMaps } from '@/lib/queries'
import { flowSections } from '@/lib/cfTaxonomy'

/* Shared model for the Cash Flow Report — used by both the screen (CashReport)
 * and the print builder (reportPrint), so grouping/aggregation is defined once. */

/* Areas whose debt is excluded from the group debt rollup so it ties Tony's
 * consolidated (CONS). His CONS omits CC (UE)'s overdraft (equity-accounted /
 * presented separately) — verified as the SOLE line where our per-project rollup
 * diverges from his: for every other area the two tie to the dollar. Dropping it
 * makes the group loans + overdrafts total match Tony's consolidated figure. */
const DEBT_ROLLUP_EXCLUDE_AREAS = new Set(['CC (UE)'])

export type AreaAgg = {
  areaId: string; label: string; currency: string; fxOk: boolean; hasCf: boolean
  lineUsd: Map<string, number>          // FX-converted to USD (rate at as-of)
  lineLocal: Map<string, number>        // raw native, unconverted (for the Local toggle)
  netOps: number
  payStart: number | null; payEnd: number | null; hasPay: boolean
  openCash: number; endCash: number     // cash position (opening Jan / ending as-of), USD
  openLocal: number; endLocal: number   // same, raw native (for the Local toggle)
  // Debt stocks (point-in-time balances) — start-of-year (Jan) vs current (as-of),
  // USD. Loans + overdrafts kept separate so the Group report can show the split.
  loanStart: number; loanEnd: number    // Accumulated Loans stock @Jan / @as-of, USD
  odStart: number; odEnd: number        // Overdrafts stock @Jan / @as-of, USD
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
  const asOfMonth = asOf % 100

  const byArea = new Map<string, AreaAgg>()
  const ensure = (areaId: string, label: string): AreaAgg => {
    let a = byArea.get(areaId)
    if (!a) { a = { areaId, label, currency: 'USD', fxOk: true, hasCf: false, lineUsd: new Map(), lineLocal: new Map(), netOps: 0, payStart: null, payEnd: null, hasPay: false, openCash: 0, endCash: 0, openLocal: 0, endLocal: 0, loanStart: 0, loanEnd: 0, odStart: 0, odEnd: 0, matched: false }; byArea.set(areaId, a) }
    return a
  }

  for (const c of cells) {
    const can = cfToCanonical.get(c.area)
    if (!can) continue
    const cur = c.currency || 'USD'
    const agg = ensure(can.area_id, can.display_name)
    agg.hasCf = true
    if (cur !== 'USD') agg.currency = cur
    const cat = lineCat.get(c.line_code)
    // cash position: opening balance at Jan (year start), ending balance at as-of
    if (cat === 'Opening Balance' && c.month === 1) agg.openLocal += c.value
    else if (cat === 'Ending Balance' && c.month === asOfMonth) agg.endLocal += c.value
    // raw native (no FX) — feeds the Local toggle; recorded regardless of FX availability
    agg.lineLocal.set(c.line_code, (agg.lineLocal.get(c.line_code) ?? 0) + c.value)
    const rate = cur === 'USD' ? 1 : (fxMap.get(cur) ?? null)
    if (rate == null) { agg.fxOk = false; continue }
    agg.lineUsd.set(c.line_code, (agg.lineUsd.get(c.line_code) ?? 0) + c.value * rate)
    if (cat === 'Opening Balance' && c.month === 1) agg.openCash += c.value * rate
    else if (cat === 'Ending Balance' && c.month === asOfMonth) agg.endCash += c.value * rate
    // Debt stocks: point-in-time balance at the month, never summed across months.
    // Start-of-year = the prior-year DECEMBER period-END stock (balances are
    // reported at period end, so Dec is the year's opening position); current =
    // the as-of month. CC (UE)'s debt is excluded to tie Tony's consolidated.
    else if ((cat === 'Accumulated Loans' || cat === 'Overdrafts') && !DEBT_ROLLUP_EXCLUDE_AREAS.has(c.area)) {
      const isLoan = cat === 'Accumulated Loans'
      if (c.year === year - 1 && c.month === 12)    { if (isLoan) agg.loanStart += c.value * rate; else agg.odStart += c.value * rate }
      if (c.year === year && c.month === asOfMonth) { if (isLoan) agg.loanEnd += c.value * rate;   else agg.odEnd += c.value * rate }
    }
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

/* Lay items (sections) into columns per a label layout; anything not named in
 * the layout falls into column 1. Shared by the Sections page + the Group
 * statement + their prints. */
export function arrangeByColumns<T extends { label: string }>(items: T[], layout: string[][]): T[][] {
  const byLabel = new Map(items.map(i => [i.label, i]))
  const placed = new Set<string>()
  const cols = layout.map(labels => {
    const col = labels.map(l => byLabel.get(l)).filter((x): x is T => !!x)
    col.forEach(c => placed.add(c.label))
    return col
  })
  cols[0].push(...items.filter(i => !placed.has(i.label)))
  return cols
}

/* Sections-page layout: Operations full-height left, Interest + Bank Financing
 * middle, Within Group + Non-operational right. */
export const SECTION_COLUMNS: string[][] = [
  ['Operations', 'New Sales'],
  ['Interest', 'Bank Financing'],
  ['Within Group', 'Non Operational'],
]
export const arrangeSectionColumns = <T extends { label: string }>(items: T[]) => arrangeByColumns(items, SECTION_COLUMNS)

/* Group-page statement layout: Operations (+ New Sales) on the left; Interest,
 * Within Group, Non Operational and Bank Financing stacked on the right. */
export const STMT_COLUMNS: string[][] = [
  ['Operations', 'New Sales'],
  ['Interest', 'Within Group', 'Non Operational', 'Bank Financing'],
]

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

/* ── Forecast overlay ────────────────────────────────────────────────────────
 * When the Period selector reaches past the cycle's as-of month, the Group page
 * shows the forecast tail (as-of+1 → horizon) alongside the actuals. These two
 * helpers build that overlay: a per-area forecast line→USD map, and a combined
 * statement that carries BOTH the actual and the forecast figure per bucket. */

/** Sum forecast cells (already windowed to as-of+1 … horizon by the caller) to
 *  USD per area × line_code, at the as-of FX rate — same basis as the actual
 *  side so the two are directly comparable. Cells with no rate are skipped. */
export function buildForecastLineUsd(
  cells: (CfCell & { currency?: string })[],
  fxMap: Map<string, number | null>,
  cfToCanonical: Map<string, CanonicalArea>,
): Map<string, Map<string, number>> {
  const byArea = new Map<string, Map<string, number>>()
  for (const c of cells) {
    const can = cfToCanonical.get(c.area); if (!can) continue
    const cur = c.currency || 'USD'
    const rate = cur === 'USD' ? 1 : (fxMap.get(cur) ?? null)
    if (rate == null) continue
    let m = byArea.get(can.area_id); if (!m) { m = new Map(); byArea.set(can.area_id, m) }
    m.set(c.line_code, (m.get(c.line_code) ?? 0) + c.value * rate)
  }
  return byArea
}

export type DualBucket = { label: string; actual: number; forecast: number }
export type DualSection = {
  label: string; receipts: DualBucket[]; payments: DualBucket[]
  recA: number; recF: number; payA: number; payF: number; netA: number; netF: number
}
/** Grouped statement carrying the actual and the forecast figure side by side:
 *  same buckets/order as buildStatement, but each keeps both an `actual` and a
 *  `forecast` value. A bucket shows if EITHER side is material (≥ THRESH). */
export function buildDualStatement(
  actual: Map<string, number>, forecast: Map<string, number>, lines: CfLine[],
): { sections: DualSection[]; netA: number; netF: number } {
  const sumA = (codes: string[]) => codes.reduce((t, c) => t + (actual.get(c) ?? 0), 0)
  const sumF = (codes: string[]) => codes.reduce((t, c) => t + (forecast.get(c) ?? 0), 0)
  const out: DualSection[] = []
  let netA = 0, netF = 0
  for (const sec of groupSections(lines)) {
    const mk = (defs: BucketDef[]): DualBucket[] =>
      defs.map(b => ({ label: b.label, actual: sumA(b.codes), forecast: sumF(b.codes) }))
        .filter(b => Math.abs(b.actual) >= THRESH || Math.abs(b.forecast) >= THRESH)
    const receipts = mk(sec.receipts), payments = mk(sec.payments)
    if (receipts.length === 0 && payments.length === 0) continue
    const recA = receipts.reduce((t, b) => t + b.actual, 0), recF = receipts.reduce((t, b) => t + b.forecast, 0)
    const payA = payments.reduce((t, b) => t + b.actual, 0), payF = payments.reduce((t, b) => t + b.forecast, 0)
    const secNetA = recA + payA, secNetF = recF + payF
    netA += secNetA; netF += secNetF
    out.push({ label: sec.label, receipts, payments, recA, recF, payA, payF, netA: secNetA, netF: secNetF })
  }
  return { sections: out, netA, netF }
}

/* ── Movers rows (per-project) ────────────────────────────────────────────────
 * One row per cf project: net cash from operations (Operation + Claims, USD) +
 * the project's CCC-share trade payables at the two periods, and its `isPrimary`
 * (mainstream) flag from Nexus. Shared by the Movers screen and the print package
 * so the numbers are computed in exactly one place. */
export type MoverRow = {
  key: string; area: string; code: string
  netOps: number; fcNetOps?: number
  payStart: number | null; payEnd: number | null
  isPrimary: boolean
}
export function buildMoverRows(params: {
  cells: (CfCell & { project_code: string | null; currency?: string })[]
  fcCells: (CfCell & { project_code: string | null; currency?: string })[]
  opCodes: Set<string>
  fxMap: Map<string, number | null>
  payMaps: PayablesMaps | null
  bookBal: Map<string, Map<number, number>>
  decP: number; asOfP: number; forecastActive: boolean
}): MoverRow[] {
  const { cells, fcCells, opCodes, fxMap, payMaps, bookBal, decP, asOfP, forecastActive } = params
  const rateOf = (cur?: string) => (cur || 'USD') === 'USD' ? 1 : (fxMap.get(cur || '') ?? null)
  // Per-project net cash from operations (USD) for a cell source (actual or forecast).
  const projOpsOf = (src: typeof cells) => {
    const agg = new Map<string, { area: string; code: string; netOps: number }>()
    for (const c of src) {
      const code = c.project_code; if (!code) continue
      if (!opCodes.has(c.line_code)) continue
      const r = rateOf(c.currency); if (r == null) continue
      const key = c.area + code
      let a = agg.get(key); if (!a) { a = { area: c.area, code, netOps: 0 }; agg.set(key, a) }
      a.netOps += c.value * r
    }
    return agg
  }
  const projOps = projOpsOf(cells)
  const fcProjOps = forecastActive ? projOpsOf(fcCells) : new Map<string, { netOps: number }>()
  return [...projOps.entries()].map(([key, x]) => {
    const cid = payMaps?.cfCodeToCanon.get(x.code.toUpperCase())
    const books = cid ? (payMaps?.canonToBooks.get(cid) ?? []) : []
    let ps = 0, pe = 0, has = false
    for (const b of books) { const bm = bookBal.get(b); if (bm) { ps += bm.get(decP) ?? 0; pe += bm.get(asOfP) ?? 0; has = true } }
    return {
      key, area: x.area, code: x.code, netOps: x.netOps,
      fcNetOps: forecastActive ? (fcProjOps.get(key)?.netOps ?? 0) : undefined,
      payStart: has ? ps : null, payEnd: has ? pe : null,
      isPrimary: cid ? !!payMaps?.primaryCanon.has(cid) : false,
    }
  }).sort((a, b) => Math.abs(b.netOps) - Math.abs(a.netOps))
}

export type PaySeriesPt = { period: number; usd: number }
/** Monthly trade-payables series (USD) for a set of scoped areas, mirroring
 *  buildModel's subgroup→area assignment (first matching area wins) so the
 *  endpoints tie the Start/End position shown in the summary. */
export function payablesSeries(
  payTraj: PayablesTrajRow[], scopedIds: Set<string>, areas: CanonicalArea[],
  periodStart: number, periodEnd: number,
): PaySeriesPt[] {
  const byPeriod = new Map<number, number>()
  const periods = new Set<number>()
  for (const r of payTraj) {
    if (r.period < periodStart || r.period > periodEnd) continue
    periods.add(r.period)
    for (const a of areas) {
      if (!subgroupMatchesArea(r.subgroup, a.area_id)) continue
      if (scopedIds.has(a.area_id)) byPeriod.set(r.period, (byPeriod.get(r.period) ?? 0) + r.usdTotal)
      break
    }
  }
  return [...periods].sort((x, y) => x - y).map(p => ({ period: p, usd: byPeriod.get(p) ?? 0 }))
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
