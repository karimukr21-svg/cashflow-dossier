import { Fragment, useMemo, useState } from 'react'
import type { CfCell, CfLine, CanonicalArea } from '@/lib/queries'
import type { Scope } from './Dossier'
import { fmt, classNum } from '@/lib/format'
import { buildColumns } from './AreaDrill'
import { computeDerivedBalances, getColumnYMEndpoints } from '@/lib/derivedBalances'

/* ───── Layout constants — kept in sync with AreaDrill so cards line up ───── */
const LABEL_COL_PX = 240
const PERIOD_COL_PX = 80
const TOTAL_COL_PX = 100

/* ───── Category sectioning (mirrors SECTIONS_BY_CATEGORY in AreaDrill) ───── */
type SectionKind = 'balance' | 'flow'
type SectionDef = { key: string; label: string; kind: SectionKind; categories: string[] }
const SECTIONS_BY_CATEGORY: SectionDef[] = [
  { key: 'opening',    label: 'Opening Balance',  kind: 'balance', categories: ['Opening Balance'] },
  { key: 'operations', label: 'Operations',       kind: 'flow',    categories: ['Operation', 'Claims'] },
  { key: 'newsales',   label: 'New Sales',        kind: 'flow',    categories: ['New Sales'] },
  { key: 'interest',   label: 'Interest',         kind: 'flow',    categories: ['Interest'] },
  { key: 'nonop',      label: 'Non-Operational',  kind: 'flow',    categories: ['Non Operational'] },
  { key: 'wg',         label: 'Within Group',     kind: 'flow',    categories: ['Within Group'] },
  { key: 'bf',         label: 'Bank Financing',   kind: 'flow',    categories: ['Bank Financing'] },
  { key: 'closing',    label: 'Closing Position', kind: 'balance', categories: ['Ending Balance', 'Accumulated Loans', 'Overdrafts'] },
]
/* Nature mode top split: 4 buckets keyed by line property. */
const BALANCE_OPEN_CATS = new Set(['Opening Balance'])
const BALANCE_CLOSE_CATS = new Set(['Ending Balance', 'Accumulated Loans', 'Overdrafts'])

type Column = { key: string; label: string; matches: (y: number, m: number) => boolean; isActual: boolean }

/* ───── Props ───── */
type Props = {
  actuals: (CfCell & { source_version: string })[];
  forecasts: (CfCell & { version: string })[];
  lines: CfLine[];
  scope: Scope;
  areas: CanonicalArea[];        // selected canonical areas
  onSelectArea: (areaId: string) => void;
}

export default function AllAreasPivot({ actuals, forecasts, lines, scope, areas, onSelectArea }: Props) {
  const ord = scope.ord
  const outer = ord[0]

  // Area-outer ordering reuses the existing AreaCategoryCards rendering per area
  if (outer === 'A') return <AreaOuter {...{ actuals, forecasts, lines, scope, areas }} />

  // Section-outer orderings — sections by Nature or Category, with Area at middle or inner
  return <SectionOuter {...{ actuals, forecasts, lines, scope, areas, onSelectArea }} />
}

/* ════════════════════════════════════════════════════════════════════════
   Mode 1 — Area-outer (ANC / ACN)
   One card per selected area, identical to AreaDrill's rendering.
   ord[1] picks the inner groupBy (Nature or Category).
   Areas start collapsed; click the heading to expand.
   ════════════════════════════════════════════════════════════════════════ */
const AREA_EXPANDED_STORAGE_KEY = 'pivot-area-expanded-v1'
function useExpandedAreas() {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(AREA_EXPANDED_STORAGE_KEY)
      return new Set(raw ? JSON.parse(raw) : [])
    } catch { return new Set() }
  })
  const toggle = (areaId: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(areaId)) next.delete(areaId)
      else next.add(areaId)
      try { localStorage.setItem(AREA_EXPANDED_STORAGE_KEY, JSON.stringify([...next])) } catch {}
      return next
    })
  }
  return { expanded, toggle }
}

