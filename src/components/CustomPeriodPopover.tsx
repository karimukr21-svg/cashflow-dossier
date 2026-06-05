import { useState } from 'react'

const YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028]
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

type YM = { year: number; month: number }

function ymInt(ym: YM) { return ym.year * 100 + ym.month }
function ymLte(a: YM, b: YM) { return ymInt(a) <= ymInt(b) }

export default function CustomPeriodPopover({
  fromYM, toYM, latestActualYM, onClose, onApply,
}: {
  fromYM: string;  // "YYYY-MM"
  toYM: string;
  latestActualYM: number;  // YYYYMM as int
  onClose: () => void;
  onApply: (from: string, to: string) => void;
}) {
  const parse = (s: string): YM => {
    const [y, m] = s.split('-').map(Number)
    return { year: y, month: m }
  }
  const [start, setStart] = useState<YM>(parse(fromYM))
  const [end, setEnd] = useState<YM>(parse(toYM))
  const [pickingEnd, setPickingEnd] = useState(false)

  const handleClick = (ym: YM) => {
    if (!pickingEnd) {
      setStart(ym)
      setEnd(ym)
      setPickingEnd(true)
    } else {
      if (ymLte(ym, start)) {
        // clicked before start — restart with this as new start
        setStart(ym)
        setEnd(ym)
        setPickingEnd(true)
      } else {
        setEnd(ym)
        setPickingEnd(false)
      }
    }
  }

  const isEndpoint = (ym: YM) => ymInt(ym) === ymInt(start) || ymInt(ym) === ymInt(end)
  const isInRange = (ym: YM) => ymInt(ym) > ymInt(start) && ymInt(ym) < ymInt(end)

  const apply = () => {
    const f = `${start.year}-${String(start.month).padStart(2, '0')}`
    const t = `${end.year}-${String(end.month).padStart(2, '0')}`
    onApply(f, t)
  }

  return (
    <div className="popover-backdrop" onClick={onClose}>
      <div className="popover" onClick={e => e.stopPropagation()}>
        <h3>Pick period</h3>
        <div className="pop-sub">
          {pickingEnd ? 'Click an end month' : 'Click a start month — then an end month'}{' · '}
          Current: {start.year}-{String(start.month).padStart(2, '0')} → {end.year}-{String(end.month).padStart(2, '0')}
        </div>

        <div className="pop-legend">
          <span className="legend-swatch actual" /> Actual
          <span className="legend-swatch forecast" /> Forecast
          <span className="legend-swatch endpoint" /> Selected
        </div>

        {YEARS.map(y => (
          <div key={y} className="year-grid-row">
            <div className="yr">{y}</div>
            {MONTHS.map((mn, i) => {
              const ym = { year: y, month: i + 1 }
              const ep = isEndpoint(ym)
              const ir = isInRange(ym)
              const isActual = ymInt(ym) <= latestActualYM
              return (
                <div key={mn}
                     className={`month-cell ${isActual ? 'actual-bg' : 'forecast-bg'} ${ep ? 'endpoint' : ''} ${ir ? 'in-range' : ''}`}
                     onClick={() => handleClick(ym)}>
                  {mn}
                </div>
              )
            })}
          </div>
        ))}

        <div className="popover-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={apply}>Apply</button>
        </div>
      </div>
    </div>
  )
}
