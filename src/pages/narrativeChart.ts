/* "The year in one shape" — the single restrained trajectory chart that is the
 * visual hero of the Chairman cash-flow report. Net funds line (the punchline,
 * crossing zero to surplus) over a liabilities/debt band, across 12 months,
 * with an explicit actual/forecast split. Pure SVG string, shared by the
 * on-screen page (Narrative.tsx) and the print document (narrativePrint.ts).
 * Values come in raw (full numbers); plotted + labelled in millions. */

const INK = '#15233b', SLATE = '#64748b', GOOD = '#057a55', BAD = '#E10020', GRID = '#e9ecf1', TINT = '#f6f7f9'

const mm = (v: number) => v / 1e6
const lab = (v: number): string => {
  const r = Math.round(mm(v) * 10) / 10
  if (r === 0) return '0.0'
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return r < 0 ? `(${s})` : s
}
const labSigned = (v: number): string => {
  const r = Math.round(mm(v) * 10) / 10
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return r < 0 ? `(${s})` : `+${s}`
}

export function buildTrajectorySvg(opts: {
  months: string[]
  liabilities: number[]   // 12 raw values (positive stock)
  netFunds: number[]      // 12 raw values (cash − debt)
  asOfMonth: number       // 1..12
}): string {
  const { months, liabilities, netFunds } = opts
  const n = 12
  const asIdx = opts.asOfMonth - 1
  const liabM = liabilities.map(mm), nfM = netFunds.map(mm)

  // symmetric Y domain from the data (no hardcoded ceiling)
  const peak = Math.max(1, ...liabM.map(Math.abs), ...nfM.map(Math.abs))
  const D = Math.ceil(peak / 50) * 50

  const W = 1360, H = 384
  const plotL = 66, plotR = 1306, plotW = plotR - plotL
  const top = 30, plotH = 286, mid = top + plotH / 2
  const axisY = top + plotH + 22
  const x = (i: number) => plotL + (i / (n - 1)) * plotW
  const y = (v: number) => mid - (v / D) * (plotH / 2)

  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`
  s += `<defs><linearGradient id="liabGrad" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${BAD}" stop-opacity="0.16"/><stop offset="1" stop-color="${BAD}" stop-opacity="0.03"/></linearGradient></defs>`

  // actual tint panel
  s += `<rect x="${plotL}" y="${top}" width="${(x(asIdx) - plotL).toFixed(1)}" height="${plotH}" fill="${TINT}"/>`

  // gridlines + axis labels (multiples of 150 within domain)
  for (let g = 150; g <= D; g += 150) {
    for (const lvl of [g, -g]) {
      const yy = y(lvl).toFixed(1)
      s += `<line x1="${plotL}" y1="${yy}" x2="${plotR}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`
      s += `<text x="${plotL - 10}" y="${(y(lvl) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${SLATE}">${lvl > 0 ? lvl : '(' + Math.abs(lvl) + ')'}</text>`
    }
  }

  // liabilities area (down to zero baseline)
  let area = `M ${x(0).toFixed(1)} ${y(0).toFixed(1)}`
  for (let i = 0; i < n; i++) area += ` L ${x(i).toFixed(1)} ${y(liabM[i]).toFixed(1)}`
  area += ` L ${x(n - 1).toFixed(1)} ${y(0).toFixed(1)} Z`
  s += `<path d="${area}" fill="url(#liabGrad)"/>`

  // helper: polyline path for a value array over a slice [a,b]
  const path = (arr: number[], a: number, b: number) => {
    let p = ''
    for (let i = a; i <= b; i++) p += `${i === a ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(arr[i]).toFixed(1)} `
    return p.trim()
  }

  // liabilities line — solid actual, dashed forecast
  s += `<path d="${path(liabM, 0, asIdx)}" fill="none" stroke="${BAD}" stroke-width="2"/>`
  s += `<path d="${path(liabM, asIdx, n - 1)}" fill="none" stroke="${BAD}" stroke-width="2" stroke-dasharray="5,4"/>`

  // net funds line — segment by segment so we can flip ink→green where ≥0, dashed in forecast
  for (let i = 0; i < n - 1; i++) {
    const both0 = nfM[i] >= 0 && nfM[i + 1] >= 0
    const color = both0 ? GOOD : INK
    const dashed = i >= asIdx
    s += `<line x1="${x(i).toFixed(1)}" y1="${y(nfM[i]).toFixed(1)}" x2="${x(i + 1).toFixed(1)}" y2="${y(nfM[i + 1]).toFixed(1)}" stroke="${color}" stroke-width="3.2"${dashed ? ' stroke-dasharray="5,4"' : ''} stroke-linecap="round"/>`
  }
  // net funds dots
  for (let i = 0; i < n; i++) {
    s += `<circle cx="${x(i).toFixed(1)}" cy="${y(nfM[i]).toFixed(1)}" r="2.4" fill="${nfM[i] >= 0 ? GOOD : INK}"/>`
  }

  // zero baseline (emphasised)
  s += `<line x1="${plotL}" y1="${y(0).toFixed(1)}" x2="${plotR}" y2="${y(0).toFixed(1)}" stroke="${INK}" stroke-width="1.3"/>`

  // actual/forecast divider + labels
  const divX = ((x(asIdx) + x(asIdx + 1)) / 2).toFixed(1)
  s += `<line x1="${divX}" y1="${top}" x2="${divX}" y2="${top + plotH}" stroke="${SLATE}" stroke-width="1" stroke-dasharray="3,3" opacity="0.7"/>`
  s += `<text x="${(x(Math.max(0, asIdx - 1))).toFixed(1)}" y="${top + 14}" text-anchor="middle" font-size="10" font-weight="700" letter-spacing="1" fill="${SLATE}">ACTUAL</text>`
  s += `<text x="${(x(asIdx + 2)).toFixed(1)}" y="${top + 14}" text-anchor="middle" font-size="10" font-weight="700" letter-spacing="1" fill="${SLATE}">FORECAST</text>`

  // debt plateau annotation
  const plateau = Math.round((liabM.slice(0, n - 1).reduce((a, b) => a + b, 0) / (n - 1)) / 50) * 50
  s += `<text x="${(x(6)).toFixed(1)}" y="${(y(D) + 30).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="${BAD}">Debt ≈ ${plateau}m most of the year</text>`

  // end pills at Dec
  const liEnd = liabM[n - 1], nfEnd = nfM[n - 1]
  const pill = (cx: number, cy: number, txt: string, fill: string, stroke: string, tcol: string) => {
    const w = 8 + txt.length * 7.6
    return `<g><rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - 11).toFixed(1)}" width="${w.toFixed(1)}" height="22" rx="11" fill="${fill}" stroke="${stroke}" stroke-width="1.3"/>`
      + `<text x="${cx.toFixed(1)}" y="${(cy + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="${tcol}">${txt}</text></g>`
  }
  s += pill(x(n - 1) - 4, y(liEnd) - 16, lab(liabilities[n - 1]), '#fff', BAD, BAD)
  s += pill(x(n - 1) - 4, y(nfEnd) - 16, labSigned(netFunds[n - 1]), GOOD, GOOD, '#fff')

  // NOW callout at as-of net funds point
  const nx = x(asIdx), ny = y(nfM[asIdx])
  s += `<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="5" fill="#fff" stroke="${INK}" stroke-width="2"/>`
  const chip = `${lab(netFunds[asIdx])} · NET FUNDS TODAY`
  const cw = 12 + chip.length * 6.4
  const chipY = ny + 30
  s += `<g><rect x="${(nx - cw / 2).toFixed(1)}" y="${(chipY - 13).toFixed(1)}" width="${cw.toFixed(1)}" height="22" rx="5" fill="${INK}"/>`
    + `<text x="${nx.toFixed(1)}" y="${(chipY + 2).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">${chip}</text></g>`

  // month axis
  for (let i = 0; i < n; i++) {
    const isDec = i === n - 1
    s += `<text x="${x(i).toFixed(1)}" y="${axisY}" text-anchor="middle" font-size="11.5" font-weight="${isDec ? 700 : 400}" fill="${isDec ? INK : SLATE}">${months[i]}</text>`
  }

  s += `</svg>`
  return s
}
