import { useState, useEffect, Fragment } from 'react'
import { supabase } from '@/lib/supabase'

/* StagingReview — the confidence check a Treasury user reads BEFORE pushing a
   staged import run. Balances first, then per-line movement (with per-month
   expand to catch month-shifting), then the projects that were summed in.
   Self-contained: fetches its own review + project data. */

type SheetEntry = { sheet: string; code: string; name?: string; is_jv?: boolean }
type SheetClassification = {
  target: string | null
  summed: string[]
  assigned?: SheetEntry[]
  unassigned?: SheetEntry[]
  area_items?: SheetEntry[]
  ignored: string[]
} | null
type ActualsChange = {
  line_code: string; category: string | null; nature: string | null
  year: number; month: number
  old_value: number | null; new_value: number | null; diff: number | null
  source_version: string | null
}
type ActualsDiffData = {
  area: string; currency: string
  n_changed: number; n_staged_actual_keys: number; n_existing_actual_keys: number
  changes: ActualsChange[]
}
// Subset of the cf_import_runs row passed from ImportRunsManager.
type RunSummary = {
  currency?: string
  recon_status?: string; recon_n_breaks?: number
  n_unmatched_labels?: number; n_projects?: number; n_projects_new?: number
  recon_summary?: { sheet_classification?: SheetClassification }
}

function unwrap<T>(x: any): T {
  return (Array.isArray(x) ? x[0] : x) as T
}

// Large numbers, thousands separators, 0 decimals, null/0-safe.
function fmt(v: any) {
  if (v == null) return '—'
  const n = Number(v)
  if (!isFinite(n)) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

// Accounting format: negatives in parentheses (the caller colours them red via .neg).
function fmtAcct(v: any) {
  if (v == null) return '—'
  const n = Number(v)
  if (!isFinite(n)) return '—'
  const a = Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })
  return n < 0 ? `(${a})` : a
}

export default function StagingReview(
  { runId, currency, run }: { runId: string; currency: string; run?: RunSummary }
) {
  const [actualsDiff, setActualsDiff] = useState<ActualsDiffData | null>(null)

  useEffect(() => {
    let alive = true
    supabase.rpc('cf_run_actuals_diff', { p_run_id: runId }).then(({ data, error }) => {
      if (!alive || error) return
      setActualsDiff(unwrap<ActualsDiffData>(data))
    })
    return () => { alive = false }
  }, [runId])

  const cur = run?.currency || currency
  const sc = run?.recon_summary?.sheet_classification ?? null

  return (
    <div className="cfm-sr">
      {/* The area cash-flow statement, reconstructed from the staged run —
          months as columns, sections as rows, bracketed by the rollup's own
          opening/ending balance. Year switcher for prior years. */}
      <CashflowGrid runId={runId} currency={cur} />

      {/* Sheets — each is a project or an area item: what mapped to the canonical
          registry vs what didn't. */}
      <SheetsPanel sc={sc} />

      {/* Actuals integrity — would the push restate frozen history? */}
      <ActualsDiff data={actualsDiff} cur={cur} />
    </div>
  )
}

/* The area cash-flow statement, rebuilt from the staged run (cf_run_cashflow_grid):
   months as columns for the chosen year, section totals as rows, bracketed by the
   rollup's own opening/ending balance. The pre-push "does this look right" surface. */
type GridYear = {
  months: { ym: string; m: number; kind: 'actual' | 'forecast' }[]
  sections: Record<string, Record<string, number> | null>
  opening: Record<string, number>
  ending: Record<string, number>
}
type GridData = {
  area: string; currency: string
  years: number[]
  by_year: Record<string, GridYear>
}

