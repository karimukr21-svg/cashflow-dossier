import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { supabase } from '@/lib/supabase'
import { useRole, canManageCashFlow } from '@/lib/role'
import {
  AREA_ACCOUNTS,
  GROUP_ACCOUNTS,
  GROUP_AREA,
  BANK_SECTION,
  type BankRow,
  type Grid,
  cellKey,
  num,
  fmtNum,
  areaNet,
  ccGroupNet,
  operatingAreas,
  cashDebtByPeriod,
  orderAreas,
  fmtPeriodLabel,
  monthInputToPeriod,
  priorPeriod,
} from './lib'
import { buildReportHtml } from './printReport'
import './bankposition.css'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

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
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null) // cell being edited (shows raw)

  const [viewYear, setViewYear] = useState<number>(() => new Date().getUTCFullYear())

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const [showNarrative, setShowNarrative] = useState(false)

  // new-month form
  const [showNew, setShowNew] = useState(false)
  const [newMonth, setNewMonth] = useState('')
  const [cloneFrom, setCloneFrom] = useState('')

  const allPeriods = useMemo(
    () => (draftPeriod ? [draftPeriod, ...periods] : periods),
    [draftPeriod, periods],
  )

  // year-button row bounds: span the available data (plus a draft year)
  const yearBounds = useMemo(() => {
    const years = allPeriods.map(p => Number(p.slice(0, 4)))
    if (!years.length) return { min: viewYear, max: viewYear }
    return { min: Math.min(...years), max: Math.max(...years) }
  }, [allPeriods, viewYear])

  // keep the visible year in step with the selected month
  useEffect(() => {
    if (period) setViewYear(Number(period.slice(0, 4)))
  }, [period])

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
  // turn the selected lines of the narrative into a bullet / numbered list
  function applyList(kind: 'bullet' | 'number') {
    const ta = taRef.current
    if (!ta) return
    const value = ta.value
    const start = value.lastIndexOf('\n', ta.selectionStart - 1) + 1
    let end = value.indexOf('\n', ta.selectionEnd)
    if (end === -1) end = value.length
    const block = value.slice(start, end)
    let n = 0
    const transformed = block
      .split('\n')
      .map(ln => {
        const stripped = ln.replace(/^(\s*)([-*•]\s+|\d+[.)]\s+)?/, '$1')
        if (stripped.trim() === '') return ln
        n += 1
        return kind === 'bullet' ? `- ${stripped.trimStart()}` : `${n}. ${stripped.trimStart()}`
      })
      .join('\n')
    const next = value.slice(0, start) + transformed + value.slice(end)
    setNarrative(next)
    setDirty(true)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(start, start + transformed.length)
    })
  }

  // wrap the selection with an inline mark (** bold, * italic, __ underline)
  function wrapSel(mark: string) {
    const ta = taRef.current
    if (!ta) return
    const { selectionStart: s, selectionEnd: e, value } = ta
    const sel = value.slice(s, e) || 'text'
    const next = value.slice(0, s) + mark + sel + mark + value.slice(e)
    setNarrative(next)
    setDirty(true)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(s + mark.length, s + mark.length + sel.length)
    })
  }

  // open a printable / save-to-PDF report for the current month
  function printReport() {
    const w = window.open('', '_blank', 'width=900,height=1100')
    if (!w) {
      setStatus({ kind: 'err', msg: 'Allow pop-ups to print the report.' })
      return
    }
    w.document.write('<!doctype html><title>Preparing report…</title><body style="font-family:system-ui;padding:40px;color:#666">Preparing report…</body>')
    supabase
      .from('bank_position')
      .select('period,area,account,balance')
      .then(({ data }) => {
        const cd = cashDebtByPeriod((data || []) as BankRow[])
        // reflect unsaved edits for the selected month in the trend series
        const ops = operatingAreas(areas)
        const liveCash = ops.reduce((s, a) => s + (num(grid[a]?.['Cash']) ?? 0), 0)
        const liveDebt = ops.reduce(
          (s, a) => s + (num(grid[a]?.['Overdrafts']) ?? 0) + (num(grid[a]?.['Loans']) ?? 0),
          0,
        )
        const idx = cd.findIndex(m => m.period === period)
        if (idx >= 0) cd[idx] = { period, cash: liveCash, debt: liveDebt }
        else {
          cd.push({ period, cash: liveCash, debt: liveDebt })
          cd.sort((a, b) => a.period.localeCompare(b.period))
        }
        const html = buildReportHtml({
          period,
          areas,
          grid,
          groupItems,
          narrative,
          priorNet,
          cashSeries: cd.map(d => ({ period: d.period, val: d.cash })),
          debtSeries: cd.map(d => ({ period: d.period, val: d.debt })),
          generatedAt: new Date().toLocaleString('en-GB'),
          logoUrl: window.location.origin + '/ccc-logo.png',
        })
        w.document.open()
        w.document.write(html)
        w.document.close()
      })
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

  // ── derived figures (Tony's subtotal hierarchy) ───────────────────
  const opAreas = operatingAreas(areas)
  const hasMtb = areas.includes('MTB Overdraft')
  const hasPalestine = areas.includes('Palestine')
  const groupNet = ccGroupNet(grid, areas) // CC GROUP TOTAL (Σ operating)
  const mtb = hasMtb ? areaNet(grid, 'MTB Overdraft') : null
  const palestine = hasPalestine ? areaNet(grid, 'Palestine') : null
  const groupWithMtb = groupNet + (mtb ?? 0)
  const grandTotal = groupWithMtb + (palestine ?? 0)
  const jvCash = num(groupItems['JV Cash'])
  const blocked = num(groupItems['Blocked'])

  // CC Group total build-up components (Σ over operating areas)
  const sumAcct = (acct: string) => opAreas.reduce((s, a) => s + (num(grid[a]?.[acct]) ?? 0), 0)
  const cashTot = sumAcct('Cash')
  const odTot = sumAcct('Overdrafts')
  const loansTot = sumAcct('Loans')
  // cash-availability waterfall
  const moneyControl = cashTot - (jvCash ?? 0)
  const freeUsable = moneyControl - (blocked ?? 0)

  // prior-month subtotals for the Δ column
  const hasPrior = Object.keys(priorNet).length > 0
  const priorOp = opAreas.reduce((s, a) => s + (priorNet[a] ?? 0), 0)
  const priorGroupWithMtb = priorOp + (priorNet['MTB Overdraft'] ?? 0)
  const priorTotal = priorGroupWithMtb + (priorNet['Palestine'] ?? 0)

  // display value for an editable cell: raw while focused, formatted otherwise
  const cellVal = (key: string, raw: string | undefined) => {
    if (focusKey === key) return raw ?? ''
    if (!raw || raw.trim() === '') return ''
    const n = num(raw)
    return n == null ? raw : fmtNum(n)
  }
  const cellNeg = (key: string, raw: string | undefined) => {
    if (focusKey === key) return false
    const n = num(raw)
    return n != null && n < 0
  }

  // editable rows in visual order (subtotal rows are skipped — not editable)
  const editRows = [
    ...opAreas,
    ...(hasMtb ? ['MTB Overdraft'] : []),
    ...(hasPalestine ? ['Palestine'] : []),
  ]
  const focusCell = (r: number, c: number) => {
    const el = document.getElementById(`bpcell-${r}-${c}`) as HTMLInputElement | null
    if (el) {
      el.focus()
      el.select()
    }
  }
  // arrow-key / Enter movement between cells; Left/Right only jump at the caret edge
  const onCellKey = (e: KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    const nR = editRows.length
    const nC = AREA_ACCOUNTS.length
    const el = e.currentTarget
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusCell((r - 1 + nR) % nR, c)
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault()
      focusCell((r + 1) % nR, c)
    } else if (e.key === 'ArrowLeft' && atStart) {
      e.preventDefault()
      if (c > 0) focusCell(r, c - 1)
      else if (r > 0) focusCell(r - 1, nC - 1)
    } else if (e.key === 'ArrowRight' && atEnd) {
      e.preventDefault()
      if (c < nC - 1) focusCell(r, c + 1)
      else if (r < nR - 1) focusCell(r + 1, 0)
    }
  }

  // one editable area row (Cash / OD / Loans + Net + Δ)
  const areaRow = (area: string, special = false, rowIndex = 0) => {
    const net = areaNet(grid, area)
    const prev = priorNet[area]
    const delta = prev == null ? null : net - prev
    return (
      <tr key={area} className={special ? 'bp-special' : ''}>
        <td className="label">{area}</td>
        {AREA_ACCOUNTS.map((account, ci) => {
          const key = cellKey(area, account)
          const raw = grid[area]?.[account]
          return (
            <td key={account} className="bp-cell">
              <input
                id={`bpcell-${rowIndex}-${ci}`}
                type="text"
                inputMode="text"
                className={cellNeg(key, raw) ? 'neg' : ''}
                value={cellVal(key, raw)}
                onFocus={() => setFocusKey(key)}
                onBlur={() => setFocusKey(null)}
                onChange={e => setCell(area, account, e.target.value)}
                onKeyDown={e => onCellKey(e, rowIndex, ci)}
              />
            </td>
          )
        })}
        <td className={`bp-num ${net < 0 ? 'neg' : ''}`}>{fmtNum(net)}</td>
        <td className={`bp-num bp-delta ${delta == null ? '' : delta < 0 ? 'neg' : ''}`}>
          {delta == null ? '—' : (delta > 0 ? '+' : '') + fmtNum(delta)}
        </td>
      </tr>
    )
  }

  // a subtotal row in Tony's hierarchy
  const subtotalRow = (label: string, value: number, prior: number, strong = false) => {
    const delta = hasPrior ? value - prior : null
    return (
      <tr className={`bp-subtotal ${strong ? 'bp-subtotal-strong' : ''}`}>
        <td className="label">{label}</td>
        <td colSpan={AREA_ACCOUNTS.length} />
        <td className={`bp-num ${value < 0 ? 'neg' : ''}`}>{fmtNum(value)}</td>
        <td className={`bp-num bp-delta ${delta == null ? '' : delta < 0 ? 'neg' : ''}`}>
          {delta == null ? '—' : (delta > 0 ? '+' : '') + fmtNum(delta)}
        </td>
      </tr>
    )
  }

  // headline card (variant = emphasis, group = colour accent)
  const card = (
    label: string,
    value: number | null,
    variant: '' | 'total' | 'free' = '',
    group: '' | 'build' | 'group' | 'free' = '',
  ) => (
    <div className={`bp-card ${variant ? `bp-card-${variant}` : ''} ${group ? `bp-card-g-${group}` : ''}`}>
      <span className="bp-card-label">{label}</span>
      <span className={`bp-card-val ${value != null && value < 0 ? 'neg' : ''}`}>{fmtNum(value)}</span>
    </div>
  )

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
        <div className="bp-months-row">
          <div className="bp-yearnav">
            <button
              className="bp-yearbtn"
              onClick={() => setViewYear(y => y - 1)}
              disabled={viewYear <= yearBounds.min}
              aria-label="Previous year"
            >
              ‹
            </button>
            <span className="bp-year">{viewYear}</span>
            <button
              className="bp-yearbtn"
              onClick={() => setViewYear(y => y + 1)}
              disabled={viewYear >= yearBounds.max}
              aria-label="Next year"
            >
              ›
            </button>
          </div>
          <div className="bp-months">
            {MONTH_ABBR.map((label, i) => {
              const p = `${viewYear}-${String(i + 1).padStart(2, '0')}-01`
              const available = allPeriods.includes(p)
              const selected = p === period
              return (
                <button
                  key={label}
                  className={`bp-month ${selected ? 'is-selected' : ''} ${p === draftPeriod ? 'is-draft' : ''}`}
                  onClick={() => selectPeriod(p)}
                  disabled={!available || saving}
                  title={available ? '' : 'No data — use New month to create'}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
        <div className="bp-head-controls">
          <button className="bp-btn" onClick={openNewMonth} disabled={saving}>
            New month
          </button>
          <button className="bp-btn" onClick={printReport} disabled={saving || !period}>
            Print report
          </button>
          <button className="bp-btn" onClick={() => setShowNarrative(true)} disabled={!period}>
            Narrative
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
          {/* headline cards — single row, colour-grouped */}
          <div className="bp-cards">
            {card('Cash', cashTot, '', 'build')}
            {card('Overdraft', odTot, '', 'build')}
            {card('Loans', loansTot, '', 'build')}
            {card('CC Group Total Actual', groupNet, 'total', 'build')}
            <span className="bp-card-div" />
            {card('MTB Loans', mtb, '', 'group')}
            {card('Palestine', palestine, '', 'group')}
            {card('Total', grandTotal, 'total', 'group')}
            <span className="bp-card-div" />
            {card('JV Money', jvCash, '', 'free')}
            {card('Money under CCC control', moneyControl, 'free', 'free')}
            {card('Blocked Cash', blocked, '', 'free')}
            {card("CCC's Free Usable Cash", freeUsable, 'free', 'free')}
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
                {opAreas.map((area, i) => areaRow(area, false, i))}
                {subtotalRow('CC Group total', groupNet, priorOp)}
                {hasMtb && areaRow('MTB Overdraft', true, opAreas.length)}
                {subtotalRow('CC Group total incl. MTB', groupWithMtb, priorGroupWithMtb)}
                {hasPalestine && areaRow('Palestine', true, opAreas.length + (hasMtb ? 1 : 0))}
                {subtotalRow('Total', grandTotal, priorTotal, true)}
              </tbody>
            </table>
          </div>

          {/* group waterfall items (stored under area = Total) */}
          <div className="bp-group">
            <h2 className="bp-h2">Group items</h2>
            <p className="bp-group-hint">Cash-availability waterfall — stored under the “Total” row.</p>
            <div className="bp-group-fields">
              {GROUP_ACCOUNTS.map(account => {
                const key = cellKey(GROUP_AREA, account)
                const raw = groupItems[account]
                return (
                  <label key={account} className="bp-field">
                    <span>{account}</span>
                    <input
                      type="text"
                      inputMode="text"
                      className={cellNeg(key, raw) ? 'neg' : ''}
                      value={cellVal(key, raw)}
                      onFocus={() => setFocusKey(key)}
                      onBlur={() => setFocusKey(null)}
                      onChange={e => setGroup(account, e.target.value)}
                    />
                  </label>
                )
              })}
            </div>
          </div>

        </>
      )}

      {showNarrative && (
        <div className="bp-modal-backdrop" onClick={() => setShowNarrative(false)}>
          <div className="bp-modal" onClick={e => e.stopPropagation()}>
            <div className="bp-narrative-head">
              <h2 className="bp-h2">Narrative — {period ? fmtPeriodLabel(period) : ''}</h2>
              <div className="bp-list-tools">
                <button type="button" className="bp-tool bp-tool-b" onClick={() => wrapSel('**')} title="Bold">
                  B
                </button>
                <button type="button" className="bp-tool bp-tool-i" onClick={() => wrapSel('*')} title="Italic">
                  I
                </button>
                <button type="button" className="bp-tool bp-tool-u" onClick={() => wrapSel('__')} title="Underline">
                  U
                </button>
                <span className="bp-tool-sep" />
                <button type="button" className="bp-tool" onClick={() => applyList('bullet')} title="Bullet list">
                  • List
                </button>
                <button type="button" className="bp-tool" onClick={() => applyList('number')} title="Numbered list">
                  1. List
                </button>
              </div>
            </div>
            <textarea
              ref={taRef}
              value={narrative}
              onChange={e => {
                setNarrative(e.target.value)
                setDirty(true)
              }}
              placeholder="Cash position commentary for this month…"
              rows={16}
            />
            <div className="bp-modal-foot">
              <span className="bp-modal-hint">Changes save with the month’s Save button.</span>
              <button type="button" className="bp-btn bp-btn-primary" onClick={() => setShowNarrative(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
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
