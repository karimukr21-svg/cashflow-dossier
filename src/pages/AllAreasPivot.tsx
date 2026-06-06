import { Fragment, useMemo, useState } from 'react'
import type { CfCell, CfLine, CanonicalArea } from '@/lib/queries'
import type { Scope } from './Dossier'
import { fmt, classNum } from '@/lib/format'
import { AreaCategoryCards, buildColumns } from './AreaDrill'

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
            return (
              <Fragment key={area.area_id}>
                <tr className={`pivot-area-headrow subtotal-row clickable ${isOpen ? 'open' : ''}`}
                    onClick={() => toggle(area.area_id)}>
                  <td className="label">
                    <span className="pivot-card-chev">▶</span>
                    {area.display_name}
                  </td>
                  {columns.map(col => {
                    const v = areaNet(area.area_id, col.matches)
                    return <td key={col.key} className={classNum(v)}>{v == null ? '' : fmt(v)}</td>
                  })}
                  <td className={classNum(rowTotal)} style={{ fontWeight: 600 }}>
                    {rowTotal == null ? '' : fmt(rowTotal)}
                  </td>
                </tr>
                {isOpen && bucket && (
                  <tr className="pivot-area-expandedrow">
                    <td colSpan={2 + columns.length} className="pivot-area-expanded-cell">
                      <AreaCategoryCards
                        actuals={bucket.actuals}
                        forecasts={bucket.forecasts}
                        lines={lines}
                        grain={scope.grain}
                        scope={scope}
                        groupBy={innerGroupBy}
                      />
                    </td>
                  </tr>
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

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ width: tableMinWidth }}>
        {outerSections.map(sec => (
          <SectionCard
            key={sec.key}
            sec={sec}
            ord={scope.ord}
            outer={outer} middle={middle} inner={inner}
            columns={columns}
            tableMinWidth={tableMinWidth}
            areas={areas}
            sumCells={sumCells}
            onSelectArea={onSelectArea}
          />
        ))}
      </div>
    </div>
  )
}

/* ───── One outer section card ───── */
function SectionCard({
  sec, ord, outer, middle, inner,
  columns, tableMinWidth, areas, sumCells, onSelectArea,
}: {
  sec: { key: string; label: string; kind: SectionKind; lines: CfLine[]; receipts: CfLine[]; payments: CfLine[]; natureClass: string };
  ord: string;
  outer: 'N' | 'C';
  middle: 'A' | 'N' | 'C';
  inner: 'A' | 'N' | 'C';
  columns: Column[];
  tableMinWidth: number;
  areas: CanonicalArea[];
  sumCells: (lineCodes: Set<string>, areaIds: Set<string> | null, matches: (y: number, m: number) => boolean) => number | null;
  onSelectArea: (areaId: string) => void;
}) {
  const allAreaIds = useMemo(() => new Set(areas.map(a => a.area_id)), [areas])
  const allLineCodes = useMemo(() => new Set(sec.lines.map(l => l.line_code)), [sec.lines])

  // Header subtotal for the whole card (across ALL areas, all lines in section)
  const cardTotal = sumCells(allLineCodes, null, () => true)

  return (
    <div className="cat-group">
      <div className={`cat-group-header ${sec.natureClass}`}>
        <span>{sec.label}</span>
        {cardTotal != null && (
          <span className="cat-totals">{sec.kind === 'balance' ? 'Total' : 'Total'}: {fmt(cardTotal)}</span>
        )}
      </div>
      <table className="cf-table" style={{ tableLayout: 'fixed', width: sec.kind === 'balance' ? tableMinWidth - TOTAL_COL_PX : tableMinWidth }}>
        <colgroup>
          <col style={{ width: LABEL_COL_PX }} />
          {columns.map(c => <col key={c.key} style={{ width: PERIOD_COL_PX }} />)}
          {sec.kind === 'flow' && <col style={{ width: TOTAL_COL_PX }} />}
        </colgroup>
        <thead>
          <tr>
            <th className="label" style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}>
              {sec.kind === 'balance' ? 'Line' : 'Line'}
            </th>
            {columns.map(c => (
              <th key={c.key} className={c.isActual ? 'cell actual' : 'cell forecast'}>{c.label}</th>
            ))}
            {sec.kind === 'flow' && <th>Total</th>}
          </tr>
        </thead>
        <tbody>
          <SectionBody
            sec={sec} ord={ord} middle={middle} inner={inner}
            columns={columns} areas={areas} allAreaIds={allAreaIds}
            sumCells={sumCells} onSelectArea={onSelectArea}
          />
        </tbody>
      </table>
    </div>
  )
}

