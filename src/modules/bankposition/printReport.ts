/* Self-contained, printable Group Cash Position report (A4 landscape):
 * KPI cards, two 12-month movement charts (Cash; Overdrafts & Loans with the
 * MTB facility segregated and a labelled y-axis), the summary area table in
 * Rasha's order (MTB before the group total, included; Palestine as a memo),
 * the treasury receipts/payments, and the narrative. No dependencies. */
import {
  FIELDS, type Field, type LineValues, type TreasuryRow,
  type BpEntity, type AreaNode,
  ccNet, fmtNum, fmtPeriodLabel, zeroLine,
} from './lib'

export interface Series { period: string; val: number; mtb?: number }

interface Summary {
  areaVals: { node: AreaNode; v: LineValues }[]
  operatingSum: LineValues
  mtbV: LineValues
  groupTotal: LineValues
  palSum: LineValues
  total: LineValues
  totalCash: number; jvMoney: number; moneyControl: number; blocked: number; freeUsable: number
}

export interface ReportData {
  period: string
  tree: { mtb: BpEntity | null; memo: BpEntity[] }
  vals: Map<string, LineValues>
  summary: Summary
  cashSeries: Series[]
  debtSeries: Series[]
  treasury: TreasuryRow[]
  narrative: string
  priorVals: Map<string, LineValues>
  generatedAt: string
  logoUrl: string
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const inline = (s: string) => esc(s)
  .replace(/__(.+?)__/g, '<u>$1</u>')
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/\*(.+?)\*/g, '<em>$1</em>')
const LEAD = ['Notable Improvements:', 'Notable Deteriorations:', 'Important Note:', 'Note:']
const boldLead = (s: string) => { for (const l of LEAD) if (s.startsWith(l)) return `<strong>${l}</strong>${s.slice(l.length)}`; return s }

function fig(n: number | null): string {
  const neg = n != null && n < 0
  return `<span class="${neg ? 'neg' : ''}">${fmtNum(n)}</span>`
}
function delta(n: number | null): string {
  if (n == null) return '—'
  return `<span class="${n < 0 ? 'neg' : ''}">${n > 0 ? '+' : ''}${fmtNum(n)}</span>`
}
function cardHtml(label: string, value: number | null, g = '', variant = ''): string {
  const neg = value != null && value < 0
  return `<div class="card ${variant} ${g ? `g-${g}` : ''}"><span class="cl">${esc(label)}</span><span class="cv ${neg ? 'neg' : ''}">${fmtNum(value)}</span></div>`
}

function narrativeHtml(text: string): string {
  const lines = (text || '').split(/\r?\n/)
  let html = '', list: 'ul' | 'ol' | null = null
  const close = () => { if (list) { html += `</${list}>`; list = null } }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { close(); continue }
    const b = /^[-*•]\s+(.*)/.exec(line), n = /^\d+[.)]\s+(.*)/.exec(line)
    if (b) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul' } html += `<li>${inline(b[1])}</li>` }
    else if (n) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol' } html += `<li>${inline(n[1])}</li>` }
    else { close(); html += `<p>${boldLead(inline(line))}</p>` }
  }
  close()
  return html || '<p class="muted">No narrative for this month.</p>'
}

const ML = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A bar chart with a labelled y-axis. `stackMtb` shades the MTB portion of
 *  each debt bar in a lighter tone so the facility is visible within the total. */
