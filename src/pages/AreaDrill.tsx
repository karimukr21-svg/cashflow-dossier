import { Fragment, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchActuals, fetchForecasts, fetchFxRate, type CfCell, type CfLine } from '@/lib/queries'
import { classNum } from '@/lib/format'
import { EditableCell } from '@/components/EditableCell'
import { computeDerivedBalances, getColumnYMEndpoints } from '@/lib/derivedBalances'
import { DispFmtCtx, useDisp, makeDisp, DENOM, type Denom, useTopbarExtras } from '@/lib/displayFmt'
import type { Scope, Grain, GroupBy } from './Dossier'

/* `area` is now the canonical area_id (e.g. 'KSA', 'ACR', 'CYP'). The
 * cf_areas list — Tony's labels in cf_actuals.area that fold into this
 * canonical area — comes from scope.areas[area_id]. */
export default function AreaDrill({ area, scope }: { area: string; scope: Scope }) {
  const [actuals, setActuals] = useState<(CfCell & { source_version: string; currency?: string })[]>([])
  const [forecasts, setForecasts] = useState<(CfCell & { version: string; currency?: string })[]>([])
  const [loading, setLoading] = useState(true)

  // Display currency + denomination (verify the figures against the source
  // Excel — native currency, in '000). Persisted so it carries across areas.
  const [ccy, setCcy] = useState<'local' | 'usd'>(() => (localStorage.getItem('dossier-area-ccy-v1') as 'local' | 'usd') || 'local')
  const [denom, setDenom] = useState<Denom>(() => (localStorage.getItem('dossier-area-denom-v1') as Denom) || 'u')
  const [fxRate, setFxRate] = useState<number | null>(null)
  useEffect(() => { try { localStorage.setItem('dossier-area-ccy-v1', ccy) } catch { /* ignore */ } }, [ccy])
  useEffect(() => { try { localStorage.setItem('dossier-area-denom-v1', denom) } catch { /* ignore */ } }, [denom])

  const canonical = scope.areas.find(a => a.area_id === area)
  const cfAreas = canonical?.cf_areas || []
  const titleLabel = canonical?.display_name || area

  useEffect(() => {
    if (cfAreas.length === 0) { setActuals([]); setForecasts([]); setLoading(false); return }
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const [a, f] = await Promise.all([
          fetchActuals({ fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth, cfAreas }),
          fetchForecasts({ version: scope.primaryVersion, fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth, cfAreas }),
        ])
        if (cancel) return
        setActuals(a); setForecasts(f)
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [area, scope.primaryVersion, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth, cfAreas.join('|')])

  // The area's native currency (from the fetched cells) and its FX→USD rate at
  // the cycle's as-of date. Local = raw native (no FX); USD = ×rate.
  const nativeCur = useMemo(
    () => [...actuals, ...forecasts].find(c => c.currency && c.currency !== 'USD')?.currency || 'USD',
    [actuals, forecasts])
  const selVer = scope.versions?.find(v => v.version_code === scope.primaryVersion)
  const asOfDate = selVer?.as_of_date || `${Math.floor(scope.latestActualYM / 100)}-${String(scope.latestActualYM % 100).padStart(2, '0')}-01`
  useEffect(() => {
    if (nativeCur === 'USD') { setFxRate(1); return }
    let cancel = false
    fetchFxRate(nativeCur, asOfDate).then(r => { if (!cancel) setFxRate(r) }).catch(() => { if (!cancel) setFxRate(null) })
    return () => { cancel = true }
  }, [nativeCur, asOfDate])

  const localAvail = nativeCur !== 'USD'
  const useUsd = ccy === 'usd' && localAvail && fxRate != null
  const rate = useUsd ? (fxRate as number) : 1
  const disp = useMemo(() => makeDisp(rate, denom), [rate, denom])
  const slot = useTopbarExtras()

  // Currency + denomination pills — rendered up in the Dossier top bar (Row 2,
  // next to Grain/Sections) via the slot; falls back to an inline bar if absent.
  const controls = (
    <>
      <div className="ctrl" style={{ marginLeft: 8 }}><label>Currency</label></div>
      <div className="pill-row">
        <button className={`pill-btn ${!useUsd ? 'active' : ''}`} disabled={!localAvail}
          onClick={() => setCcy('local')}
          title={localAvail ? 'Native currency, no FX — ties to the source Excel' : 'This area is already reported in USD'}
        >{localAvail ? nativeCur : 'Local'}</button>
        <button className={`pill-btn ${useUsd ? 'active' : ''}`} disabled={!localAvail || fxRate == null}
          onClick={() => setCcy('usd')}
          title={localAvail && fxRate == null ? 'No FX rate for this area/period' : 'Convert to USD at the cycle rate'}
        >USD</button>
      </div>
      <div className="ctrl" style={{ marginLeft: 8 }}><label>Units</label></div>
      <div className="pill-row">
        {(['m', 'k', 'u'] as Denom[]).map(d => (
          <button key={d} className={`pill-btn ${denom === d ? 'active' : ''}`} onClick={() => setDenom(d)}>{DENOM[d].btn}</button>
        ))}
      </div>
    </>
  )

  if (loading) return <div className="placeholder-box">Loading {titleLabel}…</div>
  if (!canonical) return <div className="placeholder-box">Unknown area: {area}</div>

  return (
    <div>
      <h1>{titleLabel}</h1>
      {canonical && canonical.cf_countries.length > 1 && (
        <div className="area-includes">
          <span className="area-includes-label">Includes</span>
          {canonical.cf_countries.map(c => (
            <span key={c} className="area-includes-chip">{c}</span>
          ))}
          <span className="area-includes-note">
            Source data folds at Tony's WriteUp level; country detail is not separately broken out below.
          </span>
        </div>
      )}

      {slot ? createPortal(controls, slot) : <div className="area-toolbar no-print">{controls}</div>}

      <DispFmtCtx.Provider value={disp}>
        <AreaCategoryCards
          actuals={actuals}
          forecasts={forecasts}
          lines={scope.lines}
          grain={scope.grain}
          scope={scope}
          groupBy={scope.groupBy}
          cfArea={cfAreas[0]}
        />
      </DispFmtCtx.Provider>
    </div>
  )
}

/* Column-alignment constants (apply to every section card on the page so
 * columns line up vertically across sections). */
const LABEL_COL_PX = 240
const PERIOD_COL_PX = 80
const TOTAL_COL_PX = 100

/* Persisted expand state for the area-page section/category rows.
 * Default = everything collapsed; the set holds only the keys Karim has
 * clicked open. Keyed by `${groupBy}|${blockKey}|sub:Receipts` or
 * `…|cat:Operation`. Shared across area drill + all-areas + every area
 * switch on purpose: if Karim expands Operations Payments somewhere,
 * it stays expanded when he navigates. */
const EXPANDED_STORAGE_KEY = 'dossier-area-expanded-v1'

function useExpandedSections() {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(EXPANDED_STORAGE_KEY)
      return new Set(raw ? JSON.parse(raw) : [])
    } catch { return new Set() }
  })
  const toggle = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try { localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...next])) } catch {}
      return next
    })
  }
  return { expanded, toggle }
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span style={{
      display: 'inline-block',
      width: 10,
      marginRight: 8,
      fontSize: 9,
      opacity: 0.65,
      transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
      transition: 'transform 0.15s ease',
    }}>▶</span>
  )
}

