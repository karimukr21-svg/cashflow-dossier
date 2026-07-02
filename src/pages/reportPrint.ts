import type { StmtSection, MatrixSection } from './reportModel'
import { waterfallSvg, areaBarsSvg, netTrendSvg, payablesTrendSvg } from './reportCharts'

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

function kpis(cards: { label: string; value: string; cls?: string; sub?: string }[]): string {
  return `<div class="kpis">${cards.map(c =>
    `<div class="kpi"><div class="kpi-l">${c.label}</div><div class="kpi-v ${c.cls || ''}">${c.value}</div>${c.sub ? `<div class="kpi-s">${c.sub}</div>` : ''}</div>`).join('')}</div>`
}
function head(title: string, sub: string): string {
  return `<div class="head"><div><h1>${title}</h1><div class="sub">${sub}</div></div>
    <div class="brand"><span class="glyph">C</span>CCC · Treasury</div></div>`
}

function sectionRows(sec: StmtSection, f: Fmt): string {
  const item = (label: string, v: number) => `<tr><td class="item">${label}</td><td class="r ${cl(v)}">${f.fM(v)}</td></tr>`
  const sub = (label: string, v: number) => `<tr class="natsub"><td>${label}</td><td class="r ${cl(v)}">${f.fM(v)}</td></tr>`
  let s = `<tr class="sec"><td>${sec.label}</td><td></td></tr>`
  s += sec.receipts.map(b => item(b.label, b.value)).join('')
  if (sec.receipts.length > 1) s += sub('Total receipts', sec.recTotal)
  s += sec.payments.map(b => item(b.label, b.value)).join('')
  if (sec.payments.length > 1) s += sub('Total payments', sec.payTotal)
  s += `<tr class="subtot"><td>Net ${sec.label.toLowerCase()}</td><td class="r ${cl(sec.net)}">${f.fM(sec.net)}</td></tr>`
  return s
}

function matrixRows(sec: MatrixSection, months: number[], f: Fmt): string {
  const sum = (rows: { monthly: number[] }[], i: number) => rows.reduce((t, r) => t + r.monthly[i], 0)
  const row = (label: string, monthly: number[], total: number, klass: string) =>
    `<tr class="${klass}"><td class="${klass === '' ? 'item' : ''}">${label}</td>${monthly.map(v => `<td class="r ${cl(v)}">${f.fM(v)}</td>`).join('')}<td class="r sepl ${cl(total)}">${f.fM(total)}</td></tr>`
  let s = `<tr class="sec"><td colspan="${months.length + 2}">${sec.label}</td></tr>`
  s += sec.receipts.map(b => row(b.label, b.monthly, b.total, '')).join('')
  if (sec.receipts.length > 1) s += row('Total receipts', months.map((_, i) => sum(sec.receipts, i)), sec.receipts.reduce((t, b) => t + b.total, 0), 'natsub')
  s += sec.payments.map(b => row(b.label, b.monthly, b.total, '')).join('')
  if (sec.payments.length > 1) s += row('Total payments', months.map((_, i) => sum(sec.payments, i)), sec.payments.reduce((t, b) => t + b.total, 0), 'natsub')
  s += row(`Net ${sec.label.toLowerCase()}`, sec.net, sec.netTot, 'subtot')
  return s
}

/* ── per-report sheet bodies (inner HTML of one .sheet) ─────────────────────── */

