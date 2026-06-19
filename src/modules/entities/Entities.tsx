import { useEffect, useMemo, useRef, useState } from 'react'
import { useRole, canManageCashFlow } from '@/lib/role'
import {
  loadCanonical,
  loadAliases,
  createNode,
  updateNode,
  mapAlias,
  unmapAlias,
  SOURCE_SYSTEMS,
  OWNER_DEPTS,
  type CanonicalNode,
  type Alias,
  type LocalItem,
  type EntityType,
} from './lib'
import './entities.css'

type Status = { kind: 'ok' | 'err'; msg: string } | null

export default function Entities() {
  const role = useRole()
  const isAdmin = role === 'admin'
  const canMap = canManageCashFlow(role) // admin | treasury

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
  const areas = useMemo(
    () =>
      nodes
        .filter(n => n.entity_type === 'area')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [nodes],
  )
  const projectsByArea = useMemo(() => {
    const m = new Map<string, CanonicalNode[]>()
    for (const n of nodes) {
      if (n.entity_type !== 'project' || !n.parent_id) continue
      const arr = m.get(n.parent_id) ?? []
      arr.push(n)
      m.set(n.parent_id, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => a.name.localeCompare(b.name))
    return m
  }, [nodes])
  const nodeById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])

  // alias lookup for the current source: local_key -> Alias
  const aliasByLocalKey = useMemo(() => {
    const m = new Map<string, Alias>()
    for (const a of aliases) if (a.source_system === sourceKey) m.set(a.local_key, a)
    return m
  }, [aliases, sourceKey])

  // ── canonical mutations (admin only) ──────────────────────────────
  function flash(kind: 'ok' | 'err', msg: string) {
    setStatus({ kind, msg })
    if (kind === 'ok') setTimeout(() => setStatus(s => (s?.msg === msg ? null : s)), 2200)
  }

  async function addArea(name: string) {
    try {
      await createNode({ entity_type: 'area', parent_id: null, name, owner_dept: 'group_accounts' })
      await refresh()
      flash('ok', `Added area "${name}"`)
    } catch (e) {
      flash('err', (e as Error).message)
    }
  }
  async function addProject(areaId: string, name: string) {
    try {
      await createNode({ entity_type: 'project', parent_id: areaId, name, owner_dept: 'group_accounts' })
      await refresh()
      flash('ok', `Added project "${name}"`)
    } catch (e) {
      flash('err', (e as Error).message)
    }
  }
  async function patchNode(id: string, patch: Partial<CanonicalNode>) {
    // optimistic
    setNodes(ns => ns.map(n => (n.id === id ? { ...n, ...patch } : n)))
    try {
      await updateNode(id, patch)
    } catch (e) {
      flash('err', (e as Error).message)
      await refresh()
    }
  }

  // ── alias mutations (admin | treasury) ────────────────────────────
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

      <div className="ent-panes">
        <CanonicalPane
          areas={areas}
          projectsByArea={projectsByArea}
          isAdmin={isAdmin}
          onAddArea={addArea}
          onAddProject={addProject}
          onPatch={patchNode}
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
    </div>
  )
}

/* ================================================================== *
 * LEFT — canonical tree
 * ================================================================== */

