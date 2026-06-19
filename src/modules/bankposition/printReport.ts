/* Self-contained, single-page printable report for a bank-position month:
 * KPI summary, two movement charts (Cash, and Overdrafts+Loans), the area table
 * in Tony's order with his subtotal hierarchy, group items, and the narrative
 * (bullet/numbered lists). Opens in a new window and prints — no dependencies. */
import {
  AREA_ACCOUNTS,
  type Grid,
  areaNet,
  ccGroupNet,
  operatingAreas,
  fmtNum,
  fmtPeriodLabel,
  num,
} from './lib'

export interface Series {
  period: string
  val: number
}

export interface ReportData {
  period: string
  areas: string[]
  grid: Grid
  groupItems: Record<string, string>
  narrative: string
  priorNet: Record<string, number>
  cashSeries: Series[]
  debtSeries: Series[]
  generatedAt: string
  logoUrl: string
}

/* A headline card mirroring the on-screen layout. */
function cardHtml(
  label: string,
  value: number | null,
  variant: '' | 'total' | 'free' = '',
  group: '' | 'build' | 'group' | 'free' = '',
): string {
  const neg = value != null && value < 0
  return `<div class="card ${variant} ${group ? `g-${group}` : ''}"><span class="cl">${esc(label)}</span><span class="cv ${neg ? 'neg' : ''}">${fmtNum(value)}</span></div>`
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/* Escape, then render inline marks: __underline__, **bold**, *italic*. */
const inline = (s: string) =>
  esc(s)
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')

/* Auto-bold Tony's standard section labels at the start of a line. */
const LEAD_LABELS = ['Notable Improvements:', 'Notable Deteriorations:', 'Important Note:', 'Note:']
const boldLead = (s: string) => {
  for (const lab of LEAD_LABELS) {
    if (s.startsWith(lab)) return `<strong>${lab}</strong>${s.slice(lab.length)}`
  }
  return s
}

/** A figure span, negatives shown red and in parens (fmtNum adds the parens). */
function fig(n: number | null): string {
  const neg = n != null && n < 0
  return `<span class="${neg ? 'neg' : ''}">${fmtNum(n)}</span>`
}

function delta(n: number | null): string {
  if (n == null) return '—'
  return `<span class="${n < 0 ? 'neg' : ''}">${n > 0 ? '+' : ''}${fmtNum(n)}</span>`
}

function narrativeHtml(text: string): string {
  const lines = (text || '').split(/\r?\n/)
  let html = ''
  let list: 'ul' | 'ol' | null = null
  const close = () => {
    if (list) {
      html += `</${list}>`
      list = null
    }
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      close()
      continue
    }
    const bullet = /^[-*•]\s+(.*)/.exec(line)
    const number = /^\d+[.)]\s+(.*)/.exec(line)
    if (bullet) {
      if (list !== 'ul') {
        close()
        html += '<ul>'
        list = 'ul'
      }
      html += `<li>${inline(bullet[1])}</li>`
    } else if (number) {
      if (list !== 'ol') {
        close()
        html += '<ol>'
        list = 'ol'
      }
      html += `<li>${inline(number[1])}</li>`
    } else {
      close()
      html += `<p>${boldLead(inline(line))}</p>`
    }
  }
  close()
  return html || '<p class="muted">No narrative for this month.</p>'
}

