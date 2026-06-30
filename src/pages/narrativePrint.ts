import type { NarrativeData } from './Narrative'
import { buildBridgeSvg } from './narrativeBridge'

/* Self-contained printable version of the cash-flow narrative.
 * Mirrors NarrativeBody. Opens in a new window and auto-prints (A4 portrait,
 * follows the bankposition/allocations print pattern). */

/* Figures display in millions of native currency (mirrors the on-screen body). */
const fmt = (v: number | null | undefined): string => {
  if (v == null || isNaN(v)) return '—'
  const r = Math.round((v / 1e6) * 10) / 10
  if (r === 0) return '—'
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return r < 0 ? `(${s})` : s
}
const pct = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 100)}%` : '—'

export function buildNarrativeHtml(
  d: NarrativeData,
  ctx: { scopeLabel: string; year: number; asOfLabel: string; mode: 'group' | 'area'; currency: string },
): string {
  const unitLine = ctx.mode === 'group'
    ? 'figures in millions · native currencies summed — USD consolidation via the FX layer is in progress'
    : `figures in ${ctx.currency || 'local currency'} millions`

  const beat = (n: string, lead: string, value: number | null, accent: string, tail: string,
                value2?: number | null, accent2?: string, tail2?: string) => `
    <div class="beat">
      <div class="bn">${n}</div>
      <div class="bb"><span class="lead">${lead} </span><span class="val ${accent}">${fmt(value)}</span><span class="lead"> ${tail}</span>${
        value2 !== undefined ? ` <span class="val ${accent2}">${fmt(value2)}</span><span class="lead"> ${tail2}</span>` : ''
      }</div>
    </div>`

  const posTable = `
    <table class="postable"><thead><tr><th></th><th>Started ${ctx.year}</th><th>Now (${ctx.asOfLabel})</th><th>Year-end ${ctx.year}</th></tr></thead>
    <tbody>
      <tr><td>Cash on hand</td><td class="${cls(d.opening)}">${fmt(d.opening)}</td><td class="${cls(d.now)}">${fmt(d.now)}</td><td class="${cls(d.yearEnd)}">${fmt(d.yearEnd)}</td></tr>
      <tr><td>Liabilities (loans + overdrafts)</td><td class="num neg">${fmt(-Math.abs(d.debtOpen))}</td><td class="num neg">${fmt(-Math.abs(d.debtNow))}</td><td class="num neg">${fmt(-Math.abs(d.debtEnd))}</td></tr>
      <tr class="pt-net"><td>Net funds</td><td class="${cls(d.nfOpen)}">${fmt(d.nfOpen)}</td><td class="${cls(d.nfNow)}">${fmt(d.nfNow)}</td><td class="${cls(d.nfEnd)}">${fmt(d.nfEnd)}</td></tr>
    </tbody></table>
    <div class="pos-note">Net funds = cash − liabilities · reconciling to Treasury's net-funds-per-area basis</div>`

  const bars = (items: { label: string; value: number }[], tone: string) => {
    const max = Math.max(1, ...items.map(i => Math.abs(i.value)))
    if (!items.length) return '<div class="empty">No data.</div>'
    return items.map(i => `
      <div class="bar-row">
        <div class="bar-label">${i.label}</div>
        <div class="bar-track"><div class="bar-fill ${tone}" style="width:${(Math.abs(i.value) / max) * 100}%"></div></div>
        <div class="bar-val ${tone}">${fmt(Math.abs(i.value))}</div>
      </div>`).join('')
  }

  const areaRows = d.byArea.map(a => `
    <tr><td>${a.name}</td>
      <td class="${cls(a.opening)}">${fmt(a.opening)}</td>
      <td class="${cls(a.netYTD)}">${fmt(a.netYTD)}</td>
      <td class="${cls(a.yearEnd)}">${fmt(a.yearEnd)}</td></tr>`).join('')

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Cash Flow Story — ${ctx.scopeLabel}</title>
<style>
  @page { size: A4 portrait; margin: 14mm 14mm 12mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1f2b; font-size: 12px; }
  .head { border-bottom: 2.5px solid #E10020; padding-bottom: 8px; margin-bottom: 16px; }
  .brand { font-size: 10px; font-weight: 700; letter-spacing: 1px; color: #E10020; text-transform: uppercase; }
  h1 { font-size: 20px; margin: 3px 0 2px; }
  .sub { font-size: 10.5px; color: #6b7280; }
  .beat { display: flex; gap: 12px; padding: 7px 0; border-bottom: 1px solid #f0f1f3; }
  .bn { font-size: 11px; font-weight: 700; color: #E10020; min-width: 22px; padding-top: 2px; }
  .bb { font-size: 14px; line-height: 1.5; }
  .lead { color: #374151; }
  .val { font-weight: 700; font-size: 16px; }
  .val.pos, .num.pos { color: #1a1f2b; }
  .val.neg, .num.neg { color: #E10020; }
  .val.ink { color: #1a1f2b; }
  .divider { display: flex; align-items: center; gap: 10px; margin: 12px 0 4px; }
  .divider span { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #9ca3af; }
  .divider:after { content: ""; flex: 1; height: 1px; background: #e5e7eb; }
  .bottomline { margin-top: 14px; padding: 12px 16px; background: #fafafa; border-left: 3px solid #E10020; border-radius: 5px; }
  .bl-label { font-size: 9px; text-transform: uppercase; letter-spacing: .6px; color: #6b7280; font-weight: 600; }
  .bl-value { font-size: 26px; font-weight: 700; margin: 2px 0; }
  .bl-note { font-size: 10.5px; color: #6b7280; }
  .where { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; margin-top: 20px; page-break-inside: avoid; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: #E10020; margin-bottom: 8px; }
  h3 span { color: #9ca3af; font-weight: 500; text-transform: none; letter-spacing: 0; font-size: 9.5px; }
  .bar-row { display: grid; grid-template-columns: 92px 1fr 64px; align-items: center; gap: 7px; margin-bottom: 5px; }
  .bar-label { font-size: 10px; color: #374151; }
  .bar-track { height: 11px; background: #f0f1f3; border-radius: 3px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; }
  .bar-fill.neg { background: #E10020; }
  .bar-fill.pos { background: #1a8a4a; }
  .bar-val { font-size: 10px; text-align: right; font-variant-numeric: tabular-nums; }
  .bar-val.pos { color: #1a8a4a; } .bar-val.neg { color: #E10020; }
  .empty { font-size: 10px; color: #9ca3af; }
  .byarea { margin-top: 20px; page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  th { text-align: right; font-size: 8.5px; text-transform: uppercase; letter-spacing: .4px; color: #6b7280; padding: 3px 7px; border-bottom: 1px solid #d1d5db; }
  th:first-child { text-align: left; }
  td { text-align: right; padding: 2.4px 7px; font-variant-numeric: tabular-nums; }
  td:first-child { text-align: left; }
  .num { color: #1a1f2b; }
  .bridge { margin: 6px 0 14px; }
  .bridge svg { display: block; width: 100%; }
  .postable { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 16px; }
  .postable th { text-align: right; font-size: 8px; text-transform: uppercase; letter-spacing: .5px; color: #6b7280; padding: 3px 10px; border-bottom: 1px solid #d1d5db; }
  .postable th:first-child { text-align: left; }
  .postable td { text-align: right; padding: 4px 10px; font-variant-numeric: tabular-nums; }
  .postable td:first-child { text-align: left; color: #374151; }
  .postable tr.pt-net td { font-weight: 700; font-size: 14px; border-top: 2px solid #1a1f2b; padding-top: 6px; }
  .pos-note { font-size: 8.5px; color: #9ca3af; margin: -10px 0 4px; }
  .foot { margin-top: 22px; padding-top: 8px; border-top: 1px solid #e5e7eb; font-size: 8.5px; color: #9ca3af; }
</style></head><body>
  <div class="head">
    <div class="brand">CCC · Treasury</div>
    <h1>The cash flow story — ${ctx.scopeLabel}</h1>
    <div class="sub">Year ${ctx.year} · actuals through ${ctx.asOfLabel}, forecast to year-end · ${unitLine}</div>
  </div>

  <div class="bridge">${buildBridgeSvg(d)}</div>
  ${posTable}

  ${beat('01', 'We started the year with', d.opening, 'ink', 'in cash, against borrowings of', -Math.abs(d.debtOpen), 'neg', '.')}
  ${beat('02', `Across ${ctx.year} we expect to bring in`, d.recvFull, 'pos', 'and to pay out', -Math.abs(d.payFull), 'neg', '.')}
  <div class="divider"><span>So far (${ctx.asOfLabel})</span></div>
  ${beat('03', 'We have received', d.recvYTD, 'pos', `(${pct(d.recvYTD, d.recvFull)} of the year) and paid`, -Math.abs(d.payYTD), 'neg', `(${pct(Math.abs(d.payYTD), Math.abs(d.payFull))}).`)}
  ${beat('04', 'Cash has', d.netYTD, d.netYTD < 0 ? 'neg' : 'pos', 'and borrowings have moved by', d.debtNow - d.debtOpen, (d.debtNow - d.debtOpen) > 0 ? 'neg' : 'pos', `— net funds ${d.nfNow < d.nfOpen ? 'worsened' : 'improved'} to ${fmt(d.nfNow)}.`)}
  <div class="divider"><span>Looking ahead</span></div>
  ${beat('05', 'For the rest of the year we expect to net', d.netRem, d.netRem < 0 ? 'neg' : 'pos', 'and to settle borrowings to', -Math.abs(d.debtEnd), 'neg', `, ending ${ctx.year} at net funds of ${fmt(d.nfEnd)}.`)}

  <div class="where">
    <div><h3>Where the money goes <span>· payments, full year</span></h3>${bars(d.paySections, 'neg')}</div>
    <div><h3>Where it comes from <span>· receipts, full year</span></h3>${bars(d.recvSections, 'pos')}</div>
  </div>

  ${ctx.mode === 'group' && d.byArea.length ? `
  <div class="byarea">
    <h3>By area <span>· net cash movement so far (${ctx.asOfLabel})</span></h3>
    <table><thead><tr><th>Area</th><th>Opened ${ctx.year}</th><th>Net so far</th><th>Proj. year-end</th></tr></thead>
    <tbody>${areaRows}</tbody></table>
  </div>` : ''}

  <div class="foot">Source: canonical project-grain cash-flow store · reconciled to the Treasury consolidated master.${ctx.mode === 'group' ? ' Group figures sum native-currency areas — USD consolidation via the FX layer is in progress.' : ''}</div>

  <script>window.onload = function () { window.print(); };</script>
</body></html>`
}

function cls(v: number | null): string {
  if (v == null || v === 0) return 'num'
  return v < 0 ? 'num neg' : 'num pos'
}
