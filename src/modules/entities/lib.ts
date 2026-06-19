import { supabase } from '@/lib/supabase'

/* ------------------------------------------------------------------ *
 * Canonical Area / Project management — data layer.
 *
 * The canonical tree (areas -> projects) lives ONCE in public.canonical_entity
 * and is read by both this Treasury workspace and the Group-Accounts dashboard.
 * entity_alias is the crosswalk: each system's local name -> a canonical node.
 * A local name with no alias = UNMAPPED (computed live, never stored).
 * ------------------------------------------------------------------ */

export type EntityType = 'area' | 'project'

export interface CanonicalNode {
  id: string
  entity_type: EntityType
  parent_id: string | null
  name: string
  code: string | null
  owner_dept: string
  is_active: boolean
}

export interface Alias {
  id: string
  canonical_id: string
  source_system: string
  local_key: string
  local_name: string
}

/** One local name in a source system, with the kind of canonical node it maps to. */
export interface LocalItem {
  local_key: string
  local_name: string
  kind: EntityType
  context?: string // e.g. the area a project sits under, for disambiguation
}

export interface SourceSystem {
  key: string
  label: string
  /** Loads the universe of local names this system uses. */
  loadLocals: () => Promise<LocalItem[]>
}

export const OWNER_DEPTS = ['group_accounts', 'treasury', 'corporate_planning', 'legal']

/* ── Canonical tree ─────────────────────────────────────────────── */

export async function loadCanonical(): Promise<CanonicalNode[]> {
  const { data, error } = await supabase
    .from('canonical_entity')
    .select('id, entity_type, parent_id, name, code, owner_dept, is_active')
    .order('entity_type', { ascending: true })
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

/* ── Source systems (the mapping picker) ────────────────────────── *
 * Treasury Cash Flow is the one live source today (the faked "mapped vs new"
 * badges resolve against this). More windows plug in as they get built. */

export const SOURCE_SYSTEMS: SourceSystem[] = [
  {
    key: 'treasury_cashflow',
    label: 'Treasury Cash Flow',
    loadLocals: async () => {
      const { data, error } = await supabase
        .from('cf_projects')
        .select('project_code, area, display_name, is_area_item')
      if (error) throw error
      const rows = (data ?? []) as {
        project_code: string
        area: string | null
        display_name: string | null
        is_area_item: boolean
      }[]
      const items: LocalItem[] = []
      // distinct areas
      const seenAreas = new Set<string>()
      for (const r of rows) {
        if (r.area && !seenAreas.has(r.area)) {
          seenAreas.add(r.area)
          items.push({ local_key: `area:${r.area}`, local_name: r.area, kind: 'area' })
        }
      }
      // projects
      for (const r of rows) {
        items.push({
          local_key: `proj:${r.project_code}`,
          local_name: r.display_name || r.project_code,
          kind: 'project',
          context: r.area ?? undefined,
        })
      }
      return items
    },
  },
]

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
