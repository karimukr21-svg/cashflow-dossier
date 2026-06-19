import { useEffect, useMemo, useState } from 'react'
import { useRole, canManageCashFlow } from '@/lib/role'
import {
  loadLedger,
  createInflow, updateInflow, deleteInflow,
  createObligation, updateObligation, deleteObligation,
  upsertAllocation, deleteAllocation,
  createPayment, deletePayment,
  deriveInflow, deriveObligation, computeTotals,
  inRange, usd, money, fmtDate,
  labelSourceType, labelCategory,
  SOURCE_TYPES, OBLIGATION_CATEGORIES, CURRENCIES,
  type LedgerData, type PeriodRange,
  type Inflow, type Obligation, type Allocation,
  type InflowInput, type ObligationInput, type PaymentInput,
  type SourceType, type ObligationCategory, type InflowStatus,
} from './lib'
import { openSourceUseReport, openInflowReport, openObligationReport } from './printReport'
import './allocations.css'

type Tab = 'dashboard' | 'inflows' | 'obligations'
type Status = { kind: 'ok' | 'err'; msg: string } | null
const EMPTY: LedgerData = { inflows: [], obligations: [], allocations: [], payments: [] }

export default function Allocations() {
  const role = useRole()
  const canEdit = canManageCashFlow(role)

  const [data, setData] = useState<LedgerData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<Status>(null)
  const [tab, setTab] = useState<Tab>('dashboard')
  const [range, setRange] = useState<PeriodRange>({ from: null, to: null })

  // modals
  const [inflowForm, setInflowForm] = useState<{ open: boolean; edit?: Inflow }>({ open: false })
  const [oblForm, setOblForm] = useState<{ open: boolean; edit?: Obligation }>({ open: false })
  const [allocFor, setAllocFor] = useState<{ kind: 'inflow'; row: Inflow } | { kind: 'obligation'; row: Obligation } | null>(null)
  const [payFor, setPayFor] = useState<Obligation | null>(null)

  function flash(kind: 'ok' | 'err', msg: string) {
    setStatus({ kind, msg })
    if (kind === 'ok') setTimeout(() => setStatus(s => (s?.msg === msg ? null : s)), 2200)
  }

  async function refresh() {
    try {
      setData(await loadLedger())
    } catch (e) {
      flash('err', (e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void refresh() }, [])

  // run a mutation then refresh, with toast on error
  async function run(fn: () => Promise<void>, okMsg?: string) {
    try {
      await fn()
      await refresh()
      if (okMsg) flash('ok', okMsg)
    } catch (e) {
      flash('err', (e as Error).message)
    }
  }

  // ── period-filtered slice ─────────────────────────────────────────
  const view = useMemo<LedgerData>(() => {
    const inflows = data.inflows.filter(i => inRange(i.dated, range))
    const obligations = data.obligations.filter(o => inRange(o.due_date, range))
    const inIds = new Set(inflows.map(i => i.id))
    const obIds = new Set(obligations.map(o => o.id))
    // an allocation is in scope if either endpoint is in scope
    const allocations = data.allocations.filter(a => inIds.has(a.inflow_id) || obIds.has(a.obligation_id))
    const payments = data.payments.filter(p => obIds.has(p.obligation_id))
    return { inflows, obligations, allocations, payments }
  }, [data, range])

  // derived maps (computed against FULL data so balances are always correct,
  // even when an allocation's far endpoint sits outside the period)
  const inflowDer = useMemo(
    () => new Map(data.inflows.map(i => [i.id, deriveInflow(i, data.allocations)])),
    [data],
  )
  const oblDer = useMemo(
    () => new Map(data.obligations.map(o => [o.id, deriveObligation(o, data.allocations, data.payments)])),
    [data],
  )
  const inflowById = useMemo(() => new Map(data.inflows.map(i => [i.id, i])), [data])
  const oblById = useMemo(() => new Map(data.obligations.map(o => [o.id, o])), [data])
  const totals = useMemo(() => computeTotals(view), [view])

  if (loading) return <div className="al-loading">Loading…</div>

  return (
    <div className="al-shell">
      {status && <div className={`al-toast ${status.kind}`}>{status.msg}</div>}

      <div className="al-topbar">
        <nav className="al-tabs">
          {(['dashboard', 'inflows', 'obligations'] as Tab[]).map(t => (
            <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'dashboard' ? 'Dashboard' : t === 'inflows' ? 'Inflows' : 'Obligations'}
            </button>
          ))}
        </nav>
        <PeriodBar range={range} onChange={setRange} />
      </div>

      {tab === 'dashboard' && (
        <Dashboard
          view={view} totals={totals} inflowDer={inflowDer} oblDer={oblDer}
          oblById={oblById} inflowById={inflowById} range={range}
        />
      )}

      {tab === 'inflows' && (
        <InflowsTab
          view={view} inflowDer={inflowDer} canEdit={canEdit}
          onAdd={() => setInflowForm({ open: true })}
          onEdit={row => setInflowForm({ open: true, edit: row })}
          onDelete={row => { if (confirm(`Delete inflow "${row.source_name}" and its allocations?`)) void run(() => deleteInflow(row.id), 'Inflow deleted') }}
          onAllocate={row => setAllocFor({ kind: 'inflow', row })}
        />
      )}

      {tab === 'obligations' && (
        <ObligationsTab
          view={view} oblDer={oblDer} canEdit={canEdit}
          onAdd={() => setOblForm({ open: true })}
          onEdit={row => setOblForm({ open: true, edit: row })}
          onDelete={row => { if (confirm(`Delete obligation "${row.description}" and its allocations/payments?`)) void run(() => deleteObligation(row.id), 'Obligation deleted') }}
          onAllocate={row => setAllocFor({ kind: 'obligation', row })}
          onPay={row => setPayFor(row)}
        />
      )}

      {/* ── modals ───────────────────────────────────────────────── */}
      {inflowForm.open && (
        <InflowForm
          edit={inflowForm.edit}
          onClose={() => setInflowForm({ open: false })}
          onSave={async (input, id) => {
            await run(() => (id ? updateInflow(id, input) : createInflow(input)), id ? 'Inflow updated' : 'Inflow added')
            setInflowForm({ open: false })
          }}
        />
      )}
      {oblForm.open && (
        <ObligationForm
          edit={oblForm.edit}
          onClose={() => setOblForm({ open: false })}
          onSave={async (input, id) => {
            await run(() => (id ? updateObligation(id, input) : createObligation(input)), id ? 'Obligation updated' : 'Obligation added')
            setOblForm({ open: false })
          }}
        />
      )}
      {allocFor && (
        <AllocateModal
          anchor={allocFor}
          data={data}
          inflowDer={inflowDer}
          oblDer={oblDer}
          onClose={() => setAllocFor(null)}
          onSet={(inflow_id, obligation_id, amount_usd) =>
            run(() => upsertAllocation({ inflow_id, obligation_id, amount_usd }))}
          onRemove={(id) => run(() => deleteAllocation(id))}
        />
      )}
      {payFor && (
        <PaymentForm
          obligation={payFor}
          outstanding={oblDer.get(payFor.id)?.unpaid ?? payFor.amount_usd}
          onClose={() => setPayFor(null)}
          onSave={async (input) => {
            await run(() => createPayment(input), 'Payment recorded')
            setPayFor(null)
          }}
          onDeletePayment={(id) => run(() => deletePayment(id), 'Payment removed')}
          payments={data.payments.filter(p => p.obligation_id === payFor.id)}
        />
      )}
    </div>
  )
}

/* ================================================================== *
 * Period filter
 * ================================================================== */
function PeriodBar({ range, onChange }: { range: PeriodRange; onChange: (r: PeriodRange) => void }) {
  const fromM = range.from ? range.from.slice(0, 7) : ''
  const toM = range.to ? range.to.slice(0, 7) : ''
  const set = (which: 'from' | 'to', m: string) => {
    if (!m) { onChange({ ...range, [which]: null }); return }
    onChange({ ...range, [which]: which === 'from' ? `${m}-01` : `${m}-31` })
  }
  const active = range.from || range.to
  return (
    <div className="al-period">
      <span className="al-period-lbl">Period</span>
      <input type="month" value={fromM} onChange={e => set('from', e.target.value)} aria-label="From month" />
      <span className="al-period-dash">→</span>
      <input type="month" value={toM} onChange={e => set('to', e.target.value)} aria-label="To month" />
      {active && <button type="button" className="al-period-clear" onClick={() => onChange({ from: null, to: null })}>All time</button>}
    </div>
  )
}

/* ================================================================== *
 * Dashboard — tiles + source-of-funds + use-of-funds
 * ================================================================== */
function Dashboard({
  view, totals, inflowDer, oblDer, oblById, inflowById, range,
}: {
  view: LedgerData
  totals: ReturnType<typeof computeTotals>
  inflowDer: Map<string, ReturnType<typeof deriveInflow>>
  oblDer: Map<string, ReturnType<typeof deriveObligation>>
  oblById: Map<string, Obligation>
  inflowById: Map<string, Inflow>
  range: PeriodRange
}) {
  const tiles: { label: string; value: number; lead?: boolean; warn?: boolean }[] = [
    { label: 'Total in', value: totals.totalIn, lead: true },
    { label: 'Total obligations', value: totals.totalObligations },
    { label: 'Allocated', value: totals.allocated },
    { label: 'Unallocated cash', value: totals.unallocatedCash, warn: totals.unallocatedCash > 0.005 },
    { label: 'Unfunded obligations', value: totals.unfunded, warn: totals.unfunded > 0.005 },
    { label: 'Paid', value: totals.totalPaid },
  ]

  return (
    <div className="al-dash">
      <div className="al-tiles">
        {tiles.map(t => (
          <div key={t.label} className={`al-tile ${t.lead ? 'lead' : ''} ${t.warn ? 'warn' : ''}`}>
            <span className="al-tile-l">{t.label}</span>
            <span className="al-tile-v">{usd(t.value)}</span>
          </div>
        ))}
      </div>

      <div className="al-readouts">
        <section className="al-readout">
          <header>
            <h3>Source of funds</h3>
            <button type="button" className="al-print" onClick={() => openSourceUseReport(view, range)}>Print statement</button>
          </header>
          <p className="al-readout-sub">Each inflow → what it funded, and what's still unallocated.</p>
          {view.inflows.length === 0 && <div className="al-empty">No inflows in range.</div>}
          {view.inflows.map(inf => {
            const der = inflowDer.get(inf.id)!
            const links = view.allocations.filter(a => a.inflow_id === inf.id)
            return (
              <div key={inf.id} className="al-trace">
                <div className="al-trace-head">
                  <div className="al-trace-title">
                    <span className="al-chip src">{labelSourceType(inf.source_type)}</span>
                    <strong>{inf.source_name}</strong>
                    <span className="al-trace-meta">{fmtDate(inf.dated)} · {money(inf.amount_native, inf.currency)}</span>
                  </div>
                  <div className="al-trace-fig">
                    <span>{usd(inf.amount_usd)}</span>
                    <button type="button" className="al-mini-print" title="Print this inflow" onClick={() => openInflowReport(inf, view)}>⎙</button>
                  </div>
                </div>
                <div className="al-trace-rows">
                  {links.map(l => {
                    const o = oblById.get(l.obligation_id)
                    return (
                      <div key={l.id} className="al-trace-row">
                        <span className="al-arrow">→</span>
                        <span className="al-trace-to">{o ? o.description : '(obligation outside range)'}</span>
                        <span className="al-trace-amt">{usd(l.amount_usd)}</span>
                      </div>
                    )
                  })}
                  <div className="al-trace-row residual">
                    <span className="al-arrow">•</span>
                    <span className="al-trace-to">Unallocated</span>
                    <span className={`al-trace-amt ${der.unallocated > 0.005 ? 'warn' : ''}`}>{usd(der.unallocated)}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </section>

        <section className="al-readout">
          <header>
            <h3>Use of funds</h3>
          </header>
          <p className="al-readout-sub">Each obligation → which inflows funded it, and what's still outstanding.</p>
          {view.obligations.length === 0 && <div className="al-empty">No obligations in range.</div>}
          {view.obligations.map(o => {
            const der = oblDer.get(o.id)!
            const links = view.allocations.filter(a => a.obligation_id === o.id)
            return (
              <div key={o.id} className="al-trace">
                <div className="al-trace-head">
                  <div className="al-trace-title">
                    <span className="al-chip cat">{labelCategory(o.category)}</span>
                    <strong>{o.description}</strong>
                    <span className="al-trace-meta">{fmtDate(o.due_date)} · {money(o.amount_native, o.currency)}</span>
                  </div>
                  <div className="al-trace-fig">
                    <span>{usd(o.amount_usd)}</span>
                    <button type="button" className="al-mini-print" title="Print this obligation" onClick={() => openObligationReport(o, view)}>⎙</button>
                  </div>
                </div>
                <div className="al-trace-rows">
                  {links.map(l => {
                    const inf = inflowById.get(l.inflow_id)
                    return (
                      <div key={l.id} className="al-trace-row">
                        <span className="al-arrow">←</span>
                        <span className="al-trace-to">{inf ? inf.source_name : '(inflow outside range)'}</span>
                        <span className="al-trace-amt">{usd(l.amount_usd)}</span>
                      </div>
                    )
                  })}
                  <div className="al-trace-row residual">
                    <span className="al-arrow">•</span>
                    <span className="al-trace-to">Outstanding (unfunded)</span>
                    <span className={`al-trace-amt ${der.outstanding > 0.005 ? 'warn' : ''}`}>{usd(der.outstanding)}</span>
                  </div>
                  <div className="al-trace-row residual">
                    <span className="al-arrow">•</span>
                    <span className="al-trace-to">Paid / unpaid</span>
                    <span className="al-trace-amt">{usd(der.paid)} / {usd(der.unpaid)}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </section>
      </div>
    </div>
  )
}

/* ── sortable header cell ───────────────────────────────────────── */
type SortState = { key: string; dir: 'asc' | 'desc' }
function SortTh({ label, k, sort, setSort, cls }: { label: string; k: string; sort: SortState; setSort: (s: SortState) => void; cls?: string }) {
  const active = sort.key === k
  return (
    <th
      className={`${cls ?? ''} sortable`}
      onClick={() => setSort(active ? { key: k, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' })}
    >
      {label}{active && <span className="al-sort-ind">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
    </th>
  )
}
function cmp(a: string | number, b: string | number, dir: 'asc' | 'desc'): number {
  const c = a < b ? -1 : a > b ? 1 : 0
  return dir === 'asc' ? c : -c
}

/* ================================================================== *
 * Inflows register
 * ================================================================== */
function InflowsTab({
  view, inflowDer, canEdit, onAdd, onEdit, onDelete, onAllocate,
}: {
  view: LedgerData
  inflowDer: Map<string, ReturnType<typeof deriveInflow>>
  canEdit: boolean
  onAdd: () => void
  onEdit: (r: Inflow) => void
  onDelete: (r: Inflow) => void
  onAllocate: (r: Inflow) => void
}) {
  const [q, setQ] = useState('')
  const [typeF, setTypeF] = useState('all')
  const [statusF, setStatusF] = useState('all')
  const [sort, setSort] = useState<SortState>({ key: 'dated', dir: 'desc' })

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase()
    const filtered = view.inflows.filter(i => {
      if (typeF !== 'all' && i.source_type !== typeF) return false
      if (statusF !== 'all' && i.status !== statusF) return false
      if (ql && !`${i.source_name} ${i.reference ?? ''}`.toLowerCase().includes(ql)) return false
      return true
    })
    const val = (i: Inflow): string | number => {
      const d = inflowDer.get(i.id)!
      switch (sort.key) {
        case 'source_name': return i.source_name.toLowerCase()
        case 'source_type': return i.source_type
        case 'amount_usd': return i.amount_usd
        case 'allocated': return d.allocated
        case 'unallocated': return d.unallocated
        case 'status': return i.status
        default: return i.dated
      }
    }
    return [...filtered].sort((a, b) => cmp(val(a), val(b), sort.dir))
  }, [view.inflows, inflowDer, q, typeF, statusF, sort])

  return (
    <div className="al-tabbody">
      <div className="al-tabhead">
        <div><h2>Inflows</h2><p className="al-sub">{rows.length} of {view.inflows.length} sources in range</p></div>
        {canEdit && <button type="button" className="al-btn primary" onClick={onAdd}>+ Add inflow</button>}
      </div>
      <div className="al-filters">
        <input className="al-search" placeholder="Search source / reference…" value={q} onChange={e => setQ(e.target.value)} />
        <select value={typeF} onChange={e => setTypeF(e.target.value)}>
          <option value="all">All types</option>
          {SOURCE_TYPES.map(t => <option key={t} value={t}>{labelSourceType(t)}</option>)}
        </select>
        <select value={statusF} onChange={e => setStatusF(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="expected">Expected</option>
          <option value="received">Received</option>
        </select>
      </div>
      <table className="al-table">
        <thead>
          <tr>
            <SortTh label="Date" k="dated" sort={sort} setSort={setSort} cls="l" />
            <SortTh label="Source" k="source_name" sort={sort} setSort={setSort} cls="l" />
            <SortTh label="Type" k="source_type" sort={sort} setSort={setSort} cls="l" />
            <th className="r">Native</th>
            <SortTh label="USD" k="amount_usd" sort={sort} setSort={setSort} cls="r" />
            <SortTh label="Allocated" k="allocated" sort={sort} setSort={setSort} cls="r" />
            <SortTh label="Unallocated" k="unallocated" sort={sort} setSort={setSort} cls="r" />
            <SortTh label="Status" k="status" sort={sort} setSort={setSort} cls="l" />
            <th className="r">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(inf => {
            const der = inflowDer.get(inf.id)!
            return (
              <tr key={inf.id}>
                <td className="l">{fmtDate(inf.dated)}</td>
                <td className="l"><strong>{inf.source_name}</strong>{inf.reference && <span className="al-ref">{inf.reference}</span>}</td>
                <td className="l">{labelSourceType(inf.source_type)}</td>
                <td className="r">{money(inf.amount_native, inf.currency)}</td>
                <td className="r mono">{usd(inf.amount_usd)}</td>
                <td className="r mono">{usd(der.allocated)}</td>
                <td className={`r mono ${der.unallocated > 0.005 ? 'warn' : ''}`}>{usd(der.unallocated)}</td>
                <td className="l"><span className={`al-pill ${inf.status}`}>{inf.status}</span></td>
                <td className="r al-rowact">
                  {canEdit && <button type="button" className="al-link" onClick={() => onAllocate(inf)}>Allocate</button>}
                  {canEdit && <button type="button" className="al-link" onClick={() => onEdit(inf)}>Edit</button>}
                  {canEdit && <button type="button" className="al-link del" onClick={() => onDelete(inf)}>Delete</button>}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && <tr><td colSpan={9} className="al-empty">No inflows match.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

/* ================================================================== *
 * Shopping list (obligations)
 * ================================================================== */
function ObligationsTab({
  view, oblDer, canEdit, onAdd, onEdit, onDelete, onAllocate, onPay,
}: {
  view: LedgerData
  oblDer: Map<string, ReturnType<typeof deriveObligation>>
  canEdit: boolean
  onAdd: () => void
  onEdit: (r: Obligation) => void
  onDelete: (r: Obligation) => void
  onAllocate: (r: Obligation) => void
  onPay: (r: Obligation) => void
}) {
  const [q, setQ] = useState('')
  const [catF, setCatF] = useState('all')
  const [fundF, setFundF] = useState('all')
  const [sort, setSort] = useState<SortState>({ key: 'due_date', dir: 'asc' })

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase()
    const filtered = view.obligations.filter(o => {
      if (catF !== 'all' && o.category !== catF) return false
      if (fundF !== 'all' && oblDer.get(o.id)!.fundStatus !== fundF) return false
      if (ql && !o.description.toLowerCase().includes(ql)) return false
      return true
    })
    const val = (o: Obligation): string | number => {
      const d = oblDer.get(o.id)!
      switch (sort.key) {
        case 'description': return o.description.toLowerCase()
        case 'category': return o.category
        case 'amount_usd': return o.amount_usd
        case 'funded': return d.funded
        case 'outstanding': return d.outstanding
        case 'paid': return d.paid
        case 'fundStatus': return d.fundStatus
        default: return o.due_date ?? '9999-12-31' // undated sort last on asc
      }
    }
    return [...filtered].sort((a, b) => cmp(val(a), val(b), sort.dir))
  }, [view.obligations, oblDer, q, catF, fundF, sort])

  return (
    <div className="al-tabbody">
      <div className="al-tabhead">
        <div><h2>Obligations</h2><p className="al-sub">{rows.length} of {view.obligations.length} obligations in range</p></div>
        {canEdit && <button type="button" className="al-btn primary" onClick={onAdd}>+ Add obligation</button>}
      </div>
      <div className="al-filters">
        <input className="al-search" placeholder="Search description…" value={q} onChange={e => setQ(e.target.value)} />
        <select value={catF} onChange={e => setCatF(e.target.value)}>
          <option value="all">All categories</option>
          {OBLIGATION_CATEGORIES.map(c => <option key={c} value={c}>{labelCategory(c)}</option>)}
        </select>
        <select value={fundF} onChange={e => setFundF(e.target.value)}>
          <option value="all">All funding</option>
          <option value="unfunded">Unfunded</option>
          <option value="partial">Partial</option>
          <option value="funded">Funded</option>
        </select>
      </div>
      <table className="al-table">
        <thead>
          <tr>
            <SortTh label="Due" k="due_date" sort={sort} setSort={setSort} cls="l" />
            <SortTh label="Description" k="description" sort={sort} setSort={setSort} cls="l" />
            <SortTh label="Category" k="category" sort={sort} setSort={setSort} cls="l" />
            <th className="r">Native</th>
            <SortTh label="USD" k="amount_usd" sort={sort} setSort={setSort} cls="r" />
            <SortTh label="Funded" k="funded" sort={sort} setSort={setSort} cls="r" />
            <SortTh label="Outstanding" k="outstanding" sort={sort} setSort={setSort} cls="r" />
            <SortTh label="Paid" k="paid" sort={sort} setSort={setSort} cls="r" />
            <SortTh label="Status" k="fundStatus" sort={sort} setSort={setSort} cls="l" />
            <th className="r">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(o => {
            const der = oblDer.get(o.id)!
            return (
              <tr key={o.id}>
                <td className="l">{fmtDate(o.due_date)}</td>
                <td className="l"><strong>{o.description}</strong></td>
                <td className="l">{labelCategory(o.category)}</td>
                <td className="r">{money(o.amount_native, o.currency)}</td>
                <td className="r mono">{usd(o.amount_usd)}</td>
                <td className="r mono">{usd(der.funded)}</td>
                <td className={`r mono ${der.outstanding > 0.005 ? 'warn' : ''}`}>{usd(der.outstanding)}</td>
                <td className="r mono">{usd(der.paid)}</td>
                <td className="l">
                  <span className={`al-pill fund-${der.fundStatus}`}>{der.fundStatus}</span>
                  <span className={`al-pill paid-${der.paidStatus}`}>{der.paidStatus}</span>
                </td>
                <td className="r al-rowact">
                  {canEdit && <button type="button" className="al-link" onClick={() => onAllocate(o)}>Fund</button>}
                  {canEdit && <button type="button" className="al-link" onClick={() => onPay(o)}>Pay</button>}
                  {canEdit && <button type="button" className="al-link" onClick={() => onEdit(o)}>Edit</button>}
                  {canEdit && <button type="button" className="al-link del" onClick={() => onDelete(o)}>Delete</button>}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && <tr><td colSpan={10} className="al-empty">No obligations match.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

/* ================================================================== *
 * Modal shell
 * ================================================================== */
function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="al-modal-backdrop" onMouseDown={onClose}>
      <div className={`al-modal ${wide ? 'wide' : ''}`} onMouseDown={e => e.stopPropagation()}>
        <header className="al-modal-head"><h3>{title}</h3><button type="button" className="al-modal-x" onClick={onClose} aria-label="Close">×</button></header>
        <div className="al-modal-body">{children}</div>
      </div>
    </div>
  )
}

/* ── amount-with-currency sub-form (shared) ─────────────────────── */
function AmountFields({
  amount, currency, fx, onAmount, onCurrency, onFx,
}: {
  amount: string; currency: string; fx: string
  onAmount: (v: string) => void; onCurrency: (v: string) => void; onFx: (v: string) => void
}) {
  const isUsd = currency === 'USD'
  const preview = (Number(amount) || 0) * (isUsd ? 1 : (Number(fx) || 0))
  return (
    <div className="al-amount-grid">
      <label>Amount (native)<input type="number" inputMode="decimal" value={amount} onChange={e => onAmount(e.target.value)} /></label>
      <label>Currency
        <select value={currency} onChange={e => { onCurrency(e.target.value); if (e.target.value === 'USD') onFx('1') }}>
          {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className={isUsd ? 'dim' : ''}>FX → USD<input type="number" inputMode="decimal" value={fx} disabled={isUsd} onChange={e => onFx(e.target.value)} /></label>
      <div className="al-usd-preview"><span>= USD</span><strong>{usd(preview)}</strong></div>
    </div>
  )
}

/* ================================================================== *
 * Inflow form
 * ================================================================== */
function InflowForm({ edit, onClose, onSave }: { edit?: Inflow; onClose: () => void; onSave: (input: InflowInput, id?: string) => void }) {
  const [dated, setDated] = useState(edit?.dated ?? '')
  const [status, setStatus] = useState<InflowStatus>(edit?.status ?? 'received')
  const [sourceName, setSourceName] = useState(edit?.source_name ?? '')
  const [sourceType, setSourceType] = useState<SourceType>(edit?.source_type ?? 'client')
  const [amount, setAmount] = useState(edit ? String(edit.amount_native) : '')
  const [currency, setCurrency] = useState(edit?.currency ?? 'USD')
  const [fx, setFx] = useState(edit ? String(edit.fx_to_usd) : '1')
  const [reference, setReference] = useState(edit?.reference ?? '')
  const [note, setNote] = useState(edit?.note ?? '')

  const valid = dated && sourceName.trim() && Number(amount) >= 0 && Number(fx) > 0

  function submit() {
    if (!valid) return
    onSave({
      dated, status, source_name: sourceName.trim(), source_type: sourceType,
      amount_native: Number(amount), currency, fx_to_usd: currency === 'USD' ? 1 : Number(fx),
      reference: reference.trim() || null, area_key: edit?.area_key ?? null, note: note.trim() || null,
    }, edit?.id)
  }

  return (
    <Modal title={edit ? 'Edit inflow' : 'Add inflow'} onClose={onClose}>
      <div className="al-form">
        <div className="al-form-row">
          <label>Date<input type="date" value={dated} onChange={e => setDated(e.target.value)} /></label>
          <label>Status
            <select value={status} onChange={e => setStatus(e.target.value as InflowStatus)}>
              <option value="expected">Expected</option><option value="received">Received</option>
            </select>
          </label>
        </div>
        <div className="al-form-row">
          <label className="grow">Source name<input value={sourceName} onChange={e => setSourceName(e.target.value)} placeholder="e.g. Client X, ADP loan facility" /></label>
          <label>Type
            <select value={sourceType} onChange={e => setSourceType(e.target.value as SourceType)}>
              {SOURCE_TYPES.map(t => <option key={t} value={t}>{labelSourceType(t)}</option>)}
            </select>
          </label>
        </div>
        <AmountFields amount={amount} currency={currency} fx={fx} onAmount={setAmount} onCurrency={setCurrency} onFx={setFx} />
        <div className="al-form-row">
          <label className="grow">Reference<input value={reference} onChange={e => setReference(e.target.value)} placeholder="Bank ref / note" /></label>
        </div>
        <label>Note<textarea value={note} onChange={e => setNote(e.target.value)} rows={2} /></label>
        <div className="al-form-actions">
          <button type="button" className="al-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="al-btn primary" disabled={!valid} onClick={submit}>{edit ? 'Save' : 'Add inflow'}</button>
        </div>
      </div>
    </Modal>
  )
}

/* ================================================================== *
 * Obligation form
 * ================================================================== */
function ObligationForm({ edit, onClose, onSave }: { edit?: Obligation; onClose: () => void; onSave: (input: ObligationInput, id?: string) => void }) {
  const [dueDate, setDueDate] = useState(edit?.due_date ?? '')
  const [description, setDescription] = useState(edit?.description ?? '')
  const [category, setCategory] = useState<ObligationCategory>(edit?.category ?? 'supplier')
  const [amount, setAmount] = useState(edit ? String(edit.amount_native) : '')
  const [currency, setCurrency] = useState(edit?.currency ?? 'USD')
  const [fx, setFx] = useState(edit ? String(edit.fx_to_usd) : '1')
  const [note, setNote] = useState(edit?.note ?? '')

  const valid = description.trim() && Number(amount) >= 0 && Number(fx) > 0

  function submit() {
    if (!valid) return
    onSave({
      due_date: dueDate || null, description: description.trim(), category,
      amount_native: Number(amount), currency, fx_to_usd: currency === 'USD' ? 1 : Number(fx),
      area_key: edit?.area_key ?? null, note: note.trim() || null,
    }, edit?.id)
  }

  return (
    <Modal title={edit ? 'Edit obligation' : 'Add obligation'} onClose={onClose}>
      <div className="al-form">
        <div className="al-form-row">
          <label className="grow">Description<input value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. September payroll, Supplier ABC invoice" /></label>
        </div>
        <div className="al-form-row">
          <label>Due date<input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></label>
          <label>Category
            <select value={category} onChange={e => setCategory(e.target.value as ObligationCategory)}>
              {OBLIGATION_CATEGORIES.map(c => <option key={c} value={c}>{labelCategory(c)}</option>)}
            </select>
          </label>
        </div>
        <AmountFields amount={amount} currency={currency} fx={fx} onAmount={setAmount} onCurrency={setCurrency} onFx={setFx} />
        <label>Note<textarea value={note} onChange={e => setNote(e.target.value)} rows={2} /></label>
        <div className="al-form-actions">
          <button type="button" className="al-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="al-btn primary" disabled={!valid} onClick={submit}>{edit ? 'Save' : 'Add obligation'}</button>
        </div>
      </div>
    </Modal>
  )
}

/* ================================================================== *
 * Allocate modal — works from an inflow or an obligation anchor.
 * Lists the other side; enter a USD amount per row, guardrailed by both
 * the anchor's remaining capacity and the counterpart's remaining need.
 * ================================================================== */
function AllocateModal({
  anchor, data, inflowDer, oblDer, onClose, onSet, onRemove,
}: {
  anchor: { kind: 'inflow'; row: Inflow } | { kind: 'obligation'; row: Obligation }
  data: LedgerData
  inflowDer: Map<string, ReturnType<typeof deriveInflow>>
  oblDer: Map<string, ReturnType<typeof deriveObligation>>
  onClose: () => void
  onSet: (inflow_id: string, obligation_id: string, amount_usd: number) => Promise<void>
  onRemove: (id: string) => Promise<void>
}) {
  const fromInflow = anchor.kind === 'inflow'
  const anchorId = anchor.row.id

  // existing links touching the anchor
  const links = data.allocations.filter(a => (fromInflow ? a.inflow_id : a.obligation_id) === anchorId)
  const linkByCounterpart = new Map(links.map(l => [fromInflow ? l.obligation_id : l.inflow_id, l]))

  // anchor remaining capacity
  const anchorRemaining = fromInflow
    ? inflowDer.get(anchorId)!.unallocated
    : oblDer.get(anchorId)!.outstanding
  const anchorTotal = anchor.row.amount_usd

  // counterpart list (the other side), with their own remaining need
  const counterparts = (fromInflow ? data.obligations : data.inflows).map(c => {
    const rem = fromInflow
      ? oblDer.get(c.id)!.outstanding
      : inflowDer.get(c.id)!.unallocated
    const existing = linkByCounterpart.get(c.id)
    return { id: c.id, label: fromInflow ? (c as Obligation).description : (c as Inflow).source_name, remaining: rem, existing }
  })
  // those with capacity or an existing link, sorted by remaining need desc
  const rows = counterparts
    .filter(c => c.remaining > 0.005 || c.existing)
    .sort((a, b) => b.remaining - a.remaining)

  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(links.map(l => [fromInflow ? l.obligation_id : l.inflow_id, String(l.amount_usd)])),
  )
  const [busy, setBusy] = useState<string | null>(null)

  async function apply(counterpartId: string) {
    const v = Number(draft[counterpartId])
    const existing = linkByCounterpart.get(counterpartId)
    setBusy(counterpartId)
    try {
      if (!v || v <= 0) {
        if (existing) await onRemove(existing.id)
      } else {
        const inflow_id = fromInflow ? anchorId : counterpartId
        const obligation_id = fromInflow ? counterpartId : anchorId
        await onSet(inflow_id, obligation_id, Math.round(v * 100) / 100)
      }
    } finally {
      setBusy(null)
    }
  }

  const draftTotal = Object.values(draft).reduce((s, v) => s + (Number(v) || 0), 0)
  const overCommitted = draftTotal - anchorTotal > 0.005

  return (
    <Modal
      title={fromInflow ? `Allocate — ${anchor.row.source_name}` : `Fund — ${(anchor.row as Obligation).description}`}
      onClose={onClose}
      wide
    >
      <div className="al-alloc">
        <div className="al-alloc-summary">
          <div><span>{fromInflow ? 'Inflow total' : 'Obligation total'}</span><strong>{usd(anchorTotal)}</strong></div>
          <div><span>{fromInflow ? 'Unallocated' : 'Outstanding'}</span><strong className={anchorRemaining > 0.005 ? 'warn' : ''}>{usd(anchorRemaining)}</strong></div>
          <div><span>Drafted</span><strong className={overCommitted ? 'err' : ''}>{usd(draftTotal)}</strong></div>
        </div>
        {overCommitted && <div className="al-alloc-warn">Drafted total exceeds the {fromInflow ? 'inflow' : 'obligation'} amount.</div>}

        <p className="al-alloc-hint">Enter a USD amount against each {fromInflow ? 'obligation' : 'inflow'}, then Set. Blank or 0 removes the link.</p>
        <div className="al-alloc-list">
          {rows.map(c => {
            const existing = c.existing
            // the counterpart's remaining excludes any existing link to this anchor (so the cap is what's free + what we already hold here)
            const cap = c.remaining + (existing ? existing.amount_usd : 0)
            return (
              <div key={c.id} className="al-alloc-row">
                <div className="al-alloc-name">
                  <strong>{c.label}</strong>
                  <span className="al-alloc-cap">{fromInflow ? 'outstanding' : 'unallocated'} cap {usd(cap)}</span>
                </div>
                <input
                  type="number" inputMode="decimal" className="al-alloc-input"
                  value={draft[c.id] ?? ''}
                  placeholder="0"
                  onChange={e => setDraft(d => ({ ...d, [c.id]: e.target.value }))}
                />
                <button type="button" className="al-btn sm primary" disabled={busy === c.id} onClick={() => apply(c.id)}>
                  {busy === c.id ? '…' : existing ? 'Update' : 'Set'}
                </button>
                {existing && <button type="button" className="al-link del" onClick={() => { setDraft(d => ({ ...d, [c.id]: '' })); void apply(c.id) }}>Remove</button>}
              </div>
            )
          })}
          {rows.length === 0 && <div className="al-empty">Nothing on the other side has remaining capacity.</div>}
        </div>
        <div className="al-form-actions">
          <button type="button" className="al-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  )
}

/* ================================================================== *
 * Payment form — record actual settlement of an obligation
 * ================================================================== */
function PaymentForm({
  obligation, outstanding, payments, onClose, onSave, onDeletePayment,
}: {
  obligation: Obligation
  outstanding: number
  payments: { id: string; paid_date: string; amount_usd: number; amount_native: number; currency: string; reference: string | null }[]
  onClose: () => void
  onSave: (input: PaymentInput) => void
  onDeletePayment: (id: string) => void
}) {
  const [paidDate, setPaidDate] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState(obligation.currency)
  const [fx, setFx] = useState(String(obligation.fx_to_usd))
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')

  const valid = paidDate && Number(amount) > 0 && Number(fx) > 0

  function submit() {
    if (!valid) return
    onSave({
      obligation_id: obligation.id, paid_date: paidDate,
      amount_native: Number(amount), currency, fx_to_usd: currency === 'USD' ? 1 : Number(fx),
      reference: reference.trim() || null, note: note.trim() || null,
    })
  }

  return (
    <Modal title={`Record payment — ${obligation.description}`} onClose={onClose}>
      <div className="al-form">
        <div className="al-alloc-summary">
          <div><span>Obligation</span><strong>{usd(obligation.amount_usd)}</strong></div>
          <div><span>Unpaid</span><strong className={outstanding > 0.005 ? 'warn' : ''}>{usd(outstanding)}</strong></div>
        </div>
        {payments.length > 0 && (
          <div className="al-paylist">
            {payments.map(p => (
              <div key={p.id} className="al-payrow">
                <span>{fmtDate(p.paid_date)}</span>
                <span className="mono">{usd(p.amount_usd)}</span>
                <span className="al-alloc-cap">{money(p.amount_native, p.currency)}{p.reference ? ` · ${p.reference}` : ''}</span>
                <button type="button" className="al-link del" onClick={() => onDeletePayment(p.id)}>Remove</button>
              </div>
            ))}
          </div>
        )}
        <div className="al-form-row">
          <label>Paid date<input type="date" value={paidDate} onChange={e => setPaidDate(e.target.value)} /></label>
        </div>
        <AmountFields amount={amount} currency={currency} fx={fx} onAmount={setAmount} onCurrency={setCurrency} onFx={setFx} />
        <div className="al-form-row">
          <label className="grow">Reference<input value={reference} onChange={e => setReference(e.target.value)} placeholder="Transfer ref" /></label>
        </div>
        <label>Note<textarea value={note} onChange={e => setNote(e.target.value)} rows={2} /></label>
        <div className="al-form-actions">
          <button type="button" className="al-btn" onClick={onClose}>Done</button>
          <button type="button" className="al-btn primary" disabled={!valid} onClick={submit}>Record payment</button>
        </div>
      </div>
    </Modal>
  )
}
