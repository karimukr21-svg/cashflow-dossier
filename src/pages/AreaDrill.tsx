import { Fragment, useEffect, useMemo, useState } from 'react'
import { fetchActuals, fetchForecasts, type CfCell, type CfLine } from '@/lib/queries'
import { fmt, classNum } from '@/lib/format'
import type { Scope, Grain, GroupBy } from './Dossier'

export default function AreaDrill({ area, scope }: { area: string; scope: Scope }) {
  const [actuals, setActuals] = useState<(CfCell & { source_version: string })[]>([])
  const [forecasts, setForecasts] = useState<(CfCell & { version: string })[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const [a, f] = await Promise.all([
          fetchActuals({ fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth, area }),
          fetchForecasts({ version: scope.primaryVersion, fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth, area }),
        ])
        if (cancel) return
        setActuals(a); setForecasts(f)
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [area, scope.primaryVersion, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth])

  if (loading) return <div className="placeholder-box">Loading {area}…</div>

  return (
    <div>
      <h1>{area}</h1>
      <div style={{ height: 16 }} />
      <AreaCategoryCards
        actuals={actuals}
        forecasts={forecasts}
        lines={scope.lines}
        grain={scope.grain}
        scope={scope}
        groupBy={scope.groupBy}
      />
    </div>
  )
}

/* Column-alignment constants (apply to every section card on the page so
 * columns line up vertically across sections). */
const LABEL_COL_PX = 240
const PERIOD_COL_PX = 80
const TOTAL_COL_PX = 100

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
  { key: 'closing', label: 'Closing Position', kind: 'balance', categories: ['Ending Balance', 'Accumulated Loans', 'Overdrafts'] },
]

type Column = { key: string; label: string; matches: (y: number, m: number) => boolean; isActual: boolean }

export function AreaCategoryCards({
  actuals, forecasts, lines, grain, scope, groupBy,
}: {
  actuals: CfCell[];
  forecasts: CfCell[];
  lines: CfLine[];
  grain: Grain;
  scope: Pick<Scope, 'fromYear' | 'fromMonth' | 'toYear' | 'toMonth' | 'latestActualYM'>;
  groupBy: GroupBy;
}) {
  const activeLines = useMemo(() =>
    lines.filter(l => l.is_active).sort((a, b) => a.sort_order - b.sort_order),
    [lines])

  const columns = useMemo(() => buildColumns(grain, scope, scope.latestActualYM),
    [grain, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth, scope.latestActualYM])

  // Indexed sums for fast per-cell lookup.
  const sumLineCol = (lineCode: string, matches: (y: number, m: number) => boolean): number | null => {
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
              groupBy={groupBy} />
          )
        })}
      </div>
    </div>
  )
}

/* ───── Balance card (Opening / Closing Position) ─────
 * Flat list of balance lines, no subtotal, no Net row. */
