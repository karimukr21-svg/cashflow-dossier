import { useEffect, useMemo, useState } from 'react'
import { useRole, canManageCashFlow } from '@/lib/role'
import {
  loadCanonical,
  loadAliases,
  updateNode,
  createBpGrouping,
  type CanonicalNode,
  type Alias,
} from './lib'
import ProjectMapCards from './ProjectMapCards'
import './entities.css'

type Status = { kind: 'ok' | 'err'; msg: string } | null

/* Areas & Projects — the canonical registry both workspaces read.
 * Left  = the canonical master tree (reference; edited in the dashboard),
 *         upgraded into a reverse index: each node shows what feeds it
 *         (cash-flow names, Midas books) — click to locate it on the right.
 * Right = the working surface. "Cash-flow projects" is the mapping workbench
 *         (one card per cf project: Group Accounts link + Midas books);
 *         "Bank Position" manages the bp grouping tree. */

const PROJECTS_VIEW = 'projects'
export const BANK_POSITION_SOURCE = 'bank_position'

export default function Entities() {
  const role = useRole()
  const canMap = canManageCashFlow(role) // admin | treasury — may edit aliases here

  const [nodes, setNodes] = useState<CanonicalNode[]>([])
  const [aliases, setAliases] = useState<Alias[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<Status>(null)
  const [view, setView] = useState<string>(PROJECTS_VIEW)
  const [locate, setLocate] = useState<{ id: string; n: number } | null>(null)

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

  function flash(kind: 'ok' | 'err', msg: string) {
    setStatus({ kind, msg })
    if (kind === 'ok') setTimeout(() => setStatus(s => (s?.msg === msg ? null : s)), 2200)
  }

  // reverse index: how many source names feed each canonical node
  const cfByCanon = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of aliases)
      if (a.source_system === 'treasury_cashflow')
        m.set(a.canonical_id, (m.get(a.canonical_id) ?? 0) + 1)
    return m
  }, [aliases])
  const bookByCanon = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of aliases)
      if (a.source_system === 'trial_balance')
        m.set(a.canonical_id, (m.get(a.canonical_id) ?? 0) + 1)
    return m
  }, [aliases])

  if (loading) {
    return <div className="ent-loading">Loading…</div>
  }

  const selector = <SourceSelect value={view} onChange={setView} />

  return (
    <div className="ent-shell">
      {status && <div className={`ent-toast ${status.kind}`}>{status.msg}</div>}

      <div className="ent-panes">
        <CanonicalPane
          nodes={nodes}
          cfByCanon={cfByCanon}
          bookByCanon={bookByCanon}
          onLocate={view === PROJECTS_VIEW ? id => setLocate(l => ({ id, n: (l?.n ?? 0) + 1 })) : undefined}
        />
        {view === BANK_POSITION_SOURCE ? (
          <BankPositionPane
            nodes={nodes}
            canMap={canMap}
            selector={selector}
            onChanged={refresh}
            onErr={m => flash('err', m)}
          />
        ) : (
          <ProjectMapCards
            nodes={nodes}
            aliases={aliases}
            canMap={canMap}
            onChanged={refresh}
            onErr={m => flash('err', m)}
            locate={locate}
            selector={selector}
          />
        )}
      </div>
    </div>
  )
}

/* The right-pane view selector. */
function SourceSelect({ value, onChange }: { value: string; onChange: (k: string) => void }) {
  return (
    <select className="ent-source-select" value={value} onChange={e => onChange(e.target.value)}>
      <option value={PROJECTS_VIEW}>Cash-flow projects</option>
      <option value={BANK_POSITION_SOURCE}>Bank Position</option>
    </select>
  )
}

/* ================================================================== *
 * BANK POSITION — manage the grouping (virtual areas) the lines roll into
 * ================================================================== */

