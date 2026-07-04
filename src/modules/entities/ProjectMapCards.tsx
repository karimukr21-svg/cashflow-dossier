import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  createNode,
  mapAlias,
  unmapAlias,
  loadCfProjects,
  loadPayablesBooks,
  type CanonicalNode,
  type Alias,
  type PayablesBook,
} from './lib'

/* Cash-flow projects workbench — ONE card per cash-flow project carrying BOTH
 * of its identities, which meet at the same canonical node:
 *   · Group Accounts — the canonical_entity node (entity_alias,
 *     source_system='treasury_cashflow', local_key 'proj:<code>'/'area:<name>')
 *   · Midas books — trial-balance books aliased to that node
 *     (source_system='trial_balance'); a project's payables = Σ its books.
 *
 * Directionality is deliberate: every cf project should end up mapped (an
 * unmapped project is an open question for Treasury), while a book with no
 * project legitimately stays in its area's "Area & other projects" bucket.
 * Book totals are read by the Cash Flow Report Project view. */

const fmtM = (n: number) => {
  const m = n / 1e6
  return m < -0.005 ? `(${Math.abs(m).toFixed(2)})` : m > 0.005 ? m.toFixed(2) : '—'
}

type GaStatus = 'unmapped' | 'bucket' | 'precise'

type CfProj = {
  code: string
  area: string
  name: string
  isAreaItem: boolean
}