type GroupOpts = {
  scopeLabel: string; asOfLabel: string; startLabel: string; matchedCount?: number
  statement: { sections: StmtSection[]; netMovement: number }
  payStart?: number; payEnd?: number; hasPay?: boolean
  startCash?: number; endCash?: number
  paySeries?: { label: string; value: number }[]
  disp: PrintDisp
}
function groupSheet(o: GroupOpts): string {
  const f = fmtFor(o.disp)
  const chartDisp = { div: o.disp.div, dec: o.disp.dec }
  const secBy = (label: string) => o.statement.sections.find(s => s.label === label)?.net ?? 0
  const opsNet = secBy('Operations'), finNet = secBy('Bank Financing')
  const payDelta = o.hasPay ? (o.payEnd ?? 0) - (o.payStart ?? 0) : null
  const hasCash = Math.abs(o.startCash ?? 0) > 1 || Math.abs(o.endCash ?? 0) > 1
  const cashWalk = hasCash ? `<div class="cashwalk">
      <div class="cw-pt"><div class="cw-l">Starting cash · ${o.startLabel}</div><div class="cw-v ${cl(o.startCash)}">${f.fM(o.startCash)}</div></div>
      <div class="cw-arrow"><span class="${cl(o.statement.netMovement)}">${o.statement.netMovement < 0 ? '−' : '+'}${f.fM(Math.abs(o.statement.netMovement))}</span><i>net movement</i></div>
      <div class="cw-pt"><div class="cw-l">Ending cash · ${o.asOfLabel}</div><div class="cw-v ${cl(o.endCash)}">${f.fM(o.endCash)}</div></div>
    </div>` : ''
  const band = kpis([
    { label: 'Net from operations', value: f.fM(opsNet), cls: cl(opsNet) },
    { label: 'Net financing', value: f.fM(finNet), cls: cl(finNet) },
    { label: 'Net cash movement', value: f.fM(o.statement.netMovement), cls: cl(o.statement.netMovement) },
    { label: `Trade payables · ${o.asOfLabel} · USD`, value: f.fM(o.payEnd), cls: cl(o.payEnd), sub: o.hasPay ? `${f.fD(payDelta)} since ${o.startLabel}` : '' },
  ])
  const left = `<table class="t"><thead><tr><th>Line item</th><th class="r">${o.disp.lineUnit}</th></tr></thead><tbody>
      ${o.statement.sections.map(s => sectionRows(s, f)).join('')}
      <tr class="total"><td>Net cash movement</td><td class="r ${cl(o.statement.netMovement)}">${f.fM(o.statement.netMovement)}</td></tr>
    </tbody></table>`
  const right = `
    <div class="chartcard"><div class="ch-h">How the cash moved <span>· sections → net movement</span></div>
      ${waterfallSvg(o.statement.sections.map(s => ({ label: s.label, value: s.net })), o.statement.netMovement, chartDisp)}</div>
    <div class="chartcard"><div class="ch-h">Trade payables · monthly · ${o.startLabel} → ${o.asOfLabel} · ${o.disp.payUnit}</div>
      ${o.hasPay ? `${payablesTrendSvg(o.paySeries ?? [], chartDisp)}
        <div class="paysum"><span>${o.startLabel} <b class="${cl(o.payStart)}">${f.fM(o.payStart)}</b></span><span>${o.asOfLabel} <b class="${cl(o.payEnd)}">${f.fM(o.payEnd)}</b></span><span>Δ <b class="${cl(payDelta)}">${f.fD(payDelta)}</b></span></div>
        <div class="note">Suppliers, subcontractors &amp; taxes — the editable <b>trade_payables</b> group (Midas TB, USD). Δ positive = paid down. Recent months still posting.</div>`
        : `<div class="note">No matched payables for this scope.</div>`}</div>`
  return sheet(head(`Cash Flow Report — ${o.scopeLabel}`, `Actual to date · Jan–${o.asOfLabel} · ${o.disp.lineUnit}${o.matchedCount != null ? ` · ${o.matchedCount} matched areas` : ''}`)
    + band + cashWalk + `<div class="cols"><div>${left}</div><div>${right}</div></div>`)
}

