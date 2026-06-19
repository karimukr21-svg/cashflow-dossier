/* Self-contained printable report for a bank-position month: KPI summary, the
 * area × account table, group items, the narrative (with bullet/numbered lists),
 * and an inline-SVG chart of the CC Group net movement across months. Opens in a
 * new window and triggers print — no dependencies, prints/saves to PDF cleanly. */
import {
  AREA_ACCOUNTS,
  GROUP_ACCOUNTS,
  EXCLUDED_FROM_GROUP,
  type Grid,
  areaNet,
  ccGroupNet,
  fmtNum,
  fmtPeriodLabel,
} from './lib'

export interface ReportData {
  period: string
  areas: string[]
  grid: Grid
  groupItems: Record<string, string>
  narrative: string
  priorNet: Record<string, number>
  monthly: { period: string; net: number }[]
  generatedAt: string
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A figure span, negatives in red parens (fmtNum already adds the parens). */
function fig(n: number | null): string {
  const neg = n != null && n < 0
  return `<span class="${neg ? 'neg' : ''}">${fmtNum(n)}</span>`
}

function num(s: string | undefined): number | null {
  if (s == null || s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
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
      html += `<li>${esc(bullet[1])}</li>`
    } else if (number) {
      if (list !== 'ol') {
        close()
        html += '<ol>'
        list = 'ol'
      }
      html += `<li>${esc(number[1])}</li>`
    } else {
      close()
      html += `<p>${esc(line)}</p>`
    }
  }
  close()
  return html || '<p class="muted">No narrative for this month.</p>'
}

