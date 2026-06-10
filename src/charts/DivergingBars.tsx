import { fmt } from '../lib/format'

export type DivergingRow = {
  key: string
  label: string
  /** magnitude drawn left of the axis (red) — pass positive numbers */
  neg?: number
  /** magnitude drawn right of the axis (green) — pass positive numbers */
  pos?: number
  /** optional signed net shown in the right gutter */
  net?: number
  onClick?: () => void
  active?: boolean
}

type Props = {
  rows: DivergingRow[]
  negHeader?: string
  posHeader?: string
  showNet?: boolean
  fmtValue?: (v: number) => string
}

/**
 * Horizontal diverging bar chart. One row per item: red bar extends left,
 * green bar extends right, both scaled to the max magnitude in the set.
 * Div-based (not SVG) so labels stay crisp and rows can be clickable.
 */
export default function DivergingBars({ rows, negHeader, posHeader, showNet, fmtValue = fmt }: Props) {
  const maxAbs = Math.max(1, ...rows.flatMap(r => [Math.abs(r.neg ?? 0), Math.abs(r.pos ?? 0)]))
  const pct = (v: number) => `${Math.min(100, (Math.abs(v) / maxAbs) * 100)}%`

  return (
    <div className="dvb">
      {(negHeader || posHeader) && (
        <div className="dvb-row dvb-head">
          <div className="dvb-label" />
          <div className="dvb-side dvb-neg-side"><span>{negHeader}</span></div>
          <div className="dvb-side dvb-pos-side"><span>{posHeader}</span></div>
          {showNet && <div className="dvb-net">Net</div>}
        </div>
      )}
      {rows.map(r => {
        const neg = Math.abs(r.neg ?? 0)
        const pos = Math.abs(r.pos ?? 0)
        return (
          <div
            key={r.key}
            className={`dvb-row${r.onClick ? ' clickable' : ''}${r.active ? ' active' : ''}`}
            onClick={r.onClick}
          >
            <div className="dvb-label">{r.label}</div>
            <div className="dvb-side dvb-neg-side">
              {neg > 0 && <span className="dvb-val neg">{fmtValue(-neg)}</span>}
              {neg > 0 && <div className="dvb-bar neg" style={{ width: pct(neg) }} />}
            </div>
            <div className="dvb-side dvb-pos-side">
              {pos > 0 && <div className="dvb-bar pos" style={{ width: pct(pos) }} />}
              {pos > 0 && <span className="dvb-val pos">{fmtValue(pos)}</span>}
            </div>
            {showNet && (
              <div className={`dvb-net num${(r.net ?? 0) < 0 ? ' neg' : (r.net ?? 0) > 0 ? ' pos' : ''}`}>
                {fmtValue(r.net ?? 0)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