function CanonicalPane({
  areas,
  projectsByArea,
  isAdmin,
  onAddArea,
  onAddProject,
  onPatch,
}: {
  areas: CanonicalNode[]
  projectsByArea: Map<string, CanonicalNode[]>
  isAdmin: boolean
  onAddArea: (name: string) => void
  onAddProject: (areaId: string, name: string) => void
  onPatch: (id: string, patch: Partial<CanonicalNode>) => void
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [showInactive, setShowInactive] = useState(false)
  const [addingArea, setAddingArea] = useState(false)

  function toggle(id: string) {
    setOpen(s => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  const visibleAreas = showInactive ? areas : areas.filter(a => a.is_active)
  const totalProjects = [...projectsByArea.values()].reduce((s, a) => s + a.length, 0)

  return (
    <section className="ent-pane">
      <header className="ent-pane-head">
        <div>
          <h2>Canonical tree</h2>
          <p className="ent-sub">
            {areas.length} areas · {totalProjects} projects
            {isAdmin ? '' : ' · read-only'}
          </p>
        </div>
        <label className="ent-checkline">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={e => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </header>

      <div className="ent-tree">
        {visibleAreas.map(area => {
          const kids = (projectsByArea.get(area.id) ?? []).filter(
            p => showInactive || p.is_active,
          )
          const isOpen = open.has(area.id)
          return (
            <div key={area.id} className="ent-area">
              <div className={`ent-node ent-node-area ${area.is_active ? '' : 'inactive'}`}>
                <button
                  type="button"
                  className="ent-twisty"
                  onClick={() => toggle(area.id)}
                  aria-label={isOpen ? 'Collapse' : 'Expand'}
                >
                  <svg viewBox="0 0 24 24" className={isOpen ? 'open' : ''} aria-hidden="true">
                    <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2} />
                  </svg>
                </button>
                <span className="ent-kind">Area</span>
                <NodeLabel node={area} isAdmin={isAdmin} onPatch={onPatch} />
                <span className="ent-count">{kids.length}</span>
                <NodeControls
                  node={area}
                  isAdmin={isAdmin}
                  areas={areas}
                  onPatch={onPatch}
                />
              </div>
              {isOpen && (
                <div className="ent-kids">
                  {kids.map(proj => (
                    <div
                      key={proj.id}
                      className={`ent-node ent-node-proj ${proj.is_active ? '' : 'inactive'}`}
                    >
                      <span className="ent-kind">Project</span>
                      <NodeLabel node={proj} isAdmin={isAdmin} onPatch={onPatch} />
                      <NodeControls
                        node={proj}
                        isAdmin={isAdmin}
                        areas={areas}
                        onPatch={onPatch}
                      />
                    </div>
                  ))}
                  {isAdmin && <AddInline label="+ Project" onAdd={n => onAddProject(area.id, n)} />}
                  {kids.length === 0 && !isAdmin && <div className="ent-empty">No projects</div>}
                </div>
              )}
            </div>
          )
        })}

        {isAdmin &&
          (addingArea ? (
            <AddInline label="+ Area" autoFocus onAdd={n => { onAddArea(n); setAddingArea(false) }} onCancel={() => setAddingArea(false)} />
          ) : (
            <button type="button" className="ent-add-area" onClick={() => setAddingArea(true)}>
              + Add area
            </button>
          ))}
      </div>
    </section>
  )
}

/** Inline name + active state. Rename on click (admin). */
function NodeLabel({
  node,
  isAdmin,
  onPatch,
}: {
  node: CanonicalNode
  isAdmin: boolean
  onPatch: (id: string, patch: Partial<CanonicalNode>) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(node.name)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) ref.current?.select()
  }, [editing])

  function commit() {
    const v = val.trim()
    setEditing(false)
    if (v && v !== node.name) onPatch(node.id, { name: v })
    else setVal(node.name)
  }

  if (editing) {
    return (
      <input
        ref={ref}
        className="ent-rename"
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setVal(node.name)
            setEditing(false)
          }
        }}
      />
    )
  }
  return (
    <button
      type="button"
      className="ent-name"
      title={isAdmin ? 'Click to rename' : undefined}
      onClick={() => isAdmin && setEditing(true)}
      disabled={!isAdmin}
    >
      {node.name}
      {node.code && <span className="ent-code">{node.code}</span>}
    </button>
  )
}

