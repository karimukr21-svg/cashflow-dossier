import { arrangeByColumns, STMT_COLUMNS, type StmtSection, type DualSection, type MatrixSection } from './reportModel'
import { waterfallSvg, areaBarsSvg, moverBarsSvg, netTrendSvg, payablesTrendSvg } from './reportCharts'

/* Print mirror of the Cash Flow Report (CashReport.tsx), A4 LANDSCAPE, one sheet
 * per report. Each sheet is scaled to fit a single page (fit-to-page script), so
 * a long statement never spills to a second sheet. Group → KPI band + grouped
 * statement + cash-movement waterfall + trade-payables position. Area → KPI band
 * + per-area matrix + net-cash-by-area bars. Project → KPI band + monthly net-
 * trend + line-items×months matrix. Opens in a new window and auto-prints.
 *
 * Figures follow the selected currency + denomination (the `disp` carried in
 * from the screen): value = raw / div, shown to `dec` places; `lineUnit` labels
 * the cash-flow lines (e.g. "SAR '000"), `payUnit` labels the USD-only payables. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export type PrintDisp = { div: number; dec: number; lineUnit: string; payUnit: string }
const DEF: PrintDisp = { div: 1e6, dec: 1, lineUnit: 'USD millions', payUnit: 'USD millions' }

type Fmt = { fM: (v: number | null | undefined) => string; fD: (v: number | null | undefined) => string }
function fmtFor(d: PrintDisp): Fmt {
  const fM = (v: number | null | undefined): string => {
    if (v == null || isNaN(v)) return '—'
    const f = Math.pow(10, d.dec)
    const r = Math.round((v / d.div) * f) / f
    if (r === 0) return '—'
    const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: d.dec, maximumFractionDigits: d.dec })
    return r < 0 ? `(${s})` : s
  }
  const fD = (v: number | null | undefined): string => {
    if (v == null || isNaN(v)) return '—'
    const f = Math.pow(10, d.dec)
    const r = Math.round((v / d.div) * f) / f
    if (r === 0) return '—'
    const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: d.dec, maximumFractionDigits: d.dec })
    return r < 0 ? `(${s})` : `+${s}`
  }
  return { fM, fD }
}
const cl = (v: number | null | undefined): string => (v == null || Math.abs(v) < 50000) ? '' : (v < 0 ? 'neg' : 'pos')
const esc = (s: string): string => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))

function kpis(cards: { label: string; value: string; cls?: string; sub?: string }[], compact = false): string {
  return `<div class="kpis${compact ? ' kpis--compact' : ''}">${cards.map(c =>
    `<div class="kpi"><div class="kpi-l">${c.label}</div><div class="kpi-v ${c.cls || ''}">${c.value}</div>${c.sub ? `<div class="kpi-s">${c.sub}</div>` : ''}</div>`).join('')}</div>`
}
const LOGO = (typeof window !== 'undefined' ? window.location.origin : '') + '/ccc-logo.png'

/* Invisible bookmark anchor — BMK<<base64({d,t})>>BMK, matching the gacc-workbench
 * BookmarkAnchor + the work-dashboard /pdf-bookmarker regex. Rendered in ~1pt
 * transparent text INSIDE the h1 (shares its line box → no layout strut). `<<`/`>>`
 * as entities so the HTML parser doesn't choke; they render as the literal glyphs
 * the extractor reads. base64 via the browser form (also valid in the node render
 * harness). Depth 0 = top-level; depth 1 = nested under the preceding top-level. */
export type Bmk = { title: string; depth: number }
// A sheet may carry more than one anchor (e.g. a depth-0 section header + the
// depth-1 item on the same page), so the outline can nest.
function bmkAnchor(bmk?: Bmk | Bmk[] | null): string {
  if (!bmk) return ''
  const arr = Array.isArray(bmk) ? bmk : [bmk]
  return arr.map(b => {
    if (!b || !b.title) return ''
    const json = JSON.stringify({ d: b.depth || 0, t: String(b.title) })
    const b64 = btoa(unescape(encodeURIComponent(json)))
    return `<span class="bmk" aria-hidden="true">BMK&lt;&lt;${b64}&gt;&gt;BMK</span>`
  }).join('')
}
function head(title: string, sub: string, bmk?: Bmk | Bmk[] | null): string {
  return `<div class="head"><img class="logo" src="${LOGO}" alt="CCC"/>
    <div class="ht"><h1>${title}${bmkAnchor(bmk)}</h1><div class="sub">${sub}</div></div>
    <div class="brand">Treasury</div></div>`
}


function matrixRows(sec: MatrixSection, months: number[], f: Fmt, asOfMonth = 99): string {
  const sum = (rows: { monthly: number[] }[], i: number) => rows.reduce((t, r) => t + r.monthly[i], 0)
  const fcCls = (i: number) => `${months[i] > asOfMonth ? 'fc' : ''} ${months[i] === asOfMonth + 1 ? 'fcseam' : ''}`
  const row = (label: string, monthly: number[], total: number, klass: string) =>
    `<tr class="${klass}"><td class="${klass === '' ? 'item' : ''}">${label}</td>${monthly.map((v, i) => `<td class="r ${fcCls(i)} ${cl(v)}">${f.fM(v)}</td>`).join('')}<td class="r sepl ${cl(total)}">${f.fM(total)}</td></tr>`
  let s = `<tr class="sec"><td colspan="${months.length + 2}">${sec.label}</td></tr>`
  s += sec.receipts.map(b => row(b.label, b.monthly, b.total, '')).join('')
  if (sec.receipts.length > 1) s += row('Total receipts', months.map((_, i) => sum(sec.receipts, i)), sec.receipts.reduce((t, b) => t + b.total, 0), 'natsub')
  s += sec.payments.map(b => row(b.label, b.monthly, b.total, '')).join('')
  if (sec.payments.length > 1) s += row('Total payments', months.map((_, i) => sum(sec.payments, i)), sec.payments.reduce((t, b) => t + b.total, 0), 'natsub')
  s += row(`Net ${sec.label.toLowerCase()}`, sec.net, sec.netTot, 'subtot')
  return s
}

/* ── per-report sheet bodies (inner HTML of one .sheet) ─────────────────────── */

