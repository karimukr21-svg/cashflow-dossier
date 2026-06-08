/* Scenario layer types + query helpers (Step 3 plumbing).
 *
 * DB tables are public.cf_what_if_scenarios / *_history / cf_what_if_events.
 * UI terminology stays "Scenario" everywhere — the cf_what_if_* prefix
 * exists only to avoid the pre-existing public.cf_scenarios catalog
 * (Actual/Forecast/Plan accounting layers).
 */

import { supabase } from './supabase'

export type CellDelta = {
  area: string
  line_code: string
  year: number
  month: number
  baseline_value: number
  scenario_value: number
}

export type BulkAction = {
  action: 'shift_forward' | 'shift_backward' | 'apply_pct' | 'reset' | string
  area?: string
  line_code_prefix?: string
  year?: number
  month?: number
  month_from?: number
  month_to?: number
  months_shifted?: number
  pct?: number
  applied_at: string
}

export type DeltaPayload = {
  cells: CellDelta[]
  bulk_actions: BulkAction[]
}

export const EMPTY_DELTA: DeltaPayload = { cells: [], bulk_actions: [] }

export type SavedScenario = {
  id: string
  name: string
  description: string | null
  baseline_version_code: string
  delta_payload: DeltaPayload
  is_active: boolean
  final_label: string | null
  created_at: string
  updated_at: string
}

export type ScenarioListRow = Pick<
  SavedScenario,
  'id' | 'name' | 'baseline_version_code' | 'is_active' | 'final_label' | 'updated_at'
> & { delta_cell_count: number }

/* ── Queries ───────────────────────────────────────────────────────────── */

export async function fetchScenarioList(): Promise<ScenarioListRow[]> {
  const { data, error } = await supabase
    .from('cf_what_if_scenarios')
    .select('id, name, baseline_version_code, is_active, final_label, updated_at, delta_payload')
    .order('is_active', { ascending: false })
    .order('updated_at', { ascending: false })
  if (error) throw error
  return (data || []).map(row => ({
    id: row.id,
    name: row.name,
    baseline_version_code: row.baseline_version_code,
    is_active: row.is_active,
    final_label: row.final_label,
    updated_at: row.updated_at,
    delta_cell_count: Array.isArray((row.delta_payload as DeltaPayload)?.cells)
      ? (row.delta_payload as DeltaPayload).cells.length
      : 0,
  }))
}

export async function fetchScenario(id: string): Promise<SavedScenario | null> {
  const { data, error } = await supabase
    .from('cf_what_if_scenarios')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return data as SavedScenario
}

export async function createScenario(opts: {
  name: string
  description?: string | null
  baseline_version_code: string
  delta_payload: DeltaPayload
}): Promise<SavedScenario> {
  const { data, error } = await supabase
    .from('cf_what_if_scenarios')
    .insert({
      name: opts.name,
      description: opts.description ?? null,
      baseline_version_code: opts.baseline_version_code,
      delta_payload: opts.delta_payload,
    })
    .select('*')
    .single()
  if (error) throw error
  return data as SavedScenario
}

export async function updateScenarioDelta(opts: {
  id: string
  delta_payload: DeltaPayload
  name?: string
  description?: string | null
}): Promise<SavedScenario> {
  const patch: Record<string, unknown> = { delta_payload: opts.delta_payload }
  if (opts.name !== undefined) patch.name = opts.name
  if (opts.description !== undefined) patch.description = opts.description
  const { data, error } = await supabase
    .from('cf_what_if_scenarios')
    .update(patch)
    .eq('id', opts.id)
    .select('*')
    .single()
  if (error) throw error
  return data as SavedScenario
}

/* ── Telemetry: fire-and-forget ────────────────────────────────────────── */

export type ScenarioEventType = 'open' | 'save' | 'bulk_op' | 'cell_edit' | 'discard' | 'export'

export function logEvent(
  event_type: ScenarioEventType,
  opts: { scenario_id?: string | null; meta?: Record<string, unknown> } = {},
): void {
  /* No await — telemetry must never block the UI. Errors are swallowed by
   * design; cf_what_if_events is best-effort. */
  void supabase
    .from('cf_what_if_events')
    .insert({
      scenario_id: opts.scenario_id ?? null,
      event_type,
      event_meta: opts.meta ?? {},
    })
    .then(({ error }) => { if (error) console.warn('cf_what_if_events insert failed', error) })
}

/* ── Delta application ─────────────────────────────────────────────────── */

/* Index DeltaPayload.cells by (area, line_code, year, month) for O(1) lookup.
 * Built once per (workingDelta, savedScenario) change so per-cell render
 * doesn't re-scan the cells array. */
export type DeltaIndex = Map<string, number>

function cellKey(area: string, line_code: string, year: number, month: number): string {
  return `${area}${line_code}${year}${month}`
}

export function buildDeltaIndex(payload: DeltaPayload | null | undefined): DeltaIndex {
  const out: DeltaIndex = new Map()
  if (!payload || !Array.isArray(payload.cells)) return out
  for (const c of payload.cells) {
    out.set(cellKey(c.area, c.line_code, c.year, c.month), c.scenario_value)
  }
  return out
}

/* Three-layer derivation: working buffer → saved scenario → baseline.
 * Caller passes the baseline value (already in hand from cf_actuals /
 * cf_forecasts); this function decides whether either delta layer overrides. */
export function applyDeltaToCell(
  workingIdx: DeltaIndex,
  savedIdx: DeltaIndex,
  area: string,
  line_code: string,
  year: number,
  month: number,
  baseline_value: number,
): number {
  const k = cellKey(area, line_code, year, month)
  const w = workingIdx.get(k)
  if (w !== undefined) return w
  const s = savedIdx.get(k)
  if (s !== undefined) return s
  return baseline_value
}

/* Diff: cells in workingDelta whose scenario_value differs from the saved
 * scenario's value (or from baseline if no saved scenario). Used to compute
 * hasUnsavedChanges + the "X unsaved changes" prompt on discard. */
export function countUnsavedCells(
  workingDelta: DeltaPayload,
  savedScenario: SavedScenario | null,
): number {
  if (!workingDelta.cells.length) return 0
  const savedIdx = buildDeltaIndex(savedScenario?.delta_payload ?? null)
  let n = 0
  for (const c of workingDelta.cells) {
    const k = cellKey(c.area, c.line_code, c.year, c.month)
    const s = savedIdx.get(k)
    if (s === undefined || s !== c.scenario_value) n++
  }
  return n
}
