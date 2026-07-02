/* "The year in one shape" — the Chairman cash-flow story chart. Three things in
 * one picture, from the year's opening to December: the CASH balance you hold
 * (blue), the NET liquid funds after loans & overdrafts (bold ink, crossing zero
 * from deficit to surplus), and the financing between them shown as a shaded
 * band whose HEIGHT is loans & overdrafts — narrowing as debt is paid down.
 * 13 points (opening + each month-end), actual solid / forecast dashed, with a
 * start · today · year-end position timeline of cash & loans aligned beneath the
 * plot. Pure SVG, shared by screen (Narrative.tsx) and print (narrativePrint.ts).
 * Values come in raw (full numbers); plotted + labelled in millions. */

const INK = '#15233b', SLATE = '#64748b', GOOD = '#057a55', BAD = '#E10020', GRID = '#e9ecf1', TINT = '#f6f7f9'
const CASH = '#3f6aa3', BAND = 'rgba(225,0,32,0.085)'

const mm = (v: number) => v / 1e6
const sgn = (v: number): string => {            // signed millions: +x / (x)
  const r = Math.round(mm(v) * 10) / 10
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return r < 0 ? `(${s})` : `+${s}`
}
const mag = (v: number): string => {            // magnitude millions, brackets if negative
  const r = Math.round(mm(v) * 10) / 10
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return r < 0 ? `(${s})` : s
}