/* ───── Section body — branches on whether Area is middle or inner ───── */
function SectionBody({
  sec, ord, middle, inner, columns, areas, allAreaIds, sumCells, onSelectArea,
}: {
  sec: { key: string; label: string; kind: SectionKind; lines: CfLine[]; receipts: CfLine[]; payments: CfLine[] };
  ord: string;
  middle: 'A' | 'N' | 'C';
  inner: 'A' | 'N' | 'C';
  columns: Column[];
  areas: CanonicalArea[];
  allAreaIds: Set<string>;
  sumCells: (lineCodes: Set<string>, areaIds: Set<string> | null, matches: (y: number, m: number) => boolean) => number | null;
  onSelectArea: (areaId: string) => void;
}) {
  /* V1: all section-outer orderings (NCA / CNA / NAC / CAN) treat Area as
   * the leaf with per-area total rows. NAC / CAN technically place Area in
   * the middle position (line items beneath each area) — that view is
   * deferred to v2. For v1 the swap arrow can still produce CAN/NAC but
   * the rendering matches CNA/NCA respectively. ord[1] is what we honor:
   *  - outer === 'C': Receipts/Payments subgroups inside Flow sections
   *  - outer === 'N': Category dividers inside Flow sections
   * (which dimension sits at middle in the chip control doesn't change
   * what the leaf shows — Area at any non-outer position renders totals.) */
  const outerDim = ord[0] as 'N' | 'C'
  return (
    <SectionAreaLeaf
      sec={sec} columns={columns} areas={areas} sumCells={sumCells}
      showNatureSubgroups={outerDim === 'C' && sec.kind === 'flow'}
      showCategoryDividers={outerDim === 'N' && sec.kind === 'flow'}
      onSelectArea={onSelectArea}
    />
  )
}

/* ───── Per-area leaf renderer ─────
 * Rendered inside a section card. If the section is Flow and we should show
 * Nature subgroups (Receipts/Payments), emits two area-row groups. If we
 * should show category dividers, splits Receipts/Payments lines by category
 * first. Per-area total rows at the deepest level. */
function SectionAreaLeaf({
  sec, columns, areas, sumCells, showCategoryDividers, showNatureSubgroups, onSelectArea,
}: {
  sec: { key: string; label: string; kind: SectionKind; lines: CfLine[]; receipts: CfLine[]; payments: CfLine[] };
  columns: Column[];
  areas: CanonicalArea[];
  sumCells: (lineCodes: Set<string>, areaIds: Set<string> | null, matches: (y: number, m: number) => boolean) => number | null;
  showCategoryDividers: boolean;
  showNatureSubgroups: boolean;
  onSelectArea: (areaId: string) => void;
}) {
  /* Balance sections: skip Receipts/Payments split — just per-area rows
   * for the section's balance lines. */
  if (sec.kind === 'balance') {
    const lineCodes = new Set(sec.lines.map(l => l.line_code))
    return (
      <>
        {areas.map(area => (
          <AreaRow
            key={area.area_id}
            area={area}
            lineCodes={lineCodes}
            columns={columns}
            sumCells={sumCells}
            isBalance={true}
            onSelectArea={onSelectArea}
          />
        ))}
      </>
    )
  }

  /* Flow sections: render Receipts and Payments as subgroups, with per-area
   * totals beneath each. Category dividers slot in between when ord includes
   * Category as a middle dimension. */
  return (
    <>
      {sec.receipts.length > 0 && (
        <FlowAreaSubgroup
          label="Receipts" subgroupClass="subgroup-receipts"
          lines={sec.receipts} columns={columns} areas={areas}
          sumCells={sumCells}
          showCategoryDividers={showCategoryDividers}
          showSubgroupHeader={showNatureSubgroups || showCategoryDividers}
          sectionKey={sec.key}
          onSelectArea={onSelectArea}
        />
      )}
      {sec.payments.length > 0 && (
        <FlowAreaSubgroup
          label="Payments" subgroupClass="subgroup-payments"
          lines={sec.payments} columns={columns} areas={areas}
          sumCells={sumCells}
          showCategoryDividers={showCategoryDividers}
          showSubgroupHeader={showNatureSubgroups || showCategoryDividers}
          sectionKey={sec.key}
          onSelectArea={onSelectArea}
        />
      )}
      {sec.receipts.length > 0 && sec.payments.length > 0 && (
        <NetRow sec={sec} columns={columns} sumCells={sumCells} />
      )}
    </>
  )
}

