/* Self-contained, single-page printable report for a bank-position month:
 * KPI summary, two movement charts (Cash, and Overdrafts+Loans), the area table
 * in Tony's order with his subtotal hierarchy, group items, and the narrative
 * (bullet/numbered lists). Opens in a new window and prints — no dependencies. */
import {
  AREA_ACCOUNTS,
  GROUP_ACCOUNTS,
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
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/* Escape, then render inline marks: __underline__, **bold**, *italic*. */
const inline = (s: string) =>
  esc(s)
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')

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
      html += `<p>${inline(line)}</p>`
    }
  }
  close()
  return html || '<p class="muted">No narrative for this month.</p>'
}

const ML = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function chartSvg(series: Series[], color: string, selected: string): string {
  if (!series.length) return '<p class="muted">No data.</p>'
  const W = 360
  const H = 150
  const padT = 12
  const padB = 30
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

  const kpi = (label: string, n: number | null, lead = false) =>
    `<div class="kpi ${lead ? 'lead' : ''}"><div class="kl">${label}</div><div class="kv">${fig(n)}</div></div>`

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Group Cash Position — ${esc(fmtPeriodLabel(d.period))}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500&display=swap');
  @page { size: A4 portrait; margin: 9mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Rubik, system-ui, sans-serif; color: #141414; margin: 0; font-size: 8.6px; line-height: 1.32; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #E10020; padding-bottom: 6px; margin-bottom: 10px; }
  .head h1 { font-size: 15px; font-weight: 500; margin: 0; }
  .head .ctx { color: #E10020; font-weight: 500; font-size: 11px; }
  .head .gen { font-size: 8px; color: #6b7280; text-align: right; }
  h2 { font-size: 9.5px; font-weight: 500; margin: 12px 0 5px; text-transform: uppercase; letter-spacing: 0.04em; color: #374151; }
  .kpis { display: flex; gap: 7px; }
  .kpi { flex: 1; border: 1px solid #e5e7eb; border-radius: 5px; padding: 6px 8px; }
  .kpi.lead { border-color: #141414; }
  .kl { font-size: 7.5px; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; }
  .kv { font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .charts { display: flex; gap: 12px; }
  .chartbox { flex: 1; border: 1px solid #e5e7eb; border-radius: 5px; padding: 6px 8px 2px; }
  .chartbox .ct { font-size: 8.5px; font-weight: 500; color: #374151; margin-bottom: 2px; }
  .cx { font-size: 6.5px; fill: #6b7280; text-anchor: middle; }
  .cval { font-size: 7.5px; fill: #141414; font-weight: 500; text-anchor: middle; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 2.6px 7px; border-bottom: 1px solid #eee; }
  th { font-size: 7.2px; text-transform: uppercase; letter-spacing: 0.03em; color: #6b7280; font-weight: 500; text-align: right; }
  th.l, td.l { text-align: left; }
  td.r { text-align: right; }
  tr.special td.l { font-style: italic; color: #6b7280; }
  tr.sub td { border-top: 1px solid #141414; border-bottom: none; font-weight: 500; background: #f5f5f5; }
  tr.sub td.l { text-transform: uppercase; font-size: 7.6px; letter-spacing: 0.03em; }
  tr.sub.strong td { border-top: 2px solid #141414; background: #ededed; }
  .neg { color: #E10020; }
  .muted { color: #9ca3af; }
  .twocol { display: flex; gap: 16px; align-items: flex-start; }
  .twocol .tbl { flex: 1.35; }
  .twocol .nar { flex: 1; }
  ul, ol { margin: 3px 0 3px 15px; padding: 0; }
  li { margin: 1.5px 0; }
  .nar p { margin: 3px 0; }
  .grp { display: flex; gap: 22px; }
  .grp .gi { font-size: 9px; }
  .grp .gi b { font-weight: 500; }
</style></head>
<body>
  <div class="head">
    <div><h1>Group Cash Position</h1><div class="ctx">${esc(fmtPeriodLabel(d.period))}</div></div>
    <div class="gen">USD (000's)<br/>Generated ${esc(d.generatedAt)}</div>
  </div>

  <div class="kpis">
    ${kpi('CC Group total', groupNet, true)}${kpi('incl. MTB', groupWithMtb)}${kpi('Total', total)}${kpi('JV Cash', jv)}${kpi('Blocked', blocked)}
  </div>

  <h2>Movement by month</h2>
  <div class="charts">
    <div class="chartbox"><div class="ct">Cash</div>${chartSvg(d.cashSeries, '#141414', d.period)}</div>
    <div class="chartbox"><div class="ct">Overdrafts &amp; Loans</div>${chartSvg(d.debtSeries, '#E10020', d.period)}</div>
  </div>

  <div class="twocol">
    <div class="tbl">
      <h2>By area</h2>
      <table>
        <thead><tr><th class="l">Area</th>${AREA_ACCOUNTS.map(a => `<th>${a}</th>`).join('')}<th>Net</th><th>Δ</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="grp">
        ${GROUP_ACCOUNTS.map(a => `<div class="gi">${a}: <b>${fmtNum(num(d.groupItems[a]))}</b></div>`).join('')}
      </div>
    </div>
    <div class="nar">
      <h2>Narrative</h2>
      <div>${narrativeHtml(d.narrative)}</div>
    </div>
  </div>

  <script>window.onload = function () { window.print(); };</script>
</body></html>`
}