/** Owner dept, re-parent (projects), active toggle — admin only. */
function NodeControls({
  node,
  isAdmin,
  areas,
  onPatch,
}: {
  node: CanonicalNode
  isAdmin: boolean
  areas: CanonicalNode[]
  onPatch: (id: string, patch: Partial<CanonicalNode>) => void
}) {
  if (!isAdmin) {
    return !node.is_active ? <span className="ent-inactive-pill">inactive</span> : null
  }
  return (
    <span className="ent-ctrls">
      {node.entity_type === 'project' && (
        <select
          className="ent-mini-select"
          title="Move to area"
          value={node.parent_id ?? ''}
          onChange={e => onPatch(node.id, { parent_id: e.target.value })}
        >
          {areas.map(a => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
      <select
        className="ent-mini-select"
        title="Owner"
        value={node.owner_dept}
        onChange={e => onPatch(node.id, { owner_dept: e.target.value })}
      >
        {OWNER_DEPTS.map(d => (
          <option key={d} value={d}>
            {d.replace('_', ' ')}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={`ent-toggle ${node.is_active ? 'on' : 'off'}`}
        title={node.is_active ? 'Active — click to deactivate' : 'Inactive — click to activate'}
        onClick={() => onPatch(node.id, { is_active: !node.is_active })}
      >
        {node.is_active ? 'Active' : 'Inactive'}
      </button>
    </span>
  )
}

function AddInline({
  label,
  onAdd,
  onCancel,
  autoFocus,
}: {
  label: string
  onAdd: (name: string) => void
  onCancel?: () => void
  autoFocus?: boolean
}) {
  const [open, setOpen] = useState(!!autoFocus)
  const [val, setVal] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) ref.current?.focus()
  }, [open])

  if (!open) {
    return (
      <button type="button" className="ent-add-inline" onClick={() => setOpen(true)}>
        {label}
      </button>
    )
  }
  function commit() {
    const v = val.trim()
    if (v) onAdd(v)
    setVal('')
    setOpen(false)
    onCancel?.()
  }
  return (
    <div className="ent-add-row">
      <input
        ref={ref}
        className="ent-rename"
        placeholder={label.replace('+ ', 'New ').toLowerCase()}
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setVal('')
            setOpen(false)
            onCancel?.()
          }
        }}
        onBlur={() => {
          if (!val.trim()) {
            setOpen(false)
            onCancel?.()
          }
        }}
      />
      <button type="button" className="ent-mini-btn" onMouseDown={e => e.preventDefault()} onClick={commit}>
        Add
      </button>
    </div>
  )
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

  // unmapped first, then alphabetic; apply search
  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase()
    const filtered = ql
      ? locals.filter(l => l.local_name.toLowerCase().includes(ql))
      : locals
    return [...filtered].sort((a, b) => {
      const am = aliasByLocalKey.has(a.local_key) ? 1 : 0
      const bm = aliasByLocalKey.has(b.local_key) ? 1 : 0
      if (am !== bm) return am - bm // unmapped (0) first
      return a.local_name.localeCompare(b.local_name)
    })
  }, [locals, q, aliasByLocalKey])

  const unmappedCount = useMemo(
    () => locals.filter(l => !aliasByLocalKey.has(l.local_key)).length,
    [locals, aliasByLocalKey],
  )

  // candidate canonical nodes per kind
  const areaCandidates = areas
  const projectCandidates = useMemo(() => {
    const out: { node: CanonicalNode; areaName: string }[] = []
    for (const a of areas) {
      for (const p of projectsByArea.get(a.id) ?? []) out.push({ node: p, areaName: a.name })
    }
    return out.sort((x, y) => x.node.name.localeCompare(y.node.name))
  }, [areas, projectsByArea])

  return (
    <section className="ent-pane">
      <header className="ent-pane-head">
        <div>
          <h2>Map local names</h2>
          <p className="ent-sub">
            {unmappedCount > 0 ? (
              <span className="ent-flag">{unmappedCount} not mapped yet</span>
            ) : (
              'All names mapped'
            )}
            {canMap ? '' : ' · read-only'}
          </p>
        </div>
        <select
          className="ent-source-select"
          value={sourceKey}
          onChange={e => onSourceChange(e.target.value)}
        >
          {SOURCE_SYSTEMS.map(s => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </header>

      <div className="ent-search">
        <input
          placeholder="Search local names…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
      </div>

      {localsLoading ? (
        <div className="ent-empty ent-empty-pad">Loading names…</div>
      ) : (
        <div className="ent-maplist">
          {rows.map(item => {
            const alias = aliasByLocalKey.get(item.local_key)
            const target = alias ? nodeById.get(alias.canonical_id) : undefined
            return (
              <div
                key={item.local_key}
                className={`ent-maprow ${alias ? 'mapped' : 'unmapped'}`}
              >
                <div className="ent-local">
                  <span className={`ent-dot ${alias ? 'ok' : 'todo'}`} />
                  <div className="ent-local-text">
                    <span className="ent-local-name">{item.local_name}</span>
                    <span className="ent-local-meta">
                      {item.kind === 'area' ? 'Area' : 'Project'}
                      {item.context ? ` · ${item.context}` : ''}
                    </span>
                  </div>
                </div>
                <div className="ent-maps-to">
                  {alias ? (
                    <div className="ent-mapped-to">
                      <span className="ent-arrow">→</span>
                      <span className="ent-target">
                        {target ? target.name : '(missing node)'}
                      </span>
                      {canMap && (
                        <CanonicalPicker
                          item={item}
                          areaCandidates={areaCandidates}
                          projectCandidates={projectCandidates}
                          onPick={id => onMap(item, id)}
                          trigger="Change"
                        />
                      )}
                      {canMap && (
                        <button
                          type="button"
                          className="ent-unmap"
                          onClick={() => onUnmap(item)}
                          title="Remove mapping"
                        >
                          Unmap
                        </button>
                      )}
                    </div>
                  ) : canMap ? (
                    <CanonicalPicker
                      item={item}
                      areaCandidates={areaCandidates}
                      projectCandidates={projectCandidates}
                      onPick={id => onMap(item, id)}
                      trigger="Map to…"
                      primary
                    />
                  ) : (
                    <span className="ent-notmapped">Not mapped yet</span>
                  )}
                </div>
              </div>
            )
          })}
          {rows.length === 0 && <div className="ent-empty ent-empty-pad">No names match.</div>}
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
  onPick,
  trigger,
  primary,
}: {
  item: LocalItem
  areaCandidates: CanonicalNode[]
  projectCandidates: { node: CanonicalNode; areaName: string }[]
  onPick: (id: string) => void
  trigger: string
  primary?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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
      .filter(p => !ql || p.node.name.toLowerCase().includes(ql) || p.areaName.toLowerCase().includes(ql))
      .slice(0, 50)
      .map(p => ({ id: p.node.id, label: p.node.name, sub: p.areaName }))
  }, [q, item.kind, areaCandidates, projectCandidates])

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
          <div className="ent-picker-list">
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