/* Section layout for the area page.
 *
 * Category mode is the structural default Karim locked 2026-06-05 (night):
 * Opening (top framing) → 6 flow sections (each with its own Receipts/Payments
 * subtotals and a Net row) → Closing Position band at the bottom.
 *
 * Claims rolls into Operations (single receipt line). New Sales stays on its
 * own because it carries both flow directions and its own interest/loans lines.
 */
type SectionKind = 'balance' | 'flow'
type SectionDef = { key: string; label: string; kind: SectionKind; categories: string[] }

const SECTIONS_BY_CATEGORY: SectionDef[] = [
  { key: 'opening', label: 'Opening Balance', kind: 'balance', categories: ['Opening Balance'] },
  { key: 'operations', label: 'Operations', kind: 'flow', categories: ['Operation', 'Claims'] },
  { key: 'newsales', label: 'New Sales', kind: 'flow', categories: ['New Sales'] },
  { key: 'interest', label: 'Interest', kind: 'flow', categories: ['Interest'] },
  { key: 'nonop', label: 'Non-Operational', kind: 'flow', categories: ['Non Operational'] },
  { key: 'wg', label: 'Within Group', kind: 'flow', categories: ['Within Group'] },
  { key: 'bf', label: 'Bank Financing', kind: 'flow', categories: ['Bank Financing'] },
  /* Cash closing only — derived from Opening + movements. Loans + OD are
   * separate balance tracks (not part of the cash chain) and live in
   * their own section below. */
  { key: 'closing', label: 'Cash Closing', kind: 'balance', categories: ['Ending Balance'] },
  { key: 'loansod', label: 'Loans & Overdrafts', kind: 'balance', categories: ['Accumulated Loans', 'Overdrafts'] },
]