export type GroupForecast = {
  dual: { sections: DualSection[]; netA: number; netF: number }
  horizonLabel: string
}
export type GroupOpts = {
  scopeLabel: string; asOfLabel: string; startLabel: string; cashStartLabel?: string; matchedCount?: number
  statement: { sections: StmtSection[]; netMovement: number }
  payStart?: number; payEnd?: number; hasPay?: boolean
  startCash?: number; endCash?: number
  loanStart?: number; loanEnd?: number; odStart?: number; odEnd?: number
  paySeries?: { label: string; value: number }[]
  forecast?: GroupForecast
  disp: PrintDisp
  bmk?: Bmk | Bmk[] | null
}
// short section labels for the timeline driver chips (mirror the screen)
const SHORT_SEC: Record<string, string> = { 'Bank Financing': 'Financing', 'Within Group': 'Within group', 'Non Operational': 'Non-op', 'New Sales': 'New sales' }

function groupSheet(o: GroupOpts): string {
  const f = fmtFor(o.disp)
  const chartDisp = { div: o.disp.div, dec: o.disp.dec }
  const nm = o.statement.netMovement
  const payDelta = o.hasPay ? (o.payEnd ?? 0) - (o.payStart ?? 0) : null
  const hasCash = Math.abs(o.startCash ?? 0) > 1 || Math.abs(o.endCash ?? 0) > 1

  const fc = o.forecast
  // Cash-journey timeline — start → net movement (+ driver chips) → end. With a
  // forecast horizon, the as-of cash becomes the middle pivot and a forecast
  // segment extends to the right (mirrors the screen).
  const chipsOf = (secs: { label: string; net: number }[]) => secs.filter(s => Math.abs(s.net) >= 50000)
    .map(s => `<span class="tl-chip">${SHORT_SEC[s.label] ?? s.label} <b class="${cl(s.net)}">${f.fD(s.net)}</b></span>`).join('')
  const chips = chipsOf(o.statement.sections)
  let timeline = ''
  if (hasCash && fc) {
    // Derive the actual/forecast segments from the dual statement so the print
    // timeline reconciles with the dual cards (same bucket set / totals).
    const am = fc.dual.netA, fcNm = fc.dual.netF
    const asOfCash = (o.startCash ?? 0) + am, fcEndCash = asOfCash + fcNm
    const aChips = chipsOf(fc.dual.sections.map(s => ({ label: s.label, net: s.netA })))
    const fcChips = chipsOf(fc.dual.sections.map(s => ({ label: s.label, net: s.netF })))
    timeline = `<div class="timeline">
      <div class="tl-node"><div class="tl-cap">Starting cash · ${o.cashStartLabel ?? o.startLabel}</div><div class="tl-val ${cl(o.startCash)}">${f.fM(o.startCash)}</div></div>
      <div class="tl-flow"><div class="tl-move ${cl(am)}">${am < 0 ? '−' : '+'}${f.fM(Math.abs(am))} <i>actual movement · of which</i></div><div class="tl-chips">${aChips}</div></div>
      <div class="tl-node tl-mid"><div class="tl-cap">Cash · ${o.asOfLabel}</div><div class="tl-val ${cl(asOfCash)}">${f.fM(asOfCash)}</div></div>
      <div class="tl-flow tl-flow-fc"><div class="tl-move ${cl(fcNm)}">${fcNm < 0 ? '−' : '+'}${f.fM(Math.abs(fcNm))} <i>forecast movement · of which</i></div><div class="tl-chips">${fcChips}</div></div>
      <div class="tl-node tl-end tl-fc"><div class="tl-cap">Forecast cash · ${fc.horizonLabel}</div><div class="tl-val ${cl(fcEndCash)}">${f.fM(fcEndCash)}</div></div>
    </div>`
  } else if (hasCash) {
    timeline = `<div class="timeline">
      <div class="tl-node"><div class="tl-cap">Starting cash · ${o.cashStartLabel ?? o.startLabel}</div><div class="tl-val ${cl(o.startCash)}">${f.fM(o.startCash)}</div></div>
      <div class="tl-flow"><div class="tl-move ${cl(nm)}">${nm < 0 ? '−' : '+'}${f.fM(Math.abs(nm))} <i>net cash movement · of which</i></div><div class="tl-chips">${chips}</div></div>
      <div class="tl-node tl-end"><div class="tl-cap">Ending cash · ${o.asOfLabel}</div><div class="tl-val ${cl(o.endCash)}">${f.fM(o.endCash)}</div></div>
    </div>`
  }

  // Statement — one card per section (name + net header, line items), Operations
  // (+ New Sales) left; Interest/Non-op/Financing/Within Group stacked right.
  const secCard = (s: StmtSection) => {
    const item = (label: string, v: number) => `<tr><td class="item">${label}</td><td class="r ${cl(v)}">${f.fM(v)}</td></tr>`
    let rows = s.receipts.map(b => item(b.label, b.value)).join('')
    if (s.receipts.length > 1) rows += `<tr class="natsub"><td>Total receipts</td><td class="r ${cl(s.recTotal)}">${f.fM(s.recTotal)}</td></tr>`
    rows += s.payments.map(b => item(b.label, b.value)).join('')
    if (s.payments.length > 1) rows += `<tr class="natsub"><td>Total payments</td><td class="r ${cl(s.payTotal)}">${f.fM(s.payTotal)}</td></tr>`
    return `<div class="chartcard stmtcard"><div class="ch-h"><span class="sh-t">${s.label}</span><b class="sh-n ${cl(s.net)}">${f.fM(s.net)}</b></div><table class="t"><tbody>${rows}</tbody></table></div>`
  }
  // Dual card — Actual | Forecast two-column statement per section.
  const dualCard = (s: DualSection) => {
    const drow = (label: string, a: number, fv: number, klass = '') =>
      `<tr class="${klass}"><td class="${klass ? '' : 'item'}">${label}</td><td class="r ${cl(a)}">${f.fM(a)}</td><td class="r fc ${cl(fv)}">${f.fM(fv)}</td></tr>`
    let rows = s.receipts.map(b => drow(b.label, b.actual, b.forecast)).join('')
    if (s.receipts.length > 1) rows += drow('Total receipts', s.recA, s.recF, 'natsub')
    rows += s.payments.map(b => drow(b.label, b.actual, b.forecast)).join('')
    if (s.payments.length > 1) rows += drow('Total payments', s.payA, s.payF, 'natsub')
    rows += drow(`Net ${s.label.toLowerCase()}`, s.netA, s.netF, 'subtot')
    return `<div class="chartcard stmtcard dualcard"><table class="t"><thead><tr><th class="sh-t">${s.label}</th><th class="r">Actual</th><th class="r fc">Forecast</th></tr></thead><tbody>${rows}</tbody></table></div>`
  }
  // Loans & Overdrafts — debt position (point-in-time stocks, prior-year Dec vs
  // as-of). Δ colour inverted (down = green), matching the screen's card. Sits at
  // the top of column 1, above the Operations card.
  const loanD = (o.loanEnd ?? 0) - (o.loanStart ?? 0), odD = (o.odEnd ?? 0) - (o.odStart ?? 0)
  const totDS = (o.loanStart ?? 0) + (o.odStart ?? 0), totDE = (o.loanEnd ?? 0) + (o.odEnd ?? 0)
  const hasDebt = Math.abs(o.loanStart ?? 0) + Math.abs(o.loanEnd ?? 0) + Math.abs(o.odStart ?? 0) + Math.abs(o.odEnd ?? 0) > 1
  const dcl = (v: number) => Math.abs(v) < 50000 ? '' : (v < 0 ? 'pos' : 'neg')
  const debtCard = hasDebt ? `<div class="chartcard"><div class="ch-h">Loans &amp; overdrafts · ${o.startLabel} → ${o.asOfLabel}</div>
      <table class="t"><thead><tr><th></th><th class="r">${o.startLabel}</th><th class="r">${o.asOfLabel}</th><th class="r">Δ</th></tr></thead>
      <tbody>
        <tr><td class="item">Accumulated loans</td><td class="r">${f.fM(o.loanStart)}</td><td class="r">${f.fM(o.loanEnd)}</td><td class="r ${dcl(loanD)}">${f.fD(loanD)}</td></tr>
        <tr><td class="item">Overdrafts</td><td class="r">${f.fM(o.odStart)}</td><td class="r">${f.fM(o.odEnd)}</td><td class="r ${dcl(odD)}">${f.fD(odD)}</td></tr>
        <tr class="natsub"><td>Total debt</td><td class="r">${f.fM(totDS)}</td><td class="r">${f.fM(totDE)}</td><td class="r ${dcl(totDE - totDS)}">${f.fD(totDE - totDS)}</td></tr>
      </tbody></table></div>` : ''

  const stmtCols = fc
    ? arrangeByColumns(fc.dual.sections, STMT_COLUMNS)
        .map((col, i) => `<div class="seccol${i === 1 ? ' spaced' : ''}">${(i === 0 ? debtCard : '') + col.map(dualCard).join('')}</div>`).join('')
    : arrangeByColumns(o.statement.sections, STMT_COLUMNS)
        .map((col, i) => `<div class="seccol${i === 1 ? ' spaced' : ''}">${(i === 0 ? debtCard : '') + col.map(secCard).join('')}</div>`).join('')

  const charts = `<div class="seccol">
    <div class="chartcard"><div class="ch-h">How the cash moved <span>· sections → net movement</span></div>
      ${waterfallSvg(o.statement.sections.map(s => ({ label: s.label, value: s.net })), nm, chartDisp, 1.35)}</div>
    <div class="chartcard"><div class="ch-h">Trade payables · monthly · ${o.startLabel} → ${o.asOfLabel} · ${o.disp.payUnit}</div>
      ${o.hasPay ? `${payablesTrendSvg(o.paySeries ?? [], chartDisp)}
        <div class="paysum"><span>${o.startLabel} <b class="${cl(o.payStart)}">${f.fM(o.payStart)}</b></span><span>${o.asOfLabel} <b class="${cl(o.payEnd)}">${f.fM(o.payEnd)}</b></span><span>Δ <b class="${cl(payDelta)}">${f.fD(payDelta)}</b></span></div>
        <div class="note">Suppliers, subcontractors &amp; taxes — the editable <b>trade_payables</b> group (Midas TB, USD). Δ positive = paid down. Recent months still posting.</div>`
        : `<div class="note">No matched payables for this scope.</div>`}</div>
  </div>`
  const sub = fc
    ? `Actual Jan–${o.asOfLabel} · forecast to ${fc.horizonLabel} · ${o.disp.lineUnit}${o.matchedCount != null ? ` · ${o.matchedCount} areas` : ''}`
    : `Actual to date · Jan–${o.asOfLabel} · ${o.disp.lineUnit}${o.matchedCount != null ? ` · ${o.matchedCount} areas` : ''}`
  return sheet(head(`Cash Flow Report — ${o.scopeLabel}`, sub, o.bmk)
    + timeline + `<div class="groupcols">${stmtCols}${charts}</div>`, true)
}

