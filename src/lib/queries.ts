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

/** Payables balance (Midas group 212 — suppliers/subcontractors/taxes) for a
 *  canonical area (or the whole group when omitted) at a period, from
 *  public.bs_positions. Returns BOTH native (valid only if every contributing
 *  area shares one currency) and USD. A point-in-time balance (one snapshot). */
export async function fetchPayables(opts: {
  canonicalAreaId?: string; period: number;
}): Promise<{ localValue: number | null; usdValue: number; nativeCurrency: string } | null> {
  let q = supabase
    .from('bs_positions')
    .select('local_balance, usd_balance, book_currency')
    .eq('period', opts.period).eq('grp', '212')
  if (opts.canonicalAreaId) q = q.eq('canonical_area_id', opts.canonicalAreaId)
  else q = q.not('canonical_area_id', 'is', null)
  const { data, error } = await q
  if (error) throw error
  if (!data || data.length === 0) return null
  const ccys = new Set(data.map(r => r.book_currency))
  const usdValue = data.reduce((t, r) => t + Number(r.usd_balance || 0), 0)
  const single = ccys.size === 1 && ![...ccys][0]?.includes('MULTI')
  return {
    localValue: single ? data.reduce((t, r) => t + Number(r.local_balance || 0), 0) : null,
    usdValue,
    nativeCurrency: single ? [...ccys][0] : 'MULTI',
  }
}

/* ── Payables trajectory (monthly, from the canonical TB) ──────────────────
 * Replaces the single point-in-time bs_positions snapshot: the full monthly
 * trade-payables line from public.tb_balances (USD, pre-converted), summed over
 * the LIVE, editable trade_payables account-group (public.coa_group_accounts —
 * defined in the Chart of Accounts module, NOT hardcoded to 212). Served by the
 * v_cf_payables_trajectory view, one row per (period, org_chart subgroup).
 * Group mode sums all rows per period; area mode filters subgroups by name
 * (subgroupMatchesArea) pending the canonical main-tree crosswalk. n_books is
 * the payables-carrying books posted that period — the coverage/posting-lag
 * signal (a period with fewer books than the fullest month is provisional). */
export type PayablesTrajRow = { period: number; subgroup: string | null; usdTotal: number; nBooks: number }

export async function fetchPayablesTrajectory(): Promise<PayablesTrajRow[]> {
  const { data, error } = await supabase
    .from('v_cf_payables_trajectory')
    .select('period, subgroup, usd_total, n_books')
  if (error) throw error
  return (data || []).map(r => ({
    period: Number(r.period), subgroup: r.subgroup as string | null,
    usdTotal: Number(r.usd_total || 0), nBooks: Number(r.n_books || 0),
  }))
}

/** Normalize an area / org_chart.subgroup name for best-effort matching:
 *  uppercase, drop JV ("JO'S"), city ("- ATYRAU") and "AREA" suffixes, then
 *  strip non-letters. Best-effort only — pending the canonical main-tree
 *  crosswalk (org_chart.subgroup ↔ canonical area has no shared key yet). */