type Column = {
  key: string; label: string;
  matches: (y: number, m: number) => boolean;
  isActual: boolean;
  /* Populated only on monthly grain — single concrete (year, month) the
   * column refers to. Used by EditableCell to write deltas to the right
   * coordinate. Undefined on quarterly/yearly aggregates (not editable). */
  singleMonth?: { year: number; month: number };
}

export function AreaCategoryCards({
  actuals, forecasts, lines, grain, scope, groupBy, cfArea,
}: {
  actuals: CfCell[];
  forecasts: CfCell[];
  lines: CfLine[];
  grain: Grain;
  scope: Pick<Scope, 'fromYear' | 'fromMonth' | 'toYear' | 'toMonth' | 'latestActualYM'>;
  groupBy: GroupBy;
  cfArea?: string;
}) {
  const { expanded, toggle } = useExpandedSections()

  const activeLines = useMemo(() =>
    lines.filter(l => l.is_active).sort((a, b) => a.sort_order - b.sort_order),
    [lines])

  const columns = useMemo(() => buildColumns(grain, scope, scope.latestActualYM),
    [grain, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth, scope.latestActualYM])

  /* Derived cash balance chain (Opening / Closing per month). Source values
   * for stored balance lines are ignored on display when the line is
   * categorized Opening Balance or Ending Balance — those rows show the
   * derived chain so closing[N] always equals opening[N] + movements[N]. */
  const lineByCode = useMemo(() => {
    const m = new Map<string, CfLine>()
    for (const l of lines) m.set(l.line_code, l)
    return m
  }, [lines])

  const derived = useMemo(() => {
    const cells: CfCell[] = []
    for (const c of actuals) {
      cells.push({ area: c.area, line_code: c.line_code, year: c.year, month: c.month,
        value: c.value })
    }
    for (const c of forecasts) {
      cells.push({ area: c.area, line_code: c.line_code, year: c.year, month: c.month,
        value: c.value })
    }
    return computeDerivedBalances({
      cells, lines,
      fromYear: scope.fromYear, fromMonth: scope.fromMonth,
      toYear: scope.toYear, toMonth: scope.toMonth,
    })
  }, [actuals, forecasts, lines, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth])

  // Indexed sums for fast per-cell lookup. Applies scenario delta on top of
  // baseline so the drill stays in sync with bulk-ops + cell edits. For
  // Opening Balance / Ending Balance lines, returns the DERIVED chain value
  // at the column endpoint — not the stored cell sum (which can drift).
  const sumLineCol = (lineCode: string, matches: (y: number, m: number) => boolean): number | null => {
    const line = lineByCode.get(lineCode)
    if (line && line.nature === 'Balance' && (line.category === 'Opening Balance' || line.category === 'Ending Balance')) {
      const ep = getColumnYMEndpoints(matches, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth)
      if (!ep) return null
      if (line.category === 'Opening Balance') return derived.openingByYM.get(ep.first) ?? null
      return derived.closingByYM.get(ep.last) ?? null
    }
    let sum: number | null = null
    for (const c of actuals) {
      if (c.line_code !== lineCode) continue
      if (!matches(c.year, c.month)) continue
      sum = (sum ?? 0) + c.value
    }
    for (const c of forecasts) {
      if (c.line_code !== lineCode) continue
      if (!matches(c.year, c.month)) continue
      sum = (sum ?? 0) + c.value
    }
    return sum
  }

  // Baseline-only sum (pre-scenario). Used by EditableCell to seed the
  // baseline_value on a fresh override.
  const baselineSumLineCol = (lineCode: string, matches: (y: number, m: number) => boolean): number | null => {
    let sum: number | null = null
    for (const c of actuals) {
      if (c.line_code !== lineCode) continue
      if (!matches(c.year, c.month)) continue
      sum = (sum ?? 0) + c.value
    }
    for (const c of forecasts) {
      if (c.line_code !== lineCode) continue
      if (!matches(c.year, c.month)) continue
      sum = (sum ?? 0) + c.value
    }
    return sum
  }

  const sumLinesCol = (lineCodes: string[], matches: (y: number, m: number) => boolean): number | null => {
    let t = 0; let touched = false
    for (const lc of lineCodes) {
      const s = sumLineCol(lc, matches)
      if (s != null) { t += s; touched = true }
    }
    return touched ? t : null
  }

  const tableMinWidth = LABEL_COL_PX + (columns.length * PERIOD_COL_PX) + TOTAL_COL_PX

  /* Build display blocks: each block is one rendered card. */
  type Block =
    | { kind: 'balance'; key: string; label: string; lines: CfLine[]; natureClass: string }
    | { kind: 'flow'; key: string; label: string; receipts: CfLine[]; payments: CfLine[]; natureClass: string }

  const blocks = useMemo<Block[]>(() => {
    if (groupBy === 'category') {
      return SECTIONS_BY_CATEGORY.map(sec => {
        const inSec = activeLines.filter(l => sec.categories.includes(l.category))
        if (sec.kind === 'balance') {
          return { kind: 'balance' as const, key: sec.key, label: sec.label, lines: inSec, natureClass: 'nature-balance' }
        }
        return {
          kind: 'flow' as const,
          key: sec.key,
          label: sec.label,
          receipts: inSec.filter(l => l.nature === 'Receipts'),
          payments: inSec.filter(l => l.nature === 'Payments'),
          natureClass: 'nature-mixed',
        }
      }).filter(b => b.kind === 'balance' ? b.lines.length > 0 : (b.receipts.length + b.payments.length) > 0)
    }
    // groupBy === 'nature'
    const opening = activeLines.filter(l => l.category === 'Opening Balance')
    const closing = activeLines.filter(l => ['Ending Balance', 'Accumulated Loans', 'Overdrafts'].includes(l.category))
    const receipts = activeLines.filter(l => l.nature === 'Receipts')
    const payments = activeLines.filter(l => l.nature === 'Payments')
    const blockList: Block[] = []
    if (opening.length) blockList.push({ kind: 'balance', key: 'opening', label: 'Opening Balance', lines: opening, natureClass: 'nature-balance' })
    if (receipts.length) blockList.push({ kind: 'flow', key: 'receipts', label: 'Receipts', receipts, payments: [], natureClass: 'nature-receipts' })
    if (payments.length) blockList.push({ kind: 'flow', key: 'payments', label: 'Payments', receipts: [], payments, natureClass: 'nature-payments' })
    if (closing.length) blockList.push({ kind: 'balance', key: 'closing', label: 'Closing Position', lines: closing, natureClass: 'nature-balance' })
    return blockList
  }, [activeLines, groupBy])

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ width: tableMinWidth }}>
        {blocks.map(blk => {
          if (blk.kind === 'balance') {
            return (
              <BalanceCard key={blk.key} block={blk}
                columns={columns} tableMinWidth={tableMinWidth}
                sumLineCol={sumLineCol} />
            )
          }
          return (
            <FlowCard key={blk.key} block={blk}
              columns={columns} tableMinWidth={tableMinWidth}
              sumLineCol={sumLineCol} sumLinesCol={sumLinesCol}
              baselineSumLineCol={baselineSumLineCol}
              cfArea={cfArea}
              groupBy={groupBy}
              expanded={expanded} toggle={toggle} />
          )
        })}
        {groupBy === 'nature' && (
          <NetMovementCard
            receiptsLines={activeLines.filter(l => l.nature === 'Receipts')}
            paymentsLines={activeLines.filter(l => l.nature === 'Payments')}
            columns={columns}
            tableMinWidth={tableMinWidth}
            sumLinesCol={sumLinesCol}
          />
        )}
      </div>
    </div>
  )
}

