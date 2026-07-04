import { supabase } from '@/lib/supabase'

/* ------------------------------------------------------------------ *
 * Canonical Area / Project management — data layer.
 *
 * The canonical tree (areas -> projects) lives ONCE in public.canonical_entity
 * and is read by both this Treasury workspace and the Group-Accounts dashboard.
 * entity_alias is the crosswalk: each system's local name -> a canonical node.
 * A local name with no alias = UNMAPPED (computed live, never stored).
 * ------------------------------------------------------------------ */

export type EntityType = 'area' | 'project' | 'bp_area' | 'bp_line'

export interface CanonicalNode {
  id: string
  entity_type: EntityType
  parent_id: string | null
  name: string
  code: string | null
  owner_dept: string
  is_active: boolean
  sort_order: number
  area_group: string | null
  is_virtual: boolean
}

export interface Alias {
  id: string
  canonical_id: string
  source_system: string
  local_key: string
  local_name: string
}

export const OWNER_DEPTS = ['group_accounts', 'treasury', 'corporate_planning', 'legal']

/* ── Canonical tree ─────────────────────────────────────────────── */

export async function loadCanonical(): Promise<CanonicalNode[]> {
  const { data, error } = await supabase
    .from('canonical_entity')
    .select('id, entity_type, parent_id, name, code, owner_dept, is_active, sort_order, area_group, is_virtual')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []) as CanonicalNode[]
}

export async function loadAliases(): Promise<Alias[]> {
  const { data, error } = await supabase
    .from('entity_alias')
    .select('id, canonical_id, source_system, local_key, local_name')
  if (error) throw error
  return (data ?? []) as Alias[]
}

/* ── Source data (the mapping workbench reads these) ─────────────── *
 * Treasury Cash Flow projects + Midas trial-balance books both crosswalk to
 * the canonical tree through entity_alias:
 *   source_system='treasury_cashflow', local_key 'area:<name>' | 'proj:<code>'
 *   source_system='trial_balance',     local_key <book_code>            */

export interface CfProjectRow {
  project_code: string
  area: string | null
  display_name: string | null
  is_area_item: boolean
}

export async function loadCfProjects(): Promise<CfProjectRow[]> {
  const { data, error } = await supabase
    .from('cf_projects')
    .select('project_code, area, display_name, is_area_item')
  if (error) throw error
  return (data ?? []) as CfProjectRow[]
}

export interface PayablesBook {
  book_code: string
  area: string | null
  companyname: string | null
  ccc_share_usd: number
}

export async function loadPayablesBooks(): Promise<PayablesBook[]> {
  const { data, error } = await supabase
    .from('v_cf_payables_book')
    .select('book_code, area, companyname, ccc_share_usd')
  if (error) throw error
  return (data ?? []) as PayablesBook[]
}

/* ── Mutations ──────────────────────────────────────────────────── */

export async function createNode(input: {
  entity_type: EntityType
  parent_id: string | null
  name: string
  owner_dept: string
}): Promise<CanonicalNode> {
  const { data, error } = await supabase
    .from('canonical_entity')
    .insert(input)
    .select('id, entity_type, parent_id, name, code, owner_dept, is_active')
    .single()
  if (error) throw error
  return data as CanonicalNode
}

export async function updateNode(
  id: string,
  patch: Partial<Pick<CanonicalNode, 'name' | 'parent_id' | 'owner_dept' | 'is_active'>>,
): Promise<void> {
  const { error } = await supabase.from('canonical_entity').update(patch).eq('id', id)
  if (error) throw error
}

/** Create a virtual bank-position grouping area (a parent the lines roll into). */
export async function createBpGrouping(name: string, sortOrder: number): Promise<void> {
  const { error } = await supabase.from('canonical_entity').insert({
    entity_type: 'bp_area',
    name,
    owner_dept: 'treasury',
    is_virtual: true,
    is_active: true,
    sort_order: sortOrder,
    area_group: 'operating',
  })
  if (error) throw error
}

/** Upsert an alias on the (source_system, local_key) natural key. */
export async function mapAlias(input: {
  canonical_id: string
  source_system: string
  local_key: string
  local_name: string
}): Promise<void> {
  const { error } = await supabase
    .from('entity_alias')
    .upsert(input, { onConflict: 'source_system,local_key' })
  if (error) throw error
}

export async function unmapAlias(source_system: string, local_key: string): Promise<void> {
  const { error } = await supabase
    .from('entity_alias')
    .delete()
    .eq('source_system', source_system)
    .eq('local_key', local_key)
  if (error) throw error
}
