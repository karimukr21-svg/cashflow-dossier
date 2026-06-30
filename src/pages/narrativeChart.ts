/* "The year in one shape" — the single restrained trajectory chart that is the
 * visual hero of the Chairman cash-flow report: net liquid funds (cash less
 * loans & overdrafts) across 12 months, crossing zero from deficit to surplus,
 * with an explicit actual/forecast split. Pure SVG string, shared by the
 * on-screen page (Narrative.tsx) and the print document (narrativePrint.ts).
 * Values come in raw (full numbers); plotted + labelled in millions. */

const INK = '#15233b', SLATE = '#64748b', GOOD = '#057a55', BAD = '#E10020', GRID = '#e9ecf1', TINT = '#f6f7f9'

const mm = (v: number) => v / 1e6
const labSigned = (v: number): string => {
  const r = Math.round(mm(v) * 10) / 10
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return r < 0 ? `(${s})` : `+${s}`
}

/* Net-liquid-funds trajectory — cash on hand LESS loans & overdrafts across the
 * year, the single restrained chart that is the visual hero. One series, area +
 * line, actual solid / forecast dashed, crossing zero from deficit to surplus,
 * with start · today · year-end markers. Pure SVG string, shared by the
 * on-screen page and the print document. Values come in raw (full numbers);
 * plotted + labelled in millions. */