/* ───── Balance card (Opening / Closing Position) ─────
 * Flat list of balance lines, no subtotal, no Net row.
 * Balance rows (Opening / Ending / Loans / Overdrafts) are point-in-time
 * positions, so the row-total column is dropped — summing balances across
 * months doesn't carry meaning. */
function BalanceCard({
  block, columns, tableMinWidth, sumLineCol,
}: {
  block: { key: string; label: string; lines: CfLine[]; natureClass: string };
  columns: Column[];
  tableMinWidth: number;
  sumLineCol: (lineCode: string, matches: (y: number, m: number) => boolean) => number | null;
}) {
  const disp = useDisp()
  return (
    <div className="cat-group">
      <div className={`cat-group-header ${block.natureClass}`}>
        <span>{block.label}</span>
      </div>
      <table className="cf-table" style={{ tableLayout: 'fixed', width: tableMinWidth - TOTAL_COL_PX }}>
        <colgroup>
          <col style={{ width: LABEL_COL_PX }} />
          {columns.map(c => <col key={c.key} style={{ width: PERIOD_COL_PX }} />)}
        </colgroup>
        <thead>
          <tr>
            <th className="label" style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}>Line</th>
            {columns.map(c => (
              <th key={c.key} className={c.isActual ? 'cell actual' : 'cell forecast'}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.lines.map(l => (
            <tr key={l.line_code}>
              <td className="label">{l.description}</td>
              {columns.map(col => {
                const v = sumLineCol(l.line_code, col.matches)
                return (
                  <td key={col.key} className={`${classNum(v)} ${col.isActual ? 'cell actual' : 'cell forecast'}`}>
                    {v == null ? '' : disp(v)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ───── Flow card (Operations / New Sales / Interest / Non-Op / WG / BF) ─────
 * Receipts subgroup + subtotal → Payments subgroup + subtotal → Net row.
 *
 * In Nature mode, the receipts and payments lists collapse to one side only
 * (receipts card has no payments and vice versa); the Net row is suppressed
 * since "Net Receipts" alone is not meaningful. */
function FlowCard({
  block, columns, tableMinWidth, sumLineCol, sumLinesCol, baselineSumLineCol, cfArea,
  groupBy, expanded, toggle,
}: {
  block: { key: string; label: string; receipts: CfLine[]; payments: CfLine[]; natureClass: string };
  columns: Column[];
  tableMinWidth: number;
  sumLineCol: (lineCode: string, matches: (y: number, m: number) => boolean) => number | null;
  sumLinesCol: (lineCodes: string[], matches: (y: number, m: number) => boolean) => number | null;
  baselineSumLineCol: (lineCode: string, matches: (y: number, m: number) => boolean) => number | null;
  cfArea?: string;
  groupBy: GroupBy;
  expanded: Set<string>;
  toggle: (key: string) => void;
}) {
  const disp = useDisp()
  const hasReceipts = block.receipts.length > 0
  const hasPayments = block.payments.length > 0
  const showNet = hasReceipts && hasPayments  // suppressed in Nature mode where one side is always empty

  const receiptsTotal = sumLinesCol(block.receipts.map(l => l.line_code), () => true)
  const paymentsTotal = sumLinesCol(block.payments.map(l => l.line_code), () => true)
  const netTotal = showNet ? ((receiptsTotal ?? 0) + (paymentsTotal ?? 0)) : null

  /* In Nature mode, group the single-direction lines visually by category so
   * the eye can still trace where each line came from. */
  const categoryGroups = (lines: CfLine[]) => {
    if (groupBy !== 'nature') return [{ category: '', lines }]
    const map = new Map<string, CfLine[]>()
    for (const l of lines) {
      if (!map.has(l.category)) map.set(l.category, [])
      map.get(l.category)!.push(l)
    }
    return [...map.entries()].map(([category, lines]) => ({ category, lines }))
  }

  return (
    <div className="cat-group">
      <div className={`cat-group-header ${block.natureClass}`}>
        <span>{block.label}</span>
        {netTotal != null && (
          <span className="cat-totals">Net: {disp(netTotal)}</span>
        )}
        {!showNet && receiptsTotal != null && (
          <span className="cat-totals">Total: {disp(receiptsTotal)}</span>
        )}
        {!showNet && paymentsTotal != null && (
          <span className="cat-totals">Total: {disp(paymentsTotal)}</span>
        )}
      </div>
      <table className="cf-table" style={{ tableLayout: 'fixed', width: tableMinWidth }}>
        <colgroup>
          <col style={{ width: LABEL_COL_PX }} />
          {columns.map(c => <col key={c.key} style={{ width: PERIOD_COL_PX }} />)}
          <col style={{ width: TOTAL_COL_PX }} />
        </colgroup>
        <thead>
          <tr>
            <th className="label" style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}>Line</th>
            {columns.map(c => (
              <th key={c.key} className={c.isActual ? 'cell actual' : 'cell forecast'}>{c.label}</th>
            ))}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {hasReceipts && (
            <FlowSubgroup label="Receipts"
              groups={categoryGroups(block.receipts)}
              columns={columns}
              sumLineCol={sumLineCol}
              sumLinesCol={sumLinesCol}
              baselineSumLineCol={baselineSumLineCol}
              cfArea={cfArea}
              subgroupClass="subgroup-receipts"
              blockKey={block.key} groupBy={groupBy}
              expanded={expanded} toggle={toggle}
              showSubgroupHeader={groupBy === 'category'} />
          )}
          {hasPayments && (
            <FlowSubgroup label="Payments"
              groups={categoryGroups(block.payments)}
              columns={columns}
              sumLineCol={sumLineCol}
              sumLinesCol={sumLinesCol}
              baselineSumLineCol={baselineSumLineCol}
              cfArea={cfArea}
              subgroupClass="subgroup-payments"
              blockKey={block.key} groupBy={groupBy}
              expanded={expanded} toggle={toggle}
              showSubgroupHeader={groupBy === 'category'} />
          )}
          {showNet && (
            <tr className="total net-row">
              <td className="label">Net {block.label}</td>
              {columns.map(col => {
                const r = sumLinesCol(block.receipts.map(l => l.line_code), col.matches)
                const p = sumLinesCol(block.payments.map(l => l.line_code), col.matches)
                const v = (r == null && p == null) ? null : ((r ?? 0) + (p ?? 0))
                return (
                  <td key={col.key} className={classNum(v)}>
                    {v == null ? '' : disp(v)}
                  </td>
                )
              })}
              <td className={classNum(netTotal)}>{netTotal == null ? '' : disp(netTotal)}</td>
            </tr>
          )}
          {/* Nature-mode: per-block Total footer row (Receipts-only or Payments-only).
              In Category mode the Net row above already covers this. */}
          {!showNet && (
            <tr className="total net-row">
              <td className="label">Total {block.label}</td>
              {columns.map(col => {
                const codes = (hasReceipts ? block.receipts : block.payments).map(l => l.line_code)
                const v = sumLinesCol(codes, col.matches)
                return (
                  <td key={col.key} className={classNum(v)}>
                    {v == null ? '' : disp(v)}
                  </td>
                )
              })}
              <td className={classNum(hasReceipts ? receiptsTotal : paymentsTotal)}>
                {hasReceipts
                  ? (receiptsTotal == null ? '' : disp(receiptsTotal))
                  : (paymentsTotal == null ? '' : disp(paymentsTotal))}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/* Nature-mode net summary — single row spanning all categories.
 * Shown after the Payments block in Nature mode. Sums every Receipts line
 * + every Payments line per column. */
function NetMovementCard({
  receiptsLines, paymentsLines, columns, tableMinWidth, sumLinesCol,
}: {
  receiptsLines: CfLine[];
  paymentsLines: CfLine[];
  columns: Column[];
  tableMinWidth: number;
  sumLinesCol: (lineCodes: string[], matches: (y: number, m: number) => boolean) => number | null;
}) {
  const disp = useDisp()
  const receiptCodes = receiptsLines.map(l => l.line_code)
  const paymentCodes = paymentsLines.map(l => l.line_code)
  const totalReceipts = sumLinesCol(receiptCodes, () => true)
  const totalPayments = sumLinesCol(paymentCodes, () => true)
  const netTotal = (totalReceipts ?? 0) + (totalPayments ?? 0)
  return (
    <div className="cat-group">
      <div className="cat-group-header nature-balance">
        <span>Net Movement (period)</span>
        <span className="cat-totals">{disp(netTotal)}</span>
      </div>
      <table className="cf-table" style={{ tableLayout: 'fixed', width: tableMinWidth }}>
        <colgroup>
          <col style={{ width: LABEL_COL_PX }} />
          {columns.map(c => <col key={c.key} style={{ width: PERIOD_COL_PX }} />)}
          <col style={{ width: TOTAL_COL_PX }} />
        </colgroup>
        <tbody>
          <tr className="total net-row">
            <td className="label">Receipts total</td>
            {columns.map(col => {
              const v = sumLinesCol(receiptCodes, col.matches)
              return <td key={col.key} className={classNum(v)}>{v == null ? '' : disp(v)}</td>
            })}
            <td className={classNum(totalReceipts)}>{totalReceipts == null ? '' : disp(totalReceipts)}</td>
          </tr>
          <tr className="total net-row">
            <td className="label">Payments total</td>
            {columns.map(col => {
              const v = sumLinesCol(paymentCodes, col.matches)
              return <td key={col.key} className={classNum(v)}>{v == null ? '' : disp(v)}</td>
            })}
            <td className={classNum(totalPayments)}>{totalPayments == null ? '' : disp(totalPayments)}</td>
          </tr>
          <tr className="total net-row" style={{ borderTop: '2px solid var(--border)' }}>
            <td className="label" style={{ fontWeight: 600 }}>Net movement</td>
            {columns.map(col => {
              const r = sumLinesCol(receiptCodes, col.matches)
              const p = sumLinesCol(paymentCodes, col.matches)
              const v = (r == null && p == null) ? null : ((r ?? 0) + (p ?? 0))
              return <td key={col.key} className={classNum(v)} style={{ fontWeight: 600 }}>{v == null ? '' : disp(v)}</td>
            })}
            <td className={classNum(netTotal)} style={{ fontWeight: 600 }}>{disp(netTotal)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function FlowSubgroup({
  label, groups, columns, sumLineCol, sumLinesCol, baselineSumLineCol, cfArea, subgroupClass,
  blockKey, groupBy, expanded, toggle, showSubgroupHeader,
}: {
  label: 'Receipts' | 'Payments';
  groups: { category: string; lines: CfLine[] }[];
  columns: Column[];
  sumLineCol: (lineCode: string, matches: (y: number, m: number) => boolean) => number | null;
  sumLinesCol: (lineCodes: string[], matches: (y: number, m: number) => boolean) => number | null;
  baselineSumLineCol: (lineCode: string, matches: (y: number, m: number) => boolean) => number | null;
  cfArea?: string;
  subgroupClass: string;
  blockKey: string;
  groupBy: GroupBy;
  expanded: Set<string>;
  toggle: (key: string) => void;
  showSubgroupHeader: boolean;
}) {
  const disp = useDisp()
  const allLineCodes = groups.flatMap(g => g.lines.map(l => l.line_code))
  const subtotal = sumLinesCol(allLineCodes, () => true)

  /* Default: everything collapsed. The `expanded` set holds only the keys
   * Karim has clicked open. Keys are scoped by groupBy so flipping the
   * mode toggle doesn't carry stale state (the structures don't line up).
   *
   * 2026-06-05: subgroup + category header rows carry their own subtotal
   * numbers inline (no separate "X subtotal" row at the bottom). Cuts the
   * row count roughly in half on collapsed sections and removes the
   * label-repeat / number-repeat noise on expanded ones. */
  const subgroupKey = `${groupBy}|${blockKey}|sub:${label}`
  const subgroupCollapsed = showSubgroupHeader && !expanded.has(subgroupKey)

  return (
    <>
      {showSubgroupHeader && (
        <tr className={`subgroup-header subtotal-row ${subgroupClass} clickable`}
            onClick={() => toggle(subgroupKey)}>
          <td className="label"><Chevron open={!subgroupCollapsed} />{label}</td>
          {columns.map(col => {
            const v = sumLinesCol(allLineCodes, col.matches)
            return (
              <td key={col.key} className={classNum(v)}>
                {v == null ? '' : disp(v)}
              </td>
            )
          })}
          <td className={classNum(subtotal)}>{subtotal == null ? '' : disp(subtotal)}</td>
        </tr>
      )}
      {!subgroupCollapsed && groups.map(grp => {
        const catKey = grp.category
          ? `${groupBy}|${blockKey}|cat:${grp.category}`
          : null
        const catCollapsed = !!catKey && !expanded.has(catKey)
        const catLineCodes = grp.lines.map(l => l.line_code)
        const catSubtotal = sumLinesCol(catLineCodes, () => true)

        return (
          <Fragment key={`${label}-grp-${grp.category || 'all'}`}>
            {grp.category && (
              <tr className="category-divider subtotal-row category-subtotal clickable"
                  onClick={() => catKey && toggle(catKey)}>
                <td className="label"><Chevron open={!catCollapsed} />{grp.category}</td>
                {columns.map(col => {
                  const v = sumLinesCol(catLineCodes, col.matches)
                  return (
                    <td key={col.key} className={classNum(v)}>
                      {v == null ? '' : disp(v)}
                    </td>
                  )
                })}
                <td className={classNum(catSubtotal)}>{catSubtotal == null ? '' : disp(catSubtotal)}</td>
              </tr>
            )}
            {!catCollapsed && grp.lines.map(l => {
              const rowTotal = sumLineCol(l.line_code, () => true)
              return (
                <tr key={`${label}-${l.line_code}`}>
                  <td className="label">{l.description}</td>
                  {columns.map(col => {
                    const v = sumLineCol(l.line_code, col.matches)
                    const baseline = baselineSumLineCol(l.line_code, col.matches)
                    const className = `${classNum(v)} ${col.isActual ? 'cell actual' : 'cell forecast'}`
                    return (
                      <EditableCell
                        key={col.key}
                        cfArea={cfArea}
                        lineCode={l.line_code}
                        year={col.singleMonth?.year}
                        month={col.singleMonth?.month}
                        isActual={col.isActual}
                        baselineValue={baseline}
                        scenarioValue={v}
                        className={className}
                      />
                    )
                  })}
                  <td className={classNum(rowTotal)} style={{ fontWeight: 500 }}>
                    {rowTotal == null ? '' : disp(rowTotal)}
                  </td>
                </tr>
              )
            })}
          </Fragment>
        )
      })}
    </>
  )
}

export function buildColumns(grain: Grain, scope: Pick<Scope, 'fromYear' | 'fromMonth' | 'toYear' | 'toMonth'>, asOfYM: number) {
  const cols: Column[] = []
  const months: { y: number; m: number }[] = []
  for (let y = scope.fromYear; y <= scope.toYear; y++) {
    const startM = y === scope.fromYear ? scope.fromMonth : 1
    const endM = y === scope.toYear ? scope.toMonth : 12
    for (let m = startM; m <= endM; m++) months.push({ y, m })
  }

  if (grain === 'monthly') {
    months.forEach(({ y, m }) => {
      const ym = y * 100 + m
      cols.push({
        key: `${y}-${m}`,
        label: `${String(y).slice(2)}-${String(m).padStart(2, '0')}`,
        matches: (yy, mm) => yy === y && mm === m,
        isActual: ym <= asOfYM,
        singleMonth: { year: y, month: m },
      })
    })
  } else if (grain === 'quarterly') {
    const seen = new Set<string>()
    months.forEach(({ y, m }) => {
      const q = Math.ceil(m / 3)
      const key = `${y}-Q${q}`
      if (seen.has(key)) return
      seen.add(key)
      cols.push({
        key,
        label: `${String(y).slice(2)} Q${q}`,
        matches: (yy, mm) => yy === y && Math.ceil(mm / 3) === q,
        isActual: (y * 100 + q * 3) <= asOfYM,
      })
    })
  } else {
    const years = new Set(months.map(x => x.y))
    ;[...years].sort().forEach(y => {
      cols.push({
        key: `${y}`,
        label: `${y}`,
        matches: yy => yy === y,
        isActual: (y * 100 + 12) <= asOfYM,
      })
    })
  }
  return cols
}
