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
type Review = {
  area: string
  currency: string
  current_year: number
  n_periods: number
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
  const endingZero = b.ending_stored === 0
  const driftFlag = !endingZero && Math.abs(b.closing_derived - b.ending_stored) > 1

  return (
    <div className="cfm-sr">
      {/* 0. Verdict — the glance: is this file safe to push? */}
      <VerdictBanner run={run} actualsDiff={actualsDiff} cur={cur} />

      {/* 1. Balance tiles — the headline */}
      <div className="cfm-sr-tiles">
        <Tile label="Opening" value={b.opening} cur={cur} />
        <Tile label="Net movement" value={b.net_movement} cur={cur} />
        <Tile label="Closing (derived)" value={b.closing_derived} cur={cur} accent />
        <Tile label="File ending (last month)" value={b.ending_stored} cur={cur} />
      </div>
      <div className="cfm-sr-cap">
        Current year {review.current_year} · area cash flow from project sheets · {review.n_periods} months · {cur}
      </div>
      {endingZero && (
        <div className="cfm-sr-note">
          File carries no closing balance in the final forecast period.
        </div>
      )}
      {driftFlag && (
        <div className="cfm-sr-note cfm-sr-note-amber">
          Derived closing ≠ file ending — worth a look.
        </div>
      )}

      {/* 2. Per-line movement — the core (current year) */}
      <LineMovement lines={review.lines} months={review.months} grandTotal={b.net_movement} cur={cur} year={review.current_year} />

      {/* 2b. Actuals integrity — would the push restate frozen history? */}
      <ActualsDiff data={actualsDiff} cur={cur} />

      {/* 3. Projects extracted — collapsible */}
      <ProjectsExtracted runId={runId} projects={projects} months={review.months} cur={cur} />
    </div>
  )
}

function Tile({ label, value, cur, accent }: { label: string; value: number; cur: string; accent?: boolean }) {
  const neg = Number(value) < 0
  return (
    <div className={`cfm-sr-tile ${accent ? 'is-accent' : ''}`}>
      <span className="cfm-sr-tile-label">{label}</span>
      <span className={`cfm-sr-tile-val ${neg ? 'neg' : ''}`}>{fmt(value)}</span>
      <span className="cfm-sr-tile-cur">{cur}</span>
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
  const monthKeys = months.map(ymKey)

  const toggle = (code: string) =>
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })

  // Group lines by category, preserving sort_order.
  const groups: { category: string; lines: Line[]; subtotal: number }[] = []
  const byCat = new Map<string, Line[]>()
  for (const ln of lines) {
    const arr = byCat.get(ln.category)
    if (arr) arr.push(ln)
    else byCat.set(ln.category, [ln])
  }
  for (const [category, ls] of byCat) {
    const subtotal = ls.reduce((s, l) => s + (Number(l.total) || 0), 0)
    groups.push({ category, lines: ls, subtotal })
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
          {groups.map(g => (
            <Fragment key={`cat-${g.category}`}>
              <tr className="cfm-sr-cat">
                <td>{g.category}</td>
                {showActFc && <td />}
                {showActFc && <td />}
                <td className={`num ${g.subtotal < 0 ? 'neg' : ''}`}>{fmt(g.subtotal)}</td>
              </tr>
              {g.lines.map(ln => {
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
                      {showActFc && <td className={`num ${Number(ln.actual) < 0 ? 'neg' : ''}`}>{fmt(ln.actual)}</td>}
                      {showActFc && <td className={`num ${Number(ln.forecast) < 0 ? 'neg' : ''}`}>{fmt(ln.forecast)}</td>}
                      <td className={`num ${Number(ln.total) < 0 ? 'neg' : ''}`}>{fmt(ln.total)}</td>
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
                                  <span className={`cfm-sr-cell-val ${Number(v) < 0 ? 'neg' : ''}`}>{fmt(v ?? 0)}</span>
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
          ))}
          {grandTotal != null && (
            <tr className="cfm-sr-grand">
              <td>Net movement</td>
              {showActFc && <td />}
              {showActFc && <td />}
              <td className={`num ${grandTotal < 0 ? 'neg' : ''}`}>{fmt(grandTotal)}</td>
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