export function buildLiquidChart(opts: {
  months: string[]; series: number[]; asOfMonth: number
}): string {
  const { months, series } = opts
  const n = 12, asIdx = opts.asOfMonth - 1
  const v = series.map(mm)

  // symmetric-ish domain around zero (net funds run negative then cross to surplus)
  let ymax = Math.max(0, ...v), ymin = Math.min(0, ...v)
  const pad = (ymax - ymin) * 0.12 || 1
  ymax += pad; ymin -= pad * 0.45
  const range = (ymax - ymin) || 1

  const W = 1360, H = 350
  const plotL = 94, plotR = 1320, plotW = plotR - plotL
  const top = 26, plotH = 256, axisY = top + plotH + 22
  const x = (i: number) => plotL + (i / (n - 1)) * plotW
  const y = (val: number) => top + ((ymax - val) / range) * plotH
  // actual/forecast boundary — the SAME x for the tint edge and the divider
  const divX = (x(asIdx) + x(asIdx + 1)) / 2

  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`
  s += `<defs><linearGradient id="liqGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${INK}" stop-opacity="0.14"/><stop offset="1" stop-color="${INK}" stop-opacity="0.02"/></linearGradient></defs>`

  // actual tint — extends to the divider so the shading edge and the dotted line coincide
  s += `<rect x="${plotL}" y="${top}" width="${(divX - plotL).toFixed(1)}" height="${plotH}" fill="${TINT}"/>`

  // y gridlines + labels + ticks across the negative + positive domain (round step)
  const rawStep = range / 6
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, rawStep))))
  const step = Math.max(mag, Math.ceil(rawStep / mag) * mag)
  const gStart = Math.ceil(ymin / step) * step
  for (let g = gStart; g <= ymax + 0.001; g += step) {
    const yy = y(g)
    const glab = g < 0 ? `(${Math.abs(g).toLocaleString('en-US')})` : g.toLocaleString('en-US')
    s += `<line x1="${plotL}" y1="${yy.toFixed(1)}" x2="${plotR}" y2="${yy.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`
    s += `<line x1="${(plotL - 5).toFixed(1)}" y1="${yy.toFixed(1)}" x2="${plotL}" y2="${yy.toFixed(1)}" stroke="${SLATE}" stroke-width="1"/>`
    s += `<text x="${plotL - 11}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="12.5" font-weight="500" fill="#475569">${glab}</text>`
  }
  // y axis line
  s += `<line x1="${plotL}" y1="${top}" x2="${plotL}" y2="${(top + plotH).toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`
  // zero baseline — emphasised (the deficit/surplus reference)
  { const z = y(0).toFixed(1); s += `<line x1="${plotL}" y1="${z}" x2="${plotR}" y2="${z}" stroke="${INK}" stroke-width="1.2"/>` }

  // area between the curve and the zero baseline
  let area = `M ${x(0).toFixed(1)} ${y(0).toFixed(1)}`
  for (let i = 0; i < n; i++) area += ` L ${x(i).toFixed(1)} ${y(v[i]).toFixed(1)}`
  area += ` L ${x(n - 1).toFixed(1)} ${y(0).toFixed(1)} Z`
  s += `<path d="${area}" fill="url(#liqGrad)"/>`

  const path = (a: number, b: number) => {
    let p = ''; for (let i = a; i <= b; i++) p += `${i === a ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v[i]).toFixed(1)} `; return p.trim()
  }
  s += `<path d="${path(0, asIdx)}" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>`
  s += `<path d="${path(asIdx, n - 1)}" fill="none" stroke="${INK}" stroke-width="3.2" stroke-dasharray="5,4" stroke-linecap="round"/>`
  for (let i = 0; i < n; i++) s += `<circle cx="${x(i).toFixed(1)}" cy="${y(v[i]).toFixed(1)}" r="2.4" fill="${v[i] >= 0 ? GOOD : INK}"/>`

  // divider + labels (divX shared with the tint edge above)
  s += `<line x1="${divX.toFixed(1)}" y1="${top}" x2="${divX.toFixed(1)}" y2="${(top + plotH).toFixed(1)}" stroke="${SLATE}" stroke-width="1.2" stroke-dasharray="4,3" opacity="0.8"/>`
  s += `<text x="${((plotL + divX) / 2).toFixed(1)}" y="${top + 14}" text-anchor="middle" font-size="10" font-weight="700" letter-spacing="1" fill="${SLATE}">ACTUAL</text>`
  s += `<text x="${((divX + plotR) / 2).toFixed(1)}" y="${top + 14}" text-anchor="middle" font-size="10" font-weight="700" letter-spacing="1" fill="${SLATE}">FORECAST</text>`

  // year-end pill — green in surplus, crimson in deficit
  {
    const txt = labSigned(series[n - 1]), w = 8 + txt.length * 7.6
    const cx = x(n - 1) - 6, cy = y(v[n - 1]) - 16
    s += `<g><rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - 11).toFixed(1)}" width="${w.toFixed(1)}" height="22" rx="11" fill="${v[n - 1] >= 0 ? GOOD : BAD}"/><text x="${cx.toFixed(1)}" y="${(cy + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${txt}</text></g>`
  }
  // start marker (Jan) — light outline pill above the point, shifted right to clear the axis
  {
    const txt = `${labSigned(series[0])} · START`, w = 10 + txt.length * 6.2
    const cx = x(0) + w / 2, cy = y(v[0]) - 19
    s += `<circle cx="${x(0).toFixed(1)}" cy="${y(v[0]).toFixed(1)}" r="4" fill="#fff" stroke="${SLATE}" stroke-width="1.6"/>`
    s += `<g><rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - 10).toFixed(1)}" width="${w.toFixed(1)}" height="20" rx="10" fill="#fff" stroke="${SLATE}" stroke-width="1.1"/><text x="${cx.toFixed(1)}" y="${(cy + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="${SLATE}">${txt}</text></g>`
  }
  // today marker + chip
  const nx = x(asIdx), ny = y(v[asIdx])
  s += `<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="5" fill="#fff" stroke="${INK}" stroke-width="2"/>`
  const chip = `${labSigned(series[asIdx])} · TODAY`
  const cw = 12 + chip.length * 6.4
  s += `<g><rect x="${(nx - cw / 2).toFixed(1)}" y="${(ny + 17).toFixed(1)}" width="${cw.toFixed(1)}" height="22" rx="5" fill="${INK}"/><text x="${nx.toFixed(1)}" y="${(ny + 32).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">${chip}</text></g>`

  for (let i = 0; i < n; i++) {
    const isDec = i === n - 1
    s += `<text x="${x(i).toFixed(1)}" y="${axisY}" text-anchor="middle" font-size="11.5" font-weight="${isDec ? 700 : 400}" fill="${isDec ? INK : SLATE}">${months[i]}</text>`
  }
  s += `</svg>`
  return s
}
