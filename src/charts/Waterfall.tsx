import { fmt } from '../lib/format'

export type WaterfallStep = {
  label: string
  value: number
  /** 'start' and 'end' draw absolute bars from zero (charcoal); 'delta' floats from the running total */
  kind: 'start' | 'delta' | 'end'
}

type Props = {
  steps: WaterfallStep[]
  fmtValue?: (v: number) => string
}

const W = 880
const H = 260
const PAD_L = 56
const PAD_R = 20
const PAD_T = 24
const PAD_B = 34

/** SVG waterfall bridging a start balance through signed deltas to an end balance. */
export default function Waterfall({ steps, fmtValue = fmt }: Props) {
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B

  // Running totals: each bar occupies [lo, hi] in value space
  let cum = 0
  const bars = steps.map(s => {
    let lo: number, hi: number
    if (s.kind === 'start') { lo = Math.min(0, s.value); hi = Math.max(0, s.value); cum = s.value }
    else if (s.kind === 'delta') { const next = cum + s.value; lo = Math.min(cum, next); hi = Math.max(cum, next); cum = next }
    else { lo = Math.min(0, s.value); hi = Math.max(0, s.value) }
    return { ...s, lo, hi, runEnd: s.kind === 'delta' ? cum : s.value }
  })

  const yMin = Math.min(0, ...bars.map(b => b.lo))
  const yMax = Math.max(0, ...bars.map(b => b.hi))
  const span = yMax - yMin || 1
  const yAt = (v: number) => PAD_T + ((yMax - v) / span) * plotH

  const n = bars.length
  const slot = plotW / n
  const barW = Math.min(86, slot * 0.62)
  const xAt = (i: number) => PAD_L + slot * i + (slot - barW) / 2

  const ticks = [yMax, yMax / 2, 0, yMin / 2, yMin]
    .filter((v, i, a) => a.findIndex(o => Math.abs(o - v) < span * 0.04) === i)

  return (
    <svg className="runway-chart" viewBox={`0 0 ${W} ${H}`} role="img">
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={PAD_L} x2={W - PAD_R} y1={yAt(v)} y2={yAt(v)}
            stroke="var(--border)" strokeDasharray={Math.abs(v) < span * 0.001 ? undefined : '3 4'} />
          <text x={PAD_L - 8} y={yAt(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--mute)">{fmtValue(v)}</text>
        </g>
      ))}
      {bars.map((b, i) => {
        const isAbs = b.kind !== 'delta'
        const fill = isAbs ? 'var(--charcoal)' : b.value >= 0 ? 'var(--good)' : 'var(--bad)'
        const y = yAt(b.hi)
        const h = Math.max(1.5, yAt(b.lo) - yAt(b.hi))
        const labelV = b.kind === 'delta' ? b.value : b.value
        const labelText = b.kind === 'delta' && b.value > 0 ? `+${fmtValue(b.value)}` : fmtValue(labelV)
        return (
          <g key={i}>
            {/* connector from previous bar's running level */}
            {i > 0 && (
              <line
                x1={xAt(i - 1) + barW} x2={xAt(i)}
                y1={yAt(bars[i - 1].runEnd)} y2={yAt(bars[i - 1].runEnd)}
                stroke="var(--mute)" strokeDasharray="3 3" strokeWidth="1"
              />
            )}
            <rect x={xAt(i)} y={y} width={barW} height={h} fill={fill} rx="2" opacity={isAbs ? 0.92 : 0.85} />
            <text x={xAt(i) + barW / 2} y={y - 6} textAnchor="middle" fontSize="11" fontWeight="600"
              fill={isAbs ? 'var(--charcoal)' : b.value >= 0 ? 'var(--good)' : 'var(--bad)'}>
              {labelText}
            </text>
            <text x={xAt(i) + barW / 2} y={H - PAD_B + 16} textAnchor="middle" fontSize="10.5" fill="var(--mute)">
              {b.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