export function buildCashStoryChart(opts: {
  months: string[];          // 13 labels; index 0 = opening, 1..12 = Jan..Dec
  cash: number[]; net: number[];   // 13 raw each (debt = cash − net = the band)
  asIdx: number;             // index of the current period (April = 4)
  asOfLabel: string; year: number;
  payablesToday?: number | null;   // current (as-of) trade payables balance, if known
}): string {
  const { cash, net, months, asOfLabel, year, payablesToday } = opts
  const n = cash.length, asIdx = opts.asIdx
  const C = cash.map(mm), N = net.map(mm)

  let ymax = Math.max(0, ...C), ymin = Math.min(0, ...N)
  const pad = (ymax - ymin) * 0.10 || 1
  ymax += pad; ymin -= pad * 0.45
  const range = (ymax - ymin) || 1

  const W = 1360, H = 392
  const plotL = 96, plotR = 1316, plotW = plotR - plotL
  const top = 22, plotH = 250, axisY = top + plotH + 19
  const x = (i: number) => plotL + (i / (n - 1)) * plotW
  const y = (v: number) => top + ((ymax - v) / range) * plotH
  const divX = x(asIdx)   // actual/forecast divider sits ON the current period

  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`

  // actual tint up to the current period
  s += `<rect x="${plotL}" y="${top}" width="${(divX - plotL).toFixed(1)}" height="${plotH}" fill="${TINT}"/>`

  // y gridlines + labels across the negative + positive domain (round step)
  const rawStep = range / 6
  const m10 = Math.pow(10, Math.floor(Math.log10(Math.max(1, rawStep))))
  const step = Math.max(m10, Math.ceil(rawStep / m10) * m10)
  const gStart = Math.ceil(ymin / step) * step
  for (let g = gStart; g <= ymax + 0.001; g += step) {
    const yy = y(g)
    const gl = g < 0 ? `(${Math.abs(g).toLocaleString('en-US')})` : g.toLocaleString('en-US')
    s += `<line x1="${plotL}" y1="${yy.toFixed(1)}" x2="${plotR}" y2="${yy.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`
    s += `<text x="${plotL - 10}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="12" font-weight="500" fill="#475569">${gl}</text>`
  }
  s += `<line x1="${plotL}" y1="${top}" x2="${plotL}" y2="${(top + plotH).toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`
  const zY = y(0).toFixed(1)
  s += `<line x1="${plotL}" y1="${zY}" x2="${plotR}" y2="${zY}" stroke="${INK}" stroke-width="1.2"/>`

  // financing band between cash (top) and net (bottom) — its height = loans & overdrafts
  let band = `M ${x(0).toFixed(1)} ${y(C[0]).toFixed(1)}`
  for (let i = 1; i < n; i++) band += ` L ${x(i).toFixed(1)} ${y(C[i]).toFixed(1)}`
  for (let i = n - 1; i >= 0; i--) band += ` L ${x(i).toFixed(1)} ${y(N[i]).toFixed(1)}`
  band += ` Z`
  s += `<path d="${band}" fill="${BAND}"/>`

  const seg = (arr: number[], a: number, b: number) => {
    let p = ''; for (let i = a; i <= b; i++) p += `${i === a ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(arr[i]).toFixed(1)} `; return p.trim()
  }
  // cash line (blue) — solid actual / dashed forecast
  s += `<path d="${seg(C, 0, asIdx)}" fill="none" stroke="${CASH}" stroke-width="2.4" stroke-linecap="round"/>`
  s += `<path d="${seg(C, asIdx, n - 1)}" fill="none" stroke="${CASH}" stroke-width="2.4" stroke-dasharray="5,4" stroke-linecap="round"/>`
  // net line (bold ink) — solid actual / dashed forecast
  s += `<path d="${seg(N, 0, asIdx)}" fill="none" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/>`
  s += `<path d="${seg(N, asIdx, n - 1)}" fill="none" stroke="${INK}" stroke-width="3.4" stroke-dasharray="5,4" stroke-linecap="round"/>`
  for (let i = 0; i < n; i++) s += `<circle cx="${x(i).toFixed(1)}" cy="${y(N[i]).toFixed(1)}" r="2.3" fill="${N[i] >= 0 ? GOOD : INK}"/>`
  // cash year-end label
  s += `<text x="${(x(n - 1) - 4).toFixed(1)}" y="${(y(C[n - 1]) - 9).toFixed(1)}" text-anchor="end" font-size="11.5" font-weight="700" fill="${CASH}">${mag(cash[n - 1])} cash</text>`

  // divider on the current period + region labels
  s += `<line x1="${divX.toFixed(1)}" y1="${top}" x2="${divX.toFixed(1)}" y2="${(top + plotH).toFixed(1)}" stroke="${SLATE}" stroke-width="1.2" stroke-dasharray="4,3" opacity="0.75"/>`
  s += `<text x="${((plotL + divX) / 2).toFixed(1)}" y="${top + 13}" text-anchor="middle" font-size="10" font-weight="700" letter-spacing="1" fill="${SLATE}">ACTUAL</text>`
  s += `<text x="${((divX + plotR) / 2).toFixed(1)}" y="${top + 13}" text-anchor="middle" font-size="10" font-weight="700" letter-spacing="1" fill="${SLATE}">FORECAST</text>`

  // band label (financing) inside the band, early-year
  const bi = Math.max(1, Math.round(asIdx / 2))
  s += `<text x="${x(bi).toFixed(1)}" y="${((y(C[bi]) + y(N[bi])) / 2 + 3).toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="600" fill="${BAD}" opacity="0.8">Loans &amp; overdrafts</text>`

  // year-end pill on the net line (green surplus / crimson deficit)
  { const t = sgn(net[n - 1]), w = 8 + t.length * 7.6, cx = x(n - 1) - 6, cy = y(N[n - 1]) - 15
    s += `<g><rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - 11).toFixed(1)}" width="${w.toFixed(1)}" height="22" rx="11" fill="${N[n - 1] >= 0 ? GOOD : BAD}"/><text x="${cx.toFixed(1)}" y="${(cy + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${t}</text></g>` }
  // today marker + chip on the net line
  { const nx = x(asIdx), ny = y(N[asIdx]); s += `<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="5" fill="#fff" stroke="${INK}" stroke-width="2"/>`
    const t = `${sgn(net[asIdx])} · NET TODAY`, w = 12 + t.length * 6.4
    s += `<g><rect x="${(nx - w / 2).toFixed(1)}" y="${(ny + 16).toFixed(1)}" width="${w.toFixed(1)}" height="22" rx="5" fill="${INK}"/><text x="${nx.toFixed(1)}" y="${(ny + 31).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">${t}</text></g>` }
  // start dot on the net line (opening)
  s += `<circle cx="${x(0).toFixed(1)}" cy="${y(N[0]).toFixed(1)}" r="4" fill="#fff" stroke="${SLATE}" stroke-width="1.6"/>`

  // month axis (index 0 = opening 'Open'; 1..12 = Jan..Dec)
  s += `<text x="${x(0).toFixed(1)}" y="${axisY}" text-anchor="middle" font-size="10.5" font-weight="600" fill="${SLATE}">Open</text>`
  for (let i = 1; i < n; i++) {
    const isDec = i === n - 1
    s += `<text x="${x(i).toFixed(1)}" y="${axisY}" text-anchor="middle" font-size="11.5" font-weight="${isDec ? 700 : 400}" fill="${isDec ? INK : SLATE}">${months[i]}</text>`
  }

  // ── position timeline: cash & loans at Start / Today / Year-end, aligned to the plot ──
  const cpY = axisY + 24
  s += `<line x1="${plotL}" y1="${(cpY - 13).toFixed(1)}" x2="${plotR}" y2="${(cpY - 13).toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`
  const cps: { i: number; anchor: 'start' | 'middle' | 'end'; head: string }[] = [
    { i: 0, anchor: 'start', head: `START · JAN ${year}` },
    { i: asIdx, anchor: 'middle', head: `TODAY · ${asOfLabel.toUpperCase()}` },
    { i: n - 1, anchor: 'end', head: `YEAR-END · DEC ${year}` },
  ]
  for (const cp of cps) {
    const cx = x(cp.i), debtV = cash[cp.i] - net[cp.i]
    s += `<text x="${cx.toFixed(1)}" y="${cpY.toFixed(1)}" text-anchor="${cp.anchor}" font-size="9.5" font-weight="700" letter-spacing=".4" fill="${SLATE}">${cp.head}</text>`
    s += `<text x="${cx.toFixed(1)}" y="${(cpY + 20).toFixed(1)}" text-anchor="${cp.anchor}" font-size="13.5" font-weight="700" fill="${CASH}">${mag(cash[cp.i])}<tspan font-size="9.5" font-weight="500" fill="${SLATE}"> cash</tspan></text>`
    s += `<text x="${cx.toFixed(1)}" y="${(cpY + 38).toFixed(1)}" text-anchor="${cp.anchor}" font-size="13.5" font-weight="700" fill="${BAD}">(${mag(debtV)})<tspan font-size="9.5" font-weight="500" fill="${SLATE}"> loans &amp; OD</tspan></text>`
    // Payables are no longer a single dot on this timeline — they get their own
    // monthly track (buildPayablesTrack) below the position summary.
  }

  s += `</svg>`
  return s
}

