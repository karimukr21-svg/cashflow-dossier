import { supabase } from '@/lib/supabase'

/* ------------------------------------------------------------------ *
 * Allocations module — data layer.
 *
 * A source-and-use / fund-earmarking ledger. Treasury records INFLOWS
 * (money in) and OBLIGATIONS (the shopping list of things to pay), then
 * ALLOCATES outs against ins (alloc_allocations, the many:many junction),
 * and records PAYMENTS as actual settlement of obligations.
 *
 * USD is the spine: every inflow/obligation/payment is entered in its native
 * currency with an FX rate captured at entry; amount_usd is a stored generated
 * column in the DB. All allocation amounts are USD. Payment sourcing is
 * pro-rata from an obligation's allocations (no payment<->inflow junction).
 * ------------------------------------------------------------------ */

export type InflowStatus = 'expected' | 'received'
export type SourceType = 'client' | 'loan' | 'intercompany' | 'shareholder' | 'other'
export type ObligationCategory =
  | 'payroll' | 'supplier' | 'tax' | 'loan_repayment' | 'intercompany' | 'other'

export const SOURCE_TYPES: SourceType[] = ['client', 'loan', 'intercompany', 'shareholder', 'other']
export const OBLIGATION_CATEGORIES: ObligationCategory[] =
  ['payroll', 'supplier', 'tax', 'loan_repayment', 'intercompany', 'other']

/** USD first; the rest are the currencies the group actually transacts in. */
export const CURRENCIES = ['USD', 'EUR', 'SAR', 'AED', 'QAR', 'OMR', 'KWD', 'EGP', 'GBP'] as const
export type Currency = (typeof CURRENCIES)[number] | string

export interface Inflow {
  id: string
  dated: string // 'YYYY-MM-DD'
  status: InflowStatus
  source_name: string
  source_type: SourceType
  amount_native: number
  currency: string
  fx_to_usd: number
  amount_usd: number
  reference: string | null
  area_key: string | null
  note: string | null
  created_at: string
}

export interface Obligation {
  id: string
  due_date: string | null
  description: string
  category: ObligationCategory
  amount_native: number
  currency: string
  fx_to_usd: number
  amount_usd: number
  area_key: string | null
  note: string | null
  created_at: string
}

export interface Allocation {
  id: string
  inflow_id: string
  obligation_id: string
  amount_usd: number
  alloc_date: string
  note: string | null
  created_at: string
}

export interface Payment {
  id: string
  obligation_id: string
  paid_date: string
  amount_native: number
  currency: string
  fx_to_usd: number
  amount_usd: number
  reference: string | null
  note: string | null
  created_at: string
}

/* ── Loads ──────────────────────────────────────────────────────── */

const INFLOW_COLS =
  'id, dated, status, source_name, source_type, amount_native, currency, fx_to_usd, amount_usd, reference, area_key, note, created_at'
const OBLIGATION_COLS =
  'id, due_date, description, category, amount_native, currency, fx_to_usd, amount_usd, area_key, note, created_at'
const ALLOCATION_COLS = 'id, inflow_id, obligation_id, amount_usd, alloc_date, note, created_at'
const PAYMENT_COLS =
  'id, obligation_id, paid_date, amount_native, currency, fx_to_usd, amount_usd, reference, note, created_at'

export interface LedgerData {
  inflows: Inflow[]
  obligations: Obligation[]
  allocations: Allocation[]
  payments: Payment[]
}

export async function loadLedger(): Promise<LedgerData> {
  const [inf, obl, alloc, pay] = await Promise.all([
    supabase.from('alloc_inflows').select(INFLOW_COLS).order('dated', { ascending: false }),
    supabase.from('alloc_obligations').select(OBLIGATION_COLS).order('due_date', { ascending: true, nullsFirst: false }),
    supabase.from('alloc_allocations').select(ALLOCATION_COLS),
    supabase.from('alloc_payments').select(PAYMENT_COLS).order('paid_date', { ascending: false }),
  ])
  for (const r of [inf, obl, alloc, pay]) if (r.error) throw r.error
  return {
    inflows: (inf.data ?? []) as Inflow[],
    obligations: (obl.data ?? []) as Obligation[],
    allocations: (alloc.data ?? []) as Allocation[],
    payments: (pay.data ?? []) as Payment[],
  }
}

/* ── Mutations ──────────────────────────────────────────────────── */

export type InflowInput = Omit<Inflow, 'id' | 'amount_usd' | 'created_at'>
export type ObligationInput = Omit<Obligation, 'id' | 'amount_usd' | 'created_at'>
export type PaymentInput = Omit<Payment, 'id' | 'amount_usd' | 'created_at'>

export async function createInflow(input: InflowInput): Promise<void> {
  const { error } = await supabase.from('alloc_inflows').insert(input)
  if (error) throw error
}
export async function updateInflow(id: string, patch: Partial<InflowInput>): Promise<void> {
  const { error } = await supabase.from('alloc_inflows').update(patch).eq('id', id)
  if (error) throw error
}
export async function deleteInflow(id: string): Promise<void> {
  const { error } = await supabase.from('alloc_inflows').delete().eq('id', id)
  if (error) throw error
}

export async function createObligation(input: ObligationInput): Promise<void> {
  const { error } = await supabase.from('alloc_obligations').insert(input)
  if (error) throw error
}
export async function updateObligation(id: string, patch: Partial<ObligationInput>): Promise<void> {
  const { error } = await supabase.from('alloc_obligations').update(patch).eq('id', id)
  if (error) throw error
}
export async function deleteObligation(id: string): Promise<void> {
  const { error } = await supabase.from('alloc_obligations').delete().eq('id', id)
  if (error) throw error
}

