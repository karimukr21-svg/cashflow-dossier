/* Pure-SVG chart builders for the Cash Flow Report, shared by the screen
 * (CashReport.tsx via dangerouslySetInnerHTML) and print (reportPrint.ts).
 * Values come in RAW (full native or USD). Bar geometry is relative so the
 * divisor doesn't matter for it; the value LABELS follow the display
 * denomination (millions / '000 / units) passed in via `disp`. */

const INK = '#15233b', MUTE = '#64748b', CRIM = '#E10020', GOOD = '#057a55', GRID = '#e2e8f0'
export type ChartDisp = { div: number; dec: number }
const DEF: ChartDisp = { div: 1e6, dec: 1 }
const mm = (v: number) => v / 1e6
const labf = (v: number, d: ChartDisp): string => {
  const f = Math.pow(10, d.dec)
  const r = Math.round((v / d.div) * f) / f
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: d.dec, maximumFractionDigits: d.dec })
  return r < 0 ? `(${s})` : s
}

/* Waterfall: how the section nets build to net cash movement. zoom scales the
 * value + axis-label fonts (geometry unchanged). */
export function waterfallSvg(items: { label: string; value: number }[], total: number, disp: ChartDisp = DEF, zoom = 1): string {
  const lab = (v: number) => labf(v, disp)
  const vf = (10.5 * zoom).toFixed(1), lf = (9 * zoom).toFixed(1)
  const W = 560, H = 300, padL = 6, padR = 6, top = 30, bottom = 62
  const plotW = W - padL - padR, plotH = H - top - bottom
  const bars = [...items.map(it => ({ label: it.label, value: it.value, total: false })), { label: 'Net movement', value: total, total: true }]
  let cum = 0
  const geo = bars.map(b => { const start = b.total ? 0 : cum; const end = b.total ? total : (cum += b.value); return { ...b, start, end } })
  const ys = [0, ...geo.flatMap(g => [g.start, g.end])]
  let ymin = Math.min(...ys), ymax = Math.max(...ys)
  const pad = (ymax - ymin) * 0.16 || 1; ymin -= pad; ymax += pad
  const yM = (v: number) => top + (mm(ymax) - mm(v)) / (mm(ymax) - mm(ymin) || 1) * plotH
  const n = bars.length, slot = plotW / n, bw = Math.min(48, slot * 0.6)
  const cx = (i: number) => padL + (i + 0.5) * slot
  const zero = yM(0)
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`
  s += `<line x1="${padL}" y1="${zero.toFixed(1)}" x2="${W - padR}" y2="${zero.toFixed(1)}" stroke="${INK}" stroke-width="1"/>`
  geo.forEach((g, i) => {
    const yA = yM(g.start), yB = yM(g.end)
    const t = Math.min(yA, yB), h = Math.max(2, Math.abs(yA - yB))
    const up = g.end >= g.start
    const fill = g.total ? INK : (up ? GOOD : CRIM)
    s += `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${t.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" opacity="${g.total ? 1 : 0.85}" rx="2"/>`
    const vy = up ? t - 5 : t + h + 12
    s += `<text x="${cx(i).toFixed(1)}" y="${vy.toFixed(1)}" text-anchor="middle" font-size="${vf}" font-weight="700" fill="${fill}">${lab(g.value)}</text>`
    if (i < geo.length - 1 && !geo[i + 1].total)
      s += `<line x1="${(cx(i) + bw / 2).toFixed(1)}" y1="${yB.toFixed(1)}" x2="${(cx(i + 1) - bw / 2).toFixed(1)}" y2="${yB.toFixed(1)}" stroke="${MUTE}" stroke-width="0.8" stroke-dasharray="3,2"/>`
    const words = g.label.split(' ')
    const split = words.length > 1 && g.label.length > 9
    const l1 = split ? words.slice(0, Math.ceil(words.length / 2)).join(' ') : g.label
    const l2 = split ? words.slice(Math.ceil(words.length / 2)).join(' ') : ''
    s += `<text x="${cx(i).toFixed(1)}" y="${(H - bottom + 18).toFixed(1)}" text-anchor="middle" font-size="${lf}" font-weight="${g.total ? 700 : 500}" fill="${g.total ? INK : MUTE}">${l1}</text>`
    if (l2) s += `<text x="${cx(i).toFixed(1)}" y="${(H - bottom + 29).toFixed(1)}" text-anchor="middle" font-size="${lf}" font-weight="${g.total ? 700 : 500}" fill="${g.total ? INK : MUTE}">${l2}</text>`
  })
  s += `</svg>`
  return s
}

