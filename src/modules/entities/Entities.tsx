import { useEffect, useMemo, useRef, useState } from 'react'
import { useRole, canManageCashFlow } from '@/lib/role'
import {
  loadCanonical,
  loadAliases,
  mapAlias,
  unmapAlias,
  updateNode,
  createBpGrouping,
  SOURCE_SYSTEMS,
  type CanonicalNode,
  type Alias,
  type LocalItem,
} from './lib'
import './entities.css'

type Status = { kind: 'ok' | 'err'; msg: string } | null
type MainView = 'ap' | 'bp'

export default function Entities() {
  const role = useRole()
  const canMap = canManageCashFlow(role) // admin | treasury — may edit aliases here
  const [mainView, setMainView] = useState<MainView>('ap')

  const [nodes, setNodes] = useState<CanonicalNode[]>([])
  const [aliases, setAliases] = useState<Alias[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<Status>(null)

  const [sourceKey, setSourceKey] = useState(SOURCE_SYSTEMS[0].key)
  const [locals, setLocals] = useState<LocalItem[]>([])
  const [localsLoading, setLocalsLoading] = useState(true)

  // ── load canonical + aliases ─────────────────────────────────────
  async function refresh() {
    try {
      const [n, a] = await Promise.all([loadCanonical(), loadAliases()])
      setNodes(n)
      setAliases(a)
    } catch (e) {
      setStatus({ kind: 'err', msg: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void refresh()
  }, [])

  // ── load the selected source system's local names ─────────────────
  useEffect(() => {
    const src = SOURCE_SYSTEMS.find(s => s.key === sourceKey)
    if (!src) return
    let cancelled = false
    setLocalsLoading(true)
    src
      .loadLocals()
      .then(items => {
        if (!cancelled) setLocals(items)
      })
      .catch(e => {
        if (!cancelled) setStatus({ kind: 'err', msg: (e as Error).message })
      })
      .finally(() => {
        if (!cancelled) setLocalsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sourceKey])

  // ── derived ───────────────────────────────────────────────────────
  const byOrder = (a: CanonicalNode, b: CanonicalNode) =>
    a.sort_order - b.sort_order || a.name.localeCompare(b.name)

  const areas = useMemo(
    () => nodes.filter(n => n.entity_type === 'area').sort(byOrder),
    [nodes],
  )
  // Top-level areas (parent_id null) vs member areas nested under a virtual area.
  const topAreas = useMemo(() => areas.filter(a => !a.parent_id), [areas])
  const subAreasByParent = useMemo(() => {
    const m = new Map<string, CanonicalNode[]>()
    for (const a of areas) {
      if (!a.parent_id) continue
      const arr = m.get(a.parent_id) ?? []
      arr.push(a)
      m.set(a.parent_id, arr)
    }
    for (const arr of m.values()) arr.sort(byOrder)
    return m
  }, [areas])
  const projectsByArea = useMemo(() => {
    const m = new Map<string, CanonicalNode[]>()
    for (const n of nodes) {
      if (n.entity_type !== 'project' || !n.parent_id) continue
      const arr = m.get(n.parent_id) ?? []
      arr.push(n)
      m.set(n.parent_id, arr)
    }
    for (const arr of m.values()) arr.sort(byOrder)
    return m
  }, [nodes])
  const nodeById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])

  // alias lookup for the current source: local_key -> Alias
  const aliasByLocalKey = useMemo(() => {
    const m = new Map<string, Alias>()
    for (const a of aliases) if (a.source_system === sourceKey) m.set(a.local_key, a)
    return m
  }, [aliases, sourceKey])

  function flash(kind: 'ok' | 'err', msg: string) {
    setStatus({ kind, msg })
    if (kind === 'ok') setTimeout(() => setStatus(s => (s?.msg === msg ? null : s)), 2200)
  }

  // ── alias mutations (admin | treasury) — the only edits made here ──
  async function doMap(item: LocalItem, canonicalId: string) {
    try {
      await mapAlias({
        canonical_id: canonicalId,
        source_system: sourceKey,
        local_key: item.local_key,
        local_name: item.local_name,
      })
      await refresh()
    } catch (e) {
      flash('err', (e as Error).message)
    }
  }
  async function doUnmap(item: LocalItem) {
    try {
      await unmapAlias(sourceKey, item.local_key)
      await refresh()
    } catch (e) {
      flash('err', (e as Error).message)
    }
  }

  if (loading) {
    return <div className="ent-loading">Loading…</div>
  }

  return (
    <div className="ent-shell">
      {status && <div className={`ent-toast ${status.kind}`}>{status.msg}</div>}

      <div className="ent-viewtabs">
        <button className={`ent-viewtab ${mainView === 'ap' ? 'is-active' : ''}`} onClick={() => setMainView('ap')}>
          Areas &amp; Projects
        </button>
        <button className={`ent-viewtab ${mainView === 'bp' ? 'is-active' : ''}`} onClick={() => setMainView('bp')}>
          Bank position areas
        </button>
      </div>

      {mainView === 'ap' ? (
        <div className="ent-panes">
          <CanonicalPane
            topAreas={topAreas}
            subAreasByParent={subAreasByParent}
            projectsByArea={projectsByArea}
            totalAreas={areas.length}
          />
          <MappingPane
            sourceKey={sourceKey}
            onSourceChange={setSourceKey}
            locals={locals}
            localsLoading={localsLoading}
            aliasByLocalKey={aliasByLocalKey}
            areas={areas}
            projectsByArea={projectsByArea}
            nodeById={nodeById}
            canMap={canMap}
            onMap={doMap}
            onUnmap={doUnmap}
          />
        </div>
      ) : (
        <BankPositionPane nodes={nodes} canMap={canMap} onChanged={refresh} onErr={m => flash('err', m)} />
      )}
    </div>
  )
}

/* ================================================================== *
 * BANK POSITION — manage the grouping (virtual areas) the lines roll into
 * ================================================================== */

function BankPositionPane({
  nodes, canMap, onChanged, onErr,
}: {
  nodes: CanonicalNode[]
  canMap: boolean
  onChanged: () => Promise<void> | void
  onErr: (msg: string) => void
}) {
  const byOrder = (a: CanonicalNode, b: CanonicalNode) =>
    a.sort_order - b.sort_order || a.name.localeCompare(b.name)

  const groupings = useMemo(
    () => nodes.filter(n => n.entity_type === 'bp_area').sort(byOrder),
    [nodes],
  )
  const childrenOf = useMemo(() => {
    const m = new Map<string, CanonicalNode[]>()
    for (const n of nodes) {
      if (n.entity_type === 'bp_line' && n.parent_id) {
        const a = m.get(n.parent_id) ?? []; a.push(n); m.set(n.parent_id, a)
      }
    }
    for (const a of m.values()) a.sort(byOrder)
    return m
  }, [nodes])
  // top level in their proper order — direct lines and groupings INTERLEAVED by sort_order
  const topOperating = useMemo(
    () => nodes
      .filter(n => !n.parent_id && n.area_group === 'operating' && (n.entity_type === 'bp_area' || n.entity_type === 'bp_line'))
      .sort(byOrder),
    [nodes],
  )
  const memoLines = useMemo(
    () => nodes.filter(n => n.entity_type === 'bp_line' && !n.parent_id && n.area_group !== 'operating').sort(byOrder),
    [nodes],
  )
  const lineCount = useMemo(() => nodes.filter(n => n.entity_type === 'bp_line').length, [nodes])

  const [newName, setNewName] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setCollapsed(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allCollapsed = groupings.length > 0 && collapsed.size >= groupings.length

  async function reparent(id: string, parentId: string | null) {
    try { await updateNode(id, { parent_id: parentId }); await onChanged() }
    catch (e) { onErr((e as Error).message) }
  }
  async function addGrouping() {
    const name = newName.trim()
    if (!name) return
    try {
      const maxSort = Math.max(0, ...nodes.filter(n => n.area_group === 'operating').map(g => g.sort_order))
      await createBpGrouping(name, maxSort + 1)
      setNewName(''); await onChanged()
    } catch (e) { onErr((e as Error).message) }
  }

  const picker = (line: CanonicalNode) => (
    <label className="ent-bp-pick">
      <span className="ent-bp-pick-lbl">Rolls into</span>
      <select className="ent-bp-select" value={line.parent_id ?? ''} disabled={!canMap}
        onChange={e => reparent(line.id, e.target.value || null)}>
        <option value="">Its own summary area</option>
        {groupings.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
    </label>
  )

  return (
    <section className="ent-pane ent-pane-full ent-bp">
      <header className="ent-pane-head">
        <div>
          <h2>Bank position areas</h2>
          <p className="ent-sub">
            {topOperating.length} summary areas · {lineCount} lines · the Bank Position tool rolls these up.
            {canMap ? ' Set what a line rolls into, or add a grouping.' : ' Read-only'}
          </p>
        </div>
        <div className="ent-bp-head-actions">
          <button className="ent-bp-collapse" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groupings.map(g => g.id)))}>
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
          {canMap && (
            <div className="ent-bp-add">
              <input placeholder="New grouping…" value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addGrouping() }} />
              <button className="ent-bp-addbtn" onClick={addGrouping}>Add</button>
            </div>
          )}
        </div>
      </header>

      <div className="ent-bp-tree">
        {topOperating.map(item => {
          if (item.entity_type === 'bp_line') {
            // a direct line — its own summary area
            return (
              <div key={item.id} className="ent-bp-card ent-bp-direct">
                <div className="ent-bp-row ent-bp-toprow">
                  <span className="ent-bp-name">{item.name}</span>
                  <span className="ent-bp-pill direct">Direct</span>
                  <span className="ent-bp-spacer" />
                  {picker(item)}
                </div>
              </div>
            )
          }
          // a virtual grouping — collapsible, with its children
          const kids = childrenOf.get(item.id) ?? []
          const isOpen = !collapsed.has(item.id)
          return (
            <div key={item.id} className="ent-bp-card ent-bp-grp">
              <button type="button" className="ent-bp-grphead" onClick={() => toggle(item.id)}>
                <svg viewBox="0 0 24 24" className={`ent-bp-tw ${isOpen ? 'open' : ''}`} aria-hidden="true">
                  <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2} />
                </svg>
                <span className="ent-bp-name">{item.name}</span>
                <span className="ent-bp-pill group">Grouping</span>
                <span className="ent-bp-spacer" />
                <span className="ent-bp-count">{kids.length} {kids.length === 1 ? 'line' : 'lines'}</span>
              </button>
              {isOpen && (
                <div className="ent-bp-children">
                  {kids.map(line => (
                    <div key={line.id} className="ent-bp-row ent-bp-childrow">
                      <span className="ent-bp-guide" />
                      <span className="ent-bp-name">{line.name}</span>
                      <span className="ent-bp-spacer" />
                      {picker(line)}
                    </div>
                  ))}
                  {kids.length === 0 && <div className="ent-bp-emptyline">No lines yet — set a line to roll into {item.name}.</div>}
                </div>
              )}
            </div>
          )
        })}

        {memoLines.length > 0 && (
          <>
            <div className="ent-bp-memohead">Below the line · not in the group total</div>
            <div className="ent-bp-card">
              {memoLines.map(line => (
                <div key={line.id} className="ent-bp-row ent-bp-toprow">
                  <span className="ent-bp-name">{line.name}</span>
                  <span className={`ent-bp-pill ${line.area_group === 'mtb' ? 'mtb' : 'memo'}`}>{line.area_group === 'mtb' ? 'MTB' : 'Memo'}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  )
}

/* ================================================================== *
 * LEFT — master list (read-only reference here; managed in the dashboard)
 * ================================================================== */

function CanonicalPane({
  topAreas,
  subAreasByParent,
  projectsByArea,
  totalAreas,
}: {
  topAreas: CanonicalNode[]
  subAreasByParent: Map<string, CanonicalNode[]>
  projectsByArea: Map<string, CanonicalNode[]>
  totalAreas: number
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [showInactive, setShowInactive] = useState(false)

  function toggle(id: string) {
    setOpen(s => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  const visibleTop = showInactive ? topAreas : topAreas.filter(a => a.is_active)
  const totalProjects = [...projectsByArea.values()].reduce((s, a) => s + a.length, 0)

  // a real area row: twisty + projects beneath
  function renderArea(area: CanonicalNode, nested: boolean) {
    const kids = (projectsByArea.get(area.id) ?? []).filter(p => showInactive || p.is_active)
    const isOpen = open.has(area.id)
    return (
      <div key={area.id} className={nested ? 'ent-subarea' : 'ent-area'}>
        <div className={`ent-node ent-node-area ${area.is_active ? '' : 'inactive'}`}>
          <button type="button" className="ent-twisty" onClick={() => toggle(area.id)}
            aria-label={isOpen ? 'Collapse' : 'Expand'}>
            <svg viewBox="0 0 24 24" className={isOpen ? 'open' : ''} aria-hidden="true">
              <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2} />
            </svg>
          </button>
          <span className="ent-kind">Area</span>
          <NodeLabel node={area} />
          {!area.is_active && <span className="ent-inactive-pill">inactive</span>}
          <span className="ent-count">{kids.length}</span>
        </div>
        {isOpen && (
          <div className="ent-kids">
            {kids.map(proj => (
              <div key={proj.id} className={`ent-node ent-node-proj ${proj.is_active ? '' : 'inactive'}`}>
                <span className="ent-kind">Project</span>
                <NodeLabel node={proj} />
                {!proj.is_active && <span className="ent-inactive-pill">inactive</span>}
              </div>
            ))}
            {kids.length === 0 && <div className="ent-empty">No projects</div>}
          </div>
        )}
      </div>
    )
  }

  // a virtual (grouping) area row: twisty + member areas beneath
  function renderVirtual(area: CanonicalNode) {
    const members = (subAreasByParent.get(area.id) ?? []).filter(a => showInactive || a.is_active)
    const isOpen = open.has(area.id)
    return (
      <div key={area.id} className="ent-area">
        <div className={`ent-node ent-node-area ent-node-virtual ${area.is_active ? '' : 'inactive'}`}>
          <button type="button" className="ent-twisty" onClick={() => toggle(area.id)}
            aria-label={isOpen ? 'Collapse' : 'Expand'}>
            <svg viewBox="0 0 24 24" className={isOpen ? 'open' : ''} aria-hidden="true">
              <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2} />
            </svg>
          </button>
          <span className="ent-kind ent-kind-group">Group</span>
          <NodeLabel node={area} />
          {!area.is_active && <span className="ent-inactive-pill">inactive</span>}
          <span className="ent-count">{members.length}</span>
        </div>
        {isOpen && (
          <div className="ent-kids ent-kids-areas">
            {members.map(m => renderArea(m, true))}
            {members.length === 0 && <div className="ent-empty">No areas</div>}
          </div>
        )}
      </div>
    )
  }

  return (
    <section className="ent-pane">
      <header className="ent-pane-head">
        <div>
          <h2>Master list — Areas &amp; Projects</h2>
          <p className="ent-sub">
            {totalAreas} areas · {totalProjects} projects · reference only · managed in the dashboard
          </p>
        </div>
        <label className="ent-checkline">
          <input type="checkbox" checked={showInactive}
            onChange={e => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
      </header>

      <div className="ent-tree">
        {visibleTop.map((area, i) => {
          const grp = area.area_group ?? 'Ungrouped'
          const prevGrp = i > 0 ? (visibleTop[i - 1].area_group ?? 'Ungrouped') : null
          return (
            <div key={area.id}>
              {grp !== prevGrp && <div className="ent-group-head">{grp}</div>}
              {area.is_virtual ? renderVirtual(area) : renderArea(area, false)}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** Read-only node name (no codes on this page). */
function NodeLabel({ node }: { node: CanonicalNode }) {
  return <span className="ent-name ent-name-static">{node.name}</span>
}

/* ================================================================== *
 * RIGHT — mapping
 * ================================================================== */

function MappingPane({
  sourceKey,
  onSourceChange,
  locals,
  localsLoading,
  aliasByLocalKey,
  areas,
  projectsByArea,
  nodeById,
  canMap,
  onMap,
  onUnmap,
}: {
  sourceKey: string
  onSourceChange: (k: string) => void
  locals: LocalItem[]
  localsLoading: boolean
  aliasByLocalKey: Map<string, Alias>
  areas: CanonicalNode[]
  projectsByArea: Map<string, CanonicalNode[]>
  nodeById: Map<string, CanonicalNode>
  canMap: boolean
  onMap: (item: LocalItem, canonicalId: string) => void
  onUnmap: (item: LocalItem) => void
}) {
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  function toggleGroup(name: string) {
    setCollapsed(s => {
      const n = new Set(s)
      n.has(name) ? n.delete(name) : n.add(name)
      return n
    })
  }

  type Status = 'unmapped' | 'bucket' | 'precise'
  // bucket = mapped to an Area node (the right bucket, not the exact project yet)
  // precise = mapped to a specific Project node
  function statusOf(item: LocalItem): Status {
    const a = aliasByLocalKey.get(item.local_key)
    if (!a) return 'unmapped'
    if (item.kind === 'area') return 'precise' // an area mapped to an area is correct, not a bucket
    return nodeById.get(a.canonical_id)?.entity_type === 'project' ? 'precise' : 'bucket'
  }
  const rank: Record<Status, number> = { unmapped: 0, bucket: 1, precise: 2 }

  // Group local names by their Treasury area — mirrors Treasury's file structure
  // (an area, with its projects beneath). Within a group: needs-work first.
  const groups = useMemo(() => {
    const ql = q.trim().toLowerCase()
    const map = new Map<string, { areaItem?: LocalItem; projects: LocalItem[] }>()
    const ensure = (k: string) => {
      let g = map.get(k)
      if (!g) { g = { projects: [] }; map.set(k, g) }
      return g
    }
    for (const l of locals) {
      if (l.kind === 'area') ensure(l.local_name).areaItem = l
      else ensure(l.context ?? '(no area)').projects.push(l)
    }
    const out: { areaName: string; areaItem?: LocalItem; projects: LocalItem[] }[] = []
    for (const [areaName, g] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const nameMatch = !ql || areaName.toLowerCase().includes(ql)
      const projs = (nameMatch ? g.projects : g.projects.filter(p => p.local_name.toLowerCase().includes(ql)))
        .slice()
        .sort((a, b) => rank[statusOf(a)] - rank[statusOf(b)] || a.local_name.localeCompare(b.local_name))
      if (!nameMatch && projs.length === 0) continue
      out.push({ areaName, areaItem: g.areaItem, projects: projs })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locals, q, aliasByLocalKey, nodeById])

  const unmappedCount = useMemo(
    () => locals.filter(l => statusOf(l) === 'unmapped').length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locals, aliasByLocalKey, nodeById],
  )
  const bucketCount = useMemo(
    () => locals.filter(l => statusOf(l) === 'bucket').length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locals, aliasByLocalKey, nodeById],
  )

  // candidate canonical nodes per kind (map to real areas only — not rollups)
  const areaCandidates = areas.filter(a => !a.is_virtual)
  const projectCandidates = useMemo(() => {
    const out: { node: CanonicalNode; areaName: string; areaId: string }[] = []
    for (const a of areas) {
      for (const p of projectsByArea.get(a.id) ?? [])
        out.push({ node: p, areaName: a.name, areaId: a.id })
    }
    return out.sort((x, y) => x.node.name.localeCompare(y.node.name))
  }, [areas, projectsByArea])

  // The canonical Area a project item belongs to (its Treasury area's mapping) —
  // drives both the bucket option and the scoped project list.
  function areaNodeFor(item: LocalItem): CanonicalNode | undefined {
    if (item.kind !== 'project' || !item.context) return undefined
    const id = aliasByLocalKey.get(`area:${item.context}`)?.canonical_id
    return id ? nodeById.get(id) : undefined
  }

  function renderRow(item: LocalItem, isHeader = false, toggle?: { open: boolean; onClick: () => void }, count?: number) {
    const status = statusOf(item)
    const alias = aliasByLocalKey.get(item.local_key)
    const target = alias ? nodeById.get(alias.canonical_id) : undefined
    const areaNode = areaNodeFor(item)
    const bucketArea =
      item.kind === 'project' && areaNode ? { id: areaNode.id, name: areaNode.name } : undefined
    return (
      <div
        key={item.local_key}
        className={`ent-maprow ${status}${isHeader ? ' header' : ''}${toggle ? ' clickable' : ''}`}
        onClick={toggle ? toggle.onClick : undefined}
      >
        <div className="ent-local">
          {toggle && (
            <button type="button" className="ent-twisty"
              onClick={e => { e.stopPropagation(); toggle.onClick() }}
              aria-label={toggle.open ? 'Collapse' : 'Expand'}>
              <svg viewBox="0 0 24 24" className={toggle.open ? 'open' : ''} aria-hidden="true">
                <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2} />
              </svg>
            </button>
          )}
          <span className={`ent-dot ${status}`} />
          <div className="ent-local-text">
            <span className="ent-local-name">{item.local_name}</span>
            <span className="ent-local-meta">{item.kind === 'area' ? 'Area' : 'Project'}</span>
          </div>
          {count !== undefined && <span className="ent-count">{count}</span>}
        </div>
        <div className="ent-maps-to" onClick={e => e.stopPropagation()}>
          {status === 'unmapped' ? (
            canMap ? (
              <CanonicalPicker
                item={item}
                areaCandidates={areaCandidates}
                projectCandidates={projectCandidates}
                defaultAreaId={areaNode?.id}
                bucketArea={bucketArea}
                onPick={id => onMap(item, id)}
                trigger="Map to…"
                primary
              />
            ) : (
              <span className="ent-notmapped">Not mapped yet</span>
            )
          ) : (
            <div className="ent-mapped-to">
              <span className="ent-arrow">→</span>
              <span className="ent-target">{target ? target.name : '(missing node)'}</span>
              {status === 'bucket' && <span className="ent-bucket-tag">area bucket</span>}
              {canMap && (
                <CanonicalPicker
                  item={item}
                  areaCandidates={areaCandidates}
                  projectCandidates={projectCandidates}
                  defaultAreaId={areaNode?.id}
                  bucketArea={bucketArea}
                  onPick={id => onMap(item, id)}
                  trigger={status === 'bucket' ? 'Set project' : 'Change'}
                  primary={status === 'bucket'}
                />
              )}
              {canMap && (
                <button type="button" className="ent-unmap" onClick={() => onUnmap(item)} title="Remove mapping">
                  Unmap
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <section className="ent-pane">
      <header className="ent-pane-head">
        <div>
          <h2>Map local names</h2>
          <p className="ent-sub">
            {unmappedCount > 0 && <span className="ent-flag">{unmappedCount} not mapped</span>}
            {unmappedCount > 0 && bucketCount > 0 && ' · '}
            {bucketCount > 0 && <span className="ent-amber">{bucketCount} in area bucket — refine to a project</span>}
            {unmappedCount === 0 && bucketCount === 0 && 'All names mapped to a project'}
            {canMap ? '' : ' · read-only'}
          </p>
        </div>
        <select className="ent-source-select" value={sourceKey} onChange={e => onSourceChange(e.target.value)}>
          {SOURCE_SYSTEMS.map(s => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
      </header>

      <div className="ent-search">
        <input placeholder="Search local names…" value={q} onChange={e => setQ(e.target.value)} />
        <button
          type="button"
          className="ent-collapse-all"
          onClick={() =>
            setCollapsed(s => (s.size > 0 ? new Set() : new Set(groups.map(g => g.areaName))))
          }
        >
          {collapsed.size > 0 ? 'Expand all' : 'Collapse all'}
        </button>
      </div>

      {localsLoading ? (
        <div className="ent-empty ent-empty-pad">Loading names…</div>
      ) : (
        <div className="ent-maplist">
          {groups.map(g => {
            const open = !!q.trim() || !collapsed.has(g.areaName)
            const toggle = { open, onClick: () => toggleGroup(g.areaName) }
            return (
              <div key={g.areaName} className="ent-mapgroup">
                {g.areaItem ? (
                  renderRow(g.areaItem, true, toggle, g.projects.length)
                ) : (
                  <div className="ent-maprow header clickable" onClick={toggle.onClick}>
                    <div className="ent-local">
                      <button type="button" className="ent-twisty"
                        onClick={e => { e.stopPropagation(); toggle.onClick() }}
                        aria-label={open ? 'Collapse' : 'Expand'}>
                        <svg viewBox="0 0 24 24" className={open ? 'open' : ''} aria-hidden="true">
                          <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2} />
                        </svg>
                      </button>
                      <div className="ent-local-text">
                        <span className="ent-local-name">{g.areaName}</span>
                        <span className="ent-local-meta">Area</span>
                      </div>
                    </div>
                    <span className="ent-count">{g.projects.length}</span>
                  </div>
                )}
                {open && (
                  <div className="ent-mapgroup-projects">
                    {g.projects.map(p => renderRow(p))}
                    {g.projects.length === 0 && <div className="ent-empty">No projects</div>}
                  </div>
                )}
              </div>
            )
          })}
          {groups.length === 0 && <div className="ent-empty ent-empty-pad">No names match.</div>}
        </div>
      )}
    </section>
  )
}

/** Type-ahead picker for a canonical node, filtered to the local item's kind. */
function CanonicalPicker({
  item,
  areaCandidates,
  projectCandidates,
  defaultAreaId,
  bucketArea,
  onPick,
  trigger,
  primary,
}: {
  item: LocalItem
  areaCandidates: CanonicalNode[]
  projectCandidates: { node: CanonicalNode; areaName: string; areaId: string }[]
  defaultAreaId?: string
  bucketArea?: { id: string; name: string }
  onPick: (id: string) => void
  trigger: string
  primary?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [allAreas, setAllAreas] = useState(false) // escape the area scope
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const scopedAreaName =
    defaultAreaId && item.kind === 'project'
      ? projectCandidates.find(p => p.areaId === defaultAreaId)?.areaName
      : undefined
  const scoped = !!defaultAreaId && item.kind === 'project' && !allAreas && !q.trim()

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const matches = useMemo(() => {
    const ql = q.trim().toLowerCase()
    if (item.kind === 'area') {
      return areaCandidates
        .filter(a => !ql || a.name.toLowerCase().includes(ql))
        .slice(0, 50)
        .map(a => ({ id: a.id, label: a.name, sub: 'Area' }))
    }
    return projectCandidates
      .filter(p => (scoped ? p.areaId === defaultAreaId : true))
      .filter(p => !ql || p.node.name.toLowerCase().includes(ql) || p.areaName.toLowerCase().includes(ql))
      .slice(0, 50)
      .map(p => ({ id: p.node.id, label: p.node.name, sub: p.areaName }))
  }, [q, item.kind, areaCandidates, projectCandidates, scoped, defaultAreaId])

  return (
    <div className="ent-picker" ref={boxRef}>
      <button
        type="button"
        className={`ent-picker-trigger ${primary ? 'primary' : ''}`}
        onClick={() => setOpen(v => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div className="ent-picker-pop">
          <input
            ref={inputRef}
            className="ent-picker-input"
            placeholder={`Search ${item.kind === 'area' ? 'areas' : 'projects'}…`}
            value={q}
            onChange={e => setQ(e.target.value)}
          />
          {scopedAreaName && !q.trim() && (
            <div className="ent-picker-scope">
              {scoped ? (
                <>
                  Showing <strong>{scopedAreaName}</strong> projects ·{' '}
                  <button type="button" onClick={() => setAllAreas(true)}>
                    show all
                  </button>
                </>
              ) : (
                <>
                  Showing all areas ·{' '}
                  <button type="button" onClick={() => setAllAreas(false)}>
                    back to {scopedAreaName}
                  </button>
                </>
              )}
            </div>
          )}
          <div className="ent-picker-list">
            {bucketArea && item.kind === 'project' && (
              <button
                type="button"
                className="ent-picker-item ent-picker-bucket"
                onClick={() => {
                  onPick(bucketArea.id)
                  setOpen(false)
                  setQ('')
                }}
              >
                <span className="ent-picker-label">📁 {bucketArea.name}</span>
                <span className="ent-picker-sub">whole area (bucket)</span>
              </button>
            )}
            {matches.map(m => (
              <button
                key={m.id}
                type="button"
                className="ent-picker-item"
                onClick={() => {
                  onPick(m.id)
                  setOpen(false)
                  setQ('')
                }}
              >
                <span className="ent-picker-label">{m.label}</span>
                <span className="ent-picker-sub">{m.sub}</span>
              </button>
            ))}
            {matches.length === 0 && <div className="ent-picker-empty">No match</div>}
          </div>
        </div>
      )}
    </div>
  )
}