export function normAreaName(s: string): string {
  return (s || '').toUpperCase()
    .replace(/\bJO'?S\b/g, ' ')
    .replace(/\s*-\s*[A-Z.() ]+$/g, ' ')
    .replace(/\bAREA\b/g, ' ')
    .replace(/[^A-Z]/g, '')
}
/** Report area (cf_country) → org_chart.subgroup base names a plain normalize
 *  misses. Extend / replace with the real crosswalk table when it lands. */
const AREA_SUBGROUP_ALIAS: Record<string, string[]> = {
  KSA: ['SAUDIARABIA', 'KSA'],
  UAE: ['ABUDHABI', 'UAE'],
  LYBIA: ['LIBYA'],            // Tony spells it "Lybia"
}
/** Does an org_chart.subgroup roll up to the report area (cf_country)? */
export function subgroupMatchesArea(subgroup: string | null, areaId: string): boolean {
  if (!subgroup) return false
  const base = normAreaName(areaId)
  if (!base) return false
  const targets = new Set<string>([base, ...(AREA_SUBGROUP_ALIAS[base] || [])])
  return targets.has(normAreaName(subgroup))
}

/** USD-per-1-unit rate for a currency at a date, from gacc.fx_rates (latest
 *  cycle effective on/before the date). Used to show an area's native-currency
 *  story in USD. Returns null when no rate is found. */
export async function fetchFxRate(fromCurrency: string, asOfDate: string): Promise<number | null> {
  if (!fromCurrency || fromCurrency === 'USD') return fromCurrency === 'USD' ? 1 : null
  const { data: cycles } = await supabase.schema('gacc')
    .from('fx_rate_cycles').select('id, effective_date')
    .lte('effective_date', asOfDate).order('effective_date', { ascending: false }).limit(1)
  if (!cycles || cycles.length === 0) return null
  const { data: rates } = await supabase.schema('gacc')
    .from('fx_rates').select('rate')
    .eq('fx_rate_cycle_id', cycles[0].id).eq('from_currency', fromCurrency).eq('to_currency', 'USD').limit(1)
  return rates && rates.length ? Number(rates[0].rate) : null
}

/** The distinct cf area labels that actually carry pushed forecast rows for a
 *  version — used to default a view to a populated area rather than a hardcoded
 *  showcase. One short text column; deduped client-side. */
export async function fetchPopulatedCfAreas(version: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('cf_forecasts')
    .select('area')
    .eq('version', version)
  if (error) throw error
  return new Set((data || []).map(r => r.area))
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
}): Promise<(CfCell & { source_version: string; currency?: string; project_code?: string | null })[]> {
  let q = supabase
    .from('cf_actuals')
    .select('area, project_code, line_code, year, month, value, source_version, currency')
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
}): Promise<(CfCell & { version: string; currency?: string; project_code?: string | null })[]> {
  let q = supabase
    .from('cf_forecasts')
    .select('area, project_code, line_code, year, month, value, version, currency')
    .eq('version', opts.version)
    .gte('year', opts.fromYear).lte('year', opts.toYear)
  if (opts.cfAreas && opts.cfAreas.length > 0) q = q.in('area', opts.cfAreas)
  const { data, error } = await q
  if (error) throw error
  const base = (data || [])
    .filter(r => inRange(r, opts.fromYear, opts.fromMonth, opts.toYear, opts.toMonth))
    .map(r => ({ ...r, value: Number(r.value) }))

  // Adjustment layer: Tony's version-specific adjustments live in the ledger
  // (public.cf_adjustment_legs, exposed as v_cf_adjustment_deltas) as USD deltas
  // per area x line x month — including ELAPSED months that publish trimmed out of
  // the forecast table. Append them as USD forecast-style cells so a version's
  // totals reflect its adjustments on top of the shared actuals. ORIG has no legs.
  // project_code MUST be a sentinel ('_ADJ') that never matches a real actual key:
  // deltas are ADDITIVE. CashReport merges actuals OVER forecasts by
  // area|project_code|line|year|month, so tagging deltas '_AREA' made them collide
  // with the _AREA-grain actuals of Tony-only areas — a cash-neutral reclass then
  // lost one leg while its balancing leg survived, injecting a phantom net (the
  // EPSO within->outside reclass leaked +2.2M into group Within-Group). '_ADJ'
  // never collides, so every leg adds and the report ties v_cf_adjusted_full.
  let dq = supabase
    .from('v_cf_adjustment_deltas')
    .select('area, line_code, year, month, delta_usd')
    .eq('base_version', opts.version)
    .gte('year', opts.fromYear).lte('year', opts.toYear)
  if (opts.cfAreas && opts.cfAreas.length > 0) dq = dq.in('area', opts.cfAreas)
  const { data: deltas, error: derr } = await dq
  if (derr) throw derr
  const adj = (deltas || [])
    .filter(r => inRange(r, opts.fromYear, opts.fromMonth, opts.toYear, opts.toMonth))
    .map(r => ({
      area: r.area, project_code: '_ADJ', line_code: r.line_code,
      year: r.year, month: r.month, value: Number(r.delta_usd),
      version: opts.version, currency: 'USD',
    }))

  return [...base, ...adj]
}

