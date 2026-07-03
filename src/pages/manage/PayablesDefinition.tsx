import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'

/* Payables definition — which trial-balance accounts are presented as trade
 * payables next to the cash flow. The set = prefix RULES (e.g. 212·) minus/plus
 * account overrides (coa_group_members: exclude/include), resolved by the
 * coa_group_accounts view and read by the Cash Flow Report. Treasury curates it
 * here; edits write coa_group_rules / coa_group_members (super-admin RLS). */

const GROUP_KEY = 'trade_payables'

type Acct = { account: string; name: string | null; usd_bal: number }
type Member = { account_key: string; action: 'include' | 'exclude' }

const fmtM = (n: number) => {
  const m = n / 1e6
  return m < -0.005 ? `(${Math.abs(m).toFixed(2)})` : m > 0.005 ? m.toFixed(2) : '—'
}

export default function PayablesDefinition({ canManage }: { canManage: boolean }) {
  const [groupId, setGroupId] = useState<number | null>(null)
  const [prefixes, setPrefixes] = useState<string[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [resolved, setResolved] = useState<Acct[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newPrefix, setNewPrefix] = useState('')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Acct[]>([])
  const [searching, setSearching] = useState(false)

  const loadDef = useCallback(async (gid: number) => {
    const [rl, mm, ra] = await Promise.all([
      supabase.from('coa_group_rules').select('prefix').eq('group_id', gid),
      supabase.from('coa_group_members').select('account_key, action').eq('group_id', gid),
      supabase.from('coa_group_accounts').select('account_key').eq('key', GROUP_KEY),
    ])
    if (rl.error || mm.error || ra.error) { setErr((rl.error || mm.error || ra.error)!.message); return }
    setPrefixes(((rl.data ?? []) as { prefix: string }[]).map(r => r.prefix).sort())
    setMembers((mm.data ?? []) as Member[])
    const keys = [...new Set(((ra.data ?? []) as { account_key: string }[]).map(r => r.account_key))]
    if (keys.length) {
      const bal = await supabase.from('v_tb_account').select('account, name, usd_bal').in('account', keys)
      const byK = new Map((((bal.data ?? []) as Acct[])).map(a => [a.account, a]))
      setResolved(keys.map(k => byK.get(k) ?? { account: k, name: null, usd_bal: 0 })
        .sort((a, b) => Math.abs(b.usd_bal) - Math.abs(a.usd_bal)))
    } else setResolved([])
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true); setErr(null)
      const g = await supabase.from('coa_account_groups').select('id').eq('key', GROUP_KEY).single()
      if (!alive) return
      if (g.error) { setErr(g.error.message); setLoading(false); return }
      setGroupId(g.data.id)
      await loadDef(g.data.id)
      if (alive) setLoading(false)
    })()
    return () => { alive = false }
  }, [loadDef])

  // account search (on-demand — 8k+ accounts, don't preload)
  useEffect(() => {
    const s = q.trim()
    if (s.length < 2) { setResults([]); return }
    let alive = true; setSearching(true)
    const t = setTimeout(async () => {
      const r = await supabase.from('v_tb_account').select('account, name, usd_bal')
        .or(`account.ilike.%${s}%,name.ilike.%${s}%`).limit(30)
      if (!alive) return
      setResults((r.data ?? []) as Acct[]); setSearching(false)
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [q])

  const excluded = useMemo(() => members.filter(m => m.action === 'exclude').map(m => m.account_key), [members])
  const included = useMemo(() => new Set(members.filter(m => m.action === 'include').map(m => m.account_key)), [members])
  const resolvedSet = useMemo(() => new Set(resolved.map(a => a.account)), [resolved])
  const total = useMemo(() => resolved.reduce((s, a) => s + a.usd_bal, 0), [resolved])
  const [exBal, setExBal] = useState<Map<string, Acct>>(new Map())
  useEffect(() => {
    if (!excluded.length) { setExBal(new Map()); return }
    supabase.from('v_tb_account').select('account, name, usd_bal').in('account', excluded)
      .then(r => setExBal(new Map((((r.data ?? []) as Acct[])).map(a => [a.account, a]))))
  }, [excluded.join(',')])

  async function mutate(fn: () => PromiseLike<{ error: any }>) {
    if (!canManage || !groupId) return
    setBusy(true)
    try { const { error } = await fn(); if (error) throw error; await loadDef(groupId) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const addPrefix = () => { const p = newPrefix.trim(); if (!p) return; setNewPrefix('')
    mutate(() => supabase.from('coa_group_rules').insert({ group_id: groupId, prefix: p })) }
  const removePrefix = (p: string) =>
    mutate(() => supabase.from('coa_group_rules').delete().eq('group_id', groupId).eq('prefix', p))
  const excludeAcct = (acct: string) => mutate(async () => {
    await supabase.from('coa_group_members').delete().eq('group_id', groupId).eq('account_key', acct)
    return supabase.from('coa_group_members').insert({ group_id: groupId, account_key: acct, action: 'exclude' })
  })
  const reincludeAcct = (acct: string) =>
    mutate(() => supabase.from('coa_group_members').delete().eq('group_id', groupId).eq('account_key', acct).eq('action', 'exclude'))
  const includeAcct = (acct: string) => { setQ('')
    mutate(async () => {
      await supabase.from('coa_group_members').delete().eq('group_id', groupId).eq('account_key', acct)
      return supabase.from('coa_group_members').insert({ group_id: groupId, account_key: acct, action: 'include' })
    }) }

  if (loading) return <div className="cfm-body"><div className="pm-empty">Loading…</div></div>

  return (
    <div className="cfm-body def">
      <div className="pm-head">
        <div>
          <h3>Payables definition</h3>
          <p className="pm-sub">The trial-balance accounts presented as <b>trade payables</b> next to the cash flow. Base is a set of account-code prefixes; fine-tune with per-account include / exclude. The Cash Flow Report reads this.</p>
        </div>
        <div className="pm-cov">
          <div className="pm-cov-v" style={{ fontSize: 24 }}>{fmtM(total)}m</div>
          <div className="pm-cov-l">{resolved.length} accounts · USD</div>
        </div>
      </div>
      {err && <div className="pm-err" style={{ padding: '4px 0' }}>{err}</div>}

      <section className="def-card">
        <div className="def-h">Included by prefix</div>
        <div className="def-prefixes">
          {prefixes.map(p => (
            <span className="def-chip" key={p}>{p}·{canManage && <button className="def-x" disabled={busy} onClick={() => removePrefix(p)} title="Remove prefix">×</button>}</span>
          ))}
          {canManage && (
            <span className="def-addpre">
              <input value={newPrefix} onChange={e => setNewPrefix(e.target.value.replace(/[^0-9]/g, ''))}
                     placeholder="e.g. 213" onKeyDown={e => e.key === 'Enter' && addPrefix()} />
              <button disabled={busy || !newPrefix} onClick={addPrefix}>Add prefix</button>
            </span>
          )}
        </div>
        <p className="def-note">Every trial-balance account whose code starts with a prefix is included, unless excluded below.</p>
      </section>

      <section className="def-card">
        <div className="def-h">Accounts presented <span>· {resolved.length} · {fmtM(total)}m</span></div>
        <div className="def-tablewrap">
          <table className="def-table">
            <thead><tr><th>Account</th><th>Name</th><th className="r">USD m</th><th></th></tr></thead>
            <tbody>
              {resolved.map(a => (
                <tr key={a.account}>
                  <td className="def-acct">{a.account}{included.has(a.account) && <span className="def-tag">added</span>}</td>
                  <td className="def-name">{a.name}</td>
                  <td className={`r def-num ${a.usd_bal < 0 ? 'down' : a.usd_bal > 0 ? 'up' : ''}`}>{fmtM(a.usd_bal)}</td>
                  <td className="r">{canManage && <button className="def-rm" disabled={busy} onClick={() => excludeAcct(a.account)}>Exclude</button>}</td>
                </tr>
              ))}
              {!resolved.length && <tr><td colSpan={4} className="def-empty">No accounts resolve — add a prefix.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {excluded.length > 0 && (
        <section className="def-card def-card--muted">
          <div className="def-h">Excluded <span>· pulled out of the set</span></div>
          <div className="def-tablewrap">
            <table className="def-table">
              <tbody>
                {excluded.map(acct => {
                  const a = exBal.get(acct)
                  return (
                    <tr key={acct}>
                      <td className="def-acct">{acct}</td>
                      <td className="def-name">{a?.name ?? ''}</td>
                      <td className={`r def-num ${(a?.usd_bal ?? 0) < 0 ? 'down' : ''}`}>{a ? fmtM(a.usd_bal) : ''}</td>
                      <td className="r">{canManage && <button className="def-add" disabled={busy} onClick={() => reincludeAcct(acct)}>Re-include</button>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {canManage && (
        <section className="def-card">
          <div className="def-h">Add a specific account</div>
          <input className="def-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search account code or name…" />
          {q.trim().length >= 2 && (
            <div className="def-results">
              {searching && <div className="def-empty">Searching…</div>}
              {!searching && results.map(a => {
                const inSet = resolvedSet.has(a.account)
                return (
                  <div className="def-res" key={a.account}>
                    <span className="def-acct">{a.account}</span>
                    <span className="def-name">{a.name}</span>
                    <span className={`def-num ${a.usd_bal < 0 ? 'down' : a.usd_bal > 0 ? 'up' : ''}`}>{fmtM(a.usd_bal)}</span>
                    {inSet ? <span className="def-in">in set</span>
                      : <button className="def-add" disabled={busy} onClick={() => includeAcct(a.account)}>Include</button>}
                  </div>
                )
              })}
              {!searching && !results.length && <div className="def-empty">No account matches “{q}”.</div>}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
