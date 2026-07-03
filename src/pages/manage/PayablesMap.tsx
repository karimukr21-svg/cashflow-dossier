import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'

/* Payables map — assign each trade-payables book to a cash-flow project (or
 * leave it in the area bucket). The confirmed map lives in entity_alias
 * (source_system='trial_balance'); suggestions are the auto-proposal, kept
 * separate so nothing wrong reaches the registry until Karim confirms it.
 *
 * A project's payables (shown in the Cash Flow Report Project view) = the sum
 * of its assigned books' CCC-share balances. Unassigned books fall to the
 * area's "Area & other projects" bucket. Coverage = how many books are pinned
 * to a specific project — the number to grow. */

type Book = { book_code: string; area: string | null; companyname: string | null; ccc_share_usd: number }
type Proj = { id: string; name: string; area: string }

const fmtM = (n: number) => {
  const m = n / 1e6
  return (m < -0.005 ? `(${Math.abs(m).toFixed(2)})` : m > 0.005 ? m.toFixed(2) : '—')
}

export default function PayablesMap({ canManage }: { canManage: boolean }) {
  const [books, setBooks] = useState<Book[]>([])
  const [projById, setProjById] = useState<Map<string, Proj>>(new Map())
  const [projList, setProjList] = useState<Proj[]>([])
  const [alias, setAlias] = useState<Map<string, string>>(new Map())      // book_code -> canonical_id
  const [sugg, setSugg] = useState<Map<string, string>>(new Map())        // book_code -> canonical_id
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [picker, setPicker] = useState<string | null>(null)               // book_code with the picker open
  const [q, setQ] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [onlyOpen, setOnlyOpen] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true); setErr(null)
      const [bk, ce, ea, su] = await Promise.all([
        supabase.from('v_cf_payables_book').select('book_code, area, companyname, ccc_share_usd'),
        supabase.from('canonical_entity').select('id, name, entity_type, parent_id, is_active'),
        supabase.from('entity_alias').select('local_key, canonical_id').eq('source_system', 'trial_balance'),
        supabase.from('cf_payables_map_suggestion').select('book_code, canonical_id'),
      ])
      if (!alive) return
      const firstErr = bk.error || ce.error || ea.error || su.error
      if (firstErr) { setErr(firstErr.message); setLoading(false); return }
      const nodes = (ce.data ?? []) as { id: string; name: string; entity_type: string; parent_id: string | null }[]
      const nameById = new Map(nodes.map(n => [n.id, n.name]))
      const projects = nodes.filter(n => n.entity_type === 'project')
        .map(n => ({ id: n.id, name: n.name, area: (n.parent_id && nameById.get(n.parent_id)) || '' }))
        .sort((a, b) => a.name.localeCompare(b.name))
      setProjList(projects)
      setProjById(new Map(projects.map(p => [p.id, p])))
      setBooks(((bk.data ?? []) as Book[]).sort((a, b) => (a.ccc_share_usd) - (b.ccc_share_usd)))
      setAlias(new Map(((ea.data ?? []) as { local_key: string; canonical_id: string }[]).map(r => [r.local_key, r.canonical_id])))
      setSugg(new Map(((su.data ?? []) as { book_code: string; canonical_id: string }[]).map(r => [r.book_code, r.canonical_id])))
      setLoading(false)
    })()
    return () => { alive = false }
  }, [])

  async function assign(bk: Book, cid: string | null) {
    if (!canManage) return
    setSaving(bk.book_code)
    try {
      if (cid) {
        const { error } = await supabase.from('entity_alias')
          .upsert({ source_system: 'trial_balance', local_key: bk.book_code, local_name: bk.companyname ?? bk.book_code, canonical_id: cid },
                  { onConflict: 'source_system,local_key' })
        if (error) throw error
        setAlias(m => new Map(m).set(bk.book_code, cid))
      } else {
        const { error } = await supabase.from('entity_alias').delete()
          .eq('source_system', 'trial_balance').eq('local_key', bk.book_code)
        if (error) throw error
        setAlias(m => { const n = new Map(m); n.delete(bk.book_code); return n })
      }
      setPicker(null); setQ('')
    } catch (e: any) { setErr(e.message) } finally { setSaving(null) }
  }

  // group by area
  const byArea = useMemo(() => {
    const m = new Map<string, Book[]>()
    for (const b of books) {
      const a = b.area || '—'
      const arr = m.get(a) ?? []; arr.push(b); m.set(a, arr)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [books])

  const overall = useMemo(() => {
    const mapped = books.filter(b => alias.has(b.book_code))
    return { total: books.length, mapped: mapped.length,
             pct: books.length ? Math.round(100 * mapped.length / books.length) : 0 }
  }, [books, alias])

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return projList.slice(0, 40)
    return projList.filter(p => p.name.toLowerCase().includes(s) || p.area.toLowerCase().includes(s)).slice(0, 40)
  }, [q, projList])

  if (loading) return <div className="cfm-body"><div className="pm-empty">Loading payables books…</div></div>
  if (err) return <div className="cfm-body"><div className="pm-err">Couldn’t load: {err}</div></div>

  return (
    <div className="cfm-body pm">
      <div className="pm-head">
        <div>
          <h3>Payables map</h3>
          <p className="pm-sub">Assign each trade-payables book to a cash-flow project, or leave it in the area bucket. A project’s payables = the sum of its books (CCC share). Confirmed here, read by the Project view.</p>
        </div>
        <div className="pm-cov">
          <div className="pm-cov-v">{overall.pct}%</div>
          <div className="pm-cov-l">{overall.mapped} of {overall.total} books pinned to a project</div>
          <div className="pm-cov-bar"><span style={{ width: `${overall.pct}%` }} /></div>
        </div>
      </div>

      <label className="pm-toggle">
        <input type="checkbox" checked={onlyOpen} onChange={e => setOnlyOpen(e.target.checked)} />
        Show only unassigned
      </label>

      {byArea.map(([area, bks]) => {
        const rows = onlyOpen ? bks.filter(b => !alias.has(b.book_code)) : bks
        if (!rows.length) return null
        const mapped = bks.filter(b => alias.has(b.book_code)).length
        const bucket = bks.filter(b => !alias.has(b.book_code))
        const bucketUsd = bucket.reduce((s, b) => s + b.ccc_share_usd, 0)
        return (
          <section className="pm-area" key={area}>
            <div className="pm-area-h">
              <h4>{area}</h4>
              <span className="pm-area-c">{mapped}/{bks.length} pinned</span>
              <span className="pm-area-b">Area bucket · {bucket.length} books · {fmtM(bucketUsd)}m</span>
            </div>
            <div className="pm-rows">
              {rows.map(b => {
                const cid = alias.get(b.book_code)
                const proj = cid ? projById.get(cid) : null
                const sg = !cid ? sugg.get(b.book_code) : undefined
                const sgProj = sg ? projById.get(sg) : null
                return (
                  <div className={`pm-row ${cid ? 'is-pinned' : ''}`} key={b.book_code}>
                    <div className="pm-bk">
                      <span className="pm-code">{b.book_code}</span>
                      <span className="pm-co">{b.companyname}</span>
                    </div>
                    <div className="pm-assign">
                      {proj ? (
                        <span className="pm-proj" title={proj.name}>{proj.name}</span>
                      ) : sgProj ? (
                        <span className="pm-sugg">Suggested: <b title={sgProj.name}>{sgProj.name}</b>
                          {canManage && <button className="pm-accept" disabled={saving===b.book_code} onClick={() => assign(b, sg!)}>Accept</button>}
                        </span>
                      ) : (
                        <span className="pm-bucket">Area bucket</span>
                      )}
                    </div>
                    <div className="pm-num">{fmtM(b.ccc_share_usd)}</div>
                    <div className="pm-act">
                      {canManage && (cid
                        ? <button className="pm-x" disabled={saving===b.book_code} onClick={() => assign(b, null)} title="Move to area bucket">→ area</button>
                        : <button className="pm-assignbtn" onClick={() => { setPicker(picker===b.book_code?null:b.book_code); setQ('') }}>Assign…</button>)}
                    </div>
                    {picker === b.book_code && (
                      <div className="pm-picker">
                        <input autoFocus className="pm-search" placeholder="Search projects…" value={q} onChange={e => setQ(e.target.value)} />
                        <div className="pm-list">
                          {matches.map(p => (
                            <button key={p.id} className="pm-opt" onClick={() => assign(b, p.id)}>
                              <span>{p.name}</span>{p.area && <em>{p.area}</em>}
                            </button>
                          ))}
                          {!matches.length && <div className="pm-noopt">No project matches “{q}”.</div>}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
