import { supabase } from './supabase'

/* ───────────────────────────────────────────────────────────────────────
 * Analyze mode data layer (project grain).
 *
 * Reads the project-grain canonical views built in Session 1:
 *   - v_cashflow_project  — cf_actuals + cf_forecasts at (area, project_code)
 *   - cf_versions         — the cycles (a cycle = (cycle_year, cycle_month))
 *   - cf_projects         — project catalog (display name, is_area_item, is_jv)
 *
 * This module is deliberately decoupled from the area-grain dossier's
 * queries.ts so the shipped /cashflow surface + what-if scenario layer are
 * never touched. Group/area structure is resolved through the same
 * public.areas + public.cashflow_sheets bridge the dossier uses, but here we
 * keep Tony's raw area label as the row identity (it's already human-readable
 * — Qatar / KSA / UAE — and avoids the country-collapse the area dossier does).
 * ─────────────────────────────────────────────────────────────────────── */

export type Nature = 'Receipts' | 'Payments' | 'Balance'
export type CfType = 'Actual' | 'Forecast'

export type ProjectCell = {
  area: string
  project_code: string
  nature: Nature
  category: string
  description: string
  type: CfType
  year: number
  month: number
  value: number
  version: string
}

export type CfVersionMeta = {
  version_code: string
  cycle_year: number
  cycle_month: number
  version_no: number
  is_current: boolean
  is_active: boolean
  final_label: string | null
  as_of_date: string // YYYY-MM-DD — actual/forecast cutover for the cycle
}

export type CfProjectMeta = {
  project_code: string
  area: string
  display_name: string | null
  is_area_item: boolean
  is_jv: boolean
  jv_share_pct: number | null
}

export type AreaGroupName =
  | 'Operations' | 'Subsidiaries' | 'Corporate' | 'Contingency' | 'Other'

export type AreaMeta = {
  group_name: AreaGroupName
  display_name: string
  sort_order: number
}

export const GROUP_ORDER: AreaGroupName[] =
  ['Operations', 'Subsidiaries', 'Corporate', 'Contingency', 'Other']

export function groupRank(g: AreaGroupName): number {
  const i = GROUP_ORDER.indexOf(g)
  return i < 0 ? 98 : i
}

/* PostgREST caps a single response (commonly 1000 rows); page through it so
 * a busy version's full cell set always comes back complete. */
const PAGE = 1000
async function fetchAllRows<T>(
  table: string,
  build: (q: ReturnType<typeof supabase.from>) => any,
): Promise<T[]> {
  let offset = 0
  const out: T[] = []
  for (;;) {
    const q = build(supabase.from(table)).range(offset, offset + PAGE - 1)
    const { data, error } = await q
    if (error) throw error
    const chunk = (data || []) as T[]
    out.push(...chunk)
    if (chunk.length < PAGE) break
    offset += PAGE
  }
  return out
}

/** Active cycles, oldest → newest (the version pills read this). */
export async function fetchVersionsMeta(): Promise<CfVersionMeta[]> {
  const { data, error } = await supabase
    .from('cf_versions')
    .select('version_code,cycle_year,cycle_month,version_no,is_current,is_active,final_label,as_of_date')
    .eq('is_active', true)
    .order('cycle_year').order('cycle_month').order('version_no')
  if (error) throw error
  return (data || []) as CfVersionMeta[]
}

/** Project catalog keyed by project_code. */
export async function fetchProjectsMeta(): Promise<Map<string, CfProjectMeta>> {
  const rows = await fetchAllRows<CfProjectMeta>('cf_projects', t =>
    t.select('project_code,area,display_name,is_area_item,is_jv,jv_share_pct'))
  const m = new Map<string, CfProjectMeta>()
  for (const r of rows) m.set(r.project_code, r)
  return m
}

/** Tony's cf area label → group + display + sort, via the canonical bridge.
 *  Labels with no bridge row resolve to the 'Other' group (never dropped). */
export async function fetchAreaMeta(): Promise<Map<string, AreaMeta>> {
  const [sheets, areas] = await Promise.all([
    supabase.from('cashflow_sheets').select('cf_area,cf_country,area_id'),
    supabase.from('areas').select('area_id,display_name,group_name,sort_order'),
  ])
  if (sheets.error) throw sheets.error
  if (areas.error) throw areas.error
  const byId = new Map((areas.data || []).map(a => [a.area_id, a]))
  const out = new Map<string, AreaMeta>()
  const put = (lbl: string | null, aid: string | null) => {
    if (!lbl || !aid || out.has(lbl)) return
    const meta = byId.get(aid)
    if (!meta) return
    const g = (['Operations', 'Subsidiaries', 'Corporate', 'Contingency'] as string[])
      .includes(meta.group_name) ? (meta.group_name as AreaGroupName) : 'Other'
    out.set(lbl, { group_name: g, display_name: meta.display_name || lbl, sort_order: meta.sort_order ?? 999 })
  }
  for (const s of sheets.data || []) { put(s.cf_area, s.area_id); put(s.cf_country, s.area_id) }
  return out
}