/** Project-grain cash-flow cells for a version + period window. Scoped to ONE
 *  cf area (Tony's cf label) when `cfArea` is given, or ALL areas when omitted.
 *  Carries area + project_code + currency for the Project report. */
export async function fetchProjectCells(opts: {
  version: string; cfArea?: string; fromYear: number; fromMonth: number; toYear: number; toMonth: number;
}): Promise<(CfCell & { project_code: string | null; currency?: string })[]> {
  // Project-grain cells span BOTH tables once a version is published: elapsed
  // periods live in cf_actuals (shared, version-agnostic — moved there by
  // cf_publish_version), forward periods stay in cf_forecasts for the version.
  // Read both, else a published cycle's Project view goes blank for the elapsed
  // window (actuals ≤ as-of and forecasts ≥ as-of+1 don't overlap → no dupes).
  const sel = 'area, project_code, line_code, year, month, value, currency'
  let qf = supabase.from('cf_forecasts').select(sel)
    .eq('version', opts.version)
    .gte('year', opts.fromYear).lte('year', opts.toYear)
  let qa = supabase.from('cf_actuals').select(sel)
    .gte('year', opts.fromYear).lte('year', opts.toYear)
  if (opts.cfArea) { qf = qf.eq('area', opts.cfArea); qa = qa.eq('area', opts.cfArea) }
  const [rf, ra] = await Promise.all([qf, qa])
  if (rf.error) throw rf.error
  if (ra.error) throw ra.error
  return [...(ra.data || []), ...(rf.data || [])]
    .filter(r => inRange(r, opts.fromYear, opts.fromMonth, opts.toYear, opts.toMonth))
    .map(r => ({ ...r, value: Number(r.value) }))
}

/* ── Project-level trade payables (from the trial balance) ──────────────────
 * The Payables map (entity_alias source_system='trial_balance') pins each TB
 * book to a canonical project; a cf project resolves to a canonical via its
 * treasury_cashflow alias. v_cf_payables_book_month already sums CCC's share
 * across accounts + consolidations per book per month. These helpers let the
 * Project view show a project's payables balance and its month-by-month move. */

export type PayablesMaps = {
  cfCodeToCanon: Map<string, string>   // cf project_code (UPPER) -> canonical_id
  canonToBooks: Map<string, string[]>  // canonical_id -> trial-balance book_codes
}

export async function fetchPayablesMaps(): Promise<PayablesMaps> {
  const [tc, tb] = await Promise.all([
    supabase.from('entity_alias').select('local_key, canonical_id').eq('source_system', 'treasury_cashflow'),
    supabase.from('entity_alias').select('local_key, canonical_id').eq('source_system', 'trial_balance'),
  ])
  if (tc.error) throw tc.error
  if (tb.error) throw tb.error
  const cfCodeToCanon = new Map<string, string>()
  for (const r of (tc.data ?? []) as { local_key: string; canonical_id: string }[]) {
    const code = r.local_key.replace(/^proj:/, '').trim().toUpperCase()
    if (code) cfCodeToCanon.set(code, r.canonical_id)
  }
  const canonToBooks = new Map<string, string[]>()
  for (const r of (tb.data ?? []) as { local_key: string; canonical_id: string }[]) {
    const arr = canonToBooks.get(r.canonical_id) ?? []
    arr.push(r.local_key); canonToBooks.set(r.canonical_id, arr)
  }
  return { cfCodeToCanon, canonToBooks }
}

/** Monthly CCC-share trade payables for a set of TB books, summed per period. */
export async function fetchPayablesForBooks(
  books: string[], fromPeriod: number, toPeriod: number,
): Promise<{ period: number; usd: number }[]> {
  if (!books.length) return []
  const { data, error } = await supabase
    .from('v_cf_payables_book_month')
    .select('period, ccc_share_usd')
    .in('book_code', books)
    .gte('period', fromPeriod).lte('period', toPeriod)
  if (error) throw error
  const m = new Map<number, number>()
  for (const r of (data ?? []) as { period: number; ccc_share_usd: number }[]) {
    m.set(r.period, (m.get(r.period) ?? 0) + Number(r.ccc_share_usd || 0))
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([period, usd]) => ({ period, usd }))
}