function AreaOuter({
  actuals, forecasts, lines, scope, areas,
}: Omit<Props, 'onSelectArea'>) {
  const innerGroupBy: 'category' | 'nature' = scope.ord[1] === 'N' ? 'nature' : 'category'
  const { expanded, toggle } = useExpandedAreas()

  /* Line code → nature, so per-area Net rows can ignore Balance lines. */
  const lineNature = useMemo(() => {
    const m = new Map<string, 'Receipts' | 'Payments' | 'Balance'>()
    for (const l of lines) m.set(l.line_code, l.nature)
    return m
  }, [lines])

  /* Pre-bucket cells by canonical area_id so per-row sums are O(cells_in_area)
   * per (column × area) rather than O(all_cells). */
  const cellsByArea = useMemo(() => {
    const m = new Map<string, { actuals: typeof actuals; forecasts: typeof forecasts }>()
    for (const a of areas) m.set(a.area_id, { actuals: [], forecasts: [] })
    const cfToArea = new Map<string, string>()
    for (const a of areas) for (const cf of a.cf_areas) cfToArea.set(cf, a.area_id)
    for (const c of actuals)   { const aId = cfToArea.get(c.area); if (aId) m.get(aId)!.actuals.push(c) }
    for (const c of forecasts) { const aId = cfToArea.get(c.area); if (aId) m.get(aId)!.forecasts.push(c) }
    return m
  }, [actuals, forecasts, areas])

  /* Derived cash balance chain per area (Opening / Closing per month). */
  const derivedByArea = useMemo(() => {
    const out = new Map<string, ReturnType<typeof computeDerivedBalances>>()
    for (const a of areas) {
      const bucket = cellsByArea.get(a.area_id)
      if (!bucket) continue
      const cells: CfCell[] = [...bucket.actuals, ...bucket.forecasts]
      out.set(a.area_id, computeDerivedBalances({
        cells, lines,
        fromYear: scope.fromYear, fromMonth: scope.fromMonth,
        toYear: scope.toYear, toMonth: scope.toMonth,
      }))
    }
    return out
  }, [areas, cellsByArea, lines, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth])

  const balanceAt = (areaId: string, ym: number, kind: 'opening' | 'closing'): number | null => {
    const d = derivedByArea.get(areaId)
    if (!d) return null
    const map = kind === 'opening' ? d.openingByYM : d.closingByYM
    return map.get(ym) ?? null
  }
  const balanceForCol = (areaId: string, col: Column, kind: 'opening' | 'closing'): number | null => {
    const ep = getColumnYMEndpoints(col.matches, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth)
    if (!ep) return null
    return balanceAt(areaId, kind === 'opening' ? ep.first : ep.last, kind)
  }

  const columns = useMemo(
    () => buildColumns(scope.grain, scope, scope.latestActualYM),
    [scope.grain, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth, scope.latestActualYM])
  const tableMinWidth = LABEL_COL_PX + (columns.length * PERIOD_COL_PX) + TOTAL_COL_PX

  /* Net (Receipts + Payments) for a given area + column matcher. Balance
   * lines are skipped (they're point-in-time positions, not flows). */
  const areaNet = (areaId: string, matches: (y: number, m: number) => boolean): number | null => {
    const bucket = cellsByArea.get(areaId)
    if (!bucket) return null
    let sum: number | null = null
    for (const c of bucket.actuals) {
      const nat = lineNature.get(c.line_code)
      if (nat !== 'Receipts' && nat !== 'Payments') continue
      if (!matches(c.year, c.month)) continue
      sum = (sum ?? 0) + c.value
    }
    for (const c of bucket.forecasts) {
      const nat = lineNature.get(c.line_code)
      if (nat !== 'Receipts' && nat !== 'Payments') continue
      if (!matches(c.year, c.month)) continue
      sum = (sum ?? 0) + c.value
    }
    return sum
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="cf-table pivot-area-table" style={{ tableLayout: 'fixed', width: tableMinWidth }}>
        <colgroup>
          <col style={{ width: LABEL_COL_PX }} />
          {columns.map(c => <col key={c.key} style={{ width: PERIOD_COL_PX }} />)}
          <col style={{ width: TOTAL_COL_PX }} />
        </colgroup>
        <thead>
          <tr>
            <th className="label" style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}>Area</th>
            {columns.map(c => (
              <th key={c.key} className={c.isActual ? 'cell actual' : 'cell forecast'}>{c.label}</th>
            ))}
            <th>Net</th>
          </tr>
        </thead>
        <tbody>
          {areas.map(area => {
            const isOpen = expanded.has(area.area_id)
            const rowTotal = areaNet(area.area_id, () => true)
            const bucket = cellsByArea.get(area.area_id)
            const derived = derivedByArea.get(area.area_id)
            /* Opening at first ym in scope; closing at last ym in scope. */
            const fromYM = scope.fromYear * 100 + scope.fromMonth
            const toYM = scope.toYear * 100 + scope.toMonth
            const openingTotal = derived?.openingByYM.get(fromYM) ?? null
            const closingTotal = derived?.closingByYM.get(toYM) ?? null
            return (
              <Fragment key={area.area_id}>
                {/* Opening row — always visible, even when collapsed. */}
                <tr className="pivot-area-balance-row pivot-area-opening">
                  <td className="label pivot-balance-label">Opening · {area.display_name}</td>
                  {columns.map(col => {
                    const v = balanceForCol(area.area_id, col, 'opening')
                    return <td key={col.key} className={classNum(v)}>{v == null ? '' : fmt(v)}</td>
                  })}
                  <td className={classNum(openingTotal)}>{openingTotal == null ? '' : fmt(openingTotal)}</td>
                </tr>
                {/* Movement (Net) row — clickable header. */}
                <tr className={`pivot-area-headrow subtotal-row clickable ${isOpen ? 'open' : ''}`}
                    onClick={() => toggle(area.area_id)}>
                  <td className="label">
                    <span className="pivot-card-chev">▶</span>
                    {area.display_name}
                    <span className="pivot-area-sublabel">net movement</span>
                  </td>
                  {columns.map(col => {
                    const v = areaNet(area.area_id, col.matches)
                    return <td key={col.key} className={classNum(v)}>{v == null ? '' : fmt(v)}</td>
                  })}
                  <td className={classNum(rowTotal)} style={{ fontWeight: 600 }}>
                    {rowTotal == null ? '' : fmt(rowTotal)}
                  </td>
                </tr>
                {/* Closing row — derived, always visible. */}
                <tr className="pivot-area-balance-row pivot-area-closing">
                  <td className="label pivot-balance-label">Closing · {area.display_name}</td>
                  {columns.map(col => {
                    const v = balanceForCol(area.area_id, col, 'closing')
                    return <td key={col.key} className={classNum(v)}>{v == null ? '' : fmt(v)}</td>
                  })}
                  <td className={classNum(closingTotal)}>{closingTotal == null ? '' : fmt(closingTotal)}</td>
                </tr>
                {isOpen && bucket && (
                  <AreaInnerRows
                    areaKey={area.area_id}
                    actuals={bucket.actuals}
                    forecasts={bucket.forecasts}
                    lines={lines}
                    columns={columns}
                    innerGroupBy={innerGroupBy}
                  />
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════════════
   Mode 2 — Section-outer (NCA / CNA / NAC / CAN)
   Top split = Nature or Category sections.
   Middle = Nature/Category subgroups OR Area subsections.
   Leaf = line items OR per-area totals.
   ════════════════════════════════════════════════════════════════════════ */
function SectionOuter({ actuals, forecasts, lines, scope, areas, onSelectArea }: Props) {
  const ord = scope.ord
  const outer = ord[0] as 'N' | 'C'
  const middle = ord[1] as 'A' | 'N' | 'C'
  const inner = ord[2] as 'A' | 'N' | 'C'
  /* Aggregation context — all cells live here; filters happen per cell row. */
  const allCells = useMemo(() => [...actuals, ...forecasts], [actuals, forecasts])
  const cellByAreaCanon = useMemo(() => {
    const m = new Map<string, string>() // cf_area string → canonical area_id
    for (const a of areas) for (const cf of a.cf_areas) m.set(cf, a.area_id)
    return m
  }, [areas])
  const activeLines = useMemo(
    () => lines.filter(l => l.is_active).sort((a, b) => a.sort_order - b.sort_order),
    [lines])
  const columns = useMemo(
    () => buildColumns(scope.grain, scope, scope.latestActualYM),
    [scope.grain, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth, scope.latestActualYM])
  const tableMinWidth = LABEL_COL_PX + (columns.length * PERIOD_COL_PX) + TOTAL_COL_PX

  /* Cell sum scoped to: a set of line codes, optionally a set of canonical
   * area ids, and a column matcher. Returns null if nothing touched. */
  const sumCells = (
    lineCodes: Set<string>,
    areaIds: Set<string> | null,
    matches: (y: number, m: number) => boolean,
  ): number | null => {
    let sum: number | null = null
    for (const c of allCells) {
      if (!lineCodes.has(c.line_code)) continue
      if (!matches(c.year, c.month)) continue
      if (areaIds) {
        const aId = cellByAreaCanon.get(c.area)
        if (!aId || !areaIds.has(aId)) continue
      }
      sum = (sum ?? 0) + c.value
    }
    return sum
  }

  /* Build the outermost section list once. */
  type OuterSection = {
    key: string
    label: string
    kind: SectionKind
    lines: CfLine[]            // all lines that belong to this section (both natures for flow)
    receipts: CfLine[]         // flow only
    payments: CfLine[]         // flow only
    natureClass: string
  }
  const outerSections = useMemo<OuterSection[]>(() => {
    if (outer === 'C') {
      return SECTIONS_BY_CATEGORY.map(sec => {
        const inSec = activeLines.filter(l => sec.categories.includes(l.category))
        return {
          key: sec.key,
          label: sec.label,
          kind: sec.kind,
          lines: inSec,
          receipts: inSec.filter(l => l.nature === 'Receipts'),
          payments: inSec.filter(l => l.nature === 'Payments'),
          natureClass: sec.kind === 'balance' ? 'nature-balance' : 'nature-mixed',
        }
      }).filter(s => s.lines.length > 0)
    }
    // outer === 'N'
    const opening = activeLines.filter(l => BALANCE_OPEN_CATS.has(l.category))
    const closing = activeLines.filter(l => BALANCE_CLOSE_CATS.has(l.category))
    const receipts = activeLines.filter(l => l.nature === 'Receipts')
    const payments = activeLines.filter(l => l.nature === 'Payments')
    const out: OuterSection[] = []
    if (opening.length)  out.push({ key: 'opening',  label: 'Opening Balance',  kind: 'balance', lines: opening,  receipts: [], payments: [],       natureClass: 'nature-balance' })
    if (receipts.length) out.push({ key: 'receipts', label: 'Receipts',         kind: 'flow',    lines: receipts, receipts,     payments: [],       natureClass: 'nature-receipts' })
    if (payments.length) out.push({ key: 'payments', label: 'Payments',         kind: 'flow',    lines: payments, receipts: [], payments,           natureClass: 'nature-payments' })
    if (closing.length)  out.push({ key: 'closing',  label: 'Closing Position', kind: 'balance', lines: closing,  receipts: [], payments: [],       natureClass: 'nature-balance' })
    return out
  }, [activeLines, outer])

  /* V1: all section-outer orderings (NCA / CNA / NAC / CAN) treat Area as
   * the leaf with per-area total rows. NAC / CAN technically place Area in
   * the middle position (line items beneath each area) — that view is
   * deferred to v2. middle / inner are unused below for that reason but
   * we keep them in scope so the dispatcher (Dossier) can still set them. */
  void middle; void inner;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="cf-table pivot-area-table" style={{ tableLayout: 'fixed', width: tableMinWidth }}>
        <colgroup>
          <col style={{ width: LABEL_COL_PX }} />
          {columns.map(c => <col key={c.key} style={{ width: PERIOD_COL_PX }} />)}
          <col style={{ width: TOTAL_COL_PX }} />
        </colgroup>
        <thead>
          <tr>
            <th className="label" style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}>
              {outer === 'N' ? 'Nature' : 'Category'}
            </th>
            {columns.map(c => (
              <th key={c.key} className={c.isActual ? 'cell actual' : 'cell forecast'}>{c.label}</th>
            ))}
            <th>Net</th>
          </tr>
        </thead>
        <tbody>
          {outerSections.map(sec => (
            <SectionRow
              key={sec.key}
              sec={sec}
              outer={outer}
              columns={columns}
              areas={areas}
              sumCells={sumCells}
              onSelectArea={onSelectArea}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ───── Section row in the unified Section-outer table ─────
 * Each section emits its own <tr> header row + (when open) the rows for
 * its children. All sections share one outer table so monthly columns
 * line up vertically and Karim can scan period-by-period across the
 * whole picture. */
function SectionRow({
  sec, outer, columns, areas, sumCells, onSelectArea,
}: {
  sec: { key: string; label: string; kind: SectionKind; lines: CfLine[]; receipts: CfLine[]; payments: CfLine[]; natureClass: string };
  outer: 'N' | 'C';
  columns: Column[];
  areas: CanonicalArea[];
  sumCells: (lineCodes: Set<string>, areaIds: Set<string> | null, matches: (y: number, m: number) => boolean) => number | null;
  onSelectArea: (areaId: string) => void;
}) {
  const [open, setOpen] = useState(false)
  const allLineCodes = useMemo(() => new Set(sec.lines.map(l => l.line_code)), [sec.lines])
  const headTotal = sumCells(allLineCodes, null, () => true)

  return (
    <>
      <tr className={`pivot-section-row subtotal-row clickable ${sec.natureClass} ${open ? 'open' : ''}`}
          onClick={() => setOpen(o => !o)}>
        <td className="label">
          <span className="pivot-card-chev">▶</span>
          {sec.label}
        </td>
        {columns.map(col => {
          const v = sumCells(allLineCodes, null, col.matches)
          return <td key={col.key} className={classNum(v)}>{v == null ? '' : fmt(v)}</td>
        })}
        <td className={classNum(headTotal)} style={{ fontWeight: 600 }}>
          {sec.kind === 'balance' || headTotal == null ? '' : fmt(headTotal)}
        </td>
      </tr>
      {open && (sec.kind === 'balance'
        ? <BalanceAreaRows sec={sec} columns={columns} areas={areas} sumCells={sumCells} onSelectArea={onSelectArea} />
        : <FlowSectionChildren sec={sec} outer={outer} columns={columns} areas={areas} sumCells={sumCells} onSelectArea={onSelectArea} />
      )}
    </>
  )
}

/* Balance section expanded view: just per-area rows for the balance lines. */
function BalanceAreaRows({
  sec, columns, areas, sumCells, onSelectArea,
}: {
  sec: { key: string; lines: CfLine[] };
  columns: Column[];
  areas: CanonicalArea[];
  sumCells: (lineCodes: Set<string>, areaIds: Set<string> | null, matches: (y: number, m: number) => boolean) => number | null;
  onSelectArea: (areaId: string) => void;
}) {
  const lineCodes = useMemo(() => new Set(sec.lines.map(l => l.line_code)), [sec.lines])
  return (
    <>
      {areas.map(area => (
        <AreaLeafRow
          key={`${sec.key}|${area.area_id}`}
          area={area}
          lineCodes={lineCodes}
          columns={columns}
          sumCells={sumCells}
          isBalance={true}
          depth={1}
          onSelectArea={onSelectArea}
        />
      ))}
    </>
  )
}

/* Flow section expanded view. outer='C' → Receipts/Payments subgroup rows
 * + Net row. outer='N' → category dividers (single-nature already at top). */
function FlowSectionChildren({
  sec, outer, columns, areas, sumCells, onSelectArea,
}: {
  sec: { key: string; label: string; lines: CfLine[]; receipts: CfLine[]; payments: CfLine[] };
  outer: 'N' | 'C';
  columns: Column[];
  areas: CanonicalArea[];
  sumCells: (lineCodes: Set<string>, areaIds: Set<string> | null, matches: (y: number, m: number) => boolean) => number | null;
  onSelectArea: (areaId: string) => void;
}) {
  if (outer === 'C') {
    /* Section row already shows the Net total in its header — don't repeat
     * it as a Net row at the bottom of the expansion. */
    return (
      <>
        {sec.receipts.length > 0 && (
          <SubgroupRow
            label="Receipts" subgroupClass="subgroup-receipts"
            lines={sec.receipts} columns={columns} areas={areas}
            sumCells={sumCells} sectionKey={sec.key} onSelectArea={onSelectArea}
          />
        )}
        {sec.payments.length > 0 && (
          <SubgroupRow
            label="Payments" subgroupClass="subgroup-payments"
            lines={sec.payments} columns={columns} areas={areas}
            sumCells={sumCells} sectionKey={sec.key} onSelectArea={onSelectArea}
          />
        )}
      </>
    )
  }
  /* outer === 'N': section is Receipts or Payments. Group lines by
   * category as middle-level rows, with per-area rows underneath. */
  return (
    <CategoryRowGroup
      lines={sec.lines}
      columns={columns} areas={areas} sumCells={sumCells}
      sectionKey={sec.key} onSelectArea={onSelectArea}
    />
  )
}

/* Subgroup row (Receipts / Payments inside a Category-outer section).
 * Header row + (when open) per-area leaf rows. */
function SubgroupRow({
  label, subgroupClass, lines, columns, areas, sumCells, sectionKey, onSelectArea,
}: {
  label: 'Receipts' | 'Payments';
  subgroupClass: string;
  lines: CfLine[];
  columns: Column[];
  areas: CanonicalArea[];
  sumCells: (lineCodes: Set<string>, areaIds: Set<string> | null, matches: (y: number, m: number) => boolean) => number | null;
  sectionKey: string;
  onSelectArea: (areaId: string) => void;
}) {
  const [open, setOpen] = useState(false)
  const lineCodes = useMemo(() => new Set(lines.map(l => l.line_code)), [lines])
  const subtotal = sumCells(lineCodes, null, () => true)
  return (
    <>
      <tr className={`pivot-subgroup-row subtotal-row ${subgroupClass} clickable ${open ? 'open' : ''}`}
          onClick={() => setOpen(o => !o)}>
        <td className="label" style={{ paddingLeft: 32 }}>
          <span className="pivot-card-chev">▶</span>
          {label}
        </td>
        {columns.map(col => {
          const v = sumCells(lineCodes, null, col.matches)
          return <td key={col.key} className={classNum(v)}>{v == null ? '' : fmt(v)}</td>
        })}
        <td className={classNum(subtotal)} style={{ fontWeight: 500 }}>{subtotal == null ? '' : fmt(subtotal)}</td>
      </tr>
      {open && areas.map(area => (
        <AreaLeafRow
          key={`${sectionKey}|${label}|${area.area_id}`}
          area={area}
          lineCodes={lineCodes}
          columns={columns}
          sumCells={sumCells}
          isBalance={false}
          depth={2}
          onSelectArea={onSelectArea}
        />
      ))}
    </>
  )
}

/* Group lines by category (Nature-outer Flow sections). Each category
 * becomes its own collapsible row → per-area leaf rows beneath. */
function CategoryRowGroup({
  lines, columns, areas, sumCells, sectionKey, onSelectArea,
}: {
  lines: CfLine[];
  columns: Column[];
  areas: CanonicalArea[];
  sumCells: (lineCodes: Set<string>, areaIds: Set<string> | null, matches: (y: number, m: number) => boolean) => number | null;
  sectionKey: string;
  onSelectArea: (areaId: string) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, CfLine[]>()
    for (const l of lines) {
      if (!map.has(l.category)) map.set(l.category, [])
      map.get(l.category)!.push(l)
    }
    return [...map.entries()].map(([category, lines]) => ({
      category, lineCodes: new Set(lines.map(l => l.line_code)),
    }))
  }, [lines])
  return (
    <>
      {groups.map(grp => (
        <CategoryRow
          key={grp.category}
          category={grp.category}
          lineCodes={grp.lineCodes}
          columns={columns}
          areas={areas}
          sumCells={sumCells}
          sectionKey={sectionKey}
          onSelectArea={onSelectArea}
        />
      ))}
    </>
  )
}

function CategoryRow({
  category, lineCodes, columns, areas, sumCells, sectionKey, onSelectArea,
}: {
  category: string;
  lineCodes: Set<string>;
  columns: Column[];
  areas: CanonicalArea[];
  sumCells: (lineCodes: Set<string>, areaIds: Set<string> | null, matches: (y: number, m: number) => boolean) => number | null;
  sectionKey: string;
  onSelectArea: (areaId: string) => void;
}) {
  const [open, setOpen] = useState(false)
  const subtotal = sumCells(lineCodes, null, () => true)
  return (
    <>
      <tr className={`pivot-subgroup-row subtotal-row category-divider clickable ${open ? 'open' : ''}`}
          onClick={() => setOpen(o => !o)}>
        <td className="label" style={{ paddingLeft: 32 }}>
          <span className="pivot-card-chev">▶</span>
          {category}
        </td>
        {columns.map(col => {
          const v = sumCells(lineCodes, null, col.matches)
          return <td key={col.key} className={classNum(v)}>{v == null ? '' : fmt(v)}</td>
        })}
        <td className={classNum(subtotal)} style={{ fontWeight: 500 }}>{subtotal == null ? '' : fmt(subtotal)}</td>
      </tr>
      {open && areas.map(area => (
        <AreaLeafRow
          key={`${sectionKey}|${category}|${area.area_id}`}
          area={area}
          lineCodes={lineCodes}
          columns={columns}
          sumCells={sumCells}
          isBalance={false}
          depth={2}
          onSelectArea={onSelectArea}
        />
      ))}
    </>
  )
}

/* Per-area leaf row. Clickable → deep-links into that area's drill. */
function AreaLeafRow({
  area, lineCodes, columns, sumCells, isBalance, depth, onSelectArea,
}: {
  area: CanonicalArea;
  lineCodes: Set<string>;
  columns: Column[];
  sumCells: (lineCodes: Set<string>, areaIds: Set<string> | null, matches: (y: number, m: number) => boolean) => number | null;
  isBalance: boolean;
  depth: number;
  onSelectArea: (areaId: string) => void;
}) {
  const areaSet = useMemo(() => new Set([area.area_id]), [area.area_id])
  const rowTotal = isBalance ? null : sumCells(lineCodes, areaSet, () => true)
  const indent = 12 + depth * 24
  return (
    <tr className="pivot-area-row clickable" onClick={() => onSelectArea(area.area_id)}
        title={`Open ${area.display_name} drill`}>
      <td className="label" style={{ paddingLeft: indent }}>{area.display_name}</td>
      {columns.map(col => {
        const v = sumCells(lineCodes, areaSet, col.matches)
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
}


/* ════════════════════════════════════════════════════════════════════════
   Area-inner rows — emitted inline beneath an expanded area row in the
   outer Area-outer table. Same hierarchical-row pattern as the rest of
   the pivot: section → subgroup/category → line. Period header lives on
   the outer table only, so all monthly columns line up vertically.
   ════════════════════════════════════════════════════════════════════════ */
function AreaInnerRows({
  areaKey, actuals, forecasts, lines, columns, innerGroupBy,
}: {
  areaKey: string;
  actuals: CfCell[];
  forecasts: CfCell[];
  lines: CfLine[];
  columns: Column[];
  innerGroupBy: 'category' | 'nature';
}) {
  const activeLines = useMemo(
    () => lines.filter(l => l.is_active).sort((a, b) => a.sort_order - b.sort_order),
    [lines])

  /* Sum a single line code over the area's cells with a column matcher. */
  const sumLine = (lineCode: string, matches: (y: number, m: number) => boolean): number | null => {
    let sum: number | null = null
    for (const c of actuals)   { if (c.line_code === lineCode && matches(c.year, c.month)) sum = (sum ?? 0) + c.value }
    for (const c of forecasts) { if (c.line_code === lineCode && matches(c.year, c.month)) sum = (sum ?? 0) + c.value }
    return sum
  }
  const sumLines = (lineCodes: string[], matches: (y: number, m: number) => boolean): number | null => {
    let t = 0; let touched = false
    for (const lc of lineCodes) {
      const s = sumLine(lc, matches)
      if (s != null) { t += s; touched = true }
    }
    return touched ? t : null
  }

  if (innerGroupBy === 'category') {
    const sections = SECTIONS_BY_CATEGORY.map(sec => {
      const inSec = activeLines.filter(l => sec.categories.includes(l.category))
      return {
        key: sec.key,
        label: sec.label,
        kind: sec.kind,
        lines: inSec,
        receipts: inSec.filter(l => l.nature === 'Receipts'),
        payments: inSec.filter(l => l.nature === 'Payments'),
      }
    }).filter(s => s.lines.length > 0)
    return (
      <>
        {sections.map(sec => (
          <InnerSectionRow
            key={`${areaKey}|${sec.key}`}
            areaKey={areaKey}
            sec={sec}
            mode="category"
            columns={columns}
            sumLine={sumLine}
            sumLines={sumLines}
          />
        ))}
      </>
    )
  }
  // innerGroupBy === 'nature'
  const opening = activeLines.filter(l => l.category === 'Opening Balance')
  const receipts = activeLines.filter(l => l.nature === 'Receipts')
  const payments = activeLines.filter(l => l.nature === 'Payments')
  const closing = activeLines.filter(l => ['Ending Balance', 'Accumulated Loans', 'Overdrafts'].includes(l.category))
  const natureSections = [
    opening.length ? { key: 'opening',  label: 'Opening Balance',  kind: 'balance' as const, lines: opening,  receipts: [],       payments: []    } : null,
    receipts.length ? { key: 'receipts', label: 'Receipts',         kind: 'flow' as const,    lines: receipts, receipts,           payments: []    } : null,
    payments.length ? { key: 'payments', label: 'Payments',         kind: 'flow' as const,    lines: payments, receipts: [],       payments        } : null,
    closing.length ? { key: 'closing',  label: 'Closing Position', kind: 'balance' as const, lines: closing,  receipts: [],       payments: []    } : null,
  ].filter(Boolean) as { key: string; label: string; kind: 'balance' | 'flow'; lines: CfLine[]; receipts: CfLine[]; payments: CfLine[] }[]
  return (
    <>
      {natureSections.map(sec => (
        <InnerSectionRow
          key={`${areaKey}|${sec.key}`}
          areaKey={areaKey}
          sec={sec}
          mode="nature"
          columns={columns}
          sumLine={sumLine}
          sumLines={sumLines}
        />
      ))}
    </>
  )
}

/* One section row inside an expanded area. Click to expand; reveals
 * subgroup / category rows (depth 2) which in turn hold line rows (depth 3). */
function InnerSectionRow({
  areaKey, sec, mode, columns, sumLine, sumLines,
}: {
  areaKey: string;
  sec: { key: string; label: string; kind: 'balance' | 'flow'; lines: CfLine[]; receipts: CfLine[]; payments: CfLine[] };
  mode: 'category' | 'nature';
  columns: Column[];
  sumLine: (lc: string, m: (y: number, mo: number) => boolean) => number | null;
  sumLines: (lcs: string[], m: (y: number, mo: number) => boolean) => number | null;
}) {
  const [open, setOpen] = useState(false)
  const allCodes = sec.lines.map(l => l.line_code)
  const headTotal = sumLines(allCodes, () => true)
  return (
    <>
      <tr className={`pivot-section-row subtotal-row clickable ${open ? 'open' : ''}`}
          onClick={() => setOpen(o => !o)}>
        <td className="label" style={{ paddingLeft: 24 }}>
          <span className="pivot-card-chev">▶</span>
          {sec.label}
        </td>
        {columns.map(col => {
          const v = sumLines(allCodes, col.matches)
          return <td key={col.key} className={classNum(v)}>{v == null ? '' : fmt(v)}</td>
        })}
        <td className={classNum(headTotal)} style={{ fontWeight: 600 }}>
          {sec.kind === 'balance' || headTotal == null ? '' : fmt(headTotal)}
        </td>
      </tr>
      {open && (sec.kind === 'balance'
        ? <>{sec.lines.map(l => (
            <InnerLineRow key={`${areaKey}|${sec.key}|${l.line_code}`} line={l} columns={columns} sumLine={sumLine} depth={2} />
          ))}</>
        : mode === 'category'
          ? <InnerFlowChildren areaKey={areaKey} sec={sec} columns={columns} sumLine={sumLine} sumLines={sumLines} />
          : <InnerCategoryChildren areaKey={areaKey} lines={sec.lines} sectionKey={sec.key} columns={columns} sumLine={sumLine} sumLines={sumLines} />
      )}
    </>
  )
}

/* Category-mode Flow section: emit Receipts subgroup, Payments subgroup,
 * Net row. Each subgroup row expands to its line items. */
function InnerFlowChildren({
  areaKey, sec, columns, sumLine, sumLines,
}: {
  areaKey: string;
  sec: { key: string; label: string; receipts: CfLine[]; payments: CfLine[] };
  columns: Column[];
  sumLine: (lc: string, m: (y: number, mo: number) => boolean) => number | null;
  sumLines: (lcs: string[], m: (y: number, mo: number) => boolean) => number | null;
}) {
  /* Section row already carries the Net total in its header — skip the
   * redundant Net row at the bottom of the Flow expansion. */
  return (
    <>
      {sec.receipts.length > 0 && (
        <InnerSubgroupRow
          areaKey={areaKey} sectionKey={sec.key}
          label="Receipts" subgroupClass="subgroup-receipts"
          lines={sec.receipts} columns={columns}
          sumLine={sumLine} sumLines={sumLines}
        />
      )}
      {sec.payments.length > 0 && (
        <InnerSubgroupRow
          areaKey={areaKey} sectionKey={sec.key}
          label="Payments" subgroupClass="subgroup-payments"
          lines={sec.payments} columns={columns}
          sumLine={sumLine} sumLines={sumLines}
        />
      )}
    </>
  )
}

/* Nature-mode Flow section (Receipts or Payments): group lines by category
 * and emit a category-divider row per group with line items beneath. */
function InnerCategoryChildren({
  areaKey, lines, sectionKey, columns, sumLine, sumLines,
}: {
  areaKey: string;
  lines: CfLine[];
  sectionKey: string;
  columns: Column[];
  sumLine: (lc: string, m: (y: number, mo: number) => boolean) => number | null;
  sumLines: (lcs: string[], m: (y: number, mo: number) => boolean) => number | null;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, CfLine[]>()
    for (const l of lines) {
      if (!map.has(l.category)) map.set(l.category, [])
      map.get(l.category)!.push(l)
    }
    return [...map.entries()].map(([category, lines]) => ({ category, lines }))
  }, [lines])
  return (
    <>
      {groups.map(grp => (
        <InnerCategoryRow
          key={`${areaKey}|${sectionKey}|${grp.category}`}
          areaKey={areaKey}
          sectionKey={sectionKey}
          category={grp.category}
          lines={grp.lines}
          columns={columns}
          sumLine={sumLine}
          sumLines={sumLines}
        />
      ))}
    </>
  )
}

function InnerSubgroupRow({
  areaKey, sectionKey, label, subgroupClass, lines, columns, sumLine, sumLines,
}: {
  areaKey: string;
  sectionKey: string;
  label: 'Receipts' | 'Payments';
  subgroupClass: string;
  lines: CfLine[];
  columns: Column[];
  sumLine: (lc: string, m: (y: number, mo: number) => boolean) => number | null;
  sumLines: (lcs: string[], m: (y: number, mo: number) => boolean) => number | null;
}) {
  const [open, setOpen] = useState(false)
  const codes = lines.map(l => l.line_code)
  const subtotal = sumLines(codes, () => true)
  return (
    <>
      <tr className={`pivot-subgroup-row subtotal-row ${subgroupClass} clickable ${open ? 'open' : ''}`}
          onClick={() => setOpen(o => !o)}>
        <td className="label" style={{ paddingLeft: 48 }}>
          <span className="pivot-card-chev">▶</span>
          {label}
        </td>
        {columns.map(col => {
          const v = sumLines(codes, col.matches)
          return <td key={col.key} className={classNum(v)}>{v == null ? '' : fmt(v)}</td>
        })}
        <td className={classNum(subtotal)} style={{ fontWeight: 500 }}>{subtotal == null ? '' : fmt(subtotal)}</td>
      </tr>
      {open && lines.map(l => (
        <InnerLineRow key={`${areaKey}|${sectionKey}|${label}|${l.line_code}`} line={l} columns={columns} sumLine={sumLine} depth={3} />
      ))}
    </>
  )
}

function InnerCategoryRow({
  areaKey, sectionKey, category, lines, columns, sumLine, sumLines,
}: {
  areaKey: string;
  sectionKey: string;
  category: string;
  lines: CfLine[];
  columns: Column[];
  sumLine: (lc: string, m: (y: number, mo: number) => boolean) => number | null;
  sumLines: (lcs: string[], m: (y: number, mo: number) => boolean) => number | null;
}) {
  const [open, setOpen] = useState(false)
  const codes = lines.map(l => l.line_code)
  const subtotal = sumLines(codes, () => true)
  return (
    <>
      <tr className={`pivot-subgroup-row subtotal-row category-divider clickable ${open ? 'open' : ''}`}
          onClick={() => setOpen(o => !o)}>
        <td className="label" style={{ paddingLeft: 48 }}>
          <span className="pivot-card-chev">▶</span>
          {category}
        </td>
        {columns.map(col => {
          const v = sumLines(codes, col.matches)
          return <td key={col.key} className={classNum(v)}>{v == null ? '' : fmt(v)}</td>
        })}
        <td className={classNum(subtotal)} style={{ fontWeight: 500 }}>{subtotal == null ? '' : fmt(subtotal)}</td>
      </tr>
      {open && lines.map(l => (
        <InnerLineRow key={`${areaKey}|${sectionKey}|${category}|${l.line_code}`} line={l} columns={columns} sumLine={sumLine} depth={3} />
      ))}
    </>
  )
}

function InnerLineRow({
  line, columns, sumLine, depth,
}: {
  line: CfLine;
  columns: Column[];
  sumLine: (lc: string, m: (y: number, mo: number) => boolean) => number | null;
  depth: number;
}) {
  const rowTotal = sumLine(line.line_code, () => true)
  const indent = 12 + depth * 24
  return (
    <tr>
      <td className="label" style={{ paddingLeft: indent }}>{line.description}</td>
      {columns.map(col => {
        const v = sumLine(line.line_code, col.matches)
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
}