export type AreaOpts = {
  asOfLabel: string; startLabel: string
  areaRows: { label: string; netOps: number; fcNetOps?: number; payStart: number | null; payEnd: number | null }[]
  areaTotals: { netOps: number; fcNetOps?: number; payStart: number; payEnd: number }
  forecastActive?: boolean; horizonLabel?: string
  disp: PrintDisp
  bmk?: Bmk | Bmk[] | null
}
function areaSheet(o: AreaOpts): string {
  const f = fmtFor(o.disp)
  const chartDisp = { div: o.disp.div, dec: o.disp.dec }
  const t = o.areaTotals
  const fc = !!o.forecastActive
  const row = (label: string, netOps: number, fcNetOps: number | undefined, ps: number | null, pe: number | null, tot = false) => {
    const d = (ps != null && pe != null) ? pe - ps : null
    return `<tr${tot ? ' class="total"' : ''}><td>${label}</td><td class="r ${cl(netOps)}">${f.fM(netOps)}</td>
      ${fc ? `<td class="r fc ${cl(fcNetOps ?? 0)}">${f.fM(fcNetOps ?? 0)}</td>` : ''}
      <td class="r sepl ${cl(ps)}">${f.fM(ps)}</td><td class="r ${cl(pe)}">${f.fM(pe)}</td><td class="r ${cl(d)}">${f.fD(d)}</td></tr>`
  }
  const left = `<table class="t tarea"><thead><tr><th>Area</th><th class="r">Net cash from ops</th>${fc ? '<th class="r fc">Forecast</th>' : ''}<th class="r sepl">Payables ${o.startLabel}</th><th class="r">Payables ${o.asOfLabel}</th><th class="r">Δ</th></tr></thead>
    <tbody>${o.areaRows.map(a => row(a.label, a.netOps, a.fcNetOps, a.payStart, a.payEnd)).join('')}${row(`Group (${o.areaRows.length} areas)`, t.netOps, t.fcNetOps, t.payStart, t.payEnd, true)}</tbody></table>`
  const right = `<div class="chartcard areachart"><div class="ch-h">Net cash from operations <span>· by area${fc ? ' · actual + forecast' : ''}</span></div>
    ${areaBarsSvg(o.areaRows.map(a => ({ label: a.label, value: a.netOps, forecast: fc ? (a.fcNetOps ?? 0) : undefined })), chartDisp, { zoom: 1.5, maxRows: 20 })}
    <div class="note">Green = cash generated, crimson = cash consumed (${o.disp.lineUnit}${fc ? `). Solid = actual (Jan–${o.asOfLabel}); faded = forecast (to ${o.horizonLabel})` : ', YTD'}.</div></div>`
  const sub = fc ? `Actual Jan–${o.asOfLabel} · forecast to ${o.horizonLabel} · ${o.disp.lineUnit} · ${o.areaRows.length} areas`
    : `Actual to date · Jan–${o.asOfLabel} · ${o.disp.lineUnit} · ${o.areaRows.length} areas`
  // No KPI band — chart is the headline, given the full sheet height.
  return sheet(head('Cash Flow Report — Areas', sub, o.bmk)
    + `<div class="cols"><div>${left}</div><div>${right}</div></div>`)
}