/* Horizontal diverging bars — a value per area (e.g. net cash from operations).
 * opts.zoom scales fonts + row height (for print legibility); opts.maxRows caps
 * to the top-N areas by magnitude and rolls the remainder into one "Other" bar
 * (so a many-area chart stays short and the print sheet doesn't shrink away). */
export function areaBarsSvg(rows: { label: string; value: number }[], disp: ChartDisp = DEF, opts: { zoom?: number; maxRows?: number } = {}): string {
  const zoom = opts.zoom ?? 1
  const lab = (v: number) => labf(v, disp)
  let data = rows.filter(r => Math.abs(r.value) >= 50000)
  if (data.length === 0) return `<svg viewBox="0 0 560 40" width="100%"><text x="280" y="24" text-anchor="middle" font-size="12" fill="#94a3b8" font-family="sans-serif">No data</text></svg>`
  if (opts.maxRows && data.length > opts.maxRows) {
    const keep = [...data].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, opts.maxRows)
    const rest = data.filter(d => !keep.includes(d))
    const otherVal = rest.reduce((t, r) => t + r.value, 0)
    data = [...keep, ...(Math.abs(otherVal) >= 50000 ? [{ label: `Other (${rest.length})`, value: otherVal }] : [])]
  }
  data = data.sort((a, b) => b.value - a.value)
  const fs = 10 * zoom, off = fs * 0.35
  const rowH = 22 * zoom, padT = 8, padB = 6, W = 560, labW = 104 * zoom, valW = 56 * zoom
  const H = padT + padB + data.length * rowH
  const plotL = labW, plotR = W - valW, plotW = plotR - plotL
  const max = Math.max(1, ...data.map(r => Math.abs(r.value)))
  const cxZero = plotL + plotW / 2
  const scale = (plotW / 2) / max
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`
  s += `<line x1="${cxZero}" y1="${padT}" x2="${cxZero}" y2="${H - padB}" stroke="${GRID}" stroke-width="1"/>`
  data.forEach((r, i) => {
    const y = padT + i * rowH, w = Math.abs(r.value) * scale, up = r.value >= 0
    const x = up ? cxZero : cxZero - w
    s += `<text x="${(plotL - 6).toFixed(1)}" y="${(y + rowH / 2 + off).toFixed(1)}" text-anchor="end" font-size="${fs.toFixed(1)}" fill="${INK}">${r.label.length > 16 ? r.label.slice(0, 15) + '…' : r.label}</text>`
    s += `<rect x="${x.toFixed(1)}" y="${(y + rowH * 0.18).toFixed(1)}" width="${Math.max(1.5, w).toFixed(1)}" height="${(rowH * 0.64).toFixed(1)}" fill="${up ? GOOD : CRIM}" opacity="0.88" rx="2"/>`
    s += `<text x="${(W - valW + 6).toFixed(1)}" y="${(y + rowH / 2 + off).toFixed(1)}" font-size="${fs.toFixed(1)}" font-weight="700" fill="${up ? GOOD : CRIM}">${lab(r.value)}</text>`
  })
  s += `</svg>`
  return s
}

/* Monthly trade-payables level — magnitude bars across the elapsed months with a
 * trajectory line over the tops. Payables are credit balances (negative); bars
 * show the magnitude, labels show the signed value. A falling line = paying down. */
export function payablesTrendSvg(points: { label: string; value: number }[], disp: ChartDisp = DEF): string {
  const lab = (v: number) => labf(v, disp)
  if (points.length === 0) return `<svg viewBox="0 0 560 40" width="100%"><text x="280" y="24" text-anchor="middle" font-size="12" fill="#94a3b8" font-family="sans-serif">No data</text></svg>`
  const W = 560, H = 210, padL = 8, padR = 8, top = 28, bottom = 32
  const plotW = W - padL - padR, plotH = H - top - bottom
  const max = Math.max(1, ...points.map(p => Math.abs(p.value)))
  const n = points.length, slot = plotW / n, bw = Math.min(50, slot * 0.5)
  const cx = (i: number) => padL + (i + 0.5) * slot
  const base = top + plotH
  const yTop = (mag: number) => base - (mag / max) * plotH
  const FILL = 'rgba(225,0,32,0.5)'
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`
  s += `<line x1="${padL}" y1="${base.toFixed(1)}" x2="${W - padR}" y2="${base.toFixed(1)}" stroke="${INK}" stroke-width="1"/>`
  points.forEach((p, i) => {
    const yt = yTop(Math.abs(p.value)), h = Math.max(1.5, base - yt)
    s += `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${yt.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${FILL}" rx="2"/>`
  })
  const line = points.map((p, i) => `${cx(i).toFixed(1)},${yTop(Math.abs(p.value)).toFixed(1)}`).join(' ')
  s += `<polyline points="${line}" fill="none" stroke="${CRIM}" stroke-width="1.5" opacity="0.85"/>`
  points.forEach((p, i) => {
    const yt = yTop(Math.abs(p.value))
    s += `<circle cx="${cx(i).toFixed(1)}" cy="${yt.toFixed(1)}" r="2.4" fill="${CRIM}"/>`
    s += `<text x="${cx(i).toFixed(1)}" y="${(yt - 6).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="${CRIM}">${lab(p.value)}</text>`
    s += `<text x="${cx(i).toFixed(1)}" y="${(base + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="${MUTE}">${p.label}</text>`
  })
  s += `</svg>`
  return s
}

