import { useState, useEffect, Fragment } from 'react'
import { supabase } from '@/lib/supabase'
import { usePersistedState } from '@/lib/persist'

/* StagingReview — the confidence check a Treasury user reads BEFORE pushing a
   staged import run. Balances first, then per-line movement (with per-month
   expand to catch month-shifting), then the projects that were summed in.
   Self-contained: fetches its own review + project data. */

type SheetEntry = { sheet: string; code: string; name?: string; is_jv?: boolean }
type SheetMeta = {
  sheet: string; code: string; role: string
  is_jv: boolean; name?: string | null; default_included: boolean
}
type SheetClassification = {
  target: string | null
  compare_target?: string | null
  sheets?: SheetMeta[]
  summed: string[]
  assigned?: SheetEntry[]
  unassigned?: SheetEntry[]
  area_items?: SheetEntry[]
  ignored: string[]
} | null
type ActualsDiffYear = {
  months: { ym: string; m: number; kind: 'actual' | 'forecast' }[]
  staged: Record<string, Record<string, number> | null>
  stored: Record<string, Record<string, number> | null>
}
type ActualsDiffData = {
  area: string; currency: string
  n_changed: number; has_stored: boolean
  years: number[]
  by_year: Record<string, ActualsDiffYear>
}
// Subset of the cf_import_runs row passed from ImportRunsManager.
type RunSummary = {
  currency?: string
  recon_status?: string; recon_n_breaks?: number
  n_unmatched_labels?: number; n_projects?: number; n_projects_new?: number
  included_sheets?: string[] | null
  recon_summary?: {
    sheet_classification?: SheetClassification
    unmatched_by_sheet?: Record<string, Record<string, { count: number; cells?: string[] } | number>>
  }
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

type LineCat = { line_code: string; category: string; nature: string; description: string }

export default function StagingReview(
  { runId, currency, run, lines = [], canManage = false, onIncludedChange }:
  { runId: string; currency: string; run?: RunSummary; lines?: LineCat[]
    canManage?: boolean; onIncludedChange?: (included: string[]) => void }
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
  const sheets = sc?.sheets ?? []

  // Which sheets are summed into the statement. Seeded from the run's saved set
  // (engine default = today's summed sheets); the toggle persists changes.
  const [included, setIncluded] = useState<Set<string>>(() =>
    new Set(run?.included_sheets ?? sheets.filter(s => s.default_included).map(s => s.sheet)))
  // Bumped after a toggle is persisted, to force the grid to recompute.
  const [gridNonce, setGridNonce] = useState(0)

  const onToggle = async (sheet: string, next: boolean) => {
    // optimistic chip move (snappy); grid refetches only once the write lands
    setIncluded(prev => { const n = new Set(prev); next ? n.add(sheet) : n.delete(sheet); return n })
    const { data, error } = await supabase.rpc('cf_set_sheet_included',
      { p_run_id: runId, p_sheet: sheet, p_included: next })
    if (error) {
      setIncluded(prev => { const n = new Set(prev); next ? n.delete(sheet) : n.add(sheet); return n })
      return
    }
    if (Array.isArray(data)) {
      setIncluded(new Set(data as string[]))
      onIncludedChange?.(data as string[])   // keep the parent's run row fresh (survives collapse/expand)
    }
    setGridNonce(x => x + 1)
  }

  return (
    <div className="cfm-sr">
      {/* The area cash-flow statement, reconstructed from the staged run —
          months as columns, sections as rows, bracketed by the rollup's own
          opening/ending balance. Recomputes when the included-sheet set changes. */}
      <CashflowGrid runId={runId} currency={cur} nonce={gridNonce} />

      {/* Sheets — move each between Included and Ignored to fix what's summed. */}
      <SheetsPanel sheets={sheets} included={included}
                   compareTarget={sc?.compare_target} onToggle={onToggle} />

      {/* Lines the parser couldn't map — scoped to the Included sheets only, so
          ignoring a sheet drops its unmatched lines too. */}
      <UnmatchedLabels unmatchedBySheet={run?.recon_summary?.unmatched_by_sheet}
                       included={included} lines={lines} canManage={canManage} />

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
  file_sections: Record<string, Record<string, number> | null>
  opening: Record<string, number>
  ending: Record<string, number>
}
type GridData = {
  area: string; currency: string
  accum_loans_open?: number | null
  accum_od_open?: number | null
  years: number[]
  by_year: Record<string, GridYear>
}

const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function CashflowGrid({ runId, currency, nonce }: { runId: string; currency: string; nonce?: number }) {
  const [data, setData] = useState<GridData | null>(null)
  // Year + compare mode persist per run, so leaving the tab and coming back keeps
  // the chosen year and Values/Compare-to-file view instead of resetting.
  const [year, setYear] = usePersistedState<number | null>(`cfm.grid.year.${runId}`, null)
  const [compare, setCompare] = usePersistedState<boolean>(`cfm.grid.compare.${runId}`, false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setErr(null)
    supabase.rpc('cf_run_cashflow_grid', { p_run_id: runId }).then(({ data, error }) => {
      if (!alive) return
      if (error) { setErr(String(error.message || error)); return }
      const d = unwrap<GridData>(data)
      setData(d)
      // keep the chosen year if it still exists; else default to the latest
      setYear(prev => (prev != null && d.years?.includes(prev))
        ? prev : (d.years?.length ? d.years[d.years.length - 1] : null))
    })
    return () => { alive = false }
  }, [runId, nonce])

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
  // Net movement = the cash movement, INCLUDING the NET bank financing (loans &
  // overdraft drawn − repaid, plus discounted invoices). The parser now nets the
  // banking section (skips the file's TOTAL subtotals + the accumulated-balance
  // stocks), so this is the real cash impact, not the gross loan turnover.
  const netMove = (ym: string) => operNet(ym) + interest(ym) + nonop(ym) + wg(ym) + bank(ym)

  // All balances are DERIVED running balances. Cash: ending = opening + net
  // movement (next month opens where the prior closed); the cash opening anchor is
  // the file's stated opening. Debt stocks (loans / overdraft): anchored at the
  // OPENING below the stock label (the cell before the first month), then rolled
  // forward EVERY month by the bank-financing movement — loans by net loans + net
  // discounted invoices (bf_loans), overdraft by net overdraft (bf_od). Chained
  // across all years so this year continues from the last.
  const secAt = (g: GridYear, key: string, ym: string) => at(g.sections?.[key], ym)
  // cash movement includes the NET bank financing (see netMove above)
  const netMoveOf = (g: GridYear, ym: string) =>
    secAt(g, 'oper_rec', ym) + secAt(g, 'oper_pay', ym) + secAt(g, 'interest', ym)
      + secAt(g, 'nonop', ym) + secAt(g, 'wg', ym) + secAt(g, 'bank', ym)

  const derivedOpen: Record<string, number> = {}
  const derivedEnd: Record<string, number> = {}
  const derivedLoans: Record<string, number> = {}
  const derivedOd: Record<string, number> = {}
  {
    const firstG = data.by_year[String(data.years[0])]
    const firstYm = firstG?.months?.[0]?.ym
    let bal = firstG && firstYm ? at(firstG.opening, firstYm) : 0
    let loanBal = Number(data.accum_loans_open ?? 0)
    let odBal = Number(data.accum_od_open ?? 0)
    for (const yy of data.years) {
      const g = data.by_year[String(yy)]
      if (!g) continue
      for (const mo of g.months) {
        derivedOpen[mo.ym] = bal
        bal = bal + netMoveOf(g, mo.ym)
        derivedEnd[mo.ym] = bal
        // stocks roll every month, including the first (the anchor is the opening
        // BEFORE the first month, not the first month's balance)
        loanBal = loanBal + secAt(g, 'bf_loans', mo.ym)
        odBal = odBal + secAt(g, 'bf_od', mo.ym)
        derivedLoans[mo.ym] = loanBal
        derivedOd[mo.ym] = odBal
      }
    }
  }
  const opening = (ym: string) => derivedOpen[ym] ?? 0
  const ending = (ym: string) => derivedEnd[ym] ?? 0

  // The file's OWN stated figures (the rollup), for the variance comparison.
  const fsec = yd.file_sections || {}
  const fileAt = (key: string, ym: string) => at(fsec[key], ym)
  // Debt stocks (accumulated loans / overdraft): if the rollup maintains a stated
  // running balance per period, that's authoritative — show it verbatim. Only
  // derive it (anchor + bank movement) when the file carries no per-period stock.
  // This fixes files whose opening anchor isn't where the layout expects (the
  // derived series would otherwise wrongly start from 0 at the first month).
  const hasFileLoans = !!fsec.accum_loans && ymKeys.some(ym => fsec.accum_loans?.[ym] != null)
  const hasFileOd = !!fsec.accum_od && ymKeys.some(ym => fsec.accum_od?.[ym] != null)
  const accumL = (ym: string) => hasFileLoans ? fileAt('accum_loans', ym) : (derivedLoans[ym] ?? 0)
  const accumO = (ym: string) => hasFileOd ? fileAt('accum_od', ym) : (derivedOd[ym] ?? 0)
  const fOperRec = (ym: string) => fileAt('oper_rec', ym)
  const fOperPay = (ym: string) => fileAt('oper_pay', ym)
  const fOpening = (ym: string) => at(yd.opening, ym)
  const fEnding = (ym: string) => at(yd.ending, ym)
  const fNetMove = (ym: string) => fOperRec(ym) + fOperPay(ym)
    + fileAt('interest', ym) + fileAt('nonop', ym) + fileAt('wg', ym) + fileAt('bank', ym)

  // First forecast month — marks the actual/forecast cutover divider in the grid.
  const firstFcYm = months.find(m => m.kind === 'forecast')?.ym

  type Row = { key: string; label: string; get: (ym: string) => number; file: (ym: string) => number; type: 'boundary' | 'flow' | 'net' | 'stock' }
  const rows: Row[] = [
    { key: 'opening', label: 'Opening balance', get: opening, file: fOpening, type: 'boundary' },
    { key: 'oper_rec', label: 'Receipts — operations', get: operRec, file: fOperRec, type: 'flow' },
    { key: 'oper_pay', label: 'Payments — operations', get: operPay, file: fOperPay, type: 'flow' },
    { key: 'oper_net', label: 'Net — operations', get: operNet, file: (ym) => fOperRec(ym) + fOperPay(ym), type: 'net' },
    { key: 'interest', label: 'Interest', get: interest, file: (ym) => fileAt('interest', ym), type: 'flow' },
    { key: 'nonop', label: 'Non-operational', get: nonop, file: (ym) => fileAt('nonop', ym), type: 'flow' },
    { key: 'wg', label: 'Within group', get: wg, file: (ym) => fileAt('wg', ym), type: 'flow' },
    { key: 'bank', label: 'Bank financing (net)', get: bank, file: (ym) => fileAt('bank', ym), type: 'flow' },
    { key: 'net_move', label: 'Net movement', get: netMove, file: fNetMove, type: 'net' },
    { key: 'ending', label: 'Ending balance', get: ending, file: fEnding, type: 'boundary' },
    { key: 'accum_loans', label: 'Accumulated loans', get: accumL, file: (ym) => fileAt('accum_loans', ym), type: 'stock' },
    { key: 'accum_od', label: 'Overdraft balance', get: accumO, file: (ym) => fileAt('accum_od', ym), type: 'stock' },
  ]
  // The value shown in a cell: the figure itself, or (compare mode) its variance vs the file.
  const cellVal = (r: Row, ym: string) => compare ? r.get(ym) - r.file(ym) : r.get(ym)
  const MAT = 0.5   // variances below this (rounding) read as a tie
  // Total column: flows/nets sum across the year; balances/stocks show the closing value.
  const rowTotal = (r: Row) => {
    if (r.type === 'flow' || r.type === 'net') return ymKeys.reduce((s, ym) => s + cellVal(r, ym), 0)
    return ymKeys.length ? cellVal(r, ymKeys[ymKeys.length - 1]) : 0
  }

  // Headline check: does our derived ending tie to the file's stated ending?
  const endClose = ymKeys.length ? ending(ymKeys[ymKeys.length - 1]) - fEnding(ymKeys[ymKeys.length - 1]) : 0
  const endTies = Math.abs(endClose) <= MAT

  return (
    <div className="cfm-cfg">
      <div className="cfm-cfg-head">
        <div className="cfm-cfg-years">
          {data.years.map(y => (
            <button key={y} className={`cfm-cfg-year ${y === year ? 'is-on' : ''}`} onClick={() => setYear(y)}>{y}</button>
          ))}
        </div>
        <div className="cfm-cfg-head-right">
          <span className={`cfm-cfg-tie ${endTies ? 'is-ok' : 'is-off'}`}>
            {endTies ? '✓ Ending ties the file' : `Ending Δ ${fmtAcct(endClose)} vs file`}
          </span>
          <div className="cfm-cfg-modes">
            <button className={`cfm-cfg-mode ${!compare ? 'is-on' : ''}`} onClick={() => setCompare(false)}>Values</button>
            <button className={`cfm-cfg-mode ${compare ? 'is-on' : ''}`} onClick={() => setCompare(true)}>Compare to file</button>
          </div>
          <span className="cfm-cfg-cur">{data.area} · {cur}</span>
        </div>
      </div>

      <div className="cfm-cfg-note">
        {compare
          ? 'Each cell is our figure minus the file’s own stated figure — highlighted where they differ. Scan for the highlighted section + month to trace where an ending variance comes from (drilling to the exact project is a later step).'
          : 'All balances are running balances — only the first value of each comes from the file, then rolled forward by movements. Switch to Compare to file to check every line against the original Excel.'}
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
                  const v = cellVal(r, m.ym)
                  const tie = Math.abs(v) <= MAT
                  const isVar = compare && !tie
                  return (
                    <td key={m.ym} className={`num ${v < 0 ? 'neg' : ''} ${m.kind === 'forecast' ? 'is-fc' : ''} ${m.ym === firstFcYm ? 'is-cut' : ''} ${isVar ? 'is-var' : ''}`}>
                      {(compare ? tie : v === 0) ? '·' : fmtAcct(v)}
                    </td>
                  )
                })}
                {(() => { const t = rowTotal(r); const isVar = compare && Math.abs(t) > MAT
                  return <td className={`num cfm-cfg-total ${t < 0 ? 'neg' : ''} ${isVar ? 'is-var' : ''}`}>{(compare && Math.abs(t) <= MAT) ? '·' : fmtAcct(t)}</td> })()}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* Sheets — the interactive include/ignore control. Every parseable sheet in the
   workbook is listed; move one between INCLUDED (summed into the statement above)
   and IGNORED to fix what's counted. The grid + "ties the file" badge recompute
   after each move. JV sheets are equity-accounted and never summed, so they're
   shown for reference only, not as toggles. */