export type ProjectPrint = {
  areaLabel: string; project: string; currency: string; asOfLabel: string; months: number[]
  matrix: { sections: MatrixSection[]; netMovement: number[]; netTotal: number }
  /* Trade-payables balance (USD, CCC share), aligned to `months`; `start` is the
   * Dec prior-year opening; `change` = latest − start. Undefined = not mapped. */
  payables?: { monthly: (number | null)[]; start: number | null; change: number | null }
  /* When set, months after index `actualCount` are the forecast tail (faded /
   * tinted); `horizonLabel` names the horizon. */
  actualCount?: number; horizonLabel?: string
  bmk?: Bmk | Bmk[] | null
}
function projectSheet(p: ProjectPrint, disp: PrintDisp): string {
  const f = fmtFor(disp)
  const chartDisp = { div: disp.div, dec: disp.dec }
  const fc = p.actualCount != null && p.actualCount < p.months.length
  const asOfM = fc ? p.months[p.actualCount! - 1] : 99   // last actual month number
  const secNet = (label: string) => p.matrix.sections.find(s => s.label === label)?.netTot ?? 0
  const pv = p.payables
  const th = (m: number) => `<th class="r ${fc && m > asOfM ? 'fc' : ''} ${fc && m === asOfM + 1 ? 'fcseam' : ''}">${MONTHS[m - 1]}</th>`
  const table = `<table class="t"><thead><tr><th>Line item</th>${p.months.map(th).join('')}<th class="r sepl">${fc ? 'Total' : 'YTD'}</th></tr></thead>
    <tbody>${p.matrix.sections.map(s => matrixRows(s, p.months, f, asOfM)).join('')}
      <tr class="total"><td>Net cash movement</td>${p.months.map((m, i) => `<td class="r ${fc && m > asOfM ? 'fc' : ''} ${fc && m === asOfM + 1 ? 'fcseam' : ''} ${cl(p.matrix.netMovement[i])}">${f.fM(p.matrix.netMovement[i])}</td>`).join('')}<td class="r sepl ${cl(p.matrix.netTotal)}">${f.fM(p.matrix.netTotal)}</td></tr>
    </tbody></table>`
  // Right column: each chart carries its own stat cards directly above it, so the
  // figures read against the chart they describe (mirrors the screen).
  const cashCards = kpis([
    { label: `Net cash movement · ${fc ? 'full year' : 'YTD'}`, value: f.fM(p.matrix.netTotal), cls: cl(p.matrix.netTotal) },
    { label: 'Net from operations', value: f.fM(secNet('Operations')), cls: cl(secNet('Operations')) },
    { label: 'Net financing', value: f.fM(secNet('Bank Financing')), cls: cl(secNet('Bank Financing')) },
  ], true)
  const cashCell = `<div class="pchcell">${cashCards}<div class="chartcard"><div class="ch-h">Net cash movement <span>· by month${fc ? ' · incl. forecast' : ''}</span></div>${netTrendSvg(p.months.map(m => MONTHS[m - 1]), p.matrix.netMovement, chartDisp, fc ? p.actualCount : undefined)}</div></div>`
  // Trade payables — Balance at start (Dec) · current (as-of) · Δ over the period,
  // as stat cards above the balance-trajectory chart.
  let payCell = ''
  if (pv && pv.monthly.some(v => v != null)) {
    const last = [...pv.monthly].reverse().find(v => v != null) ?? null
    const payCards = kpis([
      { label: `Balance · ${p.asOfLabel}`, value: f.fM(last), cls: cl(last) },
      { label: 'At start (Dec)', value: f.fM(pv.start), cls: cl(pv.start) },
      { label: 'Change over period', value: f.fM(pv.change), cls: cl(pv.change) },
    ], true)
    payCell = `<div class="pchcell">${payCards}<div class="chartcard"><div class="ch-h">Trade payables <span>· balance</span></div>${payablesTrendSvg(p.months.map((m, i) => ({ label: MONTHS[m - 1], value: pv.monthly[i] ?? 0 })), chartDisp)}</div></div>`
  }
  const sub = fc ? `${p.areaLabel} · monthly · actual Jan–${p.asOfLabel} · forecast to ${p.horizonLabel} · ${disp.lineUnit}`
    : `${p.areaLabel} · monthly actuals Jan–${p.asOfLabel} · ${disp.lineUnit}`
  return sheet(head(`Cash Flow Report — ${p.project}`, sub, p.bmk)
    + `<div class="cols"><div>${table}</div><div>${cashCell}${payCell}</div></div>`)
}