/* Subgroup (Receipts / Payments) — header row + per-area totals. When
 * showCategoryDividers is true, splits the lines into category dividers
 * with per-area rows under each. */
function FlowAreaSubgroup({
  label, subgroupClass, lines, columns, areas, sumCells,
  showCategoryDividers, showSubgroupHeader, sectionKey, onSelectArea,
}: {
  label: 'Receipts' | 'Payments';
  subgroupClass: string;
  lines: CfLine[];
  columns: Column[];
  areas: CanonicalArea[];
  sumCells: (lineCodes: Set<string>, areaIds: Set<string> | null, matches: (y: number, m: number) => boolean) => number | null;
  showCategoryDividers: boolean;
  showSubgroupHeader: boolean;
  sectionKey: string;
  onSelectArea: (areaId: string) => void;
}) {
  const subKey = `${sectionKey}|${label}`
  const [open, setOpen] = useState(false)

  const allLineCodes = useMemo(() => new Set(lines.map(l => l.line_code)), [lines])
  const subtotal = sumCells(allLineCodes, null, () => true)

  /* Build category dividers when needed (Category dimension is in the
   * middle/inner mix). Each divider holds the lines for that category
   * (within this subgroup's nature). */
  const categoryGroups = useMemo(() => {
    if (!showCategoryDividers) return [{ category: '', lines, lineCodes: allLineCodes }]
    const map = new Map<string, CfLine[]>()
    for (const l of lines) {
      if (!map.has(l.category)) map.set(l.category, [])
      map.get(l.category)!.push(l)
    }
    return [...map.entries()].map(([category, lines]) => ({
      category, lines, lineCodes: new Set(lines.map(l => l.line_code)),
    }))
  }, [lines, allLineCodes, showCategoryDividers])

  return (
    <>
      {showSubgroupHeader && (
        <tr className={`subgroup-header subtotal-row ${subgroupClass} clickable`}
            onClick={() => setOpen(o => !o)}>
          <td className="label">
            <span style={{ display: 'inline-block', width: 10, marginRight: 8, fontSize: 9, opacity: 0.65, transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }}>▶</span>
            {label}
          </td>
          {columns.map(col => {
            const v = sumCells(allLineCodes, null, col.matches)
            return <td key={col.key} className={classNum(v)}>{v == null ? '' : fmt(v)}</td>
          })}
          <td className={classNum(subtotal)}>{subtotal == null ? '' : fmt(subtotal)}</td>
        </tr>
      )}
      {(!showSubgroupHeader || open) && categoryGroups.map(grp => (
        <CategoryAreaGroup
          key={grp.category || 'all'}
          category={grp.category}
          lineCodes={grp.lineCodes}
          columns={columns}
          areas={areas}
          sumCells={sumCells}
          subKey={subKey}
          onSelectArea={onSelectArea}
        />
      ))}
    </>
  )
}

/* Inside a subgroup: optional category divider header, then per-area
 * totals rows. Toggle to expand/collapse category. */
