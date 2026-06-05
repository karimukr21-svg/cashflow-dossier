import { supabase } from './supabase'

/* The dossier's source of truth for area structure is now public.areas +
 * public.cashflow_sheets (canonical work-dashboard tables). cf_actuals.area
 * values are Tony's labels and only enter the dossier through that bridge.
 *
 * - public.areas — canonical area_id + display_name + group_name + sort_order
 * - public.cashflow_sheets — per-sheet rows carrying cf_area + area_id FK;
 *   we collapse to (cf_area → area_id) for the dossier's purposes
 *
 * Areas with no row in cashflow_sheets are excluded automatically (this
 * subsumes the old DROPPED_AREAS list: CCEL/Sicon were never mapped). */

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

/* ── Canonical area structure ─────────────────────────────────────────── */

export type AreaGroup = 'Operations' | 'Subsidiaries' | 'Corporate' | 'Contingency'

export type CanonicalArea = {
  area_id: string         // 'KSA' | 'ACR' | 'CYP' | …
  area_name: string       // 'SAUDI ARABIA' | 'A&C' | 'CYPRUS' | …
  display_name: string    // public.areas.display_name || area_name
  group_name: AreaGroup
  sort_order: number
  /** Tony's cf labels that map to this canonical area. cf_actuals.area
   *  values match one of these strings. */
  cf_areas: string[]
  /** cf_country values from cashflow_sheets that fold into this canonical
   *  area. Use this to caption "Includes …" on rollup areas (OTH bundles
   *  Palestine + Morganti + Others; ACR bundles Algeria + Botswana + …).
   *  cf_actuals doesn't carry country grain — this is metadata, not a
   *  re-aggregation key. */
  cf_countries: string[]
}

/** Canonical areas that have at least one cashflow_sheets mapping.
 *  Result is sorted by (group_name → sort_order → area_name) and ready
 *  to drive the nav, the All-Areas filter popover, and aggregation keys.
 *
 *  group_name order is fixed to OPERATIONS → SUBSIDIARIES → CORPORATE →
 *  CONTINGENCY (Karim's preferred read), independent of alphabetic order. */
const GROUP_ORDER: AreaGroup[] = ['Operations', 'Subsidiaries', 'Corporate', 'Contingency']
const groupRank = (g: string) => {
  const i = GROUP_ORDER.indexOf(g as AreaGroup)
  return i < 0 ? 99 : i
}

export async function fetchCanonicalAreas(): Promise<CanonicalArea[]> {
  const [areasRes, sheetsRes] = await Promise.all([
    // is_active filter dropped 2026-06-05: IRQ is is_active=false in
    // public.areas but has cf_country data + cf_actuals rows. Letting any
    // canonical area with a cf_country mapping surface; is_virtual still
    // excludes the OVH-* rollups seeded for the Overheads page.
    supabase.from('areas')
      .select('area_id, area_name, display_name, group_name, sort_order, is_active, is_virtual')
      .eq('is_virtual', false),
    supabase.from('cashflow_sheets')
      .select('cf_area, cf_country, area_id')
      .not('area_id', 'is', null),
  ])
  if (areasRes.error) throw areasRes.error
  if (sheetsRes.error) throw sheetsRes.error

  // 2026-06-05: dossier flattened to country grain. Each cf_country becomes
  // its own row, inheriting group_name + sort_order from its parent canonical
  // area in public.areas. The 3-bucket grouping (Operations / Subsidiaries /
  // Corporate) is preserved; intermediate canonical-area headers (KSA / ACR /
  // OTH / …) are gone. Mirrors how Treasury presents in Tony's workbook.
  const parentById = new Map<string, typeof areasRes.data extends (infer R)[] | null ? R : never>()
  for (const a of (areasRes.data || [])) parentById.set(a.area_id, a)

  // De-dupe (area_id, cf_country) — cashflow_sheets may have many sheet rows
  // per country across periods. We want one row per country in the nav.
  const seen = new Set<string>()
  const out: CanonicalArea[] = []
  for (const row of sheetsRes.data || []) {
    if (!row.area_id || !row.cf_country) continue
    const key = `${row.area_id}::${row.cf_country}`
    if (seen.has(key)) continue
    seen.add(key)
    const parent = parentById.get(row.area_id)
    if (!parent) continue   // unmapped — skip
    out.push({
      area_id: row.cf_country,                         // country IS the id
      area_name: row.cf_country,
      display_name: row.cf_country,
      group_name: parent.group_name as AreaGroup,
      sort_order: (parent.sort_order ?? 99) * 100,     // inherit canonical order at top, alpha within
      cf_areas: [row.cf_country],                      // single-country filter against cf_actuals.area
      cf_countries: [row.cf_country],
    })
  }
  out.sort((x, y) =>
    groupRank(x.group_name) - groupRank(y.group_name)
    || x.sort_order - y.sort_order
    || x.area_name.localeCompare(y.area_name))
  return out
}