type AreaOpts = {
  asOfLabel: string; startLabel: string
  areaRows: { label: string; netOps: number; payStart: number | null; payEnd: number | null }[]
  areaTotals: { netOps: number; payStart: number; payEnd: number }
  disp: PrintDisp
}
function areaSheet(o: AreaOpts): string {
  const f = fmtFor(o.disp)
  const chartDisp = { div: o.disp.div, dec: o.disp.dec }
  const t = o.areaTotals, payDelta = t.payEnd - t.payStart
  const top = [...o.areaRows].sort((a, b) => b.netOps - a.netOps)[0]
  const band = kpis([
    { label: 'Group net from ops', value: f.fM(t.netOps), cls: cl(t.netOps) },
    { label: `Trade payables · ${o.asOfLabel}`, value: f.fM(t.payEnd), cls: cl(t.payEnd), sub: `${f.fD(payDelta)} since ${o.startLabel}` },
    { label: 'Matched areas', value: String(o.areaRows.length) },
    { label: 'Top cash generator', value: top ? top.label : '—', sub: top ? f.fM(top.netOps) : '' },
  ])
  const row = (label: string, netOps: number, ps: number | null, pe: number | null, tot = false) => {
    const d = (ps != null && pe != null) ? pe - ps : null
    return `<tr${tot ? ' class="total"' : ''}><td>${label}</td><td class="r ${cl(netOps)}">${f.fM(netOps)}</td>
      <td class="r sepl ${cl(ps)}">${f.fM(ps)}</td><td class="r ${cl(pe)}">${f.fM(pe)}</td><td class="r ${cl(d)}">${f.fD(d)}</td></tr>`
  }
  const left = `<table class="t tarea"><thead><tr><th>Area</th><th class="r">Net cash from ops</th><th class="r sepl">Payables ${o.startLabel}</th><th class="r">Payables ${o.asOfLabel}</th><th class="r">Δ</th></tr></thead>
    <tbody>${o.areaRows.map(a => row(a.label, a.netOps, a.payStart, a.payEnd)).join('')}${row(`Group (${o.areaRows.length} areas)`, t.netOps, t.payStart, t.payEnd, true)}</tbody></table>`
  const right = `<div class="chartcard"><div class="ch-h">Net cash from operations <span>· by area</span></div>
    ${areaBarsSvg(o.areaRows.map(a => ({ label: a.label, value: a.netOps })), chartDisp)}
    <div class="note">Green = cash generated, crimson = cash consumed (${o.disp.lineUnit}, YTD).</div></div>`
  return sheet(head('Cash Flow Report — Areas', `Actual to date · Jan–${o.asOfLabel} · ${o.disp.lineUnit} · ${o.areaRows.length} matched areas`)
    + band + `<div class="cols"><div>${left}</div><div>${right}</div></div>`)
}

export type ProjectPrint = {
  areaLabel: string; project: string; currency: string; asOfLabel: string; months: number[]
  matrix: { sections: MatrixSection[]; netMovement: number[]; netTotal: number }
}
function projectSheet(p: ProjectPrint, disp: PrintDisp): string {
  const f = fmtFor(disp)
  const chartDisp = { div: disp.div, dec: disp.dec }
  const secNet = (label: string) => p.matrix.sections.find(s => s.label === label)?.netTot ?? 0
  const band = kpis([
    { label: 'Net cash movement · YTD', value: f.fM(p.matrix.netTotal), cls: cl(p.matrix.netTotal) },
    { label: 'Net from operations', value: f.fM(secNet('Operations')), cls: cl(secNet('Operations')) },
    { label: 'Net financing', value: f.fM(secNet('Bank Financing')), cls: cl(secNet('Bank Financing')) },
  ])
  const table = `<table class="t"><thead><tr><th>Line item</th>${p.months.map(m => `<th class="r">${MONTHS[m - 1]}</th>`).join('')}<th class="r sepl">YTD</th></tr></thead>
    <tbody>${p.matrix.sections.map(s => matrixRows(s, p.months, f)).join('')}
      <tr class="total"><td>Net cash movement</td>${p.months.map((_, i) => `<td class="r ${cl(p.matrix.netMovement[i])}">${f.fM(p.matrix.netMovement[i])}</td>`).join('')}<td class="r sepl ${cl(p.matrix.netTotal)}">${f.fM(p.matrix.netTotal)}</td></tr>
    </tbody></table>`
  const chart = `<div class="chartcard"><div class="ch-h">Net cash movement <span>· by month</span></div>${netTrendSvg(p.months.map(m => MONTHS[m - 1]), p.matrix.netMovement, chartDisp)}</div>`
  return sheet(head(`Cash Flow Report — ${p.project}`, `${p.areaLabel} · monthly actuals Jan–${p.asOfLabel} · ${disp.lineUnit}`)
    + band + `<div class="cols"><div>${table}</div><div>${chart}</div></div>`)
}

const sheet = (inner: string) => `<div class="page"><div class="sheet">${inner}</div></div>`

