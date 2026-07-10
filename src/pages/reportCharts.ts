/* Pure-SVG chart builders for the Cash Flow Report, shared by the screen
 * (CashReport.tsx via dangerouslySetInnerHTML) and print (reportPrint.ts).
 * Values come in RAW (full native or USD). Bar geometry is relative so the
 * divisor doesn't matter for it; the value LABELS follow the display
 * denomination (millions / '000 / units) passed in via `disp`. */

const INK = '#15233b', MUTE = '#64748b', CRIM = '#E10020', GOOD = '#057a55', GRID = '#e2e8f0', BRONZE = '#9a7b3c'
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
 * (so a many-area chart stays short and the print sheet doesn't shrink away).
 * When a row carries a `forecast` value the bar is drawn in two segments: a
 * solid ACTUAL segment then a faded FORECAST segment stacked on its end, so the
 * total bar = actual + forecast and the faded part reads as the forecast. */
export function areaBarsSvg(rows: { label: string; value: number; forecast?: number }[], disp: ChartDisp = DEF, opts: { zoom?: number; maxRows?: number; dualLabel?: boolean; width?: number; rowHpx?: number; fontPx?: number; labW?: number; valW?: number; barFrac?: number } = {}): string {
  const zoom = opts.zoom ?? 1
  const lab = (v: number) => labf(v, disp)
  const tot = (r: { value: number; forecast?: number }) => r.value + (r.forecast ?? 0)
  let data = rows.filter(r => Math.abs(r.value) >= 50000 || Math.abs(r.forecast ?? 0) >= 50000)
  if (data.length === 0) return `<svg viewBox="0 0 560 40" width="100%"><text x="280" y="24" text-anchor="middle" font-size="12" fill="#94a3b8" font-family="sans-serif">No data</text></svg>`
  if (opts.maxRows && data.length > opts.maxRows) {
    const keep = [...data].sort((a, b) => Math.abs(tot(b)) - Math.abs(tot(a))).slice(0, opts.maxRows)
    const rest = data.filter(d => !keep.includes(d))
    const otherVal = rest.reduce((t, r) => t + r.value, 0)
    const otherFc = rest.reduce((t, r) => t + (r.forecast ?? 0), 0)
    data = [...keep, ...(Math.abs(otherVal) + Math.abs(otherFc) >= 50000 ? [{ label: `Other (${rest.length})`, value: otherVal, forecast: otherFc }] : [])]
  }
  const hasFc = data.some(r => r.forecast != null)
  const dual = !!opts.dualLabel && hasFc   // show BOTH the actual + forecast figure, side by side
  data = data.sort((a, b) => b.value - a.value)
  const fs = opts.fontPx ?? 10 * zoom, off = fs * 0.35
  const rowH = opts.rowHpx ?? 22 * zoom, padT = 8, padB = 6, legendH = hasFc ? 20 * zoom : 0, W = opts.width ?? 560
  const labW = opts.labW ?? 104 * zoom, valW = opts.valW ?? (dual ? 104 : 62) * zoom, barFrac = opts.barFrac ?? 0.64
  const H = padT + padB + data.length * rowH + legendH
  const plotL = labW, plotR = W - valW, plotW = plotR - plotL
  // Extent = the furthest point from zero, considering the actual end AND the
  // stacked total (they differ when actual and forecast share a sign).
  const max = Math.max(1, ...data.map(r => Math.max(Math.abs(r.value), Math.abs(tot(r)))))
  const cxZero = plotL + plotW / 2
  const scale = (plotW / 2) / max
  const px = (v: number) => cxZero + v * scale     // signed value → x (positive → right)
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`
  s += `<line x1="${cxZero}" y1="${padT}" x2="${cxZero}" y2="${(H - padB - legendH).toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`
  data.forEach((r, i) => {
    const y = padT + i * rowH, ry = y + rowH * (1 - barFrac) / 2, rh = rowH * barFrac
    const a = r.value, fc = r.forecast ?? 0, total = a + fc
    const colA = a >= 0 ? GOOD : CRIM, colF = fc >= 0 ? GOOD : CRIM
    s += `<text x="${(plotL - 6).toFixed(1)}" y="${(y + rowH / 2 + off).toFixed(1)}" text-anchor="end" font-size="${fs.toFixed(1)}" fill="${INK}">${r.label.length > 16 ? r.label.slice(0, 15) + '…' : r.label}</text>`
    // Actual (solid) segment: 0 → a
    const xa = Math.min(cxZero, px(a)), wa = Math.abs(a) * scale
    if (wa >= 0.5) s += `<rect x="${xa.toFixed(1)}" y="${ry.toFixed(1)}" width="${Math.max(1.5, wa).toFixed(1)}" height="${rh.toFixed(1)}" fill="${colA}" opacity="0.9" rx="2"/>`
    // Forecast (faded) segment: a → a+fc
    if (Math.abs(fc) >= 1) {
      const xf = Math.min(px(a), px(total)), wf = Math.abs(fc) * scale
      s += `<rect x="${xf.toFixed(1)}" y="${ry.toFixed(1)}" width="${Math.max(1.5, wf).toFixed(1)}" height="${rh.toFixed(1)}" fill="${colF}" opacity="0.3" rx="2"/>`
    }
    // Value label(s). dual = the actual (its colour) and the forecast (bronze)
    // side by side, both right-anchored so they pack to the right edge; otherwise
    // a single figure — the actual when a forecast segment is drawn (the table
    // carries the pair), else just the value.
    const yb = y + rowH / 2 + off
    if (dual) {
      const aStr = lab(a), fStr = lab(fc), aCol = a >= 0 ? GOOD : CRIM
      const fw = fStr.length * fs * 0.6
      s += `<text x="${(W - valW + 4 + (valW - 8 - fw - fs * 0.6)).toFixed(1)}" y="${yb.toFixed(1)}" text-anchor="end" font-size="${fs.toFixed(1)}" font-weight="700" fill="${aCol}">${aStr}</text>`
      s += `<text x="${(W - 4).toFixed(1)}" y="${yb.toFixed(1)}" text-anchor="end" font-size="${(fs * 0.9).toFixed(1)}" font-weight="700" fill="${BRONZE}">${fStr}</text>`
    } else {
      const lblV = hasFc ? a : r.value, lblCol = lblV >= 0 ? GOOD : CRIM
      s += `<text x="${(W - valW + 6).toFixed(1)}" y="${yb.toFixed(1)}" font-size="${fs.toFixed(1)}" font-weight="700" fill="${lblCol}">${lab(lblV)}</text>`
    }
  })
  if (hasFc) {
    const ly = H - padB - legendH / 2 + off, sw = 9 * zoom, gap = 5 * zoom
    let lx = plotL
    const swatch = (fill: string, opacity: number, text: string) => {
      const seg = `<rect x="${lx.toFixed(1)}" y="${(ly - sw + off).toFixed(1)}" width="${sw.toFixed(1)}" height="${sw.toFixed(1)}" fill="${fill}" opacity="${opacity}" rx="1.5"/><text x="${(lx + sw + gap).toFixed(1)}" y="${ly.toFixed(1)}" font-size="${(fs * 0.92).toFixed(1)}" fill="${MUTE}">${text}</text>`
      lx += sw + gap + text.length * fs * 0.52 + 14 * zoom
      return seg
    }
    s += swatch(GOOD, 0.9, 'Actual')
    s += swatch(GOOD, 0.3, 'Forecast')
  }
  s += `</svg>`
  return s
}

/* Left-aligned "top movers" bars — one project per row, bar length ∝ |value| from
 * a common left baseline (green = cash generated, crimson = consumed), sorted by
 * value so the biggest generators are on top and the biggest consumers at the
 * bottom. Unlike the diverging areaBars, this uses the FULL width for the bars
 * (no wasted centre gutter when positives and negatives are lopsided) and keeps
 * the value labels in a clean right column. Sized to fill a tall chart column via
 * rowHpx. Forecast (when present) trails as a faded extension. */
export function moverBarsSvg(rows: { label: string; value: number; forecast?: number }[], disp: ChartDisp = DEF, opts: { maxRows?: number; width?: number; rowHpx?: number; fontPx?: number; labW?: number; valW?: number; barFrac?: number } = {}): string {
  const lab = (v: number) => labf(v, disp)
  const tot = (r: { value: number; forecast?: number }) => r.value + (r.forecast ?? 0)
  let data = rows.filter(r => Math.abs(r.value) >= 50000 || Math.abs(r.forecast ?? 0) >= 50000)
  if (data.length === 0) return `<svg viewBox="0 0 340 40" width="100%"><text x="170" y="24" text-anchor="middle" font-size="12" fill="#94a3b8" font-family="sans-serif">No data</text></svg>`
  if (opts.maxRows && data.length > opts.maxRows) {
    const keep = [...data].sort((a, b) => Math.abs(tot(b)) - Math.abs(tot(a))).slice(0, opts.maxRows)
    const rest = data.filter(d => !keep.includes(d))
    const ov = rest.reduce((t, r) => t + r.value, 0), of = rest.reduce((t, r) => t + (r.forecast ?? 0), 0)
    data = [...keep, ...(Math.abs(ov) + Math.abs(of) >= 50000 ? [{ label: `Other (${rest.length})`, value: ov, forecast: of }] : [])]
  }
  data = data.sort((a, b) => b.value - a.value)
  const W = opts.width ?? 340, rowH = opts.rowHpx ?? 26, fs = opts.fontPx ?? 12, off = fs * 0.35
  const labW = opts.labW ?? 88, valW = opts.valW ?? 54, barFrac = opts.barFrac ?? 0.66
  const padT = 8, padB = 6
  const H = padT + padB + data.length * rowH
  const baseX = labW, plotR = W - valW, plotW = plotR - baseX
  // Diverging: generators (positive) grow RIGHT, consumers (negative) grow LEFT
  // from a zero line. The zero line is positioned by the ratio of the largest
  // consumer to the largest generator, so both sides share one scale and neither
  // half is wasted when the magnitudes are lopsided (e.g. one big generator).
  const maxPos = Math.max(0, ...data.map(r => Math.max(r.value, tot(r))))
  const maxNeg = Math.max(0, ...data.map(r => Math.max(-r.value, -tot(r))))
  const span = maxPos + maxNeg || 1
  const scale = plotW / span
  const zeroX = baseX + maxNeg * scale
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`
  s += `<line x1="${zeroX.toFixed(1)}" y1="${padT}" x2="${zeroX.toFixed(1)}" y2="${(H - padB).toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`
  data.forEach((r, i) => {
    const y = padT + i * rowH, ry = y + rowH * (1 - barFrac) / 2, rh = rowH * barFrac, yb = y + rowH / 2 + off
    const a = r.value, fc = r.forecast ?? 0
    s += `<text x="${(baseX - 8).toFixed(1)}" y="${yb.toFixed(1)}" text-anchor="end" font-size="${fs.toFixed(1)}" fill="${INK}">${r.label.length > 13 ? r.label.slice(0, 12) + '…' : r.label}</text>`
    // Actual bar: from the zero line, right if positive, left if negative.
    const wa = Math.abs(a) * scale, xa = a >= 0 ? zeroX : zeroX - wa
    s += `<rect x="${xa.toFixed(1)}" y="${ry.toFixed(1)}" width="${Math.max(1.5, wa).toFixed(1)}" height="${rh.toFixed(1)}" fill="${a >= 0 ? GOOD : CRIM}" opacity="0.9" rx="2"/>`
    // Forecast (faded) trails from the actual bar's outer end, in fc's direction.
    if (Math.abs(fc) >= 1) {
      const wf = Math.abs(fc) * scale, outer = a >= 0 ? zeroX + wa : zeroX - wa
      const xf = fc >= 0 ? outer : outer - wf
      s += `<rect x="${xf.toFixed(1)}" y="${ry.toFixed(1)}" width="${Math.max(1.5, wf).toFixed(1)}" height="${rh.toFixed(1)}" fill="${fc >= 0 ? GOOD : CRIM}" opacity="0.3" rx="2"/>`
    }
    s += `<text x="${(W - 4).toFixed(1)}" y="${yb.toFixed(1)}" text-anchor="end" font-size="${fs.toFixed(1)}" font-weight="700" fill="${a >= 0 ? GOOD : CRIM}">${lab(a)}</text>`
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

/* Monthly net-cash bars — the project's cash movement per month. When
 * `actualCount` is given, bars at/after that index are the FORECAST tail: drawn
 * faded (like the area bars), with a divider marking the actual→forecast seam. */
export function netTrendSvg(labels: string[], values: number[], disp: ChartDisp = DEF, actualCount?: number): string {
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
  const ac = actualCount ?? values.length
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`
  s += `<line x1="${padL}" y1="${zero.toFixed(1)}" x2="${W - padR}" y2="${zero.toFixed(1)}" stroke="${INK}" stroke-width="1"/>`
  if (ac < values.length && ac > 0) {   // actual→forecast seam
    const dx = padL + ac * slot
    s += `<line x1="${dx.toFixed(1)}" y1="${top}" x2="${dx.toFixed(1)}" y2="${(H - bottom).toFixed(1)}" stroke="${GRID}" stroke-width="1" stroke-dasharray="3,2"/>`
  }
  values.forEach((v, i) => {
    const y0 = yM(0), y1 = yM(mm(v)), up = v >= 0, fc = i >= ac
    const t = Math.min(y0, y1), h = Math.max(1.5, Math.abs(y0 - y1))
    s += `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${t.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${up ? GOOD : CRIM}" opacity="${fc ? 0.3 : 0.85}" rx="2"/>`
    s += `<text x="${cx(i).toFixed(1)}" y="${(up ? t - 5 : t + h + 12).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="${up ? GOOD : CRIM}" opacity="${fc ? 0.55 : 1}">${lab(v)}</text>`
    s += `<text x="${cx(i).toFixed(1)}" y="${(H - bottom + 18).toFixed(1)}" text-anchor="middle" font-size="10" fill="${MUTE}" opacity="${fc ? 0.7 : 1}">${labels[i] ?? ''}</text>`
  })
  s += `</svg>`
  return s
}