/* ── Payables trajectory — its OWN track (never blended into net liquid funds) ─
 * Trade payables owed to suppliers & subcontractors, month by month, from the
 * canonical Midas trial balance (USD). Drawn as a downward magnitude area (0 at
 * top → owed grows down), horizontally aligned to the main chart's 13 slots so
 * the months line up. Below it, a small book-coverage strip: each period's bar
 * height = payables books posted that period. The point of the strip is honesty
 * — as recent months lose books, the payables total understates, so a falling
 * line that tracks a falling book count is a coverage artifact, not real paydown.
 * Provisional periods (fewer books than the fullest month) render hollow/dashed.
 * TB is actuals only → no forecast tail. Values raw (full numbers); labelled m. */
export function buildPayablesTrack(opts: {
  months: string[]                 // 13 labels: index 0 = 'Open', 1..12 = Jan..Dec
  payables: (number | null)[]      // 13 raw USD (signed, negative); null = no TB period
  nBooks: (number | null)[]        // 13; payables books posted that period
  maxBooks: number                 // fullest month's book count (posting-completeness ref)
}): string {
  const { months, payables, nBooks, maxBooks } = opts
  const n = payables.length
  const present = payables.map((v, i) => (v == null ? -1 : i)).filter(i => i >= 0)
  const W = 1360, H = 214
  const plotL = 96, plotR = 1316, plotW = plotR - plotL
  const x = (i: number) => plotL + (i / (n - 1)) * plotW

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`

  if (present.length === 0) {
    svg += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="14" fill="#94a3b8">Payables trail unavailable for this area</text></svg>`
    return svg
  }

  const isFull = (i: number) => (nBooks[i] ?? 0) >= maxBooks
  const maxMag = Math.max(1, ...present.map(i => Math.abs(payables[i] as number)))
  const top = 40, plotH = 96, base = top, bottom = top + plotH
  const y = (v: number) => top + (Math.abs(v) / maxMag) * plotH

  // header
  svg += `<text x="${plotL}" y="20" font-size="12.5" font-weight="700" fill="${INK}">Payables owed <tspan font-size="10.5" font-weight="500" fill="${SLATE}">· suppliers &amp; subcontractors, month by month</tspan></text>`
  svg += `<text x="${plotR}" y="20" text-anchor="end" font-size="10" fill="${SLATE}">USD · Midas trial balance · trade_payables group</text>`

  // 0 baseline
  svg += `<line x1="${plotL}" y1="${base}" x2="${plotR}" y2="${base}" stroke="${INK}" stroke-width="1.1"/>`
  svg += `<text x="${plotL - 8}" y="${base + 4}" text-anchor="end" font-size="10" fill="${SLATE}">0</text>`

  // downward magnitude area under the payables line (present points only)
  let area = `M ${x(present[0]).toFixed(1)} ${base}`
  for (const i of present) area += ` L ${x(i).toFixed(1)} ${y(payables[i] as number).toFixed(1)}`
  area += ` L ${x(present[present.length - 1]).toFixed(1)} ${base} Z`
  svg += `<path d="${area}" fill="${BAND}"/>`

  // payables line (solid — it is actual TB data); the coverage strip + hollow
  // dots below carry the "how complete is this month" signal, not dashing.
  let line = ''
  for (let k = 0; k < present.length; k++) {
    const i = present[k]
    line += `${k === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(payables[i] as number).toFixed(1)} `
  }
  svg += `<path d="${line.trim()}" fill="none" stroke="${BAD}" stroke-width="2.6" stroke-linecap="round"/>`
  // dots: solid where the full book set is posted, hollow where still posting
  for (const i of present) {
    svg += isFull(i)
      ? `<circle cx="${x(i).toFixed(1)}" cy="${y(payables[i] as number).toFixed(1)}" r="3" fill="${BAD}"/>`
      : `<circle cx="${x(i).toFixed(1)}" cy="${y(payables[i] as number).toFixed(1)}" r="3.4" fill="#fff" stroke="${BAD}" stroke-width="1.8"/>`
  }

  // value labels at first + latest present point (magnitude, in millions)
  const first = present[0], last = present[present.length - 1]
  for (const i of [first, last]) {
    const yy = y(payables[i] as number)
    svg += `<text x="${x(i).toFixed(1)}" y="${(yy + 17).toFixed(1)}" text-anchor="${i === first ? 'start' : 'end'}" font-size="12.5" font-weight="700" fill="${BAD}">(${mag(payables[i] as number)})<tspan font-size="9" font-weight="500" fill="${SLATE}"> m</tspan></text>`
  }
  // provisional flag on the latest point when the book set has thinned
  if (!isFull(last)) {
    svg += `<text x="${x(last).toFixed(1)}" y="${(y(payables[last] as number) - 9).toFixed(1)}" text-anchor="end" font-size="9.5" font-style="italic" fill="#b45309">provisional · ${nBooks[last]} of ${maxBooks} books</text>`
  }

  // ── book-coverage strip: bar height ∝ books posted that period ──
  const covTop = bottom + 26, covH = 30, covBottom = covTop + covH
  svg += `<text x="${plotL}" y="${(covTop - 8).toFixed(1)}" font-size="9.5" font-weight="700" letter-spacing=".3" fill="${SLATE}">BOOKS POSTED PER MONTH</text>`
  svg += `<line x1="${plotL}" y1="${covBottom}" x2="${plotR}" y2="${covBottom}" stroke="${GRID}" stroke-width="1"/>`
  const bw = Math.min(26, (plotW / (n - 1)) * 0.5)
  for (const i of present) {
    const h = (Math.max(0, (nBooks[i] ?? 0)) / Math.max(1, maxBooks)) * covH
    const full = isFull(i)
    svg += `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(covBottom - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${full ? SLATE : '#cbd5e1'}" rx="1"/>`
    svg += `<text x="${x(i).toFixed(1)}" y="${(covBottom - h - 4).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="600" fill="${full ? INK : '#94a3b8'}">${nBooks[i]}</text>`
  }

  // month axis aligned to the main chart (Open, Jan.., only present slots)
  const axisY = covBottom + 16
  for (const i of present) {
    const lbl = i === 0 ? 'Open' : months[i]
    svg += `<text x="${x(i).toFixed(1)}" y="${axisY}" text-anchor="middle" font-size="11" font-weight="${i === last ? 700 : 400}" fill="${i === last ? INK : SLATE}">${lbl}</text>`
  }

  svg += `</svg>`
  return svg
}