/** All actuals in the period scope. `cfAreas` filters by Tony's cf labels
 *  (the canonical-area drill resolves area_id → cf_areas and passes those).
 *  Pass undefined to fetch every cf_area. Month range trimmed client-side. */
export async function fetchActuals(opts: {
  fromYear: number; fromMonth: number; toYear: number; toMonth: number;
  cfAreas?: string[];
}): Promise<(CfCell & { source_version: string })[]> {
  let q = supabase
    .from('cf_actuals')
    .select('area, line_code, year, month, value, source_version')
    .gte('year', opts.fromYear).lte('year', opts.toYear)
  if (opts.cfAreas && opts.cfAreas.length > 0) q = q.in('area', opts.cfAreas)
  const { data, error } = await q
  if (error) throw error
  return (data || [])
    .filter(r => inRange(r, opts.fromYear, opts.fromMonth, opts.toYear, opts.toMonth))
    .map(r => ({ ...r, value: Number(r.value) }))
}

/** Forecast cells in the period scope for a given version. Same cfAreas
 *  contract as fetchActuals. */
export async function fetchForecasts(opts: {
  version: string;
  fromYear: number; fromMonth: number; toYear: number; toMonth: number;
  cfAreas?: string[];
}): Promise<(CfCell & { version: string })[]> {
  let q = supabase
    .from('cf_forecasts')
    .select('area, line_code, year, month, value, version')
    .eq('version', opts.version)
    .gte('year', opts.fromYear).lte('year', opts.toYear)
  if (opts.cfAreas && opts.cfAreas.length > 0) q = q.in('area', opts.cfAreas)
  const { data, error } = await q
  if (error) throw error
  return (data || [])
    .filter(r => inRange(r, opts.fromYear, opts.fromMonth, opts.toYear, opts.toMonth))
    .map(r => ({ ...r, value: Number(r.value) }))
}

/** Bank position — monthly aggregates across all areas, for a calendar year.
 *  Returns one row per month present, group-level totals for cash / loans / od. */
export async function fetchBankPositionMonthly(year: number): Promise<{
  ym: number; cash: number; loans: number; od: number; netFunds: number;
}[]> {
  const { data, error } = await supabase
    .from('bank_position')
    .select('period, account, balance')
    .gte('period', `${year}-01-01`).lt('period', `${year + 1}-01-01`)
  if (error) throw error
  const byPeriod = new Map<string, { cash: number; loans: number; od: number }>()
  for (const r of data || []) {
    const k = r.period
    if (!byPeriod.has(k)) byPeriod.set(k, { cash: 0, loans: 0, od: 0 })
    const acc = (r.account || '').toLowerCase()
    const bal = Number(r.balance)
    if (acc === 'cash') byPeriod.get(k)!.cash += bal
    else if (acc === 'loans') byPeriod.get(k)!.loans += bal
    else if (acc === 'overdrafts') byPeriod.get(k)!.od += bal
  }
  const out = [...byPeriod.entries()].map(([period, t]) => {
    const [y, m] = period.split('-').map(Number)
    return { ym: y * 100 + m, cash: t.cash, loans: t.loans, od: t.od, netFunds: t.cash + t.loans + t.od }
  })
  return out.sort((a, b) => a.ym - b.ym)
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