/* Monthly net-cash bars — the project's cash movement per elapsed month. */
export function netTrendSvg(labels: string[], values: number[], disp: ChartDisp = DEF): string {
  const lab = (v: number) => labf(v, disp)
  const W = 560, H = 210, padL = 8, padR = 8, top = 26, bottom = 34
  const plotW = W - padL - padR, plotH = H - top - bottom
  const vals = values.map(mm)
  let ymin = Math.min(0, ...vals), ymax = Math.max(0, ...vals)
  const pad = (ymax - ymin) * 0.16 || 1; ymin -= pad; ymax += pad
  const yM = (v: number) => top + (ymax - v) / (ymax - ymin || 1) * plotH
  const n = values.length || 1, slot = plotW / n, bw = Math.min(54, slot * 0.5)
  const cx = (i: number) => padL + (i + 0.5) * slot
  const zero = yM(0)
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`
  s += `<line x1="${padL}" y1="${zero.toFixed(1)}" x2="${W - padR}" y2="${zero.toFixed(1)}" stroke="${INK}" stroke-width="1"/>`
  values.forEach((v, i) => {
    const y0 = yM(0), y1 = yM(mm(v)), up = v >= 0
    const t = Math.min(y0, y1), h = Math.max(1.5, Math.abs(y0 - y1))
    s += `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${t.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${up ? GOOD : CRIM}" opacity="0.85" rx="2"/>`
    s += `<text x="${cx(i).toFixed(1)}" y="${(up ? t - 5 : t + h + 12).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="${up ? GOOD : CRIM}">${lab(v)}</text>`
    s += `<text x="${cx(i).toFixed(1)}" y="${(H - bottom + 18).toFixed(1)}" text-anchor="middle" font-size="10" fill="${MUTE}">${labels[i] ?? ''}</text>`
  })
  s += `</svg>`
  return s
}