const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function CashflowGrid({ runId, currency }: { runId: string; currency: string }) {
  const [data, setData] = useState<GridData | null>(null)
  const [year, setYear] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setErr(null); setData(null)
    supabase.rpc('cf_run_cashflow_grid', { p_run_id: runId }).then(({ data, error }) => {
      if (!alive) return
      if (error) { setErr(String(error.message || error)); return }
      const d = unwrap<GridData>(data)
      setData(d)
      setYear(d.years?.length ? d.years[d.years.length - 1] : null)
    })
    return () => { alive = false }
  }, [runId])

  if (err) return <div className="cfm-sr-error">Cash flow failed: {err}</div>
  if (!data || year == null) return <div className="cfm-empty-sm">Loading cash flow…</div>

  const cur = data.currency || currency
  const yd = data.by_year[String(year)]
  if (!yd) return <div className="cfm-empty-sm">No data for {year}.</div>

  const months = yd.months || []
  const ymKeys = months.map(m => m.ym)
  const sec = yd.sections || {}
  const at = (map: Record<string, number> | null | undefined, ym: string) => Number(map?.[ym] ?? 0)

  const operRec = (ym: string) => at(sec.oper_rec, ym)
  const operPay = (ym: string) => at(sec.oper_pay, ym)
  const operNet = (ym: string) => operRec(ym) + operPay(ym)
  const interest = (ym: string) => at(sec.interest, ym)
  const nonop = (ym: string) => at(sec.nonop, ym)
  const wg = (ym: string) => at(sec.wg, ym)
  const bank = (ym: string) => at(sec.bank, ym)
  const netMove = (ym: string) => operNet(ym) + interest(ym) + nonop(ym) + wg(ym) + bank(ym)
  const opening = (ym: string) => at(yd.opening, ym)
  const ending = (ym: string) => at(yd.ending, ym)
  const accumL = (ym: string) => at(sec.accum_loans, ym)
  const accumO = (ym: string) => at(sec.accum_od, ym)

  // Boundaries: open/close of the actual stretch and of the forecast stretch.
  const actMs = months.filter(m => m.kind === 'actual').map(m => m.ym)
  const fcMs = months.filter(m => m.kind === 'forecast').map(m => m.ym)
  const firstFcYm = fcMs[0]

  type Row = { key: string; label: string; get: (ym: string) => number; type: 'boundary' | 'flow' | 'net' | 'stock' }
  const rows: Row[] = [
    { key: 'opening', label: 'Opening balance', get: opening, type: 'boundary' },
    { key: 'oper_rec', label: 'Receipts — operations', get: operRec, type: 'flow' },
    { key: 'oper_pay', label: 'Payments — operations', get: operPay, type: 'flow' },
    { key: 'oper_net', label: 'Net — operations', get: operNet, type: 'net' },
    { key: 'interest', label: 'Interest', get: interest, type: 'flow' },
    { key: 'nonop', label: 'Non-operational', get: nonop, type: 'flow' },
    { key: 'wg', label: 'Within group', get: wg, type: 'flow' },
    { key: 'bank', label: 'Bank financing', get: bank, type: 'flow' },
    { key: 'net_move', label: 'Net movement', get: netMove, type: 'net' },
    { key: 'ending', label: 'Ending balance', get: ending, type: 'boundary' },
    { key: 'accum_loans', label: 'Accumulated loans', get: accumL, type: 'stock' },
    { key: 'accum_od', label: 'Overdraft balance', get: accumO, type: 'stock' },
  ]
  // Total column: flows/nets sum across the year; balances/stocks show the closing value.
  const rowTotal = (r: Row) =>
    (r.type === 'flow' || r.type === 'net')
      ? ymKeys.reduce((s, ym) => s + r.get(ym), 0)
      : (ymKeys.length ? r.get(ymKeys[ymKeys.length - 1]) : 0)

  const Bnd = ({ label, open, close }: { label: string; open: number | null; close: number | null }) => (
    <div className="cfm-cfg-bnd">
      <span className="cfm-cfg-bnd-lab">{label}</span>
      <span className="cfm-cfg-bnd-pair">
        <span><em>open</em> <b className={open != null && open < 0 ? 'neg' : ''}>{open == null ? '—' : fmtAcct(open)}</b></span>
        <span className="cfm-cfg-bnd-arrow">→</span>
        <span><em>close</em> <b className={close != null && close < 0 ? 'neg' : ''}>{close == null ? '—' : fmtAcct(close)}</b></span>
      </span>
    </div>
  )

  return (
    <div className="cfm-cfg">
      <div className="cfm-cfg-head">
        <div className="cfm-cfg-years">
          {data.years.map(y => (
            <button key={y} className={`cfm-cfg-year ${y === year ? 'is-on' : ''}`} onClick={() => setYear(y)}>{y}</button>
          ))}
        </div>
        <span className="cfm-cfg-cur">{data.area} · {cur}</span>
      </div>

      <div className="cfm-cfg-bnds">
        {actMs.length > 0 && (
          <Bnd label="Actuals" open={opening(actMs[0])} close={ending(actMs[actMs.length - 1])} />
        )}
        {fcMs.length > 0 && (
          <Bnd label="Forecast" open={opening(fcMs[0])} close={ending(fcMs[fcMs.length - 1])} />
        )}
      </div>

      <div className="cfm-cfg-scroll">
        <table className="cfm-cfg-table">
          <thead>
            <tr>
              <th className="cfm-cfg-rowhead">Section</th>
              {months.map(m => (
                <th key={m.ym} className={`num ${m.kind === 'forecast' ? 'is-fc' : ''} ${m.ym === firstFcYm ? 'is-cut' : ''}`}>
                  {MON[m.m]}
                  {m.kind === 'forecast' && <span className="cfm-cfg-fctag">f</span>}
                </th>
              ))}
              <th className="num cfm-cfg-total">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key} className={`cfm-cfg-row is-${r.type}`}>
                <td className="cfm-cfg-rowhead">{r.label}</td>
                {months.map(m => {
                  const v = r.get(m.ym)
                  return (
                    <td key={m.ym} className={`num ${v < 0 ? 'neg' : ''} ${m.kind === 'forecast' ? 'is-fc' : ''} ${m.ym === firstFcYm ? 'is-cut' : ''}`}>
                      {v === 0 ? '·' : fmtAcct(v)}
                    </td>
                  )
                })}
                <td className={`num cfm-cfg-total ${rowTotal(r) < 0 ? 'neg' : ''}`}>{fmtAcct(rowTotal(r))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* Sheets — each summed sheet is a project or an area item. Two lists: ASSIGNED
   (mapped onto the canonical project registry) vs NOT ASSIGNED (summed as a project
   but unrecognised — needs mapping). Area items and ignored sheets shown for context. */
function SheetsPanel({ sc }: { sc: SheetClassification }) {
  const [showIgnored, setShowIgnored] = useState(false)
  if (!sc) return null
  const assigned = sc.assigned ?? []
  const unassigned = sc.unassigned ?? []
  const areaItems = sc.area_items ?? []
  const ignored = sc.ignored ?? []

  const Item = ({ e }: { e: SheetEntry }) => (
    <div className="cfm-shp-item">
      <span className="cfm-shp-sheet">{e.sheet}</span>
      {e.name && e.name !== e.sheet && <span className="cfm-shp-map">→ {e.name}</span>}
      {e.is_jv && <span className="cfm-shp-jv">JV</span>}
    </div>
  )

  return (
    <div className="cfm-shp">
      <div className="cfm-shp-cols">
        <div className="cfm-shp-col">
          <div className="cfm-shp-h">
            <span className="cfm-shp-dot is-ok" />Assigned
            <span className="cfm-shp-n">{assigned.length}</span>
          </div>
          <div className="cfm-shp-list">
            {assigned.length ? assigned.map(e => <Item key={e.sheet} e={e} />)
              : <div className="cfm-shp-empty">None</div>}
          </div>
        </div>
        <div className="cfm-shp-col">
          <div className="cfm-shp-h">
            <span className="cfm-shp-dot is-warn" />Not assigned
            <span className="cfm-shp-n">{unassigned.length}</span>
          </div>
          <div className="cfm-shp-list">
            {unassigned.length ? unassigned.map(e => <Item key={e.sheet} e={e} />)
              : <div className="cfm-shp-empty">None — every project mapped</div>}
          </div>
        </div>
      </div>
      <div className="cfm-shp-foot">
        {areaItems.length > 0 && (
          <span className="cfm-shp-foot-grp">
            <span className="cfm-shp-foot-lab">Area items</span>
            {areaItems.map(e => <span key={e.sheet} className="cfm-shp-chip">{e.sheet}</span>)}
          </span>
        )}
        {ignored.length > 0 && (
          <button className="cfm-shp-ign-toggle" onClick={() => setShowIgnored(o => !o)}>
            {showIgnored ? '▾' : '▸'} Ignored — rollups / junk ({ignored.length})
          </button>
        )}
      </div>
      {showIgnored && ignored.length > 0 && (
        <div className="cfm-shp-ign-list">{ignored.join(' · ')}</div>
      )}
    </div>
  )
}

/* Actuals integrity drill — the periods this file would overwrite in cf_actuals
   with a different value. Only renders when there's something to flag. */
function ActualsDiff({ data, cur }: { data: ActualsDiffData | null; cur: string }) {
  const [open, setOpen] = useState(false)
  if (!data || data.n_changed === 0) return null
  const shown = data.changes || []
  const ratio = data.n_staged_actual_keys ? data.n_changed / data.n_staged_actual_keys : 0
  return (
    <div className="cfm-sr-actuals">
      <button className="cfm-sr-toggle is-warn" onClick={() => setOpen(o => !o)}>
        <span className="cfm-sr-caret">{open ? '▾' : '▸'}</span>
        Actuals that would change ({fmt(data.n_changed)})
      </button>
      {open && (
        <div className="cfm-sr-actuals-body">
          <div className="cfm-sr-cap cfm-sr-cap-sm">
            A push overwrites elapsed periods into actuals. These already have a stored
            actual that differs from this file
            {ratio > 0.5 ? ' — most lines differ, which usually means a currency/basis mismatch with the stored actuals, not real restatements' : ''}. {cur}.
          </div>
          <table className="cfm-sr-table">
            <thead>
              <tr>
                <th>Line</th><th>Period</th>
                <th className="num">Stored</th><th className="num">This file</th><th className="num">Δ</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c, i) => (
                <tr key={i}>
                  <td><span className="mono">{c.line_code}</span></td>
                  <td>{c.year}-{String(c.month).padStart(2, '0')}</td>
                  <td className="num">{fmt(c.old_value)}</td>
                  <td className="num">{fmt(c.new_value)}</td>
                  <td className={`num ${Number(c.diff) < 0 ? 'neg' : ''}`}>{fmt(c.diff)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.n_changed > shown.length && (
            <div className="cfm-sr-cap cfm-sr-cap-sm">Showing the {shown.length} largest of {fmt(data.n_changed)}.</div>
          )}
        </div>
      )}
    </div>
  )
}
