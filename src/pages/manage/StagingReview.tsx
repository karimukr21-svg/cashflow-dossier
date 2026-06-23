import { useState, useEffect, Fragment } from 'react'
import { supabase } from '@/lib/supabase'

/* StagingReview — the confidence check a Treasury user reads BEFORE pushing a
   staged import run. Balances first, then per-line movement (with per-month
   expand to catch month-shifting), then the projects that were summed in.
   Self-contained: fetches its own review + project data. */

type Month = { year: number; month: number }
type ByMonth = Record<string, number>
type Line = {
  line_code: string
  category: string
  nature: string
  sort_order: number
  actual: number | null
  forecast: number | null
  total: number | null
  by_month: ByMonth
}
type SheetClassification = {
  target: string | null
  summed: string[]
  ignored: string[]
} | null
type Review = {
  area: string
  currency: string
  current_year: number
  n_periods: number
  // 'rollup' = opening/closing read verbatim from the area's own rollup balance row
  // (basis B); 'projects' = summed from the project sheets (single-entity / no rollup).
  opening_basis: 'rollup' | 'projects'
  sheet_classification: SheetClassification
  months: Month[]
  balances: { opening: number; net_movement: number; closing_derived: number; ending_stored: number }
  monthly: { ym: string; net: number; running_close: number; ending_stored: number }[]
  lines: Line[]
}
type Project = {
  project_code: string
  display_name: string | null
  is_jv: boolean
  is_area_item: boolean
  gacc_linked: boolean
  net: number | null
  n_rows: number
}
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
// Subset of the cf_import_runs row the verdict banner reads.
type RunSummary = {
  recon_status?: string; recon_n_breaks?: number
  n_unmatched_labels?: number; n_projects?: number; n_projects_new?: number
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

function ymKey(m: Month) {
  return `${m.year}-${String(m.month).padStart(2, '0')}`
}

function ymShort(key: string) {
  // "2026-05" -> "May 26"
  const [y, mo] = key.split('-')
  const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[Number(mo)] || mo} ${y.slice(2)}`
}

export default function StagingReview(
  { runId, currency, run }: { runId: string; currency: string; run?: RunSummary }
) {
  const [review, setReview] = useState<Review | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [actualsDiff, setActualsDiff] = useState<ActualsDiffData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    Promise.all([
      supabase.rpc('cf_run_review', { p_run_id: runId }),
      supabase.rpc('cf_run_projects', { p_run_id: runId }),
      supabase.rpc('cf_run_actuals_diff', { p_run_id: runId }),
    ])
      .then(([rev, proj, adiff]) => {
        if (!alive) return
        if (rev.error) throw rev.error
        if (proj.error) throw proj.error
        setReview(unwrap<Review>(rev.data))
        const ps = Array.isArray(proj.data) ? proj.data : proj.data ? [proj.data] : []
        setProjects(ps as Project[])
        if (!adiff.error) setActualsDiff(unwrap<ActualsDiffData>(adiff.data))
      })
      .catch((e: any) => { if (alive) setError(String(e?.message || e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [runId])

  if (loading) return <div className="cfm-empty-sm">Loading staging review…</div>
  if (error) return <div className="cfm-sr-error">Review failed: {error}</div>
  if (!review) return <div className="cfm-empty-sm">No review data.</div>

  const cur = review.currency || currency
  const b = review.balances

  return (
    <div className="cfm-sr">
      {/* 0. Verdict — the glance: is this file safe to push? */}
      <VerdictBanner run={run} actualsDiff={actualsDiff} cur={cur} />

      {/* 1. The area cash-flow statement, reconstructed from the staged run —
          months as columns, sections as rows, bracketed by the rollup's own
          opening/ending balance. Year switcher for prior years. */}
      <CashflowGrid runId={runId} currency={cur} />
      <SheetClassificationLine sc={review.sheet_classification} />

      {/* 2. Per-line movement — the core (current year) */}
      <LineMovement lines={review.lines} months={review.months} grandTotal={b.net_movement} cur={cur} year={review.current_year} />

      {/* 2b. Actuals integrity — would the push restate frozen history? */}
      <ActualsDiff data={actualsDiff} cur={cur} />

      {/* 3. Projects extracted — collapsible */}
      <ProjectsExtracted runId={runId} projects={projects} months={review.months} cur={cur} />
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

/* Which sheets were summed into the area cash flow, which were ignored (rollups /
   helper tabs / junk), and which is the reconciliation target. The safety net for
   the auto-classification: the reviewer can see at a glance what went in. */
function SheetClassificationLine({ sc }: { sc: SheetClassification }) {
  const [open, setOpen] = useState(false)
  if (!sc) return null
  return (
    <div className="cfm-sr-sheets">
      <button className="cfm-sr-sheets-toggle" onClick={() => setOpen(o => !o)}>
        <span className="cfm-sr-sheets-caret">{open ? '▾' : '▸'}</span>
        Sheets: <strong>{sc.summed.length}</strong> summed · <strong>{sc.ignored.length}</strong> ignored
        {sc.target && <> · target <strong>{sc.target}</strong></>}
      </button>
      {open && (
        <div className="cfm-sr-sheets-body">
          <div className="cfm-sr-sheets-col">
            <div className="cfm-sr-sheets-h">Summed into the area ({sc.summed.length})</div>
            <div className="cfm-sr-sheets-list">{sc.summed.join(' · ') || '—'}</div>
          </div>
          <div className="cfm-sr-sheets-col">
            <div className="cfm-sr-sheets-h">Ignored — rollups / helpers / junk ({sc.ignored.length})</div>
            <div className="cfm-sr-sheets-list cfm-sr-sheets-muted">{sc.ignored.join(' · ') || '—'}</div>
          </div>
        </div>
      )}
    </div>
  )
}

/* The per-line table, grouped by category, with per-month expand. Reused for
   both the area review and per-project detail (showActFc toggles the
   Actual/Forecast columns; project detail shows Total only). */
function LineMovement({
  lines, months, grandTotal, cur, showActFc = true, title, year,
}: {
  lines: Line[]
  months: Month[]
  grandTotal?: number
  cur: string
  showActFc?: boolean
  title?: string
  year?: number
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  // Category groups start COLLAPSED — the reviewer opens a section to drill in.
  const [openCats, setOpenCats] = useState<Set<string>>(new Set())
  const monthKeys = months.map(ymKey)

  const toggle = (code: string) =>
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })

  const toggleCat = (category: string) =>
    setOpenCats(prev => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })

  // Group lines by category, preserving sort_order.
  const groups: { category: string; lines: Line[]; subtotal: number; subActual: number; subForecast: number }[] = []
  const byCat = new Map<string, Line[]>()
  for (const ln of lines) {
    const arr = byCat.get(ln.category)
    if (arr) arr.push(ln)
    else byCat.set(ln.category, [ln])
  }
  for (const [category, ls] of byCat) {
    const subtotal = ls.reduce((s, l) => s + (Number(l.total) || 0), 0)
    const subActual = ls.reduce((s, l) => s + (Number(l.actual) || 0), 0)
    const subForecast = ls.reduce((s, l) => s + (Number(l.forecast) || 0), 0)
    groups.push({ category, lines: ls, subtotal, subActual, subForecast })
  }

  const colSpan = showActFc ? 4 : 2

  return (
    <div className="cfm-sr-lines">
      <div className="cfm-sr-section-head">
        {title || `Per-line movement${year ? ` · ${year}` : ''}`}
        <span className="cfm-sr-asparsed">as parsed · finalized at push</span>
      </div>
      <table className="cfm-sr-table">
        <thead>
          <tr>
            <th>Line</th>
            {showActFc && <th className="num">Actual</th>}
            {showActFc && <th className="num">Forecast</th>}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(g => {
            const catOpen = openCats.has(g.category)
            return (
            <Fragment key={`cat-${g.category}`}>
              <tr className={`cfm-sr-cat ${catOpen ? 'is-open' : ''}`} onClick={() => toggleCat(g.category)}>
                <td>
                  <span className="cfm-sr-caret">{catOpen ? '▾' : '▸'}</span>
                  {g.category}
                  <span className="cfm-sr-cat-n">{g.lines.length}</span>
                </td>
                {showActFc && <td className={`num ${g.subActual < 0 ? 'neg' : ''}`}>{fmtAcct(g.subActual)}</td>}
                {showActFc && <td className={`num ${g.subForecast < 0 ? 'neg' : ''}`}>{fmtAcct(g.subForecast)}</td>}
                <td className={`num ${g.subtotal < 0 ? 'neg' : ''}`}>{fmtAcct(g.subtotal)}</td>
              </tr>
              {catOpen && g.lines.map(ln => {
                const isOpen = open.has(ln.line_code)
                return (
                  <Fragment key={ln.line_code}>
                    <tr
                      className={`cfm-sr-line ${isOpen ? 'is-open' : ''}`}
                      onClick={() => toggle(ln.line_code)}
                    >
                      <td>
                        <span className="cfm-sr-caret">{isOpen ? '▾' : '▸'}</span>
                        <span className="mono">{ln.line_code}</span>
                      </td>
                      {showActFc && <td className={`num ${Number(ln.actual) < 0 ? 'neg' : ''}`}>{fmtAcct(ln.actual)}</td>}
                      {showActFc && <td className={`num ${Number(ln.forecast) < 0 ? 'neg' : ''}`}>{fmtAcct(ln.forecast)}</td>}
                      <td className={`num ${Number(ln.total) < 0 ? 'neg' : ''}`}>{fmtAcct(ln.total)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="cfm-sr-strip-row">
                        <td colSpan={colSpan}>
                          <div className="cfm-sr-strip">
                            {monthKeys.map(k => {
                              const v = ln.by_month?.[k]
                              return (
                                <div key={k} className="cfm-sr-cell">
                                  <span className="cfm-sr-cell-ym">{ymShort(k)}</span>
                                  <span className={`cfm-sr-cell-val ${Number(v) < 0 ? 'neg' : ''}`}>{fmtAcct(v ?? 0)}</span>
                                </div>
                              )
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </Fragment>
          )})}
          {grandTotal != null && (
            <tr className="cfm-sr-grand">
              <td>Net movement</td>
              {showActFc && <td />}
              {showActFc && <td />}
              <td className={`num ${grandTotal < 0 ? 'neg' : ''}`}>{fmtAcct(grandTotal)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="cfm-sr-cap cfm-sr-cap-sm">
        Expand a line to see its month-by-month split — the check for month-shifting. {cur}.
      </div>
    </div>
  )
}

function ProjectsExtracted({
  runId, projects, months, cur,
}: {
  runId: string
  projects: Project[]
  months: Month[]
  cur: string
}) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, { loading: boolean; lines: Line[] }>>({})

  const loadProject = async (code: string) => {
    if (picked === code) { setPicked(null); return }
    setPicked(code)
    if (detail[code]) return
    setDetail(d => ({ ...d, [code]: { loading: true, lines: [] } }))
    const { data, error } = await supabase.rpc('cf_run_project_detail', { p_run_id: runId, p_project: code })
    if (error) {
      setDetail(d => ({ ...d, [code]: { loading: false, lines: [] } }))
      return
    }
    const row = unwrap<{ lines: Line[] }>(data)
    setDetail(d => ({ ...d, [code]: { loading: false, lines: row?.lines || [] } }))
  }

  return (
    <div className="cfm-sr-projects">
      <button className="cfm-sr-toggle" onClick={() => setOpen(o => !o)}>
        <span className="cfm-sr-caret">{open ? '▾' : '▸'}</span>
        Projects ({projects.length})
      </button>
      {open && (
        <div className="cfm-sr-proj-body">
          <div className="cfm-sr-cap cfm-sr-cap-sm">
            These are the projects whose sheets were summed into the area cash flow above.
          </div>
          <table className="cfm-sr-table cfm-sr-proj-table">
            <thead>
              <tr>
                <th>Project</th>
                <th className="num">Net</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {projects.map(p => {
                const isOpen = picked === p.project_code
                const dt = detail[p.project_code]
                return (
                  <Fragment key={p.project_code}>
                    <tr
                      className={`cfm-sr-proj-row ${isOpen ? 'is-open' : ''}`}
                      onClick={() => loadProject(p.project_code)}
                    >
                      <td>
                        <span className="cfm-sr-caret">{isOpen ? '▾' : '▸'}</span>
                        <span className="mono">{p.display_name || p.project_code}</span>
                      </td>
                      <td className={`num ${Number(p.net) < 0 ? 'neg' : ''}`}>{fmt(p.net)}</td>
                      <td>
                        <span className="cfm-sr-badges">
                          {p.is_jv && <span className="cfm-sr-pill is-jv">JV</span>}
                          {p.is_area_item && <span className="cfm-sr-pill is-area">area item</span>}
                          {p.gacc_linked
                            ? <span className="cfm-sr-pill is-linked">linked</span>
                            : <span className="cfm-sr-pill is-new">new</span>}
                        </span>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="cfm-sr-proj-detail-row">
                        <td colSpan={3}>
                          {dt?.loading && <div className="cfm-empty-sm">Loading project lines…</div>}
                          {dt && !dt.loading && dt.lines.length === 0 && (
                            <div className="cfm-empty-sm">No lines for this project.</div>
                          )}
                          {dt && !dt.loading && dt.lines.length > 0 && (
                            <LineMovement
                              lines={dt.lines}
                              months={months}
                              cur={cur}
                              showActFc={false}
                              title={`${p.display_name || p.project_code} — lines`}
                            />
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* The glance: four checks that decide "safe to push?" — extraction faithfulness
   (Σ projects vs the file's own total page), actuals integrity (frozen history
   unchanged), all lines bucketed, projects linked. Reads run-summary fields the
   stage step already computed + the live actuals diff. */
type Chip = { key: string; label: string; tone: 'ok' | 'warn' | 'neutral'; hint?: string }

function VerdictBanner(
  { run, actualsDiff, cur }: { run?: RunSummary; actualsDiff: ActualsDiffData | null; cur: string }
) {
  const chips: Chip[] = []

  // 1. Extraction faithful — Σ project sheets vs the file's own total page.
  const rs = run?.recon_status
  const breaks = run?.recon_n_breaks ?? 0
  if (rs === 'tie') chips.push({ key: 'extract', label: 'Extraction ties to file total', tone: 'ok' })
  else if (rs === 'break') chips.push({ key: 'extract', label: `${breaks} reconciliation break${breaks === 1 ? '' : 's'}`, tone: 'warn', hint: "Σ project sheets ≠ the file's own total page — drill the reconciliation below" })
  else if (rs === 'no_total' || rs === 'single_area') chips.push({ key: 'extract', label: 'No area total to check against', tone: 'neutral' })
  else chips.push({ key: 'extract', label: 'Extraction not checked', tone: 'neutral' })

  // 2. Actuals integrity — a push must not restate frozen history.
  if (actualsDiff) {
    const { n_changed, n_staged_actual_keys, n_existing_actual_keys } = actualsDiff
    if (n_existing_actual_keys === 0) chips.push({ key: 'hist', label: 'No prior actuals to disturb', tone: 'ok' })
    else if (n_changed === 0) chips.push({ key: 'hist', label: 'History preserved', tone: 'ok' })
    else {
      const ratio = n_staged_actual_keys ? n_changed / n_staged_actual_keys : 0
      chips.push({
        key: 'hist',
        label: `${fmt(n_changed)} prior actual${n_changed === 1 ? '' : 's'} would change`,
        tone: 'warn',
        hint: ratio > 0.5
          ? `Most actuals differ — usually a currency/basis mismatch with the stored actuals, not real restatements (${cur}).`
          : 'A push should not restate frozen history — check these below.',
      })
    }
  }

  // 3. Lines all bucketed — unmatched labels are DROPPED from staging.
  const unmatched = run?.n_unmatched_labels ?? 0
  if (unmatched === 0) chips.push({ key: 'lines', label: 'All lines bucketed', tone: 'ok' })
  else chips.push({ key: 'lines', label: `${unmatched} line${unmatched === 1 ? '' : 's'} unmapped`, tone: 'warn', hint: 'These were dropped — map them below so the parser catches them next upload' })

  // 4. Projects (new ones are staged but not yet linked to the catalog).
  const nProj = run?.n_projects ?? 0
  const nNew = run?.n_projects_new ?? 0
  if (nNew > 0) chips.push({ key: 'proj', label: `${nProj} project${nProj === 1 ? '' : 's'} · ${nNew} new`, tone: 'warn', hint: 'New projects are staged but not yet in the catalog' })
  else if (nProj > 0) chips.push({ key: 'proj', label: `${nProj} project${nProj === 1 ? '' : 's'} linked`, tone: 'ok' })

  // "Safe to push" = extraction not broken, history clean, no dropped lines.
  // New projects don't block (their data is kept) — they're just informational.
  const extractOk = rs !== 'break'
  const histOk = !actualsDiff || actualsDiff.n_changed === 0 || actualsDiff.n_existing_actual_keys === 0
  const linesOk = unmatched === 0
  const safe = extractOk && histOk && linesOk

  return (
    <div className={`cfm-verdict-banner ${safe ? 'is-safe' : 'is-review'}`}>
      <div className="cfm-vb-head">
        <span className="cfm-vb-dot" />
        {safe ? 'Safe to push' : 'Review before pushing'}
      </div>
      <div className="cfm-vb-chips">
        {chips.map(c => (
          <span key={c.key} className={`cfm-vb-chip tone-${c.tone}`} title={c.hint || ''}>
            <span className="cfm-vb-chip-mark">{c.tone === 'ok' ? '✓' : c.tone === 'warn' ? '!' : '–'}</span>
            {c.label}
          </span>
        ))}
      </div>
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