const ROLE_LABEL: Record<string, string> = {
  assigned: 'project', unassigned: 'project?', area_item: 'area item', rollup: 'rollup',
}
const ROLE_CLS: Record<string, string> = {
  assigned: 'is-ok', unassigned: 'is-warn', area_item: 'is-area', rollup: 'is-mute',
}

function SheetsPanel({ sheets, included, compareTarget, onToggle }: {
  sheets: SheetMeta[]
  included: Set<string>
  compareTarget?: string | null
  onToggle: (sheet: string, next: boolean) => void
}) {
  if (!sheets?.length) return null
  const toggleable = sheets.filter(s => !s.is_jv)
  const inc = toggleable.filter(s => included.has(s.sheet))
  const ign = toggleable.filter(s => !included.has(s.sheet))

  const Chip = ({ s, on }: { s: SheetMeta; on: boolean }) => {
    const role = ROLE_LABEL[s.role] || s.role
    const tip = `${role}${s.name && s.name !== s.sheet ? ` → ${s.name}` : ''} · `
      + (on ? 'click to ignore' : 'click to include')
    return (
      <button className={`cfm-shx-chip ${on ? 'is-in' : 'is-out'}`}
              onClick={() => onToggle(s.sheet, !on)} title={tip}>
        <span className={`cfm-shx-dot ${ROLE_CLS[s.role] || 'is-mute'}`} />
        <span className="cfm-shx-sheet">{s.sheet}</span>
        <span className="cfm-shx-arrow">{on ? '✕' : '＋'}</span>
      </button>
    )
  }

  return (
    <div className="cfm-shx">
      <div className="cfm-shx-cap">
        These are the workbook's sheets. <b>Included</b> sheets are summed into the
        statement above; move sheets across until it ties the file. The grid and the
        “ties the file” check refresh after each move.
        {compareTarget && <> Reconciling to <b>{compareTarget}</b> — the file's own total.</>}
      </div>
      <div className="cfm-shx-cols">
        <div className="cfm-shx-col">
          <div className="cfm-shx-h">
            <span className="cfm-shp-dot is-ok" />Included
            <span className="cfm-shp-n">{inc.length}</span>
          </div>
          <div className="cfm-shx-list">
            {inc.length ? inc.map(s => <Chip key={s.sheet} s={s} on={true} />)
              : <div className="cfm-shp-empty">None included</div>}
          </div>
        </div>
        <div className="cfm-shx-col">
          <div className="cfm-shx-h">
            <span className="cfm-shp-dot is-mute" />Ignored
            <span className="cfm-shp-n">{ign.length}</span>
          </div>
          <div className="cfm-shx-list">
            {ign.length ? ign.map(s => <Chip key={s.sheet} s={s} on={false} />)
              : <div className="cfm-shp-empty">None</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

/* Actuals integrity — what a push would restate, as a grid mirroring the cash-flow
   statement above: months as columns, sections as rows, comparing the stored actual
   against this file's would-be figure. Cells a push would restate (a stored actual
   already exists and differs) are highlighted. Only renders when there are stored
   actuals to compare against. */
type AdRow = { key: string; label: string; comp?: string[]; type: 'flow' | 'net' }
const AD_ROWS: AdRow[] = [
  { key: 'oper_rec', label: 'Receipts — operations', type: 'flow' },
  { key: 'oper_pay', label: 'Payments — operations', type: 'flow' },
  { key: 'oper_net', label: 'Net — operations', comp: ['oper_rec', 'oper_pay'], type: 'net' },
  { key: 'interest', label: 'Interest', type: 'flow' },
  { key: 'nonop', label: 'Non-operational', type: 'flow' },
  { key: 'wg', label: 'Within group', type: 'flow' },
  { key: 'bank', label: 'Bank financing', type: 'flow' },
  { key: 'net_move', label: 'Net movement', comp: ['oper_rec', 'oper_pay', 'interest', 'nonop', 'wg', 'bank'], type: 'net' },
]

function ActualsDiff({ data, cur }: { data: ActualsDiffData | null; cur: string }) {
  const [open, setOpen] = useState(false)
  const [year, setYear] = useState<number | null>(null)
  const [mode, setMode] = useState<'delta' | 'staged' | 'stored'>('delta')

  useEffect(() => {
    if (!data?.years?.length) return
    setYear(prev => (prev != null && data.years.includes(prev)) ? prev : data.years[data.years.length - 1])
  }, [data])

  if (!data || !data.has_stored) return null
  const MAT = 0.5
  const yd = year != null ? data.by_year[String(year)] : null
  const months = yd?.months || []
  const ymKeys = months.map(m => m.ym)
  const at = (m: Record<string, number> | null | undefined, ym: string) => Number(m?.[ym] ?? 0)
  const has = (set: Record<string, Record<string, number> | null>, key: string, ym: string) =>
    set?.[key]?.[ym] != null
  // section value for a row (sum its components for derived rows)
  const valOf = (set: Record<string, Record<string, number> | null>, r: AdRow, ym: string) =>
    (r.comp ?? [r.key]).reduce((s, k) => s + at(set?.[k], ym), 0)
  // a cell "would restate" if a stored actual exists for it and it differs materially
  const isRestate = (r: AdRow, ym: string) => {
    if (!yd) return false
    const keys = r.comp ?? [r.key]
    const storedExists = keys.some(k => has(yd.stored, k, ym))
    return storedExists && Math.abs(valOf(yd.staged, r, ym) - valOf(yd.stored, r, ym)) > MAT
  }
  const cellVal = (r: AdRow, ym: string) => {
    if (!yd) return 0
    const sg = valOf(yd.staged, r, ym), st = valOf(yd.stored, r, ym)
    return mode === 'staged' ? sg : mode === 'stored' ? st : sg - st
  }
  const rowTotal = (r: AdRow) => ymKeys.reduce((s, ym) => s + cellVal(r, ym), 0)

  return (
    <div className="cfm-sr-actuals">
      <button className="cfm-sr-toggle is-warn" onClick={() => setOpen(o => !o)}>
        <span className="cfm-sr-caret">{open ? '▾' : '▸'}</span>
        Actuals that would change ({fmt(data.n_changed)})
      </button>
      {open && yd && (
        <div className="cfm-cfg cfm-cfg-actuals">
          <div className="cfm-cfg-head">
            <div className="cfm-cfg-years">
              {data.years.map(y => (
                <button key={y} className={`cfm-cfg-year ${y === year ? 'is-on' : ''}`} onClick={() => setYear(y)}>{y}</button>
              ))}
            </div>
            <div className="cfm-cfg-head-right">
              <div className="cfm-cfg-modes">
                <button className={`cfm-cfg-mode ${mode === 'delta' ? 'is-on' : ''}`} onClick={() => setMode('delta')}>Δ restate</button>
                <button className={`cfm-cfg-mode ${mode === 'staged' ? 'is-on' : ''}`} onClick={() => setMode('staged')}>This file</button>
                <button className={`cfm-cfg-mode ${mode === 'stored' ? 'is-on' : ''}`} onClick={() => setMode('stored')}>Stored</button>
              </div>
              <span className="cfm-cfg-cur">{data.area} · {cur}</span>
            </div>
          </div>
          <div className="cfm-cfg-note">
            A push promotes elapsed periods to actuals. Highlighted cells already hold a
            different stored actual and would be <b>restated</b>. {mode === 'delta'
              ? 'Showing this file minus the stored actual.'
              : mode === 'staged' ? "Showing this file's figures." : 'Showing the stored actuals.'}
            {data.n_changed > 8 ? ' Most cells differing usually means a currency/basis mismatch with the stored actuals, not real restatements.' : ''}
          </div>
          <div className="cfm-cfg-scroll">
            <table className="cfm-cfg-table">
              <thead>
                <tr>
                  <th className="cfm-cfg-rowhead">Section</th>
                  {months.map(m => <th key={m.ym} className="num">{MON[m.m]}</th>)}
                  <th className="num cfm-cfg-total">Total</th>
                </tr>
              </thead>
              <tbody>
                {AD_ROWS.map(r => (
                  <tr key={r.key} className={`cfm-cfg-row is-${r.type}`}>
                    <td className="cfm-cfg-rowhead">{r.label}</td>
                    {months.map(m => {
                      const v = cellVal(r, m.ym)
                      const restate = isRestate(r, m.ym)
                      return (
                        <td key={m.ym} className={`num ${v < 0 ? 'neg' : ''} ${restate ? 'is-var' : ''}`}>
                          {v === 0 && !restate ? '·' : fmtAcct(v)}
                        </td>
                      )
                    })}
                    {(() => { const t = rowTotal(r)
                      return <td className={`num cfm-cfg-total ${t < 0 ? 'neg' : ''}`}>{t === 0 ? '·' : fmtAcct(t)}</td> })()}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

/* Lines the parser couldn't map onto the canonical chart — aggregated across the
   currently INCLUDED sheets only (ignore a sheet and its dropped lines go with it).
   Each can be mapped to a canonical line so the next upload catches it. */
function UnmatchedLabels({ unmatchedBySheet, included, lines, canManage }: {
  unmatchedBySheet?: Record<string, Record<string, { count: number; cells?: string[] } | number>>
  included: Set<string>
  lines: LineCat[]
  canManage: boolean
}) {
  const [open, setOpen] = useState(false)
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [done, setDone] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  // aggregate label -> {count, locations} over INCLUDED sheets only
  const agg: Record<string, { count: number; locations: string[] }> = {}
  for (const [sheet, labels] of Object.entries(unmatchedBySheet || {})) {
    if (!included.has(sheet)) continue
    for (const [lab, v] of Object.entries(labels)) {
      const count = typeof v === 'number' ? v : (v?.count ?? 0)
      const cells = typeof v === 'number' ? [] : (v?.cells ?? [])
      const a = (agg[lab] ||= { count: 0, locations: [] })
      a.count += count
      for (const c of cells) {
        const loc = String(c).includes('!') ? String(c) : `${sheet}!${c}`
        if (a.locations.length < 8 && !a.locations.includes(loc)) a.locations.push(loc)
      }
    }
  }
  const entries = Object.entries(agg).sort((a, b) => b[1].count - a[1].count)
  if (entries.length === 0) return null

  const mapLabel = async (label: string) => {
    const code = picks[label]
    if (!code) return
    setBusy(label)
    const { error } = await supabase.rpc('cf_map_line_alias',
      { p_alias: label, p_line_code: code, p_notes: 'mapped in staging' })
    setBusy(null)
    if (error) { alert('Map failed: ' + error.message); return }
    setDone(d => ({ ...d, [label]: code }))
  }

  return (
    <div className="cfm-unmatched">
      <button className="cfm-sr-toggle is-warn" onClick={() => setOpen(o => !o)}>
        <span className="cfm-sr-caret">{open ? '▾' : '▸'}</span>
        Lines that didn't map ({entries.length})
      </button>
      {open && (
        <div className="cfm-unmatched-body">
          <div className="cfm-sr-cap cfm-sr-cap-sm">
            Rows in the <b>included</b> sheets the parser dropped (no canonical line matched).
            Map each to a line so it's caught on the next upload. Mapping takes effect when the file is re-staged.
          </div>
          <div className="cfm-unmatched-list">
            {entries.map(([lab, info]) => {
              const mappedCode = done[lab]
              return (
                <div key={lab} className={`cfm-unmatched-row ${mappedCode ? 'is-mapped' : ''}`}>
                  <div className="cfm-unmatched-id">
                    <span className="cfm-unmatched-label" title={`${info.count}×`}>
                      {lab}{info.count > 1 ? ` ×${info.count}` : ''}
                    </span>
                    {info.locations.length > 0 && (
                      <span className="cfm-unmatched-locs">
                        {info.locations.map(loc => (
                          <span key={loc} className="cfm-loc-pill" title="Sheet ! cell in the source file">{loc}</span>
                        ))}
                      </span>
                    )}
                  </div>
                  {mappedCode ? (
                    <span className="cfm-unmatched-mapped">→ {mappedCode} ✓</span>
                  ) : canManage ? (
                    <span className="cfm-unmatched-map">
                      <select value={picks[lab] || ''} onChange={e => setPicks(p => ({ ...p, [lab]: e.target.value }))}>
                        <option value="">Map to…</option>
                        {lines.map(l => (
                          <option key={l.line_code} value={l.line_code}>
                            {l.category} · {l.nature} · {l.description}
                          </option>
                        ))}
                      </select>
                      <button className="cfm-btn cfm-btn-ghost cfm-btn-sm"
                              disabled={!picks[lab] || busy === lab} onClick={() => mapLabel(lab)}>
                        {busy === lab ? '…' : 'Map'}
                      </button>
                    </span>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
