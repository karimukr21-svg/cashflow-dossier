/** Format a number as $K. Defaults to whole numbers; zero (after rounding)
 * renders as an em-dash. Negatives wrapped in parens. */
export function fmt(v: number | null | undefined, opts: { decimals?: number } = {}): string {
  if (v == null || isNaN(v)) return '—'
  const d = opts.decimals ?? 0
  const factor = Math.pow(10, d)
  const rounded = Math.round(v * factor) / factor
  if (rounded === 0) return '—'
  const abs = Math.abs(rounded)
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
  if (rounded < 0) return `(${s})`
  return s
}

export function classNum(v: number | null | undefined, opts: { decimals?: number } = {}): string {
  if (v == null || isNaN(v)) return 'num'
  const d = opts.decimals ?? 0
  const factor = Math.pow(10, d)
  const rounded = Math.round(v * factor) / factor
  if (rounded === 0) return 'num'
  if (rounded < 0) return 'num neg'
  return 'num pos'
}

export function fmtDelta(v: number | null | undefined, opts: { decimals?: number } = {}): string {
  if (v == null || isNaN(v)) return '—'
  const d = opts.decimals ?? 0
  const factor = Math.pow(10, d)
  const rounded = Math.round(v * factor) / factor
  if (rounded === 0) return '—'
  const sign = rounded > 0 ? '+' : ''
  return `${sign}${rounded.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
}
