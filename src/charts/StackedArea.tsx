import { fmt } from '../lib/format'

export type StackedAreaSeries = {
  name: string
  color: string
  values: number[]
}

type Props = {
  /** x-axis labels, one per point */
  labels: string[]
  /** stacked bottom-up; all values expected >= 0 (magnitudes) */
  series: StackedAreaSeries[]
  /** index of the last actual point — a dashed seam is drawn after it */
  seamIndex?: number | null
  fmtValue?: (v: number) => string
}

const W = 880
const H = 260
const PAD_L = 56
const PAD_R = 20
const PAD_T = 16
const PAD_B = 30

/** SVG stacked area chart with an actual/forecast seam, following the trajectory-chart conventions. */
export default function StackedArea({ labels, series, seamIndex = null, fmtValue = fmt }: Props) {
  const n = labels.length
  if (n === 0 || series.length === 0) return null
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B

  // cumulative stacks: tops[s][i] = sum of series 0..s at point i
  const tops: number[][] = []
  for (let s = 0; s < series.length; s++) {
    tops.push(labels.map((_, i) => (s > 0 ? tops[s - 1][i] : 0) + Math.abs(series[s].values[i] ?? 0)))
  }
  const yMax = Math.max(1, ...tops[tops.length - 1])
  const xAt = (i: number) => PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * plotW)
  const yAt = (v: number) => PAD_T + ((yMax - v) / yMax) * plotH

  const areaPath = (lower: number[], upper: number[]) => {
    const up = upper.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ')
    const down = [...lower].reverse().map((v, idx) => {
      const i = n - 1 - idx
      return `L${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`
    }).join(' ')
    return `${up} ${down} Z`
  }

  const ticks = [yMax, yMax * 0.75, yMax * 0.5, yMax * 0.25, 0]
  const seamX = seamIndex != null && seamIndex >= 0 && seamIndex < n - 1
    ? xAt(seamIndex) + (plotW / (n - 1)) / 2
    : null

  return (
    <svg className="runway-chart" viewBox={`0 0 ${W} ${H}`} role="img">
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={PAD_L} x2={W - PAD_R} y1={yAt(v)} y2={yAt(v)}
            stroke="var(--border)" strokeDasharray={v === 0 ? undefined : '3 4'} />
          <text x={PAD_L - 8} y={yAt(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--mute)">{fmtValue(v)}</text>
        </g>
      ))}
      {series.map((s, idx) => (
        <path key={s.name}
          d={areaPath(idx === 0 ? labels.map(() => 0) : tops[idx - 1], tops[idx])}
          fill={s.color} opacity="0.22" />
      ))}
      {series.map((s, idx) => (
        <path key={`${s.name}-line`}
          d={tops[idx].map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ')}
          fill="none" stroke={s.color} strokeWidth="2" />
      ))}
      {seamX != null && (
        <line x1={seamX} x2={seamX} y1={PAD_T} y2={H - PAD_B}
          stroke="var(--charcoal)" opacity="0.4" strokeDasharray="4 4" />
      )}
      {labels.map((l, i) => (
        (n <= 14 || i % 2 === 0) && (
          <text key={i} x={xAt(i)} y={H - PAD_B + 16} textAnchor="middle" fontSize="10" fill="var(--mute)">{l}</text>
        )
      ))}
      <g transform={`translate(${PAD_L}, ${PAD_T + 4})`}>
        {series.map((s, i) => (
          <g key={s.name} transform={`translate(${i * 130}, 0)`}>
            <rect width="14" height="2" y="3" fill={s.color} />
            <text x="20" y="7" fontSize="10.5" fill="var(--charcoal)">{s.name}</text>
          </g>
        ))}
      </g>
    </svg>
  )
}
