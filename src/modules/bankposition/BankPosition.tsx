import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRole, canManageCashFlow } from '@/lib/role'
import {
  AREA_ACCOUNTS,
  GROUP_ACCOUNTS,
  GROUP_AREA,
  EXCLUDED_FROM_GROUP,
  BANK_SECTION,
  type BankRow,
  type Grid,
  cellKey,
  num,
  fmtNum,
  areaNet,
  ccGroupNet,
  orderAreas,
  fmtPeriodLabel,
  periodToMonthInput,
  monthInputToPeriod,
  priorPeriod,
} from './lib'
import './bankposition.css'

type Status = { kind: 'ok' | 'err' | 'busy'; msg: string } | null

/* Original DB cell (by cellKey) so we can diff on save. */
type OrigCell = { id: number; balance: number }

export default function BankPosition() {
  const role = useRole()
  const canManage = canManageCashFlow(role)

  const [periods, setPeriods] = useState<string[]>([]) // real DB periods, desc
  const [period, setPeriod] = useState('')
  const [draftPeriod, setDraftPeriod] = useState<string | null>(null) // new month, not yet saved

  const [grid, setGrid] = useState<Grid>({})
  const [areas, setAreas] = useState<string[]>([])
  const [groupItems, setGroupItems] = useState<Record<string, string>>({})
  const orig = useRef<Map<string, OrigCell>>(new Map())

  const [priorNet, setPriorNet] = useState<Record<string, number>>({})
  const [narrative, setNarrative] = useState('')
  const narrativeOrig = useRef<{ id: number; content: string } | null>(null)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  // new-month form
  const [showNew, setShowNew] = useState(false)
  const [newMonth, setNewMonth] = useState('')
  const [cloneFrom, setCloneFrom] = useState('')

  const allPeriods = useMemo(
    () => (draftPeriod ? [draftPeriod, ...periods] : periods),
    [draftPeriod, periods],
  )
  const isDraft = period !== '' && period === draftPeriod

  // ── initial period list ───────────────────────────────────────────
  useEffect(() => {
    supabase
      .from('bank_position')
      .select('period')
      .order('period', { ascending: false })
      .then(({ data, error }) => {
        if (error) {
          setStatus({ kind: 'err', msg: error.message })
          setLoading(false)
          return
        }
        const uniq = Array.from(new Set((data || []).map((r: any) => r.period as string)))
        setPeriods(uniq)
        if (uniq.length) setPeriod(uniq[0])
        else setLoading(false)
      })
  }, [])

  const buildFromRows = useCallback((rows: BankRow[]) => {
    const g: Grid = {}
    const group: Record<string, string> = {}
    const o = new Map<string, OrigCell>()
    const areaSet = new Set<string>()
    for (const r of rows) {
      const bal = Number(r.balance)
      if (r.area === GROUP_AREA) {
        if ((GROUP_ACCOUNTS as readonly string[]).includes(r.account)) {
          group[r.account] = String(bal)
          if (r.id != null) o.set(cellKey(r.area, r.account), { id: r.id, balance: bal })
        }
        continue
      }
      areaSet.add(r.area)
      g[r.area] = g[r.area] || {}
      g[r.area][r.account] = String(bal)
      if (r.id != null) o.set(cellKey(r.area, r.account), { id: r.id, balance: bal })
    }
    orig.current = o
    setGrid(g)
    setGroupItems(group)
    setAreas(orderAreas(Array.from(areaSet)))
  }, [])

  // ── load a real period from the DB ────────────────────────────────
  const openPeriod = useCallback(
    async (p: string) => {
      setLoading(true)
      setStatus(null)
      const [{ data: rows, error }, { data: rem }, { data: prior }] = await Promise.all([
        supabase.from('bank_position').select('*').eq('period', p),
        supabase
          .from('report_remarks')
          .select('*')
          .eq('period', p)
          .eq('section', BANK_SECTION)
          .maybeSingle(),
        supabase.from('bank_position').select('area,account,balance').eq('period', priorPeriod(p)),
      ])
      if (error) {
        setStatus({ kind: 'err', msg: error.message })
        setLoading(false)
        return
      }
      buildFromRows((rows || []) as BankRow[])
      setNarrative(rem?.content || '')
      narrativeOrig.current = rem ? { id: rem.id, content: rem.content } : null
      setPriorNet(computeNet((prior || []) as BankRow[]))
      setDirty(false)
      setLoading(false)
    },
    [buildFromRows],
  )

  // selecting a real period loads it; a draft is already in memory
  useEffect(() => {
    if (!period || period === draftPeriod) {
      setLoading(false)
      return
    }
    openPeriod(period)
  }, [period, draftPeriod, openPeriod])

  function selectPeriod(p: string) {
    if (p === period) return
    if (dirty && !window.confirm('Discard unsaved changes to this month?')) return
    if (draftPeriod && p !== draftPeriod) setDraftPeriod(null)
    setPeriod(p)
  }

  // ── editing ───────────────────────────────────────────────────────
  function setCell(area: string, account: string, value: string) {
    setGrid(g => ({ ...g, [area]: { ...(g[area] || {}), [account]: value } }))
    setDirty(true)
  }
  function setGroup(account: string, value: string) {
    setGroupItems(g => ({ ...g, [account]: value }))
    setDirty(true)
  }
  function addArea() {
    const name = window.prompt('New area name (e.g. Qatar):')?.trim()
    if (!name) return
    if (areas.includes(name) || name === GROUP_AREA) {
      setStatus({ kind: 'err', msg: `Area "${name}" already exists.` })
      return
    }
    setAreas(a => orderAreas([...a, name]))
    setGrid(g => ({ ...g, [name]: {} }))
    setDirty(true)
  }

  // ── new month (clone prior as starting point, persisted on Save) ──
  function openNewMonth() {
    setCloneFrom(periods[0] || '')
    setNewMonth('')
    setShowNew(true)
  }
  function createNewMonth() {
    const p = monthInputToPeriod(newMonth)
    if (!newMonth) {
      setStatus({ kind: 'err', msg: 'Pick a month.' })
      return
    }
    if (periods.includes(p)) {
      setStatus({ kind: 'err', msg: `${fmtPeriodLabel(p)} already exists — select it from the picker.` })
      return
    }
    // clone the chosen source month into the editor; ids dropped → all become inserts on save
    if (cloneFrom) {
      supabase
        .from('bank_position')
        .select('area,account,balance')
        .eq('period', cloneFrom)
        .then(({ data }) => {
          buildFromRows(((data || []) as BankRow[]).map(r => ({ ...r, id: undefined, period: p })))
          orig.current = new Map() // nothing persisted yet for this month
        })
    } else {
      buildFromRows([])
      orig.current = new Map()
    }
    setNarrative('')
    narrativeOrig.current = null
    setPriorNet(priorNet) // keep; openPeriod won't run for a draft
    // load the prior month's net for the Δ column
    supabase
      .from('bank_position')
      .select('area,account,balance')
      .eq('period', priorPeriod(p))
      .then(({ data }) => setPriorNet(computeNet((data || []) as BankRow[])))
    setDraftPeriod(p)
    setPeriod(p)
    setShowNew(false)
    setDirty(true)
    setStatus({ kind: 'ok', msg: `Started ${fmtPeriodLabel(p)} from ${fmtPeriodLabel(cloneFrom)} — edit, then Save.` })
  }

  // ── save grid + narrative ─────────────────────────────────────────
  async function save() {
    if (!canManage || !period) return
    setSaving(true)
    setStatus({ kind: 'busy', msg: 'Saving…' })

    // desired cells: operating areas × 3 accounts + Total × group accounts
    const desired: { area: string; account: string; value: number | null }[] = []
    for (const area of areas)
      for (const account of AREA_ACCOUNTS) desired.push({ area, account, value: num(grid[area]?.[account]) })
    for (const account of GROUP_ACCOUNTS)
      desired.push({ area: GROUP_AREA, account, value: num(groupItems[account]) })

    const inserts: Omit<BankRow, 'id'>[] = []
    const updates: { id: number; balance: number }[] = []
    const deletes: number[] = []
    for (const d of desired) {
      const o = orig.current.get(cellKey(d.area, d.account))
      if (d.value == null) {
        if (o) deletes.push(o.id)
      } else if (!o) {
        inserts.push({ area: d.area, account: d.account, period, balance: d.value })
      } else if (o.balance !== d.value) {
        updates.push({ id: o.id, balance: d.value })
      }
    }

    try {
      if (inserts.length) {
        const { error } = await supabase.from('bank_position').insert(inserts)
        if (error) throw error
      }
      for (const u of updates) {
        const { error } = await supabase.from('bank_position').update({ balance: u.balance }).eq('id', u.id)
        if (error) throw error
      }
      if (deletes.length) {
        const { error } = await supabase.from('bank_position').delete().in('id', deletes)
        if (error) throw error
      }

      // narrative upsert
      const content = narrative.trim()
      const no = narrativeOrig.current
      if (no && content !== no.content) {
        const { error } = await supabase.from('report_remarks').update({ content }).eq('id', no.id)
        if (error) throw error
      } else if (!no && content) {
        const { error } = await supabase
          .from('report_remarks')
          .insert({ period, section: BANK_SECTION, content })
        if (error) throw error
      }

      // promote a draft month into the real list, then reload from DB for fresh ids
      const wasDraft = period === draftPeriod
      if (wasDraft) {
        setPeriods(prev => Array.from(new Set([period, ...prev])).sort((a, b) => b.localeCompare(a)))
        setDraftPeriod(null)
      }
      setStatus({ kind: 'ok', msg: `Saved ${fmtPeriodLabel(period)}.` })
      setDirty(false)
      await openPeriod(period)
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || 'Save failed.' })
    } finally {
      setSaving(false)
    }
  }

  // ── derived figures ───────────────────────────────────────────────
  const groupNet = ccGroupNet(grid, areas)
  const jvCash = num(groupItems['JV Cash'])
  const blocked = num(groupItems['Blocked'])
  const mtb = areas.includes('MTB Overdraft') ? areaNet(grid, 'MTB Overdraft') : null
  const palestine = areas.includes('Palestine') ? areaNet(grid, 'Palestine') : null

  if (!canManage) {
    return (
      <div className="bp-gate">
        <div className="bp-gate-card">
          <h1>Bank Position</h1>
          <p>Managing the group cash position needs the Treasury or admin role.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bp-root">
      <header className="bp-head">
        <div className="bp-head-main">
          <h1 className="bp-title">Bank Position</h1>
          <p className="bp-sub">Monthly group cash position by area and account. Edits write to the same data the dashboard reads.</p>
        </div>
        <div className="bp-head-controls">
          <label className="bp-field">
            <span>Month</span>
            <select value={period} onChange={e => selectPeriod(e.target.value)} disabled={saving}>
              {allPeriods.map(p => (
                <option key={p} value={p}>
                  {fmtPeriodLabel(p)}
                  {p === draftPeriod ? ' (draft)' : ''}
                </option>
              ))}
            </select>
          </label>
          <button className="bp-btn" onClick={openNewMonth} disabled={saving}>
            New month
          </button>
          <button className="bp-btn bp-btn-primary" onClick={save} disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      {status && <div className={`bp-status bp-status-${status.kind}`}>{status.msg}</div>}

      {showNew && (
        <div className="bp-newmonth">
          <div className="bp-field">
            <span>New month</span>
            <input type="month" value={newMonth} onChange={e => setNewMonth(e.target.value)} />
          </div>
          <div className="bp-field">
            <span>Clone from</span>
            <select value={cloneFrom} onChange={e => setCloneFrom(e.target.value)}>
              <option value="">— blank —</option>
              {periods.map(p => (
                <option key={p} value={p}>
                  {fmtPeriodLabel(p)}
                </option>
              ))}
            </select>
          </div>
          <button className="bp-btn bp-btn-primary" onClick={createNewMonth}>
            Create
          </button>
          <button className="bp-btn" onClick={() => setShowNew(false)}>
            Cancel
          </button>
        </div>
      )}

      {loading ? (
        <div className="bp-loading">Loading…</div>
      ) : (
        <>
          {/* headline figures */}
          <div className="bp-kpis">
            <div className="bp-kpi bp-kpi-lead">
              <span className="bp-kpi-label">CC Group net</span>
              <span className={`bp-kpi-val ${groupNet < 0 ? 'neg' : 'pos'}`}>{fmtNum(groupNet)}</span>
            </div>
            <div className="bp-kpi">
              <span className="bp-kpi-label">JV Cash</span>
              <span className="bp-kpi-val">{fmtNum(jvCash)}</span>
            </div>
            <div className="bp-kpi">
              <span className="bp-kpi-label">Blocked</span>
              <span className="bp-kpi-val">{fmtNum(blocked)}</span>
            </div>
            <div className="bp-kpi">
              <span className="bp-kpi-label">MTB Overdraft</span>
              <span className={`bp-kpi-val ${(mtb ?? 0) < 0 ? 'neg' : ''}`}>{fmtNum(mtb)}</span>
            </div>
            <div className="bp-kpi">
              <span className="bp-kpi-label">Palestine</span>
              <span className={`bp-kpi-val ${(palestine ?? 0) < 0 ? 'neg' : ''}`}>{fmtNum(palestine)}</span>
            </div>
          </div>

          {/* area × account grid */}
          <div className="bp-gridwrap">
            <table className="bp-table">
              <thead>
                <tr>
                  <th className="label">Area</th>
                  {AREA_ACCOUNTS.map(a => (
                    <th key={a}>{a}</th>
                  ))}
                  <th>Net</th>
                  <th title="Net change vs prior month">Δ MoM</th>
                </tr>
              </thead>
              <tbody>
                {areas.map(area => {
                  const net = areaNet(grid, area)
                  const prev = priorNet[area]
                  const delta = prev == null ? null : net - prev
                  const special = EXCLUDED_FROM_GROUP.includes(area)
                  return (
                    <tr key={area} className={special ? 'bp-special' : ''}>
                      <td className="label">{area}</td>
                      {AREA_ACCOUNTS.map(account => (
                        <td key={account} className="bp-cell">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={grid[area]?.[account] ?? ''}
                            onChange={e => setCell(area, account, e.target.value)}
                          />
                        </td>
                      ))}
                      <td className={`bp-num ${net < 0 ? 'neg' : 'pos'}`}>{fmtNum(net)}</td>
                      <td className={`bp-num bp-delta ${delta == null ? '' : delta < 0 ? 'neg' : 'pos'}`}>
                        {delta == null ? '—' : (delta > 0 ? '+' : '') + fmtNum(delta)}
                      </td>
                    </tr>
                  )
                })}
                <tr className="bp-total">
                  <td className="label">CC Group net</td>
                  <td colSpan={AREA_ACCOUNTS.length} />
                  <td className={`bp-num ${groupNet < 0 ? 'neg' : 'pos'}`}>{fmtNum(groupNet)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
            <button className="bp-addarea" onClick={addArea}>
              + Add area
            </button>
          </div>

          {/* group waterfall items (stored under area = Total) */}
          <div className="bp-group">
            <h2 className="bp-h2">Group items</h2>
            <p className="bp-group-hint">Cash-availability waterfall — stored under the “Total” row.</p>
            <div className="bp-group-fields">
              {GROUP_ACCOUNTS.map(account => (
                <label key={account} className="bp-field">
                  <span>{account}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={groupItems[account] ?? ''}
                    onChange={e => setGroup(account, e.target.value)}
                  />
                </label>
              ))}
            </div>
          </div>

          {/* month narrative */}
          <div className="bp-narrative">
            <h2 className="bp-h2">Narrative</h2>
            <p className="bp-group-hint">Tony's monthly write-up — saved to report_remarks.</p>
            <textarea
              value={narrative}
              onChange={e => {
                setNarrative(e.target.value)
                setDirty(true)
              }}
              placeholder="Cash position commentary for this month…"
              rows={8}
            />
          </div>
        </>
      )}
    </div>
  )
}

/* area→net map for a set of rows (used for the Δ-vs-prior column). */
function computeNet(rows: BankRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) {
    if (r.area === GROUP_AREA) continue
    if (!(AREA_ACCOUNTS as readonly string[]).includes(r.account)) continue
    out[r.area] = (out[r.area] || 0) + Number(r.balance)
  }
  return out
}