function CategoryAreaGroup({
  category, lineCodes, columns, areas, sumCells, subKey, onSelectArea,
}: {
  category: string;
  lineCodes: Set<string>;
  columns: Column[];
  areas: CanonicalArea[];
  sumCells: (lineCodes: Set<string>, areaIds: Set<string> | null, matches: (y: number, m: number) => boolean) => number | null;
  subKey: string;
  onSelectArea: (areaId: string) => void;
}) {
  const [open, setOpen] = useState(false)
  const subtotal = sumCells(lineCodes, null, () => true)
  return (
    <>
      {category && (
        <tr className="category-divider subtotal-row category-subtotal clickable"
            onClick={() => setOpen(o => !o)}>
          <td className="label">
            <span style={{ display: 'inline-block', width: 10, marginRight: 8, fontSize: 9, opacity: 0.65, transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }}>▶</span>
            {category}
          </td>
          {columns.map(col => {
            const v = sumCells(lineCodes, null, col.matches)
            return <td key={col.key} className={classNum(v)}>{v == null ? '' : fmt(v)}</td>
          })}
          <td className={classNum(subtotal)}>{subtotal == null ? '' : fmt(subtotal)}</td>
        </tr>
      )}
      {(!category || open) && areas.map(area => (
        <AreaRow
          key={`${subKey}|${category}|${area.area_id}`}
          area={area}
          lineCodes={lineCodes}
          columns={columns}
          sumCells={sumCells}
          isBalance={false}
          onSelectArea={onSelectArea}
        />
      ))}
    </>
  )
}

/* One per-area total row at the leaf. Clicking deep-links to that area. */
function AreaRow({
  area, lineCodes, columns, sumCells, isBalance, onSelectArea,
}: {
  area: CanonicalArea;
  lineCodes: Set<string>;
  columns: Column[];
  sumCells: (lineCodes: Set<string>, areaIds: Set<string> | null, matches: (y: number, m: number) => boolean) => number | null;
  isBalance: boolean;
  onSelectArea: (areaId: string) => void;
}) {
  const areaSet = useMemo(() => new Set([area.area_id]), [area.area_id])
  const rowTotal = isBalance ? null : sumCells(lineCodes, areaSet, () => true)
  return (
    <tr className="pivot-area-row clickable" onClick={() => onSelectArea(area.area_id)} title={`Open ${area.display_name} drill`}>
      <td className="label" style={{ paddingLeft: 24 }}>{area.display_name}</td>
      {columns.map(col => {
        const v = sumCells(lineCodes, areaSet, col.matches)
        return (
          <td key={col.key} className={`${classNum(v)} ${col.isActual ? 'cell actual' : 'cell forecast'}`}>
            {v == null ? '' : fmt(v)}
          </td>
        )
      })}
      {!isBalance && (
        <td className={classNum(rowTotal)} style={{ fontWeight: 500 }}>
          {rowTotal == null ? '' : fmt(rowTotal)}
        </td>
      )}
    </tr>
  )
}

/* Net row at the bottom of a Flow section (Receipts + Payments) — only
 * rendered when both Receipts and Payments exist in the section. */
function NetRow({
  sec, columns, sumCells,
}: {
  sec: { label: string; receipts: CfLine[]; payments: CfLine[] };
  columns: Column[];
  sumCells: (lineCodes: Set<string>, areaIds: Set<string> | null, matches: (y: number, m: number) => boolean) => number | null;
}) {
  const receiptsCodes = new Set(sec.receipts.map(l => l.line_code))
  const paymentsCodes = new Set(sec.payments.map(l => l.line_code))
  const netTotal = (() => {
    const r = sumCells(receiptsCodes, null, () => true)
    const p = sumCells(paymentsCodes, null, () => true)
    if (r == null && p == null) return null
    return (r ?? 0) + (p ?? 0)
  })()
  return (
    <tr className="total net-row">
      <td className="label">Net {sec.label}</td>
      {columns.map(col => {
        const r = sumCells(receiptsCodes, null, col.matches)
        const p = sumCells(paymentsCodes, null, col.matches)
        const v = (r == null && p == null) ? null : ((r ?? 0) + (p ?? 0))
        return <td key={col.key} className={classNum(v)}>{v == null ? '' : fmt(v)}</td>
      })}
      <td className={classNum(netTotal)}>{netTotal == null ? '' : fmt(netTotal)}</td>
    </tr>
  )
}