export type SectionsOpts = {
  asOfLabel: string; matchedCount: number
  sections: { label: string; net: number; fcNet?: number; rows: { label: string; value: number; forecast?: number }[] }[]
  forecastActive?: boolean; horizonLabel?: string
  disp: PrintDisp
  bmk?: Bmk | Bmk[] | null
}
function sectionsSheet(o: SectionsOpts): string {
  const f = fmtFor(o.disp)
  const chartDisp = { div: o.disp.div, dec: o.disp.dec }
  const card = (s: SectionsOpts['sections'][number]) =>
    `<div class="chartcard"><div class="ch-h"><span class="sh-t">${s.label}</span><span class="sh-nn"><b class="sh-n ${cl(s.net)}">${f.fM(s.net)}</b>${o.forecastActive ? `<b class="sh-n fc">${f.fM(s.fcNet)}</b>` : ''}</span></div>${areaBarsSvg(s.rows, chartDisp, { zoom: 1.6, maxRows: 16, dualLabel: o.forecastActive })}</div>`
  // Balance the 5 sections across 3 columns by estimated height (tallest first
  // into the shortest column) so no column runs long and the page fills evenly.
  const est = (s: SectionsOpts['sections'][number]) => Math.min(16, s.rows.length) + 2
  const colBins: SectionsOpts['sections'] [] = [[], [], []]
  const heights = [0, 0, 0]
  ;[...o.sections].sort((a, b) => est(b) - est(a)).forEach(s => {
    let mi = 0; for (let i = 1; i < 3; i++) if (heights[i] < heights[mi]) mi = i
    colBins[mi].push(s); heights[mi] += est(s)
  })
  const cols = colBins
    .map(col => `<div class="seccol">${col.map(card).join('')}</div>`).join('')
  const sub = o.forecastActive
    ? `Actual Jan–${o.asOfLabel} · forecast to ${o.horizonLabel} · ${o.disp.lineUnit} · ${o.matchedCount} areas · each section's net, by area`
    : `Actual to date · Jan–${o.asOfLabel} · ${o.disp.lineUnit} · ${o.matchedCount} areas · each section's net, by area`
  return sheet(head('Cash Flow Report — Sections', sub, o.bmk)
    + `<div class="seccols">${cols}</div>`)
}

/* ── Movers sheet — projects grouped by area (package only) ───────────────────
 * The Movers screen renders its own standalone print (printMovers in CashReport);
 * this is the same content laid on the shared .sheet system so it composes into a
 * bookmarkable package. Cards are pre-shaped by the caller (one per area, project
 * rows + subtotal); a diverging net-CFO chart trails the cards. */
export type MoversCardRow = { code: string; star: boolean; netOps: number; fcNetOps?: number; payStart: number | null; payEnd: number | null; sec?: boolean }
export type MoversCard = { label: string; count: string; rows: MoversCardRow[]; subNet: number; subFc?: number; subPayStart: number | null; subPayEnd: number | null }
export type MoversOpts = {
  title: string; areaLabel: string; asOfLabel: string; startLabel: string
  forecastActive?: boolean; horizonLabel?: string; headNote: string
  cards: MoversCard[]
  chartRows: { label: string; value: number; forecast?: number }[]
  grand: { netOps: number; fcNetOps?: number; payStart: number | null; payEnd: number | null }
  gN: number; gMain: number
  disp: PrintDisp
  /* 'masonry' (default) = cards flow full-width, chart tucked bottom-right.
   * 'chartCol' = cards in `cardCols` columns, the net-CFO chart alone in a
   * full-height final column (bigger fonts). */
  layout?: 'masonry' | 'chartCol'
  cardCols?: number   // card columns when layout='chartCol' (default 2); chart is the +1
  bmk?: Bmk | Bmk[] | null
}
function moversSheet(o: MoversOpts): string {
  const f = fmtFor(o.disp)
  const fc = !!o.forecastActive
  const payD = (s: number | null, e: number | null) => (s != null && e != null) ? e - s : null
  const cell = (v: number | null | undefined) => `<td class="r ${cl(v)}">${f.fM(v)}</td>`
  const fcell = (v: number | null | undefined) => fc ? `<td class="r fc ${cl(v)}">${f.fM(v)}</td>` : ''
  const dcell = (v: number | null) => `<td class="r ${cl(v)}">${f.fD(v)}</td>`
  const shortPd = (l: string) => l.replace(/\s*20(\d\d)\b/, " '$1")
  const thead = `<thead><tr><th>Project</th><th class="r">Net</th>${fc ? '<th class="r fc">Fcst</th>' : ''}<th class="r">${shortPd(o.startLabel)}</th><th class="r">${shortPd(o.asOfLabel)}</th><th class="r">Δ</th></tr></thead>`
  const cardHtml = (c: MoversCard) => {
    if (c.rows.length === 1) {
      const r = c.rows[0]
      return `<div class="pcard pcard--one">
        <div class="pcard-h"><span class="pcard-name">${esc(c.label)}</span>${r.star ? '<span class="star">★</span>' : r.sec ? `<span class="k">${esc(c.count)}</span>` : ''}</div>
        <table class="pct">${thead}<tbody>
          <tr class="one ${r.sec ? 'sec' : ''}"><td class="p">${esc(r.code)}</td>${cell(r.netOps)}${fcell(r.fcNetOps)}${cell(r.payStart)}${cell(r.payEnd)}${dcell(payD(r.payStart, r.payEnd))}</tr>
        </tbody></table></div>`
    }
    return `<div class="pcard">
      <div class="pcard-h"><span class="pcard-name">${esc(c.label)}</span><span class="k">${esc(c.count)}</span></div>
      <table class="pct">${thead}<tbody>
        ${c.rows.map(r => `<tr class="${r.sec ? 'sec' : ''}"><td class="p">${esc(r.code)}${r.star ? ' <span class="star">★</span>' : ''}</td>${cell(r.netOps)}${fcell(r.fcNetOps)}${cell(r.payStart)}${cell(r.payEnd)}${dcell(payD(r.payStart, r.payEnd))}</tr>`).join('')}
        <tr class="sub"><td>Subtotal</td>${cell(c.subNet)}${fcell(c.subFc)}${cell(c.subPayStart)}${cell(c.subPayEnd)}${dcell(payD(c.subPayStart, c.subPayEnd))}</tr>
      </tbody></table></div>`
  }
  const sub = fc
    ? `${o.areaLabel} · net cash from operations · actual Jan–${o.asOfLabel} · forecast to ${o.horizonLabel} · ${o.disp.lineUnit} · ${o.headNote}`
    : `${o.areaLabel} · net cash from operations · Jan–${o.asOfLabel} · ${o.disp.lineUnit} · ${o.headNote}`
  const chartDisp = { div: o.disp.div, dec: o.disp.dec }
  if (o.layout === 'chartCol') {
    // Cards balanced across `cardCols` columns (left), the chart alone in a
    // full-height final column (right).
    const cardCols = o.cardCols ?? 2
    const tight = cardCols >= 3
    // Balance cards by estimated height (tallest first into the shortest column)
    // so no column runs long — same packing as the Sections page.
    const est = (c: MoversCard) => Math.min(30, c.rows.length) + 2
    const bins: MoversCard[][] = Array.from({ length: cardCols }, () => [])
    const bh = new Array(cardCols).fill(0)
    ;[...o.cards].sort((a, b) => est(b) - est(a)).forEach(c => {
      let mi = 0; for (let i = 1; i < cardCols; i++) if (bh[i] < bh[mi]) mi = i
      bins[mi].push(c); bh[mi] += est(c)
    })
    const colDivs = bins.map(col => `<div class="pmain-col">${col.map(cardHtml).join('')}</div>`).join('')
    // Size the chart to fill its full-height column: estimate the tallest card
    // column's pixel height, then pick a bar height so nBars bars span it
    // top-to-bottom (chart renders at natural height, height:auto, no letterbox).
    const nBars = Math.max(1, Math.min(40, o.chartRows.filter(r => Math.abs(r.value) >= 50000).length))
    const rowPx = tight ? 20 : 22
    const tallestColPx = Math.max(...bh) * rowPx + Math.max(...bins.map(b => b.length)) * 18
    const targetPx = Math.max(tallestColPx, 610)               // never shorter than the min column height
    const chartVBW = 340, colWpx = 1024 / (cardCols + 1) - 26  // approx chart-column content width
    const targetVBH = targetPx * chartVBW / colWpx
    const rowHpx = Math.max(26, Math.min(74, (targetVBH - 14) / nBars))
    const chart = o.chartRows.length
      ? `<div class="pchart pchart--tall">${moverBarsSvg(o.chartRows, chartDisp, { maxRows: 40, width: chartVBW, rowHpx, fontPx: Math.min(16, Math.max(11, rowHpx * 0.42)), labW: 96, valW: 54, barFrac: 0.62 })}</div>` : ''
    return sheet(head(o.title, sub, o.bmk)
      + `<div class="pmain${tight ? ' pmain--tight' : ''}" style="--cardcols:${cardCols}"><div class="pmain-cardcols">${colDivs}</div><div class="pmain-chart">${chart}</div></div>`)
  }
  const chart = o.chartRows.length ? `<div class="pchart">${areaBarsSvg(o.chartRows, chartDisp, { zoom: 1.05, maxRows: 26 })}</div>` : ''
  return sheet(head(o.title, sub, o.bmk) + `<div class="pflow">${o.cards.map(cardHtml).join('')}${chart}</div>`)
}