function chartSvg(series: Series[], color: string, selected: string, stackMtb = false): string {
  if (!series.length) return '<p class="muted">No data.</p>'
  const W = 380, H = 150, padT = 12, padB = 26, padL = 38, padR = 6
  const vals = series.map(d => d.val)
  const max = Math.max(0, ...vals), min = Math.min(0, ...vals)
  const range = max - min || 1
  const plotH = H - padT - padB, plotW = W - padL - padR
  const zeroY = padT + (max / range) * plotH
  const slot = plotW / series.length
  const bw = Math.min(22, slot * 0.6)
  const y = (v: number) => padT + ((max - v) / range) * plotH

  // y-axis ticks (nice-ish): 4 divisions across the range
  const ticks: number[] = []
  const step = niceStep(range / 4)
  let t = Math.ceil(min / step) * step
  for (; t <= max + 1e-6; t += step) ticks.push(Math.round(t))
  const axis = ticks.map(tv => {
    const yy = y(tv)
    return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="${tv === 0 ? '#94a3b8' : '#eef2f7'}" stroke-width="${tv === 0 ? 0.9 : 0.7}"/>
      <text x="${padL - 4}" y="${yy + 2.5}" class="cyax">${fmtNum(tv)}</text>`
  }).join('')

  const bars = series.map((d, i) => {
    const cx = padL + slot * i + slot / 2
    const top = y(Math.max(0, d.val)), bot = y(Math.min(0, d.val))
    const h = Math.max(1, bot - top)
    const isSel = d.period === selected
    const label = `${ML[Number(d.period.slice(5, 7))]}${d.period.slice(2, 4)}`
    let rects = `<rect x="${cx - bw / 2}" y="${top}" width="${bw}" height="${h}" fill="${color}" opacity="${isSel ? 1 : 0.42}" rx="1.5"/>`
    if (stackMtb && d.mtb && d.val < 0) {
      // MTB portion drawn from the zero line downward in a lighter shade
      const mtbH = Math.min(h, (Math.abs(d.mtb) / range) * plotH)
      rects += `<rect x="${cx - bw / 2}" y="${zeroY}" width="${bw}" height="${mtbH}" fill="#f59e0b" opacity="${isSel ? 0.95 : 0.4}" rx="1.5"/>`
    }
    const vlab = isSel ? `<text x="${cx}" y="${d.val >= 0 ? top - 3 : bot + 9}" class="cval">${fmtNum(d.val)}</text>` : ''
    return `${rects}${isSel ? `<rect x="${cx - bw / 2 - 1.5}" y="${top - 1.5}" width="${bw + 3}" height="${h + 3}" fill="none" stroke="${color}" stroke-width="1.1" rx="2"/>` : ''}
      <text x="${cx}" y="${H - padB + 12}" class="cx">${label}</text>${vlab}`
  }).join('')

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${axis}${bars}</svg>`
}
function niceStep(x: number): number {
  if (x <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(x)))
  const f = x / p
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p
}

export function buildReportHtml(d: ReportData): string {
  const s = d.summary
  // area table rows (summary grain): each area net, prior net, Δ
  const priorNet = (eid: string) => { const p = d.priorVals.get(eid); return p ? ccNet(p) : null }
  const areaRow = (name: string, v: LineValues, priorN: number | null, special = false) => {
    const net = ccNet(v)
    const dl = priorN == null ? null : net - priorN
    return `<tr class="${special ? 'special' : ''}"><td class="l">${esc(name)}</td>
      <td class="r">${fig(v.cc_cash)}</td><td class="r">${fig(v.cc_overdraft)}</td><td class="r">${fig(v.cc_loans)}</td>
      <td class="r">${fig(net)}</td><td class="r">${fig(v.free)}</td><td class="r">${fig(v.blocked)}</td><td class="r">${fig(v.jv_monies)}</td>
      <td class="r">${delta(dl)}</td></tr>`
  }
  const subRow = (name: string, v: LineValues, strong = false) =>
    `<tr class="sub ${strong ? 'strong' : ''}"><td class="l">${esc(name)}</td>
      <td class="r">${fig(v.cc_cash)}</td><td class="r">${fig(v.cc_overdraft)}</td><td class="r">${fig(v.cc_loans)}</td>
      <td class="r">${fig(ccNet(v))}</td><td class="r">${fig(v.free)}</td><td class="r">${fig(v.blocked)}</td><td class="r">${fig(v.jv_monies)}</td><td class="r"></td></tr>`

  // prior area net via rolled children: approximate using the same area's own+children prior is complex;
  // for the summary print we show prior net at area level using rolled prior values.
  const rolledPrior = (node: AreaNode): number | null => {
    const parts: LineValues[] = []
    const own = d.priorVals.get(node.entity.id); if (own) parts.push(own)
    for (const c of node.children) { const cv = d.priorVals.get(c.id); if (cv) parts.push(cv) }
    if (!parts.length) return null
    return parts.reduce((a, p) => a + ccNet(p), 0)
  }

  const rows = s.areaVals.map(a => areaRow(a.node.entity.name, a.v, rolledPrior(a.node))).join('')
    + (d.tree.mtb ? areaRow('MTB', s.mtbV, priorNet(d.tree.mtb.id), true) : '')
    + subRow('CC Group Total Actual', s.groupTotal, true)
    + d.tree.memo.map(m => areaRow(m.name, d.vals.get(m.id) || zeroLine(), priorNet(m.id), true)).join('')
    + subRow('Total (incl. Palestine)', s.total, true)

  const cards =
    cardHtml('Cash', s.operatingSum.cc_cash, 'build') +
    cardHtml('Overdraft', s.operatingSum.cc_overdraft, 'build') +
    cardHtml('Loans (excl MTB)', s.operatingSum.cc_loans, 'build') +
    cardHtml('MTB Loans', s.mtbV.cc_loans, 'build') +
    cardHtml('CC Group Total Actual', ccNet(s.groupTotal), 'build', 'total') +
    '<span class="cdiv"></span>' +
    cardHtml('Palestine', ccNet(s.palSum), 'group') +
    cardHtml('Total', ccNet(s.total), 'group', 'total') +
    '<span class="cdiv"></span>' +
    cardHtml('JV Money', s.jvMoney, 'free') +
    cardHtml('Money under CCC control', s.moneyControl, 'free', 'free') +
    cardHtml('Blocked Cash', s.blocked, 'free') +
    cardHtml("CCC's Free Usable Cash", s.freeUsable, 'free', 'free')

  const treRow = (t: TreasuryRow) =>
    `<tr><td class="l">${esc(t.label)}</td><td class="r">${t.flow === 'receipt' ? fmtNum(t.amount) : ''}</td><td class="r neg">${t.flow === 'payment' ? fmtNum(-t.amount) : ''}</td></tr>`
  const treRows = d.treasury.length
    ? d.treasury.map(treRow).join('')
    : '<tr><td class="l muted" colspan="3">No treasury detail recorded.</td></tr>'

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Group Cash Position — ${esc(fmtPeriodLabel(d.period))}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500&display=swap');
  @page { size: A4 landscape; margin: 5mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Rubik, system-ui, sans-serif; color: #141414; margin: 0; font-size: 9.2px; line-height: 1.3; }
  .head { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #E10020; padding-bottom: 5px; margin-bottom: 8px; }
  .hleft { display: flex; align-items: center; gap: 12px; }
  .logo { height: 30px; }
  .head h1 { font-size: 15px; font-weight: 500; margin: 0; }
  .head .ctx { color: #E10020; font-weight: 500; font-size: 11px; }
  .head .gen { font-size: 8px; color: #6b7280; text-align: right; }
  h2 { font-size: 9.3px; font-weight: 500; margin: 7px 0 4px; text-transform: uppercase; letter-spacing: 0.04em; color: #374151; }
  .cards { display: flex; gap: 5px; }
  .card { flex: 1 1 0; min-width: 0; border: 1px solid #e5e7eb; border-top: 2.5px solid #9ca3af; border-radius: 5px; padding: 5px 7px; display: flex; flex-direction: column; gap: 3px; }
  .card .cl { font-size: 6.6px; text-transform: uppercase; letter-spacing: 0.02em; color: #6b7280; font-weight: 500; }
  .card .cv { font-size: 12.5px; font-weight: 500; font-variant-numeric: tabular-nums; margin-top: auto; }
  .card .cv.neg { color: #E10020; }
  .card.g-build { border-top-color: #141414; }
  .card.g-group { border-top-color: #E10020; }
  .card.g-free { border-top-color: #057a55; }
  .card.total { background: #E10020; border-color: #E10020; }
  .card.total .cl { color: rgba(255,255,255,0.85); } .card.total .cv, .card.total .cv.neg { color: #fff; }
  .card.free { background: #ecfdf5; border-color: #6ee7b7; } .card.free .cl { color: #047857; } .card.free .cv { color: #065f46; } .card.free .cv.neg { color: #E10020; }
  .cdiv { width: 1px; align-self: stretch; background: #d1d5db; margin: 2px; }
  .charts { display: flex; gap: 12px; }
  .chartbox { flex: 1; border: 1px solid #e5e7eb; border-radius: 5px; padding: 6px 8px 2px; }
  .chartbox .ct { font-size: 8.4px; font-weight: 500; color: #374151; margin-bottom: 2px; display:flex; justify-content:space-between; }
  .chartbox .leg { font-size: 7px; color:#6b7280; font-weight:400; }
  .chartbox .leg b { color:#f59e0b; }
  .cx { font-size: 6.4px; fill: #6b7280; text-anchor: middle; }
  .cyax { font-size: 6px; fill: #94a3b8; text-anchor: end; }
  .cval { font-size: 7.4px; fill: #141414; font-weight: 500; text-anchor: middle; }
  .twocol { display: flex; gap: 14px; align-items: flex-start; }
  .twocol .tbl { flex: 1.7; } .twocol .side { flex: 1; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 2.3px 5px; border-bottom: 1px solid #eee; }
  th { font-size: 7.2px; text-transform: uppercase; letter-spacing: 0.02em; color: #6b7280; font-weight: 500; text-align: right; }
  th.l, td.l { text-align: left; width: 1%; white-space: nowrap; }
  td.r { text-align: right; }
  tr.special td.l { font-style: italic; color: #6b7280; }
  tr.sub td { border-top: 1px solid #141414; border-bottom: none; font-weight: 500; background: #f5f5f5; }
  tr.sub td.l { text-transform: uppercase; font-size: 7.2px; }
  tr.sub.strong td { border-top: 2px solid #141414; background: #ededed; }
  .neg { color: #E10020; } .muted { color: #9ca3af; }
  .narbox { background: #fafafa; border: 1px solid #eee; border-left: 3px solid #E10020; border-radius: 4px; padding: 8px 11px; color: #1f2937; font-size: 9.6px; line-height: 1.4; }
  .narbox p { margin: 4px 0; } .narbox ul, .narbox ol { margin: 4px 0 4px 15px; padding: 0; } .narbox li { margin: 3px 0; } .narbox li::marker { color: #E10020; } .narbox strong { font-weight: 500; }
</style></head>
<body>
  <div class="head">
    <div class="hleft"><img class="logo" src="${esc(d.logoUrl)}" alt="CCC"/>
      <div><h1>Group Cash Position</h1><div class="ctx">${esc(fmtPeriodLabel(d.period))}</div></div></div>
    <div class="gen">USD (000's)<br/>Generated ${esc(d.generatedAt)}</div>
  </div>

  <div class="cards">${cards}</div>

  <h2>Movement — last 12 months</h2>
  <div class="charts">
    <div class="chartbox"><div class="ct"><span>Cash</span></div>${chartSvg(d.cashSeries, '#141414', d.period)}</div>
    <div class="chartbox"><div class="ct"><span>Overdrafts &amp; Loans</span><span class="leg"><b>■</b> MTB facility</span></div>${chartSvg(d.debtSeries, '#E10020', d.period, true)}</div>
  </div>

  <div class="twocol">
    <div class="tbl">
      <h2>By area</h2>
      <table>
        <thead><tr><th class="l">Area</th><th>Cash</th><th>OD</th><th>Loans</th><th>CC Net</th><th>Free</th><th>Blocked</th><th>JV Monies</th><th>Δ</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="side">
      <h2>Treasury details</h2>
      <table>
        <thead><tr><th class="l">Source</th><th>Receipts</th><th>Payments</th></tr></thead>
        <tbody>${treRows}</tbody>
      </table>
      <h2>Narrative</h2>
      <div class="narbox">${narrativeHtml(d.narrative)}</div>
    </div>
  </div>
  <script>window.onload = function () { window.print(); };</script>
</body></html>`
}