export default function ProjectMapCards({
  nodes,
  aliases,
  canMap,
  onChanged,
  onErr,
  locate,
  selector,
}: {
  nodes: CanonicalNode[]
  aliases: Alias[]
  canMap: boolean
  onChanged: () => Promise<void> | void
  onErr: (msg: string) => void
  /** left-tree click target: a canonical node id to scroll to (n bumps per click) */
  locate: { id: string; n: number } | null
  selector: ReactNode
}) {
  const [cfRows, setCfRows] = useState<CfProj[]>([])
  const [books, setBooks] = useState<PayablesBook[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [onlyOpen, setOnlyOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [picker, setPicker] = useState<CfProj | null>(null) // add-book target
  const [bookQ, setBookQ] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    Promise.all([loadCfProjects(), loadPayablesBooks()])
      .then(([cp, bk]) => {
        if (!alive) return
        setCfRows(
          cp
            .filter(r => r.area)
            .map(r => ({
              code: r.project_code,
              area: r.area!,
              name: r.display_name || r.project_code,
              isAreaItem: r.is_area_item,
            }))
            .sort((a, b) => a.area.localeCompare(b.area) || a.name.localeCompare(b.name)),
        )
        setBooks(bk.sort((a, b) => a.ccc_share_usd - b.ccc_share_usd))
        setLoading(false)
      })
      .catch(e => {
        if (!alive) return
        onErr((e as Error).message)
        setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── crosswalk lookups (all derived from the shared aliases) ────── */
  const nodeById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])
  const tcProj = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of aliases)
      if (a.source_system === 'treasury_cashflow' && a.local_key.startsWith('proj:'))
        m.set(a.local_key.slice(5).toUpperCase(), a.canonical_id)
    return m
  }, [aliases])
  const tcArea = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of aliases)
      if (a.source_system === 'treasury_cashflow' && a.local_key.startsWith('area:'))
        m.set(a.local_key.slice(5), a.canonical_id)
    return m
  }, [aliases])
  const tbAlias = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of aliases) if (a.source_system === 'trial_balance') m.set(a.local_key, a.canonical_id)
    return m
  }, [aliases])
  /** how many cf projects alias each canonical node (guards the book cascades) */
  const cfCountByCanon = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of aliases)
      if (a.source_system === 'treasury_cashflow' && a.local_key.startsWith('proj:'))
        m.set(a.canonical_id, (m.get(a.canonical_id) ?? 0) + 1)
    return m
  }, [aliases])

  const booksByCanon = useMemo(() => {
    const m = new Map<string, PayablesBook[]>()
    for (const b of books) {
      const cid = tbAlias.get(b.book_code)
      if (!cid) continue
      const arr = m.get(cid) ?? []
      arr.push(b)
      m.set(cid, arr)
    }
    return m
  }, [books, tbAlias])

  const unassigned = useMemo(() => books.filter(b => !tbAlias.has(b.book_code)), [books, tbAlias])
  const unassignedUsd = useMemo(() => unassigned.reduce((s, b) => s + b.ccc_share_usd, 0), [unassigned])

  /* ── picker candidates ──────────────────────────────────────────── */
  const areaCandidates = useMemo(
    () => nodes.filter(n => n.entity_type === 'area' && !n.is_virtual).sort((a, b) => a.name.localeCompare(b.name)),
    [nodes],
  )
  const projectCandidates = useMemo(() => {
    const out: { node: CanonicalNode; areaName: string; areaId: string }[] = []
    for (const n of nodes) {
      if (n.entity_type !== 'project' || !n.parent_id) continue
      const parent = nodeById.get(n.parent_id)
      out.push({ node: n, areaName: parent?.name ?? '—', areaId: n.parent_id })
    }
    return out.sort((x, y) => x.node.name.localeCompare(y.node.name))
  }, [nodes, nodeById])

  /* ── GA status per cf project ───────────────────────────────────── */
  function gaOf(p: CfProj): { status: GaStatus; target?: CanonicalNode } {
    const cid = tcProj.get(p.code.toUpperCase())
    if (!cid) return { status: 'unmapped' }
    const target = nodeById.get(cid)
    if (!target) return { status: 'unmapped' }
    // an area item mapped to its area node IS correctly mapped, not a bucket
    if (target.entity_type === 'project' || p.isAreaItem) return { status: 'precise', target }
    return { status: 'bucket', target }
  }
  /** the project-type node the books hang on (precise projects only) */
  function bookNodeOf(p: CfProj): string | null {
    const cid = tcProj.get(p.code.toUpperCase())
    return cid && nodeById.get(cid)?.entity_type === 'project' ? cid : null
  }

  /* ── mutations ──────────────────────────────────────────────────── */

  // The cf project needs a canonical PROJECT node before a book can attach.
  // Creating one (under its mapped area) also upgrades a bucket mapping.
  async function ensureProjectNode(p: CfProj): Promise<string> {
    const existing = bookNodeOf(p)
    if (existing) return existing
    const parent = tcArea.get(p.area)
    if (!parent) throw new Error(`No canonical area for “${p.area}” — map the area first (header of this section).`)
    const node = await createNode({ entity_type: 'project', parent_id: parent, name: p.name, owner_dept: 'treasury' })
    await mapAlias({ canonical_id: node.id, source_system: 'treasury_cashflow', local_key: `proj:${p.code}`, local_name: p.name })
    return node.id
  }

  async function assignBook(p: CfProj, book: PayablesBook) {
    if (!canMap) return
    setSaving(true)
    try {
      const cid = await ensureProjectNode(p)
      await mapAlias({ canonical_id: cid, source_system: 'trial_balance', local_key: book.book_code, local_name: book.companyname ?? book.book_code })
      setPicker(null)
      setBookQ('')
      await onChanged()
    } catch (e) {
      onErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function removeBook(book: PayablesBook) {
    if (!canMap) return
    setSaving(true)
    try {
      await unmapAlias('trial_balance', book.book_code)
      await onChanged()
    } catch (e) {
      onErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // Re-point a cf project's GA mapping. Its books follow it to another project
  // node; if it moves to an area bucket the books return to the unassigned pool
  // (a book only "belongs" to a project through a project-type node).
  async function mapProject(p: CfProj, canonicalId: string) {
    if (!canMap) return
    setSaving(true)
    try {
      const oldNode = bookNodeOf(p)
      const carried = oldNode && (cfCountByCanon.get(oldNode) ?? 0) <= 1 ? (booksByCanon.get(oldNode) ?? []) : []
      await mapAlias({ canonical_id: canonicalId, source_system: 'treasury_cashflow', local_key: `proj:${p.code}`, local_name: p.name })
      if (carried.length && oldNode !== canonicalId) {
        const targetIsProject = nodeById.get(canonicalId)?.entity_type === 'project'
        for (const b of carried) {
          if (targetIsProject)
            await mapAlias({ canonical_id: canonicalId, source_system: 'trial_balance', local_key: b.book_code, local_name: b.companyname ?? b.book_code })
          else await unmapAlias('trial_balance', b.book_code)
        }
      }
      await onChanged()
    } catch (e) {
      onErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function unmapProject(p: CfProj) {
    if (!canMap) return
    setSaving(true)
    try {
      const oldNode = bookNodeOf(p)
      const orphaned = oldNode && (cfCountByCanon.get(oldNode) ?? 0) <= 1 ? (booksByCanon.get(oldNode) ?? []) : []
      for (const b of orphaned) await unmapAlias('trial_balance', b.book_code) // back to the bucket
      await unmapAlias('treasury_cashflow', `proj:${p.code}`)
      await onChanged()
    } catch (e) {
      onErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function mapArea(areaName: string, canonicalId: string) {
    if (!canMap) return
    setSaving(true)
    try {
      await mapAlias({ canonical_id: canonicalId, source_system: 'treasury_cashflow', local_key: `area:${areaName}`, local_name: areaName })
      await onChanged()
    } catch (e) {
      onErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  /* ── grouping + filters ─────────────────────────────────────────── */
  const groups = useMemo(() => {
    const ql = q.trim().toLowerCase()
    const m = new Map<string, { projects: CfProj[]; items: CfProj[] }>()
    for (const p of cfRows) {
      const g = m.get(p.area) ?? { projects: [], items: [] }
      ;(p.isAreaItem ? g.items : g.projects).push(p)
      m.set(p.area, g)
    }
    const out: { area: string; projects: CfProj[]; items: CfProj[] }[] = []
    for (const [area, g] of [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const areaMatch = !ql || area.toLowerCase().includes(ql)
      const projects = areaMatch ? g.projects : g.projects.filter(p => p.name.toLowerCase().includes(ql) || p.code.toLowerCase().includes(ql))
      const items = areaMatch ? g.items : g.items.filter(p => p.name.toLowerCase().includes(ql))
      if (!areaMatch && !projects.length && !items.length) continue
      out.push({ area, projects, items })
    }
    return out
  }, [cfRows, q])

  const overall = useMemo(() => {
    const real = cfRows.filter(p => !p.isAreaItem)
    const withBook = real.filter(p => {
      const nid = bookNodeOf(p)
      return nid && (booksByCanon.get(nid)?.length ?? 0) > 0
    }).length
    const gaUn = cfRows.filter(p => gaOf(p).status === 'unmapped').length
    const gaBucket = cfRows.filter(p => gaOf(p).status === 'bucket').length
    return { total: real.length, withBook, pct: real.length ? Math.round((100 * withBook) / real.length) : 0, gaUn, gaBucket }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfRows, tcProj, nodeById, booksByCanon])

  /* ── left-tree click → scroll to the card / section ─────────────── */
  useEffect(() => {
    if (!locate) return
    setOnlyOpen(false)
    setQ('')
    const t = setTimeout(() => {
      const root = scrollRef.current
      if (!root) return
      const el =
        root.querySelector(`[data-canon="${locate.id}"]`) ?? root.querySelector(`[data-canonarea="${locate.id}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('pm-flash')
        setTimeout(() => el.classList.remove('pm-flash'), 1800)
      }
    }, 80)
    return () => clearTimeout(t)
  }, [locate])

  /* ── book-picker modal matches ──────────────────────────────────── */
  const bookMatches = useMemo(() => {
    const s = bookQ.trim().toLowerCase()
    const base = s
      ? unassigned.filter(b => b.book_code.toLowerCase().includes(s) || (b.companyname ?? '').toLowerCase().includes(s))
      : unassigned
    return base.slice(0, 80)
  }, [bookQ, unassigned])

  if (loading) return <section className="ent-pane"><div className="pm-empty">Loading…</div></section>

  return (
    <section className="ent-pane">
      <header className="ent-pane-head">
        <div>
          <h2>Cash-flow projects — Group Accounts &amp; Midas books</h2>
          <p className="ent-sub">
            {overall.withBook} of {overall.total} projects have a book
            {overall.gaUn > 0 && <> · <span className="ent-flag">{overall.gaUn} not mapped to GA</span></>}
            {overall.gaBucket > 0 && <> · <span className="ent-amber">{overall.gaBucket} in area bucket</span></>}
            {canMap ? '' : ' · read-only'}
          </p>
        </div>
        {selector}
      </header>

      <div className="ent-search">
        <input placeholder="Search projects…" value={q} onChange={e => setQ(e.target.value)} />
        <label className="pm-toggle">
          <input type="checkbox" checked={onlyOpen} onChange={e => setOnlyOpen(e.target.checked)} />
          Only projects without a book
        </label>
        <div className="pm-cov-mini" title={`${overall.withBook} of ${overall.total} projects have at least one Midas book`}>
          <span className="pm-cov-mini-v">{overall.pct}%</span>
          <span className="pm-cov-bar"><span style={{ width: `${overall.pct}%` }} /></span>
        </div>
      </div>

      <div className="pm-scroll" ref={scrollRef}>
        {groups.map(({ area, projects, items }) => {
          const shown = onlyOpen
            ? projects.filter(p => {
                const nid = bookNodeOf(p)
                return !(nid && (booksByCanon.get(nid)?.length ?? 0) > 0)
              })
            : projects
          if (!shown.length && !(items.length && !onlyOpen)) return null
          const withBook = projects.filter(p => {
            const nid = bookNodeOf(p)
            return nid && (booksByCanon.get(nid)?.length ?? 0) > 0
          }).length
          const areaCanonId = tcArea.get(area)
          const areaTarget = areaCanonId ? nodeById.get(areaCanonId) : undefined
          return (
            <section className="pm-area" key={area} data-canonarea={areaCanonId ?? undefined}>
              <div className="pm-area-h">
                <h4>{area}</h4>
                <span className="pm-area-map">
                  {areaTarget ? (
                    <>
                      <span className="ent-arrow">→</span> {areaTarget.name}
                    </>
                  ) : canMap ? (
                    <CanonicalPicker
                      kind="area"
                      areaCandidates={areaCandidates}
                      projectCandidates={projectCandidates}
                      onPick={id => mapArea(area, id)}
                      trigger="Map area to GA…"
                      primary
                    />
                  ) : (
                    <span className="ent-notmapped">Area not mapped</span>
                  )}
                </span>
                <span className="pm-area-c">
                  {withBook}/{projects.length} with a book
                </span>
              </div>

              <div className="pm-grid">
                {shown.map(p => {
                  const ga = gaOf(p)
                  const nid = bookNodeOf(p)
                  const bks = nid ? (booksByCanon.get(nid) ?? []) : []
                  const tot = bks.reduce((s, b) => s + b.ccc_share_usd, 0)
                  return (
                    <div
                      className={`pm-card ${bks.length ? 'is-pinned' : ''}`}
                      key={p.code + p.area}
                      data-canon={nid ?? undefined}
                    >
                      <div className="pm-card-top">
                        <span className="pm-code" title={`${p.name} (${p.code})`}>{p.name}</span>
                        <span className="pm-num">{bks.length ? fmtM(tot) : ''}</span>
                      </div>

                      <div className="pm-line">
                        <span className="pm-line-lbl">GA</span>
                        <span className={`ent-dot ${ga.status}`} />
                        {ga.status === 'unmapped' ? (
                          canMap ? (
                            <CanonicalPicker
                              kind="project"
                              areaCandidates={areaCandidates}
                              projectCandidates={projectCandidates}
                              defaultAreaId={areaCanonId}
                              bucketArea={areaTarget ? { id: areaTarget.id, name: areaTarget.name } : undefined}
                              onPick={id => mapProject(p, id)}
                              trigger="Map to…"
                              primary
                            />
                          ) : (
                            <span className="ent-notmapped">Not mapped</span>
                          )
                        ) : (
                          <>
                            <span className="pm-ga-target" title={ga.target?.name}>{ga.target?.name}</span>
                            {ga.status === 'bucket' && <span className="ent-bucket-tag">area bucket</span>}
                            {canMap && (
                              <span className="pm-ga-acts">
                                <CanonicalPicker
                                  kind="project"
                                  areaCandidates={areaCandidates}
                                  projectCandidates={projectCandidates}
                                  defaultAreaId={areaCanonId}
                                  bucketArea={areaTarget ? { id: areaTarget.id, name: areaTarget.name } : undefined}
                                  onPick={id => mapProject(p, id)}
                                  trigger={ga.status === 'bucket' ? 'Set project' : 'Change'}
                                  primary={ga.status === 'bucket'}
                                />
                                <button className="ent-unmap" disabled={saving} onClick={() => unmapProject(p)}>
                                  Unmap
                                </button>
                              </span>
                            )}
                          </>
                        )}
                      </div>

                      <div className="pm-line">
                        <span className="pm-line-lbl">Books</span>
                        <span className="pm-books">
                          {bks.length ? (
                            bks.map(b => (
                              <span className="pm-chip" key={b.book_code} title={b.companyname ?? ''}>
                                {b.book_code} <span className="pm-chip-n">{fmtM(b.ccc_share_usd)}</span>
                                {canMap && (
                                  <button className="pm-chip-x" disabled={saving} onClick={() => removeBook(b)} title="Remove — back to the area bucket">
                                    ×
                                  </button>
                                )}
                              </span>
                            ))
                          ) : (
                            <span className="pm-bucket">No book — in area bucket</span>
                          )}
                        </span>
                      </div>

                      {canMap && (
                        <div className="pm-card-foot">
                          <button className="pm-assignbtn" disabled={saving} onClick={() => { setPicker(p); setBookQ('') }}>
                            + Add book
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
                {!shown.length && <div className="pm-none">All projects here have a book.</div>}
              </div>

              {items.length > 0 && !onlyOpen && (
                <details className="pm-items">
                  <summary>
                    Area items <span>{items.length} · PMV, camps, overheads… map to the area itself</span>
                  </summary>
                  <div className="pm-items-list">
                    {items.map(p => {
                      const ga = gaOf(p)
                      return (
                        <div className="pm-item-row" key={p.code}>
                          <span className={`ent-dot ${ga.status === 'unmapped' ? 'unmapped' : 'precise'}`} />
                          <span className="pm-item-name">{p.name}</span>
                          {ga.status === 'unmapped' ? (
                            canMap ? (
                              <CanonicalPicker
                                kind="project"
                                areaCandidates={areaCandidates}
                                projectCandidates={projectCandidates}
                                defaultAreaId={areaCanonId}
                                bucketArea={areaTarget ? { id: areaTarget.id, name: areaTarget.name } : undefined}
                                onPick={id => mapProject(p, id)}
                                trigger="Map to…"
                              />
                            ) : (
                              <span className="ent-notmapped">Not mapped</span>
                            )
                          ) : (
                            <>
                              <span className="ent-arrow">→</span>
                              <span className="pm-ga-target">{ga.target?.name}</span>
                              {canMap && (
                                <button className="ent-unmap" disabled={saving} onClick={() => unmapProject(p)}>
                                  Unmap
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </details>
              )}
            </section>
          )
        })}

        {!onlyOpen && unassigned.length > 0 && (
          <UnassignedBrowser unassigned={unassigned} unassignedUsd={unassignedUsd} />
        )}
      </div>

      {picker && (
        <div className="pm-modal-bg" onClick={() => { setPicker(null); setBookQ('') }}>
          <div className="pm-modal" onClick={e => e.stopPropagation()}>
            <div className="pm-modal-h">
              <div>
                Add a book to <b>{picker.name}</b>
              </div>
              <div className="pm-modal-co">{picker.area} · pick from unassigned books</div>
              <button className="pm-modal-x" onClick={() => { setPicker(null); setBookQ('') }}>×</button>
            </div>
            <input autoFocus className="pm-search" placeholder="Search books…" value={bookQ} onChange={e => setBookQ(e.target.value)} />
            <div className="pm-list">
              {bookMatches.map(b => (
                <button key={b.book_code} className="pm-opt" disabled={saving} onClick={() => assignBook(picker, b)}>
                  <span>
                    {b.book_code} <em style={{ marginLeft: 6 }}>{b.companyname}</em>
                  </span>
                  <em>{fmtM(b.ccc_share_usd)}</em>
                </button>
              ))}
              {!bookMatches.length && <div className="pm-noopt">No unassigned book matches “{bookQ}”.</div>}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/* ── "Area & other projects" — the unassigned-book pool, view-only ── */
function UnassignedBrowser({ unassigned, unassignedUsd }: { unassigned: PayablesBook[]; unassignedUsd: number }) {
  const byArea = useMemo(() => {
    const m = new Map<string, PayablesBook[]>()
    for (const b of unassigned) {
      const a = b.area || '—'
      const arr = m.get(a) ?? []
      arr.push(b)
      m.set(a, arr)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [unassigned])
  return (
    <div className="pm-bucketwrap">
      <div className="pm-bucket-title">
        Area &amp; other projects{' '}
        <span>
          · {unassigned.length} unassigned books · {fmtM(unassignedUsd)}m — mostly closed jobs the area still settles;
          assign any via a project’s “+ Add book”
        </span>
      </div>
      {byArea.map(([area, bks]) => {
        const tot = bks.reduce((s, b) => s + b.ccc_share_usd, 0)
        return (
          <details className="pm-bkt" key={area}>
            <summary>
              <span className="pm-bkt-a">{area}</span>
              <span className="pm-bkt-c">
                {bks.length} book{bks.length === 1 ? '' : 's'} · {fmtM(tot)}m
              </span>
            </summary>
            <div className="pm-bkt-list">
              {bks
                .slice()
                .sort((a, b) => a.ccc_share_usd - b.ccc_share_usd)
                .map(b => (
                  <div className="pm-bkt-row" key={b.book_code}>
                    <span className="pm-code">{b.book_code}</span>
                    <span className="pm-bkt-co" title={b.companyname ?? ''}>{b.companyname}</span>
                    <span className="pm-num">{fmtM(b.ccc_share_usd)}</span>
                  </div>
                ))}
            </div>
          </details>
        )
      })}
    </div>
  )
}

/* ── type-ahead picker for a canonical node ─────────────────────────
 * kind='area': real areas only. kind='project': project nodes, scoped to the
 * item's area by default, with the area itself offered as the bucket option. */
export function CanonicalPicker({
  kind,
  areaCandidates,
  projectCandidates,
  defaultAreaId,
  bucketArea,
  onPick,
  trigger,
  primary,
}: {
  kind: 'area' | 'project'
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
  const [allAreas, setAllAreas] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const scopedAreaName =
    defaultAreaId && kind === 'project'
      ? projectCandidates.find(p => p.areaId === defaultAreaId)?.areaName
      : undefined
  const scoped = !!defaultAreaId && kind === 'project' && !allAreas && !q.trim()

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
    if (kind === 'area') {
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
  }, [q, kind, areaCandidates, projectCandidates, scoped, defaultAreaId])

  return (
    <div className="ent-picker" ref={boxRef}>
      <button type="button" className={`ent-picker-trigger ${primary ? 'primary' : ''}`} onClick={() => setOpen(v => !v)}>
        {trigger}
      </button>
      {open && (
        <div className="ent-picker-pop">
          <input
            ref={inputRef}
            className="ent-picker-input"
            placeholder={`Search ${kind === 'area' ? 'areas' : 'projects'}…`}
            value={q}
            onChange={e => setQ(e.target.value)}
          />
          {scopedAreaName && !q.trim() && (
            <div className="ent-picker-scope">
              {scoped ? (
                <>
                  Showing <strong>{scopedAreaName}</strong> projects ·{' '}
                  <button type="button" onClick={() => setAllAreas(true)}>show all</button>
                </>
              ) : (
                <>
                  Showing all areas ·{' '}
                  <button type="button" onClick={() => setAllAreas(false)}>back to {scopedAreaName}</button>
                </>
              )}
            </div>
          )}
          <div className="ent-picker-list">
            {bucketArea && kind === 'project' && (
              <button
                type="button"
                className="ent-picker-item ent-picker-bucket"
                onClick={() => { onPick(bucketArea.id); setOpen(false); setQ('') }}
              >
                <span className="ent-picker-label">{bucketArea.name}</span>
                <span className="ent-picker-sub">whole area (bucket)</span>
              </button>
            )}
            {matches.map(m => (
              <button
                key={m.id}
                type="button"
                className="ent-picker-item"
                onClick={() => { onPick(m.id); setOpen(false); setQ('') }}
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
