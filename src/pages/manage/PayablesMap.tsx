import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { createNode, mapAlias, unmapAlias } from '@/modules/entities/lib'

/* Payables map — assign each cash-flow project to its trial-balance book(s).
 * The confirmed map lives in entity_alias: a book aliases (source_system=
 * 'trial_balance') to the project's canonical node, and the cf project aliases
 * (source_system='treasury_cashflow') to that same node — so both meet at the
 * canonical project. Assigning a book to a project that has no canonical node
 * yet creates one under its area on the fly.
 *
 * A project's payables (Cash Flow Report → Project view) = the sum of its
 * assigned books' CCC-share balances. Every book not assigned to a project
 * stays in that area's "Area & other projects" bucket — mostly closed jobs the
 * area still settles. Coverage = how many cf projects have at least one book. */

type Book = { book_code: string; area: string | null; companyname: string | null; ccc_share_usd: number }
type CfProj = { code: string; area: string; name: string; canonId: string | null }

const fmtM = (n: number) => {
  const m = n / 1e6
  return (m < -0.005 ? `(${Math.abs(m).toFixed(2)})` : m > 0.005 ? m.toFixed(2) : '—')
}

type Picker = { mode: 'book'; proj: CfProj } | { mode: 'proj'; book: Book } | null

export default function PayablesMap({ canManage }: { canManage: boolean }) {
  const [books, setBooks] = useState<Book[]>([])
  const [cfProjs, setCfProjs] = useState<CfProj[]>([])
  const [tbAlias, setTbAlias] = useState<Map<string, string>>(new Map())   // book_code -> canonical_id
  const [areaNode, setAreaNode] = useState<Map<string, string>>(new Map()) // cf area -> canonical area id
  const [projNodeIds, setProjNodeIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [picker, setPicker] = useState<Picker>(null)
  const [q, setQ] = useState('')
  const [saving, setSaving] = useState(false)
  const [onlyOpen, setOnlyOpen] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true); setErr(null)
      const [bk, cp, ce, ea] = await Promise.all([
        supabase.from('v_cf_payables_book').select('book_code, area, companyname, ccc_share_usd'),
        supabase.from('cf_projects').select('project_code, area, display_name, is_area_item'),
        supabase.from('canonical_entity').select('id, name, entity_type'),
        supabase.from('entity_alias').select('source_system, local_key, canonical_id'),
      ])
      if (!alive) return
      const e = bk.error || cp.error || ce.error || ea.error
      if (e) { setErr(e.message); setLoading(false); return }
      const nodes = (ce.data ?? []) as { id: string; name: string; entity_type: string }[]
      const projIds = new Set(nodes.filter(n => n.entity_type === 'project').map(n => n.id))
      const aliases = (ea.data ?? []) as { source_system: string; local_key: string; canonical_id: string }[]
      const tcProj = new Map<string, string>(), tcArea = new Map<string, string>(), tb = new Map<string, string>()
      for (const a of aliases) {
        if (a.source_system === 'treasury_cashflow' && a.local_key.startsWith('proj:'))
          tcProj.set(a.local_key.slice(5).toUpperCase(), a.canonical_id)
        else if (a.source_system === 'treasury_cashflow' && a.local_key.startsWith('area:'))
          tcArea.set(a.local_key.slice(5), a.canonical_id)
        else if (a.source_system === 'trial_balance') tb.set(a.local_key, a.canonical_id)
      }
      const projs = ((cp.data ?? []) as { project_code: string; area: string | null; display_name: string | null; is_area_item: boolean }[])
        .filter(p => !p.is_area_item && p.area)
        .map(p => {
          const cid = tcProj.get(p.project_code.toUpperCase())
          return { code: p.project_code, area: p.area!, name: p.display_name || p.project_code,
                   canonId: cid && projIds.has(cid) ? cid : null }
        })
        .sort((a, b) => a.area.localeCompare(b.area) || a.name.localeCompare(b.name))
      setProjNodeIds(projIds); setAreaNode(tcArea); setTbAlias(tb)
      setBooks(((bk.data ?? []) as Book[]).sort((a, b) => a.ccc_share_usd - b.ccc_share_usd))
      setCfProjs(projs)
      setLoading(false)
    })()
    return () => { alive = false }
  }, [])

  // Ensure the cf project has a canonical project node; create it (under its
  // area) + point the treasury_cashflow alias at it if missing. Returns the id.
  async function ensureNode(proj: CfProj): Promise<string> {
    if (proj.canonId) return proj.canonId
    const parent = areaNode.get(proj.area)
    if (!parent) throw new Error(`No canonical area for “${proj.area}” — map the area first.`)
    const node = await createNode({ entity_type: 'project', parent_id: parent, name: proj.name, owner_dept: 'treasury' })
    await mapAlias({ canonical_id: node.id, source_system: 'treasury_cashflow', local_key: `proj:${proj.code}`, local_name: proj.name })
    setProjNodeIds(s => new Set(s).add(node.id))
    setCfProjs(list => list.map(p => p === proj || (p.code === proj.code && p.area === proj.area) ? { ...p, canonId: node.id } : p))
    return node.id
  }

  async function assign(proj: CfProj, book: Book) {
    if (!canManage) return
    setSaving(true)
    try {
      const cid = await ensureNode(proj)
      await mapAlias({ canonical_id: cid, source_system: 'trial_balance', local_key: book.book_code, local_name: book.companyname ?? book.book_code })
      setTbAlias(m => new Map(m).set(book.book_code, cid))
      setPicker(null); setQ('')
    } catch (e: any) { setErr(e.message) } finally { setSaving(false) }
  }

  async function removeBook(book: Book) {
    if (!canManage) return
    setSaving(true)
    try {
      await unmapAlias('trial_balance', book.book_code)
      setTbAlias(m => { const n = new Map(m); n.delete(book.book_code); return n })
    } catch (e: any) { setErr(e.message) } finally { setSaving(false) }
  }

  // books assigned to each project's canonical node
  const booksByCanon = useMemo(() => {
    const m = new Map<string, Book[]>()
    for (const b of books) {
      const cid = tbAlias.get(b.book_code); if (!cid) continue
      const arr = m.get(cid) ?? []; arr.push(b); m.set(cid, arr)
    }
    return m
  }, [books, tbAlias])

  const assignedSet = useMemo(() => new Set(books.filter(b => tbAlias.has(b.book_code)).map(b => b.book_code)), [books, tbAlias])
  const unassigned = useMemo(() => books.filter(b => !assignedSet.has(b.book_code)), [books, assignedSet])

  const projByArea = useMemo(() => {
    const m = new Map<string, CfProj[]>()
    for (const p of cfProjs) { const a = m.get(p.area) ?? []; a.push(p); m.set(p.area, a) }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [cfProjs])

  const bucketByArea = useMemo(() => {
    const m = new Map<string, Book[]>()
    for (const b of unassigned) { const a = b.area || '—'; const arr = m.get(a) ?? []; arr.push(b); m.set(a, arr) }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [unassigned])

  const overall = useMemo(() => {
    const mapped = cfProjs.filter(p => p.canonId && (booksByCanon.get(p.canonId)?.length ?? 0) > 0).length
    return { total: cfProjs.length, mapped, pct: cfProjs.length ? Math.round(100 * mapped / cfProjs.length) : 0 }
  }, [cfProjs, booksByCanon])

  const projMatches = useMemo(() => {
    const s = q.trim().toLowerCase()
    const base = s ? cfProjs.filter(p => p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s) || p.area.toLowerCase().includes(s)) : cfProjs
    return base.slice(0, 60)
  }, [q, cfProjs])
  const bookMatches = useMemo(() => {
    const s = q.trim().toLowerCase()
    const base = s ? unassigned.filter(b => b.book_code.toLowerCase().includes(s) || (b.companyname ?? '').toLowerCase().includes(s)) : unassigned
    return base.slice(0, 80)
  }, [q, unassigned])

  if (loading) return <div className="cfm-body"><div className="pm-empty">Loading…</div></div>
  if (err && !books.length) return <div className="cfm-body"><div className="pm-err">Couldn’t load: {err}</div></div>

  return (
    <div className="cfm-body pm">
      <div className="pm-head">
        <div>
          <h3>Payables map</h3>
          <p className="pm-sub">Assign each cash-flow project to its trial-balance book(s). A project’s payables = the sum of its books (CCC share). Every unassigned book stays in its area’s “Area &amp; other projects” bucket. Read by the Project view.</p>
        </div>
        <div className="pm-cov">
          <div className="pm-cov-v">{overall.pct}%</div>
          <div className="pm-cov-l">{overall.mapped} of {overall.total} projects have a book</div>
          <div className="pm-cov-bar"><span style={{ width: `${overall.pct}%` }} /></div>
        </div>
      </div>
      {err && <div className="pm-err" style={{ padding: '4px 0' }}>{err}</div>}

      <label className="pm-toggle">
        <input type="checkbox" checked={onlyOpen} onChange={e => setOnlyOpen(e.target.checked)} />
        Show only projects without a book
      </label>

      {projByArea.map(([area, ps]) => {
        const rows = onlyOpen ? ps.filter(p => !(p.canonId && (booksByCanon.get(p.canonId)?.length ?? 0) > 0)) : ps
        if (!rows.length) return null
        const mapped = ps.filter(p => p.canonId && (booksByCanon.get(p.canonId)?.length ?? 0) > 0).length
        return (
          <section className="pm-area" key={area}>
            <div className="pm-area-h">
              <h4>{area}</h4>
              <span className="pm-area-c">{mapped}/{ps.length} with a book</span>
            </div>
            <div className="pm-grid">
              {rows.map(p => {
                const bks = p.canonId ? (booksByCanon.get(p.canonId) ?? []) : []
                const tot = bks.reduce((s, b) => s + b.ccc_share_usd, 0)
                return (
                  <div className={`pm-card ${bks.length ? 'is-pinned' : ''}`} key={p.code + p.area}>
                    <div className="pm-card-top">
                      <span className="pm-code" title={p.name}>{p.name}</span>
                      <span className="pm-num">{bks.length ? fmtM(tot) : ''}</span>
                    </div>
                    <div className="pm-books">
                      {bks.length ? bks.map(b => (
                        <span className="pm-chip" key={b.book_code} title={b.companyname ?? ''}>
                          {b.book_code} <span className="pm-chip-n">{fmtM(b.ccc_share_usd)}</span>
                          {canManage && <button className="pm-chip-x" disabled={saving} onClick={() => removeBook(b)} title="Remove">×</button>}
                        </span>
                      )) : <span className="pm-bucket">No book — in area bucket</span>}
                    </div>
                    {canManage && (
                      <div className="pm-card-foot">
                        <button className="pm-assignbtn" onClick={() => { setPicker({ mode: 'book', proj: p }); setQ('') }}>+ Add book</button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}

      {!onlyOpen && bucketByArea.map(([area, bks]) => {
        const tot = bks.reduce((s, b) => s + b.ccc_share_usd, 0)
        return (
          <section className="pm-area pm-area--bucket" key={'bkt-' + area}>
            <div className="pm-area-h">
              <h4>Area &amp; other projects · {area}</h4>
              <span className="pm-area-b">{bks.length} unassigned books · {fmtM(tot)}m</span>
            </div>
            <div className="pm-grid">
              {bks.map(b => (
                <div className="pm-card" key={b.book_code}>
                  <div className="pm-card-top">
                    <span className="pm-code">{b.book_code}</span>
                    <span className="pm-num">{fmtM(b.ccc_share_usd)}</span>
                  </div>
                  <div className="pm-co" title={b.companyname ?? ''}>{b.companyname}</div>
                  {canManage && (
                    <div className="pm-card-foot">
                      <button className="pm-assignbtn" onClick={() => { setPicker({ mode: 'proj', book: b }); setQ('') }}>Assign to project…</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )
      })}

      {picker && (
        <div className="pm-modal-bg" onClick={() => { setPicker(null); setQ('') }}>
          <div className="pm-modal" onClick={e => e.stopPropagation()}>
            <div className="pm-modal-h">
              <div>{picker.mode === 'book'
                ? <>Add a book to <b>{picker.proj.name}</b></>
                : <>Assign <b>{picker.book.book_code}</b> to a project</>}</div>
              <div className="pm-modal-co">{picker.mode === 'book' ? `${picker.proj.area} · pick from unassigned books` : picker.book.companyname}</div>
              <button className="pm-modal-x" onClick={() => { setPicker(null); setQ('') }}>×</button>
            </div>
            <input autoFocus className="pm-search" placeholder={picker.mode === 'book' ? 'Search books…' : 'Search projects…'} value={q} onChange={e => setQ(e.target.value)} />
            <div className="pm-list">
              {picker.mode === 'book'
                ? (bookMatches.map(b => (
                    <button key={b.book_code} className="pm-opt" disabled={saving} onClick={() => assign(picker.proj, b)}>
                      <span>{b.book_code} <em style={{ marginLeft: 6 }}>{b.companyname}</em></span>
                      <em>{fmtM(b.ccc_share_usd)}</em>
                    </button>
                  )).concat(bookMatches.length ? [] : [<div key="n" className="pm-noopt">No unassigned book matches “{q}”.</div>] as any))
                : (projMatches.map(p => (
                    <button key={p.code + p.area} className="pm-opt" disabled={saving} onClick={() => assign(p, picker.book)}>
                      <span>{p.name}</span><em>{p.area}</em>
                    </button>
                  )).concat(projMatches.length ? [] : [<div key="n" className="pm-noopt">No project matches “{q}”.</div>] as any))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
