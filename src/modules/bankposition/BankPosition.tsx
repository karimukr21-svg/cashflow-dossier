import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { supabase } from '@/lib/supabase'
import { useRole, canManageCashFlow } from '@/lib/role'
import {
  FIELDS, FIELD_GROUPS, FIELD_LABEL, BANK_SECTION,
  type Field, type BpEntity, type BpLine, type LineValues, type TreasuryRow, type AreaNode,
  num, fmtNum, zeroLine, ccNet, sumValues, areaValues,
  loadEntities, loadLines, loadTreasury, loadPeriods, indexLines, buildTree,
  fmtPeriodLabel, monthInputToPeriod, priorPeriod,
} from './lib'
import { buildReportHtml } from './printReport'
import './bankposition.css'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
type Status = { kind: 'ok' | 'err' | 'busy'; msg: string } | null
/** grid state: entity_id -> field -> raw input string */
type Grid = Record<string, Partial<Record<Field, string>>>

export default function BankPosition() {
  const role = useRole()
  const canManage = canManageCashFlow(role)

  const [entities, setEntities] = useState<BpEntity[]>([])
  const [periods, setPeriods] = useState<string[]>([])
  const [period, setPeriod] = useState('')
  const [draftPeriod, setDraftPeriod] = useState<string | null>(null)

  const [grid, setGrid] = useState<Grid>({})
  const origLines = useRef<Map<string, BpLine>>(new Map()) // entity_id -> stored row
  const [treasury, setTreasury] = useState<TreasuryRow[]>([])
  const treasuryOrig = useRef<TreasuryRow[]>([])
  const [priorVals, setPriorVals] = useState<Map<string, LineValues>>(new Map())

  const [narrative, setNarrative] = useState('')
  const narrativeOrig = useRef<{ id: number; content: string } | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)

  const [viewYear, setViewYear] = useState<number>(() => new Date().getUTCFullYear())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [showNarrative, setShowNarrative] = useState(false)
  const [showTreasury, setShowTreasury] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [newMonth, setNewMonth] = useState('')
  const [cloneFrom, setCloneFrom] = useState('')

  const [viewMode, setViewMode] = useState<'detail' | 'summary'>('detail')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleCollapse = (id: string) =>
    setCollapsed(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const tree = useMemo(() => buildTree(entities), [entities])
  const allPeriods = useMemo(
    () => (draftPeriod ? [draftPeriod, ...periods] : periods),
    [draftPeriod, periods],
  )
  const yearBounds = useMemo(() => {
    const ys = allPeriods.map(p => Number(p.slice(0, 4)))
    return ys.length ? { min: Math.min(...ys), max: Math.max(...ys) } : { min: viewYear, max: viewYear }
  }, [allPeriods, viewYear])

  useEffect(() => { if (period) setViewYear(Number(period.slice(0, 4))) }, [period])

  // ── boot: entities + period list ──────────────────────────────────
  useEffect(() => {
    Promise.all([loadEntities(), loadPeriods()])
      .then(([ents, pers]) => {
        setEntities(ents)
        setPeriods(pers)
        if (pers.length) setPeriod(pers[0])
        else setLoading(false)
      })
      .catch(e => { setStatus({ kind: 'err', msg: e.message }); setLoading(false) })
  }, [])

  const gridFromLines = useCallback((lines: BpLine[]) => {
    const g: Grid = {}
    const o = new Map<string, BpLine>()
    for (const l of lines) {
      o.set(l.entity_id, l)
      const row: Partial<Record<Field, string>> = {}
      for (const f of FIELDS) {
        const v = Number(l[f] ?? 0)
        if (v !== 0) row[f] = String(v)
      }
      g[l.entity_id] = row
    }
    origLines.current = o
    setGrid(g)
  }, [])

  const openPeriod = useCallback(async (p: string) => {
    setLoading(true); setStatus(null)
    try {
      const [lines, tre, prior, rem] = await Promise.all([
        loadLines(p), loadTreasury(p), loadLines(priorPeriod(p)),
        supabase.from('report_remarks').select('*').eq('period', p).eq('section', BANK_SECTION).maybeSingle(),
      ])
      gridFromLines(lines)
      setTreasury(tre)
      treasuryOrig.current = tre
      setPriorVals(indexLines(prior))
      setNarrative(rem.data?.content || '')
      narrativeOrig.current = rem.data ? { id: rem.data.id, content: rem.data.content } : null
      setDirty(false)
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e.message })
    } finally {
      setLoading(false)
    }
  }, [gridFromLines])

  useEffect(() => {
    if (!period || period === draftPeriod) { setLoading(false); return }
    openPeriod(period)
  }, [period, draftPeriod, openPeriod])

  function selectPeriod(p: string) {
    if (p === period) return
    if (dirty && !window.confirm('Discard unsaved changes to this month?')) return
    if (draftPeriod && p !== draftPeriod) setDraftPeriod(null)
    setPeriod(p)
  }

  // ── current parsed values per entity ──────────────────────────────
  const vals = useMemo(() => {
    const m = new Map<string, LineValues>()
    for (const [eid, row] of Object.entries(grid)) {
      const v = zeroLine()
      let any = false
      for (const f of FIELDS) { const n = num(row[f]); if (n != null) { v[f] = n; any = true } }
      if (any) m.set(eid, v)
    }
    return m
  }, [grid])

  // ── derived summary ───────────────────────────────────────────────
  const summary = useMemo(() => {
    const areaVals = tree.operating.map(node => ({ node, v: areaValues(node, vals) }))
    const operatingSum = sumValues(areaVals.map(a => a.v))
    const mtbV = (tree.mtb && vals.get(tree.mtb.id)) || zeroLine()
    const groupTotal = sumValues([operatingSum, mtbV]) // CC Group Total Actual incl MTB
    const palV = tree.memo.map(m => vals.get(m.id) || zeroLine())
    const palSum = sumValues(palV)
    const total = sumValues([groupTotal, palSum])
    // waterfall (ties to Rasha's file)
    const totalCash = groupTotal.cc_cash + groupTotal.jv_cash
    const jvMoney = groupTotal.jv_monies
    const moneyControl = totalCash - jvMoney
    const blocked = groupTotal.blocked
    const freeUsable = moneyControl - blocked
    return { areaVals, operatingSum, mtbV, groupTotal, palSum, total, totalCash, jvMoney, moneyControl, blocked, freeUsable }
  }, [tree, vals])

  // ── editing ───────────────────────────────────────────────────────
  function setCell(eid: string, f: Field, value: string) {
    setGrid(g => ({ ...g, [eid]: { ...(g[eid] || {}), [f]: value } }))
    setDirty(true)
  }
  const cellKey = (eid: string, f: Field) => `${eid}:${f}`
  const cellVal = (eid: string, f: Field) => {
    const raw = grid[eid]?.[f]
    if (focusKey === cellKey(eid, f)) return raw ?? ''
    const n = num(raw)
    return n == null ? '' : fmtNum(n)
  }
  const cellNeg = (eid: string, f: Field) => {
    if (focusKey === cellKey(eid, f)) return false
    const n = num(grid[eid]?.[f]); return n != null && n < 0
  }

  // ── save ──────────────────────────────────────────────────────────
  async function save() {
    if (!canManage || !period) return
    setSaving(true); setStatus({ kind: 'busy', msg: 'Saving…' })
    try {
      // editable entities: all bp_line entities present in the tree
      const editable = entities.filter(e => e.entity_type === 'bp_line')
      const upserts: any[] = []
      const deletes: string[] = []
      for (const e of editable) {
        const row = grid[e.id] || {}
        const v = zeroLine(); let any = false
        for (const f of FIELDS) { const n = num(row[f]); if (n != null) { v[f] = n; any = true } }
        const had = origLines.current.has(e.id)
        if (!any) { if (had) deletes.push(e.id); continue }
        upserts.push({ period, entity_id: e.id, ...v })
      }
      if (upserts.length) {
        const { error } = await supabase
          .from('bank_position_lines')
          .upsert(upserts, { onConflict: 'period,entity_id' })
        if (error) throw error
      }
      if (deletes.length) {
        const { error } = await supabase
          .from('bank_position_lines').delete().eq('period', period).in('entity_id', deletes)
        if (error) throw error
      }

      // treasury rows: replace-all for the period
      const { error: delErr } = await supabase.from('bank_position_treasury').delete().eq('period', period)
      if (delErr) throw delErr
      const trRows = treasury
        .filter(t => t.label.trim() && t.amount)
        .map((t, i) => ({ period, flow: t.flow, label: t.label.trim(), amount: Math.abs(t.amount), sort_order: i }))
      if (trRows.length) {
        const { error } = await supabase.from('bank_position_treasury').insert(trRows)
        if (error) throw error
      }

      // narrative
      const content = narrative.trim()
      const no = narrativeOrig.current
      if (no && content !== no.content) {
        const { error } = await supabase.from('report_remarks').update({ content }).eq('id', no.id)
        if (error) throw error
      } else if (!no && content) {
        const { error } = await supabase.from('report_remarks').insert({ period, section: BANK_SECTION, content })
        if (error) throw error
      }

      if (period === draftPeriod) {
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

  // ── new month (clone prior detail as starting point) ──────────────
  function openNewMonth() { setCloneFrom(periods[0] || ''); setNewMonth(''); setShowNew(true) }
  async function createNewMonth() {
    const p = monthInputToPeriod(newMonth)
    if (!newMonth) { setStatus({ kind: 'err', msg: 'Pick a month.' }); return }
    if (periods.includes(p)) { setStatus({ kind: 'err', msg: `${fmtPeriodLabel(p)} already exists.` }); return }
    if (cloneFrom) {
      const lines = await loadLines(cloneFrom)
      const g: Grid = {}
      for (const l of lines) {
        const row: Partial<Record<Field, string>> = {}
        for (const f of FIELDS) { const v = Number(l[f] ?? 0); if (v !== 0) row[f] = String(v) }
        g[l.entity_id] = row
      }
      setGrid(g)
      const prior = await loadLines(cloneFrom)
      setPriorVals(indexLines(prior))
    } else { setGrid({}); setPriorVals(new Map()) }
    origLines.current = new Map()
    setTreasury([]); treasuryOrig.current = []
    setNarrative(''); narrativeOrig.current = null
    setDraftPeriod(p); setPeriod(p); setShowNew(false); setDirty(true)
    setStatus({ kind: 'ok', msg: `Started ${fmtPeriodLabel(p)} from ${fmtPeriodLabel(cloneFrom)} — edit, then Save.` })
  }

  // ── print ─────────────────────────────────────────────────────────
  async function printReport() {
    const w = window.open('', '_blank', 'width=1000,height=1200')
    if (!w) { setStatus({ kind: 'err', msg: 'Allow pop-ups to print the report.' }); return }
    w.document.write('<!doctype html><title>Preparing…</title><body style="font-family:system-ui;padding:40px;color:#666">Preparing report…</body>')
    // 12-month trend of CC Net and (OD+Loans incl MTB), with the MTB portion
    const { data } = await supabase.from('bank_position_lines').select('period,entity_id,cc_cash,cc_overdraft,cc_loans')
    const mtbId = tree.mtb?.id
    const byP = new Map<string, { cash: number; debt: number; mtb: number }>()
    for (const r of (data || []) as any[]) {
      const e = byP.get(r.period) || { cash: 0, debt: 0, mtb: 0 }
      e.cash += Number(r.cc_cash || 0)
      e.debt += Number(r.cc_overdraft || 0) + Number(r.cc_loans || 0)
      if (mtbId && r.entity_id === mtbId) e.mtb += Number(r.cc_loans || 0)
      byP.set(r.period, e)
    }
    // reflect unsaved current month
    byP.set(period, {
      cash: summary.groupTotal.cc_cash,
      debt: summary.groupTotal.cc_overdraft + summary.groupTotal.cc_loans,
      mtb: summary.mtbV.cc_loans,
    })
    const series = Array.from(byP.entries()).map(([p, v]) => ({ period: p, ...v })).sort((a, b) => a.period.localeCompare(b.period)).slice(-12)
    const html = buildReportHtml({
      period, tree, vals, summary,
      cashSeries: series.map(s => ({ period: s.period, val: s.cash })),
      debtSeries: series.map(s => ({ period: s.period, val: s.debt, mtb: s.mtb })),
      treasury, narrative,
      priorVals,
      generatedAt: new Date().toLocaleString('en-GB'),
      logoUrl: window.location.origin + '/ccc-logo.png',
    })
    w.document.open(); w.document.write(html); w.document.close()
  }

  // narrative helpers
  function wrapSel(mark: string) {
    const ta = taRef.current; if (!ta) return
    const { selectionStart: s, selectionEnd: e, value } = ta
    const sel = value.slice(s, e) || 'text'
    setNarrative(value.slice(0, s) + mark + sel + mark + value.slice(e)); setDirty(true)
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(s + mark.length, s + mark.length + sel.length) })
  }
  function applyList(kind: 'bullet' | 'number') {
    const ta = taRef.current; if (!ta) return
    const value = ta.value
    const start = value.lastIndexOf('\n', ta.selectionStart - 1) + 1
    let end = value.indexOf('\n', ta.selectionEnd); if (end === -1) end = value.length
    let n = 0
    const t = value.slice(start, end).split('\n').map(ln => {
      const s = ln.replace(/^(\s*)([-*•]\s+|\d+[.)]\s+)?/, '$1')
      if (s.trim() === '') return ln
      n += 1; return kind === 'bullet' ? `- ${s.trimStart()}` : `${n}. ${s.trimStart()}`
    }).join('\n')
    setNarrative(value.slice(0, start) + t + value.slice(end)); setDirty(true)
  }

  if (!canManage) {
    return (
      <div className="bp-gate"><div className="bp-gate-card">
        <h1>Bank Position</h1>
        <p>Managing the group cash position needs the Treasury or admin role.</p>
      </div></div>
    )
  }

  // ── grid geometry + arrow-key navigation ──────────────────────────
  // First field of each column group → gets a left separator border.
  const GRP_START = new Set<Field>(FIELD_GROUPS.map(g => g.fields[0]))
  const colClass = (f: Field) => (GRP_START.has(f) ? 'grp-start' : '')

  // editable rows in visual order (respects collapse + view mode) — indexes arrow nav
  const editOrder: string[] = []
  if (viewMode === 'detail') {
    for (const { node } of summary.areaVals) {
      if (node.children.length === 0) editOrder.push(node.entity.id)
      else if (!collapsed.has(node.entity.id)) for (const c of node.children) editOrder.push(c.id)
    }
    if (tree.mtb) editOrder.push(tree.mtb.id)
    for (const m of tree.memo) editOrder.push(m.id)
  }
  const editIndex = new Map(editOrder.map((id, i) => [id, i]))
  const nRows = editOrder.length
  const nCols = FIELDS.length

  const focusCell = (r: number, c: number) => {
    const el = document.getElementById(`bpc-${r}-${c}`) as HTMLInputElement | null
    if (el) { el.focus(); el.select() }
  }
  const onCellKey = (e: KeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    const el = e.currentTarget
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length
    if (e.key === 'ArrowUp') { e.preventDefault(); if (r > 0) focusCell(r - 1, c) }
    else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); if (r < nRows - 1) focusCell(r + 1, c) }
    else if (e.key === 'ArrowLeft' && atStart) { e.preventDefault(); if (c > 0) focusCell(r, c - 1); else if (r > 0) focusCell(r - 1, nCols - 1) }
    else if (e.key === 'ArrowRight' && atEnd) { e.preventDefault(); if (c < nCols - 1) focusCell(r, c + 1); else if (r < nRows - 1) focusCell(r + 1, 0) }
  }

  // CC-net change vs prior month, rolled over an area's lines (for summary rows)
  const rolledPriorNet = (node: AreaNode): number | null => {
    const parts: LineValues[] = []
    const own = priorVals.get(node.entity.id); if (own) parts.push(own)
    for (const c of node.children) { const cv = priorVals.get(c.id); if (cv) parts.push(cv) }
    if (!parts.length) return null
    return parts.reduce((a, p) => a + ccNet(p), 0)
  }
  const priorNetOf = (eid: string) => { const p = priorVals.get(eid); return p ? ccNet(p) : null }

  // ── render helpers ────────────────────────────────────────────────
  const inputCell = (eid: string, f: Field, r: number, c: number) => (
    <td key={f} className={`bp-cell ${colClass(f)}`}>
      <input
        id={`bpc-${r}-${c}`}
        type="text" inputMode="text"
        className={cellNeg(eid, f) ? 'neg' : ''}
        value={cellVal(eid, f)}
        onFocus={() => setFocusKey(cellKey(eid, f))}
        onBlur={() => setFocusKey(null)}
        onChange={e => setCell(eid, f, e.target.value)}
        onKeyDown={e => onCellKey(e, r, c)}
      />
    </td>
  )

  // an editable detail row (detail view)
  const editableRow = (e: BpEntity, rowIdx: number, opts: { indent?: boolean; special?: string } = {}) => {
    const v = vals.get(e.id) || zeroLine()
    const net = ccNet(v)
    const delta = priorNetOf(e.id) == null ? null : net - (priorNetOf(e.id) as number)
    return (
      <tr key={e.id} className={`bp-line-row ${opts.indent ? 'bp-child' : ''} ${opts.special || ''}`}>
        <td className={`label ${opts.indent ? 'indent' : ''}`}>{e.name}</td>
        {FIELDS.map((f, ci) => inputCell(e.id, f, rowIdx, ci))}
        <td className={`bp-num bp-netcol ${net < 0 ? 'neg' : ''}`}>{fmtNum(net)}</td>
        <td className={`bp-num bp-delta ${delta == null ? '' : delta < 0 ? 'neg' : ''}`}>
          {delta == null ? '—' : (delta > 0 ? '+' : '') + fmtNum(delta)}
        </td>
      </tr>
    )
  }

  // a read-only rolled row (summary view)
  const summaryRow = (name: string, v: LineValues, delta: number | null, opts: { special?: string } = {}) => (
    <tr key={name} className={`bp-line-row bp-readonly ${opts.special || ''}`}>
      <td className="label">{name}</td>
      {FIELDS.map(f => <td key={f} className={`bp-num ${colClass(f)} ${v[f] < 0 ? 'neg' : ''}`}>{v[f] ? fmtNum(v[f]) : ''}</td>)}
      <td className={`bp-num bp-netcol ${ccNet(v) < 0 ? 'neg' : ''}`}>{fmtNum(ccNet(v))}</td>
      <td className={`bp-num bp-delta ${delta == null ? '' : delta < 0 ? 'neg' : ''}`}>
        {delta == null ? '—' : (delta > 0 ? '+' : '') + fmtNum(delta)}
      </td>
    </tr>
  )

  // a subtotal row — optional collapse twisty (groupings) and strong styling (grand totals)
  const subtotalRow = (
    label: string, v: LineValues,
    opts: { strong?: boolean; collapse?: { id: string; isOpen: boolean } } = {},
  ) => (
    <tr className={`bp-subtotal ${opts.strong ? 'bp-subtotal-strong' : ''} ${opts.collapse ? 'bp-grouphead-row' : ''}`}>
      <td className="label">
        {opts.collapse && (
          <button type="button" className="bp-twisty" onClick={() => toggleCollapse(opts.collapse!.id)}
            aria-label={opts.collapse.isOpen ? 'Collapse' : 'Expand'}>
            <svg viewBox="0 0 24 24" className={opts.collapse.isOpen ? 'open' : ''} aria-hidden="true">
              <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth={2} />
            </svg>
          </button>
        )}
        {label}
      </td>
      {FIELDS.map(f => <td key={f} className={`bp-num ${colClass(f)} ${v[f] < 0 ? 'neg' : ''}`}>{v[f] ? fmtNum(v[f]) : ''}</td>)}
      <td className={`bp-num bp-netcol ${ccNet(v) < 0 ? 'neg' : ''}`}>{fmtNum(ccNet(v))}</td>
      <td className="bp-num" />
    </tr>
  )

  const card = (label: string, value: number | null, g: '' | 'build' | 'group' | 'free' = '', variant: '' | 'total' | 'free' = '') => (
    <div className={`bp-card ${variant ? `bp-card-${variant}` : ''} ${g ? `bp-card-g-${g}` : ''}`}>
      <span className="bp-card-label">{label}</span>
      <span className={`bp-card-val ${value != null && value < 0 ? 'neg' : ''}`}>{fmtNum(value)}</span>
    </div>
  )

  return (
    <div className="bp-root">
      <header className="bp-head">
        <div className="bp-months-row">
          <div className="bp-yearnav">
            <button className="bp-yearbtn" onClick={() => setViewYear(y => y - 1)} disabled={viewYear <= yearBounds.min} aria-label="Previous year">‹</button>
            <span className="bp-year">{viewYear}</span>
            <button className="bp-yearbtn" onClick={() => setViewYear(y => y + 1)} disabled={viewYear >= yearBounds.max} aria-label="Next year">›</button>
          </div>
          <div className="bp-months">
            {MONTH_ABBR.map((label, i) => {
              const p = `${viewYear}-${String(i + 1).padStart(2, '0')}-01`
              const available = allPeriods.includes(p)
              return (
                <button key={label}
                  className={`bp-month ${p === period ? 'is-selected' : ''} ${p === draftPeriod ? 'is-draft' : ''}`}
                  onClick={() => selectPeriod(p)} disabled={!available || saving}
                  title={available ? '' : 'No data — use New month'}>{label}</button>
              )
            })}
          </div>
        </div>
        <div className="bp-head-controls">
          <div className="bp-seg" role="tablist" aria-label="View">
            <button className={`bp-seg-btn ${viewMode === 'summary' ? 'is-active' : ''}`} onClick={() => setViewMode('summary')}>Summary</button>
            <button className={`bp-seg-btn ${viewMode === 'detail' ? 'is-active' : ''}`} onClick={() => setViewMode('detail')}>Detailed</button>
          </div>
          <button className="bp-btn" onClick={openNewMonth} disabled={saving}>New month</button>
          <button className="bp-btn" onClick={() => setShowTreasury(true)} disabled={!period}>Treasury details</button>
          <button className="bp-btn" onClick={printReport} disabled={saving || !period}>Print report</button>
          <button className="bp-btn" onClick={() => setShowNarrative(true)} disabled={!period}>Narrative</button>
          <button className="bp-btn bp-btn-primary" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </header>

      {status && <div className={`bp-status bp-status-${status.kind}`}>{status.msg}</div>}

      {showNew && (
        <div className="bp-newmonth">
          <div className="bp-field"><span>New month</span><input type="month" value={newMonth} onChange={e => setNewMonth(e.target.value)} /></div>
          <div className="bp-field"><span>Clone from</span>
            <select value={cloneFrom} onChange={e => setCloneFrom(e.target.value)}>
              <option value="">— blank —</option>
              {periods.map(p => <option key={p} value={p}>{fmtPeriodLabel(p)}</option>)}
            </select>
          </div>
          <button className="bp-btn bp-btn-primary" onClick={createNewMonth}>Create</button>
          <button className="bp-btn" onClick={() => setShowNew(false)}>Cancel</button>
        </div>
      )}

      {loading ? <div className="bp-loading">Loading…</div> : (
        <>
          <div className="bp-cards">
            {card('Cash', summary.operatingSum.cc_cash, 'build')}
            {card('Overdraft', summary.operatingSum.cc_overdraft, 'build')}
            {card('Loans (excl MTB)', summary.operatingSum.cc_loans, 'build')}
            {card('MTB Loans', summary.mtbV.cc_loans, 'build')}
            {card('CC Group Total Actual', ccNet(summary.groupTotal), 'build', 'total')}
            <span className="bp-card-div" />
            {card('Palestine', ccNet(summary.palSum), 'group')}
            {card('Total', ccNet(summary.total), 'group', 'total')}
            <span className="bp-card-div" />
            {card('JV Money', summary.jvMoney, 'free')}
            {card('Money under CCC control', summary.moneyControl, 'free', 'free')}
            {card('Blocked Cash', summary.blocked, 'free')}
            {card("CCC's Free Usable Cash", summary.freeUsable, 'free', 'free')}
          </div>

          {viewMode === 'detail' && (
            <div className="bp-grid-actions">
              <button className="bp-link-btn" onClick={() => {
                const grpIds = summary.areaVals.filter(a => a.node.children.length > 0).map(a => a.node.entity.id)
                setCollapsed(s => (s.size >= grpIds.length ? new Set() : new Set(grpIds)))
              }}>
                {(() => { const g = summary.areaVals.filter(a => a.node.children.length > 0).length; return collapsed.size >= g && g > 0 ? 'Expand all' : 'Collapse all' })()}
              </button>
            </div>
          )}

          <div className="bp-gridwrap">
            <table className={`bp-table bp-wide ${viewMode === 'summary' ? 'bp-summary-mode' : ''}`}>
              <thead>
                <tr className="bp-grouphead">
                  <th className="label" rowSpan={2}>Area</th>
                  {FIELD_GROUPS.map(g => <th key={g.label} colSpan={g.fields.length} className="bp-grp">{g.label}</th>)}
                  <th rowSpan={2} className="grp-start">CC Net</th>
                  <th rowSpan={2} title="CC Net change vs prior month">Δ MoM</th>
                </tr>
                <tr className="bp-fieldhead">
                  {FIELDS.map(f => <th key={f} className={GRP_START.has(f) ? 'grp-start' : ''}>{FIELD_LABEL[f]}</th>)}
                </tr>
              </thead>
              <tbody>
                {viewMode === 'summary'
                  ? (
                    <>
                      {summary.areaVals.map(({ node, v }) => summaryRow(node.entity.name, v, rolledPriorNet(node)))}
                      {tree.mtb && summaryRow('MTB', summary.mtbV, priorNetOf(tree.mtb.id), { special: 'bp-special' })}
                      {subtotalRow('CC Group Total Actual', summary.groupTotal, { strong: true })}
                      {tree.memo.map(m => summaryRow(m.name, vals.get(m.id) || zeroLine(), priorNetOf(m.id), { special: 'bp-special' }))}
                      {subtotalRow('Total (incl. Palestine)', summary.total, { strong: true })}
                    </>
                  )
                  : (
                    <>
                      {summary.areaVals.map(({ node, v }) =>
                        node.children.length === 0
                          ? editableRow(node.entity, editIndex.get(node.entity.id) ?? 0)
                          : (
                            <Fragment key={node.entity.id}>
                              {subtotalRow(node.entity.name, v, { collapse: { id: node.entity.id, isOpen: !collapsed.has(node.entity.id) } })}
                              {!collapsed.has(node.entity.id) && node.children.map(c => editableRow(c, editIndex.get(c.id) ?? 0, { indent: true }))}
                            </Fragment>
                          ),
                      )}
                      {tree.mtb && editableRow(tree.mtb, editIndex.get(tree.mtb.id) ?? 0, { special: 'bp-special' })}
                      {subtotalRow('CC Group Total Actual', summary.groupTotal, { strong: true })}
                      {tree.memo.map(m => editableRow(m, editIndex.get(m.id) ?? 0, { special: 'bp-special' }))}
                      {subtotalRow('Total (incl. Palestine)', summary.total, { strong: true })}
                    </>
                  )}
              </tbody>
            </table>
          </div>
          <p className="bp-foot-note">
            {viewMode === 'detail'
              ? 'Detailed grain — sub-area lines roll up to their grouping (collapse a grouping to focus). Arrow keys move between cells. OD & Loans entered negative. MTB shown separately, included in the group total.'
              : 'Summary view — read-only rollup. Switch to Detailed to edit the sub-area lines. Grouping is managed in Areas & Projects.'}
          </p>
        </>
      )}

      {showTreasury && (
        <TreasuryModal
          rows={treasury}
          onChange={r => { setTreasury(r); setDirty(true) }}
          onClose={() => setShowTreasury(false)}
          period={period}
        />
      )}

      {showNarrative && (
        <div className="bp-modal-backdrop" onClick={() => setShowNarrative(false)}>
          <div className="bp-modal" onClick={e => e.stopPropagation()}>
            <div className="bp-narrative-head">
              <h2 className="bp-h2">Narrative — {period ? fmtPeriodLabel(period) : ''}</h2>
              <div className="bp-list-tools">
                <button type="button" className="bp-tool bp-tool-b" onClick={() => wrapSel('**')} title="Bold">B</button>
                <button type="button" className="bp-tool bp-tool-i" onClick={() => wrapSel('*')} title="Italic">I</button>
                <button type="button" className="bp-tool bp-tool-u" onClick={() => wrapSel('__')} title="Underline">U</button>
                <span className="bp-tool-sep" />
                <button type="button" className="bp-tool" onClick={() => applyList('bullet')}>• List</button>
                <button type="button" className="bp-tool" onClick={() => applyList('number')}>1. List</button>
              </div>
            </div>
            <textarea ref={taRef} value={narrative}
              onChange={e => { setNarrative(e.target.value); setDirty(true) }}
              placeholder="Cash position commentary for this month…" rows={16} />
            <div className="bp-modal-foot">
              <span className="bp-modal-hint">Changes save with the month's Save button.</span>
              <button type="button" className="bp-btn bp-btn-primary" onClick={() => setShowNarrative(false)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Treasury details editor ───────────────────────────────────────────
function TreasuryModal({ rows, onChange, onClose, period }: {
  rows: TreasuryRow[]; onChange: (r: TreasuryRow[]) => void; onClose: () => void; period: string
}) {
  const receipts = rows.filter(r => r.flow === 'receipt')
  const payments = rows.filter(r => r.flow === 'payment')
  const update = (flow: 'receipt' | 'payment', list: TreasuryRow[]) =>
    onChange([...rows.filter(r => r.flow !== flow), ...list])
  const totReceipts = receipts.reduce((s, r) => s + (r.amount || 0), 0)
  const totPayments = payments.reduce((s, r) => s + (r.amount || 0), 0)

  const column = (flow: 'receipt' | 'payment', list: TreasuryRow[]) => (
    <div className="bp-tre-col">
      <h3>{flow === 'receipt' ? 'Receipts' : 'Payments'}</h3>
      {list.map((r, i) => (
        <div className="bp-tre-row" key={i}>
          <input className="bp-tre-label" value={r.label} placeholder="Source"
            onChange={e => { const l = [...list]; l[i] = { ...r, label: e.target.value }; update(flow, l) }} />
          <input className="bp-tre-amt" inputMode="decimal" value={r.amount || ''}
            onChange={e => { const l = [...list]; l[i] = { ...r, amount: Number(e.target.value) || 0 }; update(flow, l) }} />
          <button className="bp-tre-del" onClick={() => update(flow, list.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="bp-btn bp-tre-add"
        onClick={() => update(flow, [...list, { period, flow, label: '', amount: 0, sort_order: list.length }])}>+ Add {flow}</button>
      <div className="bp-tre-total">Total {flow === 'receipt' ? 'in' : 'out'}: {fmtNum(flow === 'receipt' ? totReceipts : -totPayments)}</div>
    </div>
  )

  return (
    <div className="bp-modal-backdrop" onClick={onClose}>
      <div className="bp-modal bp-modal-wide" onClick={e => e.stopPropagation()}>
        <div className="bp-narrative-head">
          <h2 className="bp-h2">Treasury details — {fmtPeriodLabel(period)}</h2>
        </div>
        <div className="bp-tre-grid">{column('receipt', receipts)}{column('payment', payments)}</div>
        <div className="bp-modal-foot">
          <span className="bp-modal-hint">Net movement {fmtNum(totReceipts - totPayments)} — saves with the month's Save button.</span>
          <button className="bp-btn bp-btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