function BankPositionPane({
  nodes, canMap, selector, onChanged, onErr,
}: {
  nodes: CanonicalNode[]
  canMap: boolean
  selector: React.ReactNode
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
  async function rename(id: string, name: string) {
    try { await updateNode(id, { name }); await onChanged() }
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
    <section className="ent-pane ent-bp">
      <header className="ent-pane-head">
        <div>
          <h2>Bank position areas</h2>
          <p className="ent-sub">
            {topOperating.length} summary areas · {lineCount} lines · the Bank Position tool rolls these up.
            {canMap ? ' Rename inline, set what a line rolls into, or add a grouping.' : ' Read-only'}
          </p>
        </div>
        {selector}
      </header>

      <div className="ent-bp-bar">
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

      <div className="ent-bp-tree">
        {topOperating.map(item => {
          if (item.entity_type === 'bp_line') {
            // a direct line — its own summary area
            return (
              <div key={item.id} className="ent-bp-card ent-bp-direct">
                <div className="ent-bp-row ent-bp-toprow">
                  <EditableName value={item.name} canEdit={canMap} onSave={n => rename(item.id, n)} />
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
              <div className="ent-bp-grphead" onClick={() => toggle(item.id)}>
                <svg viewBox="0 0 24 24" className={`ent-bp-tw ${isOpen ? 'open' : ''}`} aria-hidden="true">
                  <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2} />
                </svg>
                <EditableName value={item.name} canEdit={canMap} onSave={n => rename(item.id, n)} strong />
                <span className="ent-bp-pill group">Grouping</span>
                <span className="ent-bp-spacer" />
                <span className="ent-bp-count">{kids.length} {kids.length === 1 ? 'line' : 'lines'}</span>
              </div>
              {isOpen && (
                <div className="ent-bp-children">
                  {kids.map(line => (
                    <div key={line.id} className="ent-bp-row ent-bp-childrow">
                      <span className="ent-bp-guide" />
                      <EditableName value={line.name} canEdit={canMap} onSave={n => rename(line.id, n)} />
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
                  <EditableName value={line.name} canEdit={canMap} onSave={n => rename(line.id, n)} />
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

/* Inline-rename a bank-position entity (reflects in the Bank Position tool). */
function EditableName({ value, canEdit, onSave, strong }: {
  value: string; canEdit: boolean; onSave: (name: string) => void; strong?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  if (!canEdit) return <span className={`ent-bp-name ${strong ? 'strong' : ''}`}>{value}</span>
  if (editing) {
    return (
      <input
        className="ent-bp-nameedit" value={draft} autoFocus
        onClick={e => e.stopPropagation()}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); const t = draft.trim(); if (t && t !== value) onSave(t); else setDraft(value) }}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') { setDraft(value); setEditing(false) }
        }}
      />
    )
  }
  return (
    <button type="button" className={`ent-bp-name ent-bp-name-btn ${strong ? 'strong' : ''}`}
      title="Click to rename"
      onClick={e => { e.stopPropagation(); setEditing(true) }}>
      {value}
    </button>
  )
}

/* ================================================================== *
 * LEFT — canonical master tree + reverse index (what feeds each node)
 * ================================================================== */

function CanonicalPane({
  nodes,
  cfByCanon,
  bookByCanon,
  onLocate,
}: {
  nodes: CanonicalNode[]
  cfByCanon: Map<string, number>
  bookByCanon: Map<string, number>
  onLocate?: (canonicalId: string) => void
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [showInactive, setShowInactive] = useState(false)

  const byOrder = (a: CanonicalNode, b: CanonicalNode) =>
    a.sort_order - b.sort_order || a.name.localeCompare(b.name)

  const areas = useMemo(
    () => nodes.filter(n => n.entity_type === 'area').sort(byOrder),
    [nodes],
  )
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

  function toggle(id: string) {
    setOpen(s => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  const visibleTop = showInactive ? topAreas : topAreas.filter(a => a.is_active)
  const totalProjects = [...projectsByArea.values()].reduce((s, a) => s + a.length, 0)

  // quiet source chips: what feeds this node (no red flags here — a bare node
  // is normal; most gacc projects have no treasury data by design)
  function chips(node: CanonicalNode) {
    const cf = cfByCanon.get(node.id) ?? 0
    const bk = bookByCanon.get(node.id) ?? 0
    if (!cf && !bk) return null
    const locate = onLocate
      ? (e: React.MouseEvent) => { e.stopPropagation(); onLocate(node.id) }
      : undefined
    return (
      <span className={`ent-srcchips ${locate ? 'clickable' : ''}`}
        title={locate ? 'Show on the mapping side' : undefined}
        onClick={locate}>
        {cf > 0 && (
          <span className={`ent-srcchip cf ${cf > 1 && node.entity_type === 'project' ? 'multi' : ''}`}>
            CF{cf > 1 ? ` ×${cf}` : ''}
          </span>
        )}
        {bk > 0 && <span className="ent-srcchip bk">{bk} book{bk === 1 ? '' : 's'}</span>}
      </span>
    )
  }

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
          {chips(area)}
          {!area.is_active && <span className="ent-inactive-pill">inactive</span>}
          <span className="ent-count">{kids.length}</span>
        </div>
        {isOpen && (
          <div className="ent-kids">
            {kids.map(proj => (
              <div key={proj.id} className={`ent-node ent-node-proj ${proj.is_active ? '' : 'inactive'}`}>
                <span className="ent-kind">Project</span>
                <NodeLabel node={proj} />
                {chips(proj)}
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
            {areas.length} areas · {totalProjects} projects · managed in the dashboard · chips show what feeds a node
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