/* wide=true lays the sheet out on a wider design canvas (1240px). The page stays
 * 1040px; the fit-to-page script then scales the sheet down to fill the page
 * WIDTH exactly (a tall statement is otherwise height-bound and shrinks away from
 * the right edge, wasting ~20% of the width). Used by the Group sheet. */
const sheet = (inner: string, wide = false) => `<div class="page"><div class="sheet${wide ? ' wide' : ''}">${inner}</div></div>`

/* ── skeleton: shared style + fit-to-page script ────────────────────────────── */
const STYLE = `
  @page { size: A4 landscape; margin: 9mm 11mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #15233b; font-size: 12.5px; }
  .neg { color: #E10020; } .pos { color: #057a55; }
  .page { width: 1040px; height: 726px; overflow: hidden; }
  .page + .page { page-break-before: always; }
  .sheet { width: 1040px; transform-origin: top left; }
  .sheet.wide { width: 1240px; }
  .head { display: flex; align-items: center; gap: 11px; border-bottom: 2.5px solid #E10020; padding-bottom: 7px; margin-bottom: 10px; }
  .logo { height: 34px; width: auto; flex: 0 0 auto; }
  .ht { min-width: 0; }
  h1 { font-size: 22px; } .sub { font-size: 11.5px; color: #64748b; margin-top: 2px; }
  .brand { margin-left: auto; align-self: flex-end; font-size: 10px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: #64748b; white-space: nowrap; }
  .kpis { display: flex; gap: 10px; margin-bottom: 12px; }
  .kpi { flex: 1; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 12px; border-left: 3px solid #E10020; }
  .kpi-l { font-size: 8.5px; letter-spacing: .4px; text-transform: uppercase; color: #64748b; font-weight: 700; }
  .kpi-v { font-size: 22px; font-weight: 800; margin-top: 2px; }
  .kpi-s { font-size: 9px; color: #64748b; margin-top: 1px; }
  /* Compact KPI band — sits directly above the chart it describes (project page). */
  .kpis--compact { gap: 8px; margin-bottom: 7px; }
  .kpis--compact .kpi { padding: 6px 10px; }
  .kpis--compact .kpi-v { font-size: 16px; }
  .pchcell + .pchcell { margin-top: 4px; }
  .cashwalk { display: flex; align-items: stretch; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; margin-bottom: 12px; }
  .cw-pt { flex: 1; padding: 8px 14px; }
  .cw-l { font-size: 8.5px; letter-spacing: .4px; text-transform: uppercase; color: #64748b; font-weight: 700; }
  .cw-v { font-size: 21px; font-weight: 800; margin-top: 2px; }
  .cw-arrow { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 0 18px; background: #f6f7f9; border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; }
  .cw-arrow span { font-size: 15px; font-weight: 800; }
  .cw-arrow i { font-size: 8px; letter-spacing: .4px; text-transform: uppercase; color: #64748b; font-weight: 700; font-style: normal; margin-top: 2px; }
  .cols { display: grid; grid-template-columns: 1.25fr 1fr; gap: 16px; align-items: start; }
  table.t { width: 100%; border-collapse: collapse; }
  .t th { text-align: left; font-size: 8.5px; letter-spacing: .4px; text-transform: uppercase; color: #64748b; font-weight: 700; padding: 4px 8px; border-bottom: 1px solid #e2e8f0; }
  .t th.r, .t td.r { text-align: right; font-variant-numeric: tabular-nums; }
  .t td { padding: 3px 8px; }
  .t .sec td { font-size: 8.5px; letter-spacing: .4px; text-transform: uppercase; color: #64748b; font-weight: 700; padding-top: 8px; }
  .t td.item { padding-left: 18px; color: #334155; }
  .t .natsub td { font-style: italic; font-weight: 600; color: #15233b; background: #f2f4f7; border-top: 1px dashed #cbd5e1; }
  .t .subtot td { font-weight: 700; border-top: 1px solid #e2e8f0; }
  .t .total td { font-weight: 800; border-top: 2px solid #15233b; padding-top: 5px; }
  .t.tpos .total td { border-top: 0; }
  .sepl { border-left: 1px solid #e2e8f0; }
  .chartcard { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; break-inside: avoid; }
  .chartcard svg { display: block; width: 100%; }
  .ch-h { font-size: 11px; font-weight: 700; margin-bottom: 4px; } .ch-h span { color: #94a3b8; font-weight: 500; }
  .seccols { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; align-items: start; }
  .seccol { display: flex; flex-direction: column; gap: 14px; }
  .seccol .chartcard { margin-bottom: 0; padding: 12px 14px; }
  .seccol .ch-h, .netcard .ch-h { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .sh-t { font-size: 16px; font-weight: 700; color: #15233b; } .sh-n { font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sh-nn { display: inline-flex; align-items: baseline; gap: 10px; } .sh-n.fc { color: #9a7b3c; font-size: 16px; }
  /* Group page — cash-journey timeline (mirrors the screen) */
  .timeline { display: flex; align-items: stretch; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; margin-bottom: 12px; }
  .tl-node { padding: 9px 15px; min-width: 150px; }
  .tl-cap { font-size: 9px; letter-spacing: .4px; text-transform: uppercase; color: #64748b; font-weight: 700; }
  .tl-val { font-size: 23px; font-weight: 800; margin-top: 2px; }
  .tl-flow { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 8px 16px; background: #f6f7f9; border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; }
  .tl-move { font-size: 17px; font-weight: 800; }
  .tl-move i { font-size: 9px; letter-spacing: .4px; text-transform: uppercase; color: #64748b; font-weight: 700; font-style: normal; margin-left: 6px; }
  .tl-chips { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .tl-chip { font-size: 12px; color: #64748b; font-weight: 600; border: 1px solid #e2e8f0; border-radius: 20px; padding: 4px 11px; background: #fff; }
  .tl-chip b { font-weight: 800; margin-left: 3px; }
  .tl-mid { background: #eef2f7; border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; }
  .tl-flow-fc { background: #fbfaf6; } .tl-flow-fc .tl-move i { color: #9a7b3c; }
  .tl-fc { background: #fbfaf6; }
  /* Dual (Actual | Forecast) statement card */
  .dualcard .t thead th { border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  .dualcard .t thead th.sh-t { font-size: 14px; font-weight: 700; color: #15233b; text-transform: none; letter-spacing: 0; }
  .t td.fc, .t th.fc { color: #9a7b3c; }
  .t .fc.neg { color: #E10020; opacity: .78; } .t .fc.pos { color: #057a55; opacity: .78; }
  .t td.fcseam, .t th.fcseam { border-left: 1px dashed #cbd5e1; }
  /* Group page — justified 3-column grid: Operations · four sections · charts */
  .groupcols { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; align-items: start; }
  .groupcols .seccol { gap: 10px; }
  .groupcols .seccol.spaced { gap: 20px; }
  .stmtcard .t td { padding-top: 4px; padding-bottom: 4px; }
  .paysum { display: flex; gap: 16px; margin-top: 6px; font-size: 10px; color: #64748b; }
  .paysum b { font-variant-numeric: tabular-nums; }
  .note { font-size: 10.5px; color: #64748b; line-height: 1.5; margin-top: 8px; } .note b { color: #15233b; }
  /* Invisible bookmark anchor — present in the PDF text layer, invisible on paper.
     text-transform/letter-spacing reset so the base64 payload isn't corrupted. */
  .bmk { font-size: 1pt; color: transparent; background: #fff; white-space: nowrap; text-transform: none; letter-spacing: normal; font-variant-caps: normal; }
  /* Movers page (package) — projects grouped by area as full-width masonry cards
     + a diverging net-CFO chart trailing at the end. Mirrors the standalone
     printMovers layout, laid on the shared .sheet so it composes into the package. */
  .ptotal { display: flex; align-items: baseline; gap: 16px; background: #141414; color: #fff; border-radius: 7px; padding: 7px 13px; margin-bottom: 10px; font-size: 10.5px; }
  .ptotal b { font-size: 12px; font-variant-numeric: tabular-nums; } .ptotal .neg { color: #ff7a8a; } .ptotal .pos { color: #6ee7a8; }
  .ptotal .lbl { color: #9aa4b2; text-transform: uppercase; letter-spacing: .4px; font-size: 8px; font-weight: 700; margin-right: 5px; }
  .pflow { columns: 300px; column-gap: 12px; }
  .pchart { break-inside: avoid; margin-top: 2px; } .pchart svg { width: 100%; height: auto; display: block; }
  /* Movers with a dedicated chart column — cards balanced across var(--cardcols)
     columns (left), the chart alone in a full-height final column (right). */
  .pmain { display: flex; gap: 16px; align-items: stretch; min-height: 640px; }
  .pmain-cardcols { flex: var(--cardcols, 2); display: flex; gap: 12px; align-items: flex-start; }
  .pmain-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 11px; }
  /* Tighter horizontal padding in the (narrower) chart-column cards so project
     names keep room next to the numeric columns. */
  .pmain-cardcols .pct td, .pmain-cardcols .pct th { padding-left: 4px; padding-right: 4px; }
  /* 3-card-column pack (all-projects page) — smaller font + narrower numeric
     columns so short project codes fit beside four value columns. */
  .pmain--tight .pct { font-size: 10.5px; }
  .pmain--tight .pct td.r, .pmain--tight .pct th.r { width: 45px; }
  /* Roomier project rows when there are only two card columns (mainstream page). */
  .pmain:not(.pmain--tight) .pct td { padding-top: 5px; padding-bottom: 5px; }
  .pmain:not(.pmain--tight) .pct th { padding-top: 4px; padding-bottom: 4px; }
  .pmain-chart { flex: 1; display: flex; flex-direction: column; justify-content: flex-start; border: 1px solid #e2e8f0; border-radius: 7px; padding: 10px 12px; }
  .pmain-chart .pchart--tall { margin-top: 0; width: 100%; }
  /* height:auto → the chart renders at its natural height (sized by rowHpx to fill
     the column), so there's no meet-letterbox whitespace above/below it. */
  .pmain-chart .pchart--tall svg { width: 100%; height: auto; display: block; }
  .pcard { break-inside: avoid; border: 1px solid #e2e8f0; border-radius: 7px; overflow: hidden; margin: 0 0 11px; }
  .pcard-h { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; background: #f1f4f8; border-bottom: 1px solid #e2e8f0; padding: 5px 9px; }
  .pcard-name { font-weight: 800; text-transform: uppercase; font-size: 11.5px; letter-spacing: .3px; }
  .pct { width: 100%; border-collapse: collapse; font-size: 11.5px; table-layout: fixed; }
  .pct th { text-align: left; font-size: 8.5px; text-transform: uppercase; letter-spacing: .3px; color: #94a3b8; font-weight: 700; border-bottom: 1px solid #e2e8f0; padding: 2.5px 6px; }
  .pct th.r, .pct td.r { text-align: right; font-variant-numeric: tabular-nums; width: 50px; } .pct th.r { white-space: nowrap; }
  .pct td { padding: 2.5px 6px; } .pct td.p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pct td.fc, .pct th.fc { color: #9a7b3c; } .pct td.fc.neg { color: #E10020; opacity: .8; } .pct td.fc.pos { color: #057a55; opacity: .8; }
  /* The folded "Others" row: only the label cell is muted/italic — the numeric
     cells keep their green/red (neg/pos) colour, like a mainstream project row. */
  .pct tr.sec td.p { color: #64748b; font-style: italic; }
  .pct tr.sub td { font-weight: 800; border-top: 1.4px solid #141414; }
  .pcard--one .pct tr.one td { font-weight: 700; } .pcard--one .pct tr.one.sec td.p { font-weight: 600; font-style: italic; color: #64748b; }
  .star { color: #E10020; font-style: normal; } .k { color: #94a3b8; font-weight: 600; font-size: 8.5px; }`