/* ── Account-group definitions (for the Report → Definitions view) ──────────
 * What liability account-groups exist and exactly which accounts feed each —
 * so inclusions can be reviewed (e.g. with Amr). Groups are defined/edited in
 * the Chart of Accounts module (Group Accounts Workspace); this is read-only. */
export type GroupDef = { key: string; label: string; accountCount: number }
export type GroupAccount = { account: string; name: string; balance: number }

export async function fetchAccountGroups(): Promise<GroupDef[]> {
  const [grpRes, memRes] = await Promise.all([
    supabase.from('coa_account_groups').select('key, label'),
    supabase.from('coa_group_accounts').select('key, account_key'),
  ])
  if (grpRes.error) throw grpRes.error
  if (memRes.error) throw memRes.error
  const count = new Map<string, number>()
  for (const m of memRes.data || []) count.set(m.key, (count.get(m.key) ?? 0) + 1)
  return (grpRes.data || []).map(g => ({ key: g.key, label: g.label, accountCount: count.get(g.key) ?? 0 }))
    .sort((a, b) => b.accountCount - a.accountCount)
}

/** The accounts that make up an account-group, with their latest (period) USD
 *  balance from the TB. Accounts in the group with no TB rows show a 0 balance. */
export async function fetchGroupAccounts(groupKey: string, period: number): Promise<{ accounts: GroupAccount[]; total: number }> {
  const memRes = await supabase.from('coa_group_accounts').select('account_key').eq('key', groupKey)
  if (memRes.error) throw memRes.error
  const keys = [...new Set((memRes.data || []).map(m => m.account_key as string))]
  if (keys.length === 0) return { accounts: [], total: 0 }
  const balRes = await supabase.from('tb_balances').select('account, account_name_src, usd_bal').eq('period', period).in('account', keys)
  if (balRes.error) throw balRes.error
  const byAcct = new Map<string, { name: string; balance: number }>()
  for (const k of keys) byAcct.set(k, { name: k, balance: 0 })
  for (const r of balRes.data || []) {
    const cur = byAcct.get(r.account) || { name: r.account, balance: 0 }
    cur.balance += Number(r.usd_bal || 0)
    if (r.account_name_src) cur.name = r.account_name_src
    byAcct.set(r.account, cur)
  }
  const accounts = [...byAcct.entries()].map(([account, x]) => ({ account, name: x.name, balance: x.balance }))
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
  return { accounts, total: accounts.reduce((t, a) => t + a.balance, 0) }
}

export type BridgeEntry = { area_id: string; area_label: string; sort_order: number }

/** Maps ANY cf label — cf_area (old vintages) or cf_country (2026-05+) — to its
 *  canonical parent area. Lets pages compare vintages stored at different grains
 *  by rolling both up to the same canonical area level. */
export async function fetchCashflowBridge(): Promise<Map<string, BridgeEntry>> {
  const [sheetsRes, areasRes] = await Promise.all([
    supabase.from('cashflow_sheets').select('cf_area, cf_country, area_id'),
    supabase.from('areas').select('area_id, display_name, sort_order'),
  ])
  if (sheetsRes.error) throw sheetsRes.error
  if (areasRes.error) throw areasRes.error
  const areaMeta = new Map((areasRes.data || []).map(a => [a.area_id, a]))
  const out = new Map<string, BridgeEntry>()
  for (const s of sheetsRes.data || []) {
    const meta = areaMeta.get(s.area_id)
    if (!meta) continue
    const entry: BridgeEntry = { area_id: s.area_id, area_label: meta.display_name, sort_order: meta.sort_order ?? 999 }
    if (s.cf_area) out.set(s.cf_area, entry)
    if (s.cf_country) out.set(s.cf_country, entry)
  }
  return out
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