function chartSvg(monthly: { period: string; net: number }[], selected: string): string {
  if (!monthly.length) return '<p class="muted">No data to chart.</p>'
  const W = 760
  const H = 260
  const padT = 16
  const padB = 46
  const padX = 12
  const vals = monthly.map(d => d.net)
  const max = Math.max(0, ...vals)
  const min = Math.min(0, ...vals)
  const range = max - min || 1
  const plotH = H - padT - padB
  const zeroY = padT + (max / range) * plotH
  const slot = (W - padX * 2) / monthly.length
  const bw = Math.min(38, slot * 0.6)

  const bars = monthly
    .map((d, i) => {
      const cx = padX + slot * i + slot / 2
      const h = (Math.abs(d.net) / range) * plotH
      const y = d.net >= 0 ? zeroY - h : zeroY
      const isSel = d.period === selected
      const fill = d.net < 0 ? '#E10020' : '#141414'
      const [, mm] = d.period.split('-')
      const yr = d.period.slice(2, 4)
      const ML = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const label = `${ML[Number(mm)]} ${yr}`
      const valLabel = isSel ? `<text x="${cx}" y="${(d.net >= 0 ? y - 5 : y + h + 13)}" class="cval">${fmtNum(d.net)}</text>` : ''
      return `
        <rect x="${cx - bw / 2}" y="${y}" width="${bw}" height="${Math.max(1, h)}"
              fill="${fill}" opacity="${isSel ? 1 : 0.42}" rx="2" />
        ${isSel ? `<rect x="${cx - bw / 2 - 2}" y="${y - 2}" width="${bw + 4}" height="${Math.max(1, h) + 4}" fill="none" stroke="#E10020" stroke-width="1.4" rx="3"/>` : ''}
        <text x="${cx}" y="${H - padB + 16}" class="cx">${label}</text>
        ${valLabel}`
    })
    .join('')

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">
    <line x1="${padX}" y1="${zeroY}" x2="${W - padX}" y2="${zeroY}" stroke="#cbd5e1" stroke-width="1"/>
    ${bars}
  </svg>`
}

export function buildReportHtml(d: ReportData): string {
  const groupNet = ccGroupNet(d.grid, d.areas)
  const jv = num(d.groupItems['JV Cash'])
  const blocked = num(d.groupItems['Blocked'])
  const mtb = d.areas.includes('MTB Overdraft') ? areaNet(d.grid, 'MTB Overdraft') : null
  const pal = d.areas.includes('Palestine') ? areaNet(d.grid, 'Palestine') : null

  const rows = d.areas
    .map(area => {
      const net = areaNet(d.grid, area)
      const prev = d.priorNet[area]
      const delta = prev == null ? null : net - prev
      const cells = AREA_ACCOUNTS.map(acc => `<td class="r">${fig(num(d.grid[area]?.[acc]))}</td>`).join('')
      const special = EXCLUDED_FROM_GROUP.includes(area)
      const deltaCell =
        delta == null ? '—' : `<span class="${delta < 0 ? 'neg' : ''}">${delta > 0 ? '+' : ''}${fmtNum(delta)}</span>`
      return `<tr class="${special ? 'special' : ''}">
        <td class="l">${esc(area)}</td>${cells}
        <td class="r">${fig(net)}</td><td class="r">${deltaCell}</td></tr>`
    })
    .join('')

  const kpi = (label: string, n: number | null) =>
    `<div class="kpi"><div class="kl">${label}</div><div class="kv">${fig(n)}</div></div>`

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Group Cash Position — ${esc(fmtPeriodLabel(d.period))}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500&display=swap');
  * { box-sizing: border-box; }
  body { font-family: Rubik, system-ui, sans-serif; color: #141414; margin: 0; padding: 28px 32px; font-size: 12.5px; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #E10020; padding-bottom: 10px; margin-bottom: 18px; }
  .head h1 { font-size: 19px; font-weight: 500; margin: 0; }
  .head .ctx { color: #E10020; font-weight: 500; }
  .head .gen { font-size: 11px; color: #6b7280; text-align: right; }
  h2 { font-size: 13px; font-weight: 500; margin: 22px 0 8px; }
  .kpis { display: flex; gap: 10px; margin-bottom: 6px; }
  .kpi { flex: 1; border: 1px solid #e5e7eb; border-radius: 6px; padding: 9px 11px; }
  .kpi.lead { border-color: #141414; }
  .kl { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
  .kv { font-size: 17px; font-weight: 500; font-variant-numeric: tabular-nums; margin-top: 3px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 5px 9px; border-bottom: 1px solid #eee; }
  th { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; font-weight: 500; text-align: right; }
  th.l, td.l { text-align: left; }
  td.r { text-align: right; }
  tr.special td.l { font-style: italic; color: #6b7280; }
  tr.total td { border-top: 2px solid #141414; font-weight: 500; }
  .neg { color: #E10020; }
  .muted { color: #9ca3af; }
  ul, ol { margin: 4px 0 4px 18px; padding: 0; }
  li { margin: 2px 0; }
  .narrative p { margin: 5px 0; }
  .chart { border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; }
  .cx { font-size: 9px; fill: #6b7280; text-anchor: middle; }
  .cval { font-size: 10px; fill: #141414; font-weight: 500; text-anchor: middle; }
  @media print { body { padding: 0; } .chart, .kpi, table { break-inside: avoid; } }
</style></head>
<body>
  <div class="head">
    <div><h1>Group Cash Position</h1><div class="ctx">${esc(fmtPeriodLabel(d.period))}</div></div>
    <div class="gen">Generated ${esc(d.generatedAt)}</div>
  </div>

  <div class="kpis">
    <div class="kpi lead"><div class="kl">CC Group net</div><div class="kv">${fig(groupNet)}</div></div>
    ${kpi('JV Cash', jv)}${kpi('Blocked', blocked)}${kpi('MTB Overdraft', mtb)}${kpi('Palestine', pal)}
  </div>

  <h2>CC Group net — movement by month</h2>
  <div class="chart">${chartSvg(d.monthly, d.period)}</div>

  <h2>By area</h2>
  <table>
    <thead><tr><th class="l">Area</th>${AREA_ACCOUNTS.map(a => `<th>${a}</th>`).join('')}<th>Net</th><th>Δ MoM</th></tr></thead>
    <tbody>
      ${rows}
      <tr class="total"><td class="l">CC Group net</td><td colspan="${AREA_ACCOUNTS.length}"></td><td class="r">${fig(groupNet)}</td><td></td></tr>
    </tbody>
  </table>

  <h2>Group items</h2>
  <table><tbody>
    ${GROUP_ACCOUNTS.map(a => `<tr><td class="l">${a}</td><td class="r">${fig(num(d.groupItems[a]))}</td></tr>`).join('')}
  </tbody></table>

  <h2>Narrative</h2>
  <div class="narrative">${narrativeHtml(d.narrative)}</div>

  <script>window.onload = function () { window.print(); };</script>
</body></html>`
}