/* ── skeleton: shared style + fit-to-page script ────────────────────────────── */
const STYLE = `
  @page { size: A4 landscape; margin: 9mm 11mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #15233b; font-size: 11.5px; }
  .neg { color: #E10020; } .pos { color: #057a55; }
  .page { width: 1040px; height: 726px; overflow: hidden; }
  .page + .page { page-break-before: always; }
  .sheet { width: 1040px; transform-origin: top left; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.5px solid #E10020; padding-bottom: 7px; margin-bottom: 10px; }
  h1 { font-size: 19px; } .sub { font-size: 10px; color: #64748b; margin-top: 2px; }
  .brand { font-size: 11px; font-weight: 700; white-space: nowrap; }
  .glyph { display: inline-block; background: #E10020; color: #fff; width: 15px; height: 15px; border-radius: 3px; text-align: center; line-height: 15px; font-size: 10px; margin-right: 3px; }
  .kpis { display: flex; gap: 10px; margin-bottom: 12px; }
  .kpi { flex: 1; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 12px; border-left: 3px solid #E10020; }
  .kpi-l { font-size: 8.5px; letter-spacing: .4px; text-transform: uppercase; color: #64748b; font-weight: 700; }
  .kpi-v { font-size: 22px; font-weight: 800; margin-top: 2px; }
  .kpi-s { font-size: 9px; color: #64748b; margin-top: 1px; }
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
  .t .natsub td { font-style: italic; color: #475569; }
  .t .subtot td { font-weight: 700; border-top: 1px solid #e2e8f0; }
  .t .total td { font-weight: 800; border-top: 2px solid #15233b; padding-top: 5px; }
  .t.tpos .total td { border-top: 0; }
  .sepl { border-left: 1px solid #e2e8f0; }
  .chartcard { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; break-inside: avoid; }
  .chartcard svg { display: block; width: 100%; }
  .ch-h { font-size: 11px; font-weight: 700; margin-bottom: 4px; } .ch-h span { color: #94a3b8; font-weight: 500; }
  .paysum { display: flex; gap: 16px; margin-top: 6px; font-size: 10px; color: #64748b; }
  .paysum b { font-variant-numeric: tabular-nums; }
  .note { font-size: 9px; color: #64748b; line-height: 1.5; margin-top: 8px; } .note b { color: #15233b; }`

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
  level: 'group' | 'area'
  scopeLabel: string; year: number; asOfLabel: string; startLabel: string; matchedCount?: number
  statement?: { sections: StmtSection[]; netMovement: number }
  payStart?: number; payEnd?: number; hasPay?: boolean
  startCash?: number; endCash?: number
  paySeries?: { label: string; value: number }[]
  areaRows?: { label: string; netOps: number; payStart: number | null; payEnd: number | null }[]
  areaTotals?: { netOps: number; payStart: number; payEnd: number }
  disp?: PrintDisp
}
export function buildReportHtml(o: Opts): string {
  const disp = o.disp ?? DEF
  if (o.level === 'area' && o.areaRows && o.areaTotals)
    return skeleton('Cash Flow Report — Areas', areaSheet({ asOfLabel: o.asOfLabel, startLabel: o.startLabel, areaRows: o.areaRows, areaTotals: o.areaTotals, disp }))
  return skeleton(`Cash Flow Report — ${o.scopeLabel}`, groupSheet({
    scopeLabel: o.scopeLabel, asOfLabel: o.asOfLabel, startLabel: o.startLabel, matchedCount: o.matchedCount,
    statement: o.statement!, payStart: o.payStart, payEnd: o.payEnd, hasPay: o.hasPay, startCash: o.startCash, endCash: o.endCash,
    paySeries: o.paySeries, disp,
  }))
}

/** One or more project sheets in a single print job (each project on its own page). */
export function buildProjectsPrintHtml(projects: ProjectPrint[], disp: PrintDisp = DEF): string {
  const title = projects.length === 1 ? `Cash Flow Report — ${projects[0].project}` : `Cash Flow Report — ${projects.length} projects`
  return skeleton(title, projects.map(p => projectSheet(p, disp)).join(''))
}