function BalanceCard({
  block, columns, tableMinWidth, sumLineCol,
}: {
  block: { key: string; label: string; lines: CfLine[]; natureClass: string };
  columns: Column[];
  tableMinWidth: number;
  sumLineCol: (lineCode: string, matches: (y: number, m: number) => boolean) => number | null;
}) {
  return (
    <div className="cat-group">
      <div className={`cat-group-header ${block.natureClass}`}>
        <span>{block.label}</span>
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
          {block.lines.map(l => {
            const rowTotal = sumLineCol(l.line_code, () => true)
            return (
              <tr key={l.line_code}>
                <td className="label">{l.description}</td>
                {columns.map(col => {
                  const v = sumLineCol(l.line_code, col.matches)
                  return (
                    <td key={col.key} className={`${classNum(v)} ${col.isActual ? 'cell actual' : 'cell forecast'}`}>
                      {v == null ? '' : fmt(v)}
                    </td>
                  )
                })}
                <td className={classNum(rowTotal)} style={{ fontWeight: 500 }}>
                  {rowTotal == null ? '' : fmt(rowTotal)}
                </td>
              </tr>
            )
          })}
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
  block, columns, tableMinWidth, sumLineCol, sumLinesCol, groupBy,
}: {
  block: { key: string; label: string; receipts: CfLine[]; payments: CfLine[]; natureClass: string };
  columns: Column[];
  tableMinWidth: number;
  sumLineCol: (lineCode: string, matches: (y: number, m: number) => boolean) => number | null;
  sumLinesCol: (lineCodes: string[], matches: (y: number, m: number) => boolean) => number | null;
  groupBy: GroupBy;
}) {
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
          <span className="cat-totals">Net: {fmt(netTotal)}</span>
        )}
        {!showNet && receiptsTotal != null && (
          <span className="cat-totals">Total: {fmt(receiptsTotal)}</span>
        )}
        {!showNet && paymentsTotal != null && (
          <span className="cat-totals">Total: {fmt(paymentsTotal)}</span>
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
              subgroupClass="subgroup-receipts" />
          )}
          {hasPayments && (
            <FlowSubgroup label="Payments"
              groups={categoryGroups(block.payments)}
              columns={columns}
              sumLineCol={sumLineCol}
              sumLinesCol={sumLinesCol}
              subgroupClass="subgroup-payments" />
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
                    {v == null ? '' : fmt(v)}
                  </td>
                )
              })}
              <td className={classNum(netTotal)}>{netTotal == null ? '' : fmt(netTotal)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function FlowSubgroup({
  label, groups, columns, sumLineCol, sumLinesCol, subgroupClass,
}: {
  label: 'Receipts' | 'Payments';
  groups: { category: string; lines: CfLine[] }[];
  columns: Column[];
  sumLineCol: (lineCode: string, matches: (y: number, m: number) => boolean) => number | null;
  sumLinesCol: (lineCodes: string[], matches: (y: number, m: number) => boolean) => number | null;
  subgroupClass: string;
}) {
  const allLineCodes = groups.flatMap(g => g.lines.map(l => l.line_code))
  const subtotal = sumLinesCol(allLineCodes, () => true)
  const colSpan = columns.length + 2

  return (
    <>
      <tr className={`subgroup-header ${subgroupClass}`}>
        <td colSpan={colSpan}>{label}</td>
      </tr>
      {groups.map(grp => (
        <Fragment key={`${label}-grp-${grp.category || 'all'}`}>
          {grp.category && (
            <tr className="category-divider">
              <td colSpan={colSpan}>{grp.category}</td>
            </tr>
          )}
          {grp.lines.map(l => {
            const rowTotal = sumLineCol(l.line_code, () => true)
            return (
              <tr key={`${label}-${l.line_code}`}>
                <td className="label">{l.description}</td>
                {columns.map(col => {
                  const v = sumLineCol(l.line_code, col.matches)
                  return (
                    <td key={col.key} className={`${classNum(v)} ${col.isActual ? 'cell actual' : 'cell forecast'}`}>
                      {v == null ? '' : fmt(v)}
                    </td>
                  )
                })}
                <td className={classNum(rowTotal)} style={{ fontWeight: 500 }}>
                  {rowTotal == null ? '' : fmt(rowTotal)}
                </td>
              </tr>
            )
          })}
        </Fragment>
      ))}
      <tr className="subtotal-row">
        <td className="label">{label} subtotal</td>
        {columns.map(col => {
          const v = sumLinesCol(allLineCodes, col.matches)
          return (
            <td key={col.key} className={classNum(v)}>
              {v == null ? '' : fmt(v)}
            </td>
          )
        })}
        <td className={classNum(subtotal)}>{subtotal == null ? '' : fmt(subtotal)}</td>
      </tr>
    </>
  )
}

export function buildColumns(grain: Grain, scope: Pick<Scope, 'fromYear' | 'fromMonth' | 'toYear' | 'toMonth'>, asOfYM: number) {
  const cols: { key: string; label: string; matches: (y: number, m: number) => boolean; isActual: boolean }[] = []
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