/** Upsert one allocation link (inflow x obligation). Set amount=0 effectively removes it via deleteAllocation. */
export async function upsertAllocation(input: {
  inflow_id: string
  obligation_id: string
  amount_usd: number
  alloc_date?: string
  note?: string | null
}): Promise<void> {
  const { error } = await supabase
    .from('alloc_allocations')
    .upsert(input, { onConflict: 'inflow_id,obligation_id' })
  if (error) throw error
}
export async function deleteAllocation(id: string): Promise<void> {
  const { error } = await supabase.from('alloc_allocations').delete().eq('id', id)
  if (error) throw error
}

export async function createPayment(input: PaymentInput): Promise<void> {
  const { error } = await supabase.from('alloc_payments').insert(input)
  if (error) throw error
}
export async function deletePayment(id: string): Promise<void> {
  const { error } = await supabase.from('alloc_payments').delete().eq('id', id)
  if (error) throw error
}

/* ── Derived source-and-use math (pure, computed client-side) ────── *
 * Data volumes are small (manual entry), so we resolve everything from the
 * loaded arrays rather than DB views. */

export interface InflowDerived {
  allocated: number   // Σ allocations from this inflow (USD)
  unallocated: number // amount_usd - allocated
}
export interface ObligationDerived {
  funded: number      // Σ allocations to this obligation (USD)
  outstanding: number // amount_usd - funded
  paid: number        // Σ payments against this obligation (USD)
  unpaid: number      // amount_usd - paid
  fundStatus: 'unfunded' | 'partial' | 'funded'
  paidStatus: 'unpaid' | 'partial' | 'settled'
}

const EPS = 0.005 // sub-cent tolerance

export function deriveInflow(inflow: Inflow, allocations: Allocation[]): InflowDerived {
  const allocated = allocations
    .filter(a => a.inflow_id === inflow.id)
    .reduce((s, a) => s + a.amount_usd, 0)
  return { allocated, unallocated: inflow.amount_usd - allocated }
}

export function deriveObligation(obl: Obligation, allocations: Allocation[], payments: Payment[]): ObligationDerived {
  const funded = allocations
    .filter(a => a.obligation_id === obl.id)
    .reduce((s, a) => s + a.amount_usd, 0)
  const paid = payments
    .filter(p => p.obligation_id === obl.id)
    .reduce((s, p) => s + p.amount_usd, 0)
  const outstanding = obl.amount_usd - funded
  const fundStatus: ObligationDerived['fundStatus'] =
    funded <= EPS ? 'unfunded' : outstanding <= EPS ? 'funded' : 'partial'
  const paidStatus: ObligationDerived['paidStatus'] =
    paid <= EPS ? 'unpaid' : obl.amount_usd - paid <= EPS ? 'settled' : 'partial'
  return { funded, outstanding, paid, unpaid: obl.amount_usd - paid, fundStatus, paidStatus }
}

/** Headline totals for the dashboard tiles, respecting a period filter already applied upstream. */
export interface Totals {
  totalIn: number
  totalObligations: number
  allocated: number
  unallocatedCash: number
  unfunded: number
  totalPaid: number
}
export function computeTotals(d: LedgerData): Totals {
  const totalIn = d.inflows.reduce((s, i) => s + i.amount_usd, 0)
  const totalObligations = d.obligations.reduce((s, o) => s + o.amount_usd, 0)
  const allocated = d.allocations.reduce((s, a) => s + a.amount_usd, 0)
  const totalPaid = d.payments.reduce((s, p) => s + p.amount_usd, 0)
  const unfunded = d.obligations.reduce((s, o) => {
    const der = deriveObligation(o, d.allocations, d.payments)
    return s + Math.max(0, der.outstanding)
  }, 0)
  return {
    totalIn,
    totalObligations,
    allocated,
    unallocatedCash: totalIn - allocated,
    unfunded,
    totalPaid,
  }
}

/* ── Period filtering ───────────────────────────────────────────── *
 * Continuous ledger, period-aware: a date range filters which inflows /
 * obligations / payments are in scope. Allocations always follow their
 * endpoints (an allocation is in scope if either side is). */
export interface PeriodRange {
  from: string | null // 'YYYY-MM-DD' inclusive
  to: string | null   // 'YYYY-MM-DD' inclusive
}

export const inRange = (d: string | null, r: PeriodRange): boolean => {
  if (!d) return r.from == null // undated rows only show when range is open
  if (r.from && d < r.from) return false
  if (r.to && d > r.to) return false
  return true
}

/* ── Formatting ─────────────────────────────────────────────────── */
const usdFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
/** Whole-USD with thousands separators; negatives in parens; null/0 → em-dash. */
export function usd(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—'
  const r = Math.round(n)
  if (r === 0) return '—'
  const s = usdFmt.format(Math.abs(r))
  return r < 0 ? `(${s})` : s
}
/** Native amount with its currency code, e.g. "1,000,000 EUR". */
export function money(n: number | null | undefined, ccy: string): string {
  if (n == null || isNaN(n)) return '—'
  return `${usdFmt.format(Math.round(n))} ${ccy}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function fmtDate(d: string | null): string {
  if (!d) return '—'
  const [y, m, day] = d.split('-')
  return `${day} ${MONTHS[Number(m) - 1] || ''} ${y}`
}
export const labelSourceType = (t: SourceType) =>
  ({ client: 'Client', loan: 'Loan / facility', intercompany: 'Intercompany', shareholder: 'Shareholder', other: 'Other' }[t])
export const labelCategory = (c: ObligationCategory) =>
  ({ payroll: 'Payroll', supplier: 'Supplier', tax: 'Tax', loan_repayment: 'Loan repayment', intercompany: 'Intercompany', other: 'Other' }[c])
