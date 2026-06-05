/** Format a number as $K with sign convention */
export function fmt(v: number | null | undefined, opts: { decimals?: number; pos?: boolean } = {}): string {
  if (v == null || isNaN(v)) return '—'
  const d = opts.decimals ?? 1
  const abs = Math.abs(v)
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
  if (v < 0) return `(${s})`
  return s
}

export function classNum(v: number | null | undefined): string {
  if (v == null || isNaN(v)) return 'num'
  if (v < 0) return 'num neg'
  if (v > 0) return 'num pos'
  return 'num'
}

export function fmtDelta(v: number | null | undefined, opts: { decimals?: number } = {}): string {
  if (v == null || isNaN(v)) return '—'
  const d = opts.decimals ?? 1
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
}
