import { supabase } from './supabase'

export type CfLine = {
  line_code: string
  nature: 'Receipts' | 'Payments' | 'Balance'
  category: string
  description: string
  sign_convention: 'positive' | 'negative' | 'signed'
  sort_order: number
  is_active: boolean
}

export type CfVersion = {
  version_code: string
  cycle_year: number
  cycle_month: number
  source_file: string | null
  as_of_date: string
  loaded_at: string
  notes: string | null
}

export type CfCell = {
  area: string
  line_code: string
  year: number
  month: number
  value: number
}

export type CfCellWithLine = CfCell & {
  line: CfLine
  kind: 'Actual' | 'Forecast'
  source_version?: string
  version?: string
}

export type BankPositionRow = {
  area: string
  period: string
  account: string
  balance: number
}

/** Catalog: all lines, sorted display-ready */
export async function fetchLines(): Promise<CfLine[]> {
  const { data, error } = await supabase
    .from('cf_lines')
    .select('*')
    .order('sort_order')
  if (error) throw error
  return data as CfLine[]
}

/** Catalog: all known forecast versions, newest first */
export async function fetchVersions(): Promise<CfVersion[]> {
  const { data, error } = await supabase
    .from('cf_versions')
    .select('*')
    .order('cycle_year', { ascending: false })
    .order('cycle_month', { ascending: false })
  if (error) throw error
  return data as CfVersion[]
}

/** Distinct areas across actuals + forecasts (alphabetical) */
export async function fetchAreas(): Promise<string[]> {
  const [actRes, fcRes] = await Promise.all([
    supabase.from('cf_actuals').select('area'),
    supabase.from('cf_forecasts').select('area'),
  ])
  if (actRes.error) throw actRes.error
  if (fcRes.error) throw fcRes.error
  const set = new Set<string>()
  ;(actRes.data || []).forEach(r => set.add(r.area))
  ;(fcRes.data || []).forEach(r => set.add(r.area))
  return [...set].sort()
}

/** All actuals in the period scope (filters month client-side). */
export async function fetchActuals(opts: {
  fromYear: number; fromMonth: number; toYear: number; toMonth: number;
  area?: string;
}): Promise<(CfCell & { source_version: string })[]> {
  let q = supabase
    .from('cf_actuals')
    .select('area, line_code, year, month, value, source_version')
    .gte('year', opts.fromYear).lte('year', opts.toYear)
  if (opts.area) q = q.eq('area', opts.area)
  const { data, error } = await q
  if (error) throw error
  return (data || [])
    .filter(r => inRange(r, opts.fromYear, opts.fromMonth, opts.toYear, opts.toMonth))
    .map(r => ({ ...r, value: Number(r.value) }))
}

/** Forecast cells in the period scope for a given version */
export async function fetchForecasts(opts: {
  version: string;
  fromYear: number; fromMonth: number; toYear: number; toMonth: number;
  area?: string;
}): Promise<(CfCell & { version: string })[]> {
  let q = supabase
    .from('cf_forecasts')
    .select('area, line_code, year, month, value, version')
    .eq('version', opts.version)
    .gte('year', opts.fromYear).lte('year', opts.toYear)
  if (opts.area) q = q.eq('area', opts.area)
  const { data, error } = await q
  if (error) throw error
  return (data || [])
    .filter(r => inRange(r, opts.fromYear, opts.fromMonth, opts.toYear, opts.toMonth))
    .map(r => ({ ...r, value: Number(r.value) }))
}

/** Bank position — latest period across areas */
export async function fetchBankPositionLatest(): Promise<{
  period: string;
  rows: BankPositionRow[];
}> {
  const { data: periods, error: e1 } = await supabase
    .from('bank_position').select('period').order('period', { ascending: false }).limit(1)
  if (e1) throw e1
  if (!periods || periods.length === 0) return { period: '', rows: [] }
  const period = periods[0].period
  const { data, error } = await supabase
    .from('bank_position')
    .select('area, period, account, balance')
    .eq('period', period)
  if (error) throw error
  return {
    period,
    rows: (data || []).map(r => ({ ...r, balance: Number(r.balance) })),
  }
}

/** Helper: same OR clauses don't combine nicely on supabase-js — fall back to
 * a simple year-only filter range and trim months client-side when needed. */
export function inRange(r: { year: number; month: number },
  fy: number, fm: number, ty: number, tm: number): boolean {
  const k = r.year * 100 + r.month
  return k >= fy * 100 + fm && k <= ty * 100 + tm
}
