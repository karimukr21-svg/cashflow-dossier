import { fmt } from '@/lib/format'

type Props = {
  /* The cf_area label this cell writes to (cf_actuals.area). When the
   * canonical area folds multiple cf_areas the caller picks the first;
   * post-2026-06-05 country-grain that is == area_id anyway. */
  cfArea: string | undefined
  lineCode: string
  year: number | undefined
  month: number | undefined
  isActual: boolean
  baselineValue: number | null
  scenarioValue: number | null  // baseline + delta — what to display
  className?: string
}

/* Read-only cell for the per-area drill. With the scenario/what-if layer
 * removed there is no editing path — this renders the value as a plain
 * <td>. Props are kept stable so callers are unchanged. */
export function EditableCell(props: Props) {
  const { scenarioValue, className } = props
  return <td className={className}>{scenarioValue == null ? '' : fmt(scenarioValue)}</td>
}