const ML = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function chartSvg(series: Series[], color: string, selected: string): string {
  if (!series.length) return '<p class="muted">No data.</p>'
  const W = 360
  const H = 128
  const padT = 10
  const padB = 26
  const padX = 8
  const vals = series.map(d => d.val)
  const max = Math.max(0, ...vals)
  const min = Math.min(0, ...vals)
  const range = max - min || 1
  const plotH = H - padT - padB
  const zeroY = padT + (max / range) * plotH
  const slot = (W - padX * 2) / series.length
  const bw = Math.min(20, slot * 0.62)

  const bars = series
    .map(d => {
      const cx = padX + slot * series.indexOf(d) + slot / 2
      const h = (Math.abs(d.val) / range) * plotH
      const y = d.val >= 0 ? zeroY - h : zeroY
      const isSel = d.period === selected
      const label = `${ML[Number(d.period.slice(5, 7))]}${d.period.slice(2, 4)}`
      const valLabel = isSel
        ? `<text x="${cx}" y="${d.val >= 0 ? y - 3 : y + h + 9}" class="cval">${fmtNum(d.val)}</text>`
        : ''
      return `<rect x="${cx - bw / 2}" y="${y}" width="${bw}" height="${Math.max(1, h)}" fill="${color}" opacity="${isSel ? 1 : 0.4}" rx="1.5"/>
        ${isSel ? `<rect x="${cx - bw / 2 - 1.5}" y="${y - 1.5}" width="${bw + 3}" height="${Math.max(1, h) + 3}" fill="none" stroke="${color}" stroke-width="1.2" rx="2"/>` : ''}
        <text x="${cx}" y="${H - padB + 12}" class="cx">${label}</text>${valLabel}`
    })
    .join('')

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">
    <line x1="${padX}" y1="${zeroY}" x2="${W - padX}" y2="${zeroY}" stroke="#cbd5e1" stroke-width="0.8"/>
    ${bars}
  </svg>`
}

export function buildReportHtml(d: ReportData): string {
  const ops = operatingAreas(d.areas)
  const hasMtb = d.areas.includes('MTB Overdraft')
  const hasPal = d.areas.includes('Palestine')
  const groupNet = ccGroupNet(d.grid, d.areas)
  const mtb = hasMtb ? areaNet(d.grid, 'MTB Overdraft') : 0
  const pal = hasPal ? areaNet(d.grid, 'Palestine') : 0
  const groupWithMtb = groupNet + mtb
  const total = groupWithMtb + pal
  const jv = num(d.groupItems['JV Cash'])
  const blocked = num(d.groupItems['Blocked'])

  // card components (Σ over operating areas) + cash-availability waterfall
  const sum = (acct: string) => ops.reduce((s, a) => s + (num(d.grid[a]?.[acct]) ?? 0), 0)
  const cashTot = sum('Cash')
  const odTot = sum('Overdrafts')
  const loansTot = sum('Loans')
  const moneyControl = cashTot - (jv ?? 0)
  const freeUsable = moneyControl - (blocked ?? 0)

  const hasPrior = Object.keys(d.priorNet).length > 0
  const priorOp = ops.reduce((s, a) => s + (d.priorNet[a] ?? 0), 0)
  const priorWithMtb = priorOp + (d.priorNet['MTB Overdraft'] ?? 0)
  const priorTotal = priorWithMtb + (d.priorNet['Palestine'] ?? 0)

  const areaRow = (area: string, special = false) => {
    const net = areaNet(d.grid, area)
    const prev = d.priorNet[area]
    const dl = prev == null ? null : net - prev
    const cells = AREA_ACCOUNTS.map(acc => `<td class="r">${fig(num(d.grid[area]?.[acc]))}</td>`).join('')
    return `<tr class="${special ? 'special' : ''}"><td class="l">${esc(area)}</td>${cells}<td class="r">${fig(net)}</td><td class="r">${delta(dl)}</td></tr>`
  }
  const subRow = (label: string, value: number, prior: number, strong = false) =>
    `<tr class="sub ${strong ? 'strong' : ''}"><td class="l">${esc(label)}</td><td colspan="${AREA_ACCOUNTS.length}"></td><td class="r">${fig(value)}</td><td class="r">${delta(hasPrior ? value - prior : null)}</td></tr>`

  const rows =
    ops.map(a => areaRow(a)).join('') +
    subRow('CC Group total', groupNet, priorOp) +
    (hasMtb ? areaRow('MTB Overdraft', true) : '') +
    subRow('CC Group total incl. MTB', groupWithMtb, priorWithMtb) +
    (hasPal ? areaRow('Palestine', true) : '') +
    subRow('Total', total, priorTotal, true)

  const cards =
    cardHtml('Cash', cashTot, '', 'build') +
    cardHtml('Overdraft', odTot, '', 'build') +
    cardHtml('Loans', loansTot, '', 'build') +
    cardHtml('CC Group Total Actual', groupNet, 'total', 'build') +
    '<span class="cdiv"></span>' +
    cardHtml('MTB Loans', mtb, '', 'group') +
    cardHtml('Palestine', pal, '', 'group') +
    cardHtml('Total', total, 'total', 'group') +
    '<span class="cdiv"></span>' +
    cardHtml('JV Money', jv, '', 'free') +
    cardHtml('Money under CCC control', moneyControl, 'free', 'free') +
    cardHtml('Blocked Cash', blocked, '', 'free') +
    cardHtml("CCC's Free Usable Cash", freeUsable, 'free', 'free')

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Group Cash Position — ${esc(fmtPeriodLabel(d.period))}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500&display=swap');
  @page { size: A4 landscape; margin: 5mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { height: auto; }
  body { font-family: Rubik, system-ui, sans-serif; color: #141414; margin: 0; font-size: 9.4px; line-height: 1.32; }
  .head { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #E10020; padding-bottom: 5px; margin-bottom: 8px; }
  .hleft { display: flex; align-items: center; gap: 12px; }
  .logo { height: 30px; width: auto; }
  .head h1 { font-size: 15px; font-weight: 500; margin: 0; }
  .head .ctx { color: #E10020; font-weight: 500; font-size: 11px; }
  .head .gen { font-size: 8px; color: #6b7280; text-align: right; }
  h2 { font-size: 9.5px; font-weight: 500; margin: 7px 0 4px; text-transform: uppercase; letter-spacing: 0.04em; color: #374151; }
  .cards { display: flex; gap: 5px; align-items: stretch; }
  .card { flex: 1 1 0; min-width: 0; border: 1px solid #e5e7eb; border-top: 2.5px solid #9ca3af; border-radius: 5px; padding: 5px 7px; display: flex; flex-direction: column; gap: 3px; }
  .card .cl { font-size: 7px; text-transform: uppercase; letter-spacing: 0.02em; color: #6b7280; font-weight: 500; line-height: 1.2; }
  .card .cv { font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; margin-top: auto; }
  .card .cv.neg { color: #E10020; }
  .card.g-build { border-top-color: #141414; }
  .card.g-group { border-top-color: #E10020; }
  .card.g-free { border-top-color: #057a55; }
  .card.total { background: #E10020; border-color: #E10020; border-top-color: #E10020; }
  .card.total .cl { color: rgba(255,255,255,0.85); }
  .card.total .cv, .card.total .cv.neg { color: #fff; }
  .card.free { background: #ecfdf5; border-color: #6ee7b7; border-top-color: #057a55; }
  .card.free .cl { color: #047857; }
  .card.free .cv { color: #065f46; }
  .card.free .cv.neg { color: #E10020; }
  .cdiv { flex: 0 0 auto; width: 1px; align-self: stretch; background: #d1d5db; margin: 2px 2px; }
  .charts { display: flex; gap: 12px; }
  .chartbox { flex: 1; border: 1px solid #e5e7eb; border-radius: 5px; padding: 6px 8px 2px; }
  .chartbox .ct { font-size: 8.5px; font-weight: 500; color: #374151; margin-bottom: 2px; }
  .cx { font-size: 6.5px; fill: #6b7280; text-anchor: middle; }
  .cval { font-size: 7.5px; fill: #141414; font-weight: 500; text-anchor: middle; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 2.6px 6px; border-bottom: 1px solid #eee; }
  th { font-size: 7.8px; text-transform: uppercase; letter-spacing: 0.03em; color: #6b7280; font-weight: 500; text-align: right; }
  th.l, td.l { text-align: left; padding-left: 4px; padding-right: 3px; width: 1%; white-space: nowrap; }
  td.r { text-align: right; }
  tr.special td.l { font-style: italic; color: #6b7280; }
  tr.sub td { border-top: 1px solid #141414; border-bottom: none; font-weight: 500; background: #f5f5f5; }
  tr.sub td.l { text-transform: uppercase; font-size: 7.6px; letter-spacing: 0.02em; }
  tr.sub.strong td { border-top: 2px solid #141414; background: #ededed; }
  .neg { color: #E10020; }
  .muted { color: #9ca3af; }
  .twocol { display: flex; gap: 18px; align-items: flex-start; }
  .twocol .tbl { flex: 1.4; }
  .twocol .nar { flex: 1.15; }
  .narbox { background: #fafafa; border: 1px solid #eee; border-left: 3px solid #E10020; border-radius: 4px; padding: 10px 13px; color: #1f2937; font-size: 11px; line-height: 1.42; }
  .narbox p { margin: 5px 0; }
  .narbox p:first-child { margin-top: 0; }
  .narbox ul, .narbox ol { margin: 5px 0 5px 17px; padding: 0; }
  .narbox li { margin: 3.5px 0; line-height: 1.45; padding-left: 2px; }
  .narbox li::marker { color: #E10020; }
  .narbox strong { font-weight: 500; }
</style></head>
<body>
  <div class="head">
    <div class="hleft">
      <img class="logo" src="${esc(d.logoUrl)}" alt="CCC"/>
      <div><h1>Group Cash Position</h1><div class="ctx">${esc(fmtPeriodLabel(d.period))}</div></div>
    </div>
    <div class="gen">USD (000's)<br/>Generated ${esc(d.generatedAt)}</div>
  </div>

  <div class="cards">${cards}</div>

  <h2>Movement — last 12 months</h2>
  <div class="charts">
    <div class="chartbox"><div class="ct">Cash</div>${chartSvg(d.cashSeries.slice(-12), '#141414', d.period)}</div>
    <div class="chartbox"><div class="ct">Overdrafts &amp; Loans</div>${chartSvg(d.debtSeries.slice(-12), '#E10020', d.period)}</div>
  </div>

  <div class="twocol">
    <div class="tbl">
      <h2>By area</h2>
      <table>
        <thead><tr><th class="l">Area</th>${AREA_ACCOUNTS.map(a => `<th>${a}</th>`).join('')}<th>Net</th><th>Δ</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="nar">
      <h2>Narrative</h2>
      <div class="narbox">${narrativeHtml(d.narrative)}</div>
    </div>
  </div>

  <script>window.onload = function () { window.print(); };</script>
</body></html>`
}