// Scale each sheet down so it fits exactly one landscape page (never spills).
const FIT_SCRIPT = `window.onload = function () {
  var W = 1040, H = 726;
  document.querySelectorAll('.sheet').forEach(function (el) {
    var sc = Math.min(1, W / el.scrollWidth, H / el.scrollHeight);
    if (sc < 1) el.style.transform = 'scale(' + sc + ')';
  });
  setTimeout(function () { window.print(); }, 80);
};`

function skeleton(title: string, sheets: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head>
<body>${sheets}<script>${FIT_SCRIPT}</script></body></html>`
}

/* ── public builders ────────────────────────────────────────────────────────── */
type Opts = {
  level: 'group' | 'area' | 'sections'
  scopeLabel: string; year: number; asOfLabel: string; startLabel: string; cashStartLabel?: string; matchedCount?: number
  statement?: { sections: StmtSection[]; netMovement: number }
  payStart?: number; payEnd?: number; hasPay?: boolean
  startCash?: number; endCash?: number
  loanStart?: number; loanEnd?: number; odStart?: number; odEnd?: number
  paySeries?: { label: string; value: number }[]
  forecast?: GroupForecast
  areaRows?: { label: string; netOps: number; fcNetOps?: number; payStart: number | null; payEnd: number | null }[]
  areaTotals?: { netOps: number; fcNetOps?: number; payStart: number; payEnd: number }
  forecastActive?: boolean; horizonLabel?: string
  sections?: { label: string; net: number; fcNet?: number; rows: { label: string; value: number; forecast?: number }[] }[]
  disp?: PrintDisp
}
export function buildReportHtml(o: Opts): string {
  const disp = o.disp ?? DEF
  if (o.level === 'sections' && o.sections)
    return skeleton('Cash Flow Report — Sections', sectionsSheet({ asOfLabel: o.asOfLabel, matchedCount: o.matchedCount ?? 0, sections: o.sections, forecastActive: o.forecastActive, horizonLabel: o.horizonLabel, disp }))
  if (o.level === 'area' && o.areaRows && o.areaTotals)
    return skeleton('Cash Flow Report — Areas', areaSheet({ asOfLabel: o.asOfLabel, startLabel: o.startLabel, areaRows: o.areaRows, areaTotals: o.areaTotals, forecastActive: o.forecastActive, horizonLabel: o.horizonLabel, disp }))
  return skeleton(`Cash Flow Report — ${o.scopeLabel}`, groupSheet({
    scopeLabel: o.scopeLabel, asOfLabel: o.asOfLabel, startLabel: o.startLabel, cashStartLabel: o.cashStartLabel, matchedCount: o.matchedCount,
    statement: o.statement!, payStart: o.payStart, payEnd: o.payEnd, hasPay: o.hasPay, startCash: o.startCash, endCash: o.endCash,
    loanStart: o.loanStart, loanEnd: o.loanEnd, odStart: o.odStart, odEnd: o.odEnd,
    paySeries: o.paySeries, forecast: o.forecast, disp,
  }))
}

/** One or more project sheets in a single print job (each project on its own page). */
export function buildProjectsPrintHtml(projects: ProjectPrint[], disp: PrintDisp = DEF): string {
  const title = projects.length === 1 ? `Cash Flow Report — ${projects[0].project}` : `Cash Flow Report — ${projects.length} projects`
  return skeleton(title, projects.map(p => projectSheet(p, disp)).join(''))
}

/* ── Print package ────────────────────────────────────────────────────────────
 * A single document composed of any subset of report sheets, each on its own
 * page and carrying an invisible bookmark anchor (via opts.bmk), so running the
 * PDF through /pdf-bookmarker yields a matching outline. The caller builds each
 * sheet with its opts (incl. bmk) and hands the ordered list here. Each builder
 * already returns a `.page` block; skeleton adds the shared style + fit script. */
export type PackageSheet =
  | { kind: 'group'; opts: GroupOpts }
  | { kind: 'area'; opts: AreaOpts }
  | { kind: 'sections'; opts: SectionsOpts }
  | { kind: 'movers'; opts: MoversOpts }
  | { kind: 'project'; opts: ProjectPrint; disp?: PrintDisp }
export function buildPackageHtml(sheets: PackageSheet[], title = 'Cash Flow Report — package'): string {
  const bodies = sheets.map(s => {
    switch (s.kind) {
      case 'group': return groupSheet(s.opts)
      case 'area': return areaSheet(s.opts)
      case 'sections': return sectionsSheet(s.opts)
      case 'movers': return moversSheet(s.opts)
      case 'project': return projectSheet(s.opts, s.disp ?? DEF)
    }
  })
  return skeleton(title, bodies.join(''))
}