export function resolveAreaMeta(area: string, areaMeta: Map<string, AreaMeta>): AreaMeta {
  return areaMeta.get(area) || { group_name: 'Other', display_name: area, sort_order: 999 }
}

/** Latest settled actual period as YYYYMM int (the continuous-series cutover). */
export async function fetchLatestActualYM(): Promise<number> {
  const { data, error } = await supabase
    .from('cf_actuals')
    .select('year,month')
    .order('year', { ascending: false })
    .order('month', { ascending: false })
    .limit(1)
  if (error) throw error
  if (!data || data.length === 0) return 202604
  return data[0].year * 100 + data[0].month
}

/** Cells for a cycle: the continuous actuals series (every Actual row,
 *  regardless of which cycle settled it) + the chosen version's forecasts.
 *  Pass `area` to scope to one area's drill. */
export async function fetchProjectCells(opts: {
  version: string
  fromYear: number
  toYear: number
  area?: string
}): Promise<ProjectCell[]> {
  const rows = await fetchAllRows<ProjectCell>('v_cashflow_project', t => {
    let q = t
      .select('area,project_code,nature,category,description,type,year,month,value,version')
      .gte('year', opts.fromYear).lte('year', opts.toYear)
      .or(`type.eq.Actual,version.eq.${opts.version}`)
    if (opts.area) q = q.eq('area', opts.area)
    return q
  })
  return rows.map(r => ({ ...r, value: Number(r.value) }))
}

/** Forecast-only cells for a version (no actuals). Used by drift compare. */
export async function fetchForecastCells(opts: {
  version: string
  fromYear: number
  toYear: number
  area?: string
}): Promise<ProjectCell[]> {
  const rows = await fetchAllRows<ProjectCell>('v_cashflow_project', t => {
    let q = t
      .select('area,project_code,nature,category,description,type,year,month,value,version')
      .eq('type', 'Forecast').eq('version', opts.version)
      .gte('year', opts.fromYear).lte('year', opts.toYear)
    if (opts.area) q = q.eq('area', opts.area)
    return q
  })
  return rows.map(r => ({ ...r, value: Number(r.value) }))
}

/* ── Period columns ─────────────────────────────────────────────────────── */

export type Grain = 'monthly' | 'quarterly' | 'yearly'
export type PeriodCol = {
  key: string
  label: string
  matches: (y: number, m: number) => boolean
  isActual: boolean
}

export function buildPeriodCols(
  grain: Grain,
  fromYear: number, fromMonth: number, toYear: number, toMonth: number,
  asOfYM: number,
): PeriodCol[] {
  const cols: PeriodCol[] = []
  const months: { y: number; m: number }[] = []
  for (let y = fromYear; y <= toYear; y++) {
    const sm = y === fromYear ? fromMonth : 1
    const em = y === toYear ? toMonth : 12
    for (let m = sm; m <= em; m++) months.push({ y, m })
  }
  if (grain === 'monthly') {
    months.forEach(({ y, m }) => {
      const ym = y * 100 + m
      cols.push({
        key: `${y}-${m}`,
        label: `${String(y).slice(2)}-${String(m).padStart(2, '0')}`,
        matches: (yy, mm) => yy === y && mm === m,
        isActual: ym <= asOfYM,
      })
    })
  } else if (grain === 'quarterly') {
    const seen = new Set<string>()
    months.forEach(({ y, m }) => {
      const q = Math.ceil(m / 3)
      const key = `${y}-Q${q}`
      if (seen.has(key)) return
      seen.add(key)
      cols.push({
        key,
        label: `${String(y).slice(2)} Q${q}`,
        matches: (yy, mm) => yy === y && Math.ceil(mm / 3) === q,
        isActual: (y * 100 + q * 3) <= asOfYM,
      })
    })
  } else {
    const years = [...new Set(months.map(x => x.y))].sort()
    years.forEach(y => {
      cols.push({
        key: `${y}`,
        label: `${y}`,
        matches: yy => yy === y,
        isActual: (y * 100 + 12) <= asOfYM,
      })
    })
  }
  return cols
}

/* ── Aggregation helpers ────────────────────────────────────────────────── */

export const isFlow = (c: { nature: Nature }) => c.nature !== 'Balance'

/** Net cash flow (Σ value over flow lines; payments are stored negative) for
 *  the cells matching a period predicate. `kind` optionally restricts to
 *  Actual or Forecast rows. */
export function netFlow(
  cells: ProjectCell[],
  matches: (y: number, m: number) => boolean,
  kind?: CfType,
): number {
  let t = 0
  for (const c of cells) {
    if (!isFlow(c)) continue
    if (kind && c.type !== kind) continue
    if (!matches(c.year, c.month)) continue
    t += c.value
  }
  return t
}
