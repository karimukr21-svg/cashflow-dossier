import type { NarrativeData } from './Narrative'

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
  const consumed = d.netYTD < 0
  const projUp = (d.yearEnd ?? 0) >= (d.opening ?? 0)

  const beat = (n: string, lead: string, value: number | null, accent: string, tail: string) => `
    <div class="beat">
      <div class="bn">${n}</div>
      <div class="bb"><span class="lead">${lead} </span><span class="val ${accent}">${fmt(value)}</span><span class="lead"> ${tail}</span></div>
    </div>`

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
  .foot { margin-top: 22px; padding-top: 8px; border-top: 1px solid #e5e7eb; font-size: 8.5px; color: #9ca3af; }
</style></head><body>
  <div class="head">
    <div class="brand">CCC · Treasury</div>
    <h1>The cash flow story — ${ctx.scopeLabel}</h1>
    <div class="sub">Year ${ctx.year} · actuals through ${ctx.asOfLabel}, forecast to year-end · ${unitLine}</div>
  </div>

  ${beat('01', 'We started the year with', d.opening, 'ink', 'in cash on hand.')}
  ${beat('02', `Across ${ctx.year} we expect to bring in`, d.recvFull, 'pos', 'from operations, claims and financing.')}
  ${beat('03', 'And we have liabilities to pay of', -Math.abs(d.payFull), 'neg', 'over the same year.')}
  <div class="divider"><span>So far (${ctx.asOfLabel})</span></div>
  ${beat('04', 'We have actually received', d.recvYTD, 'pos', `— ${pct(d.recvYTD, d.recvFull)} of the year's expected inflow.`)}
  ${beat('05', 'And we have actually paid', -Math.abs(d.payYTD), 'neg', `— ${pct(Math.abs(d.payYTD), Math.abs(d.payFull))} of the year's liabilities.`)}
  ${beat('06', consumed ? 'Our net position has fallen by' : 'Our net position has risen by', d.netYTD, consumed ? 'neg' : 'pos', consumed ? 'over the period — funded from cash and borrowing.' : 'over the period — the period generated cash.')}
  <div class="divider"><span>Looking ahead</span></div>
  ${beat('07', 'For the rest of the year we still expect to net', d.netRem, d.netRem < 0 ? 'neg' : 'pos', `, ending ${ctx.year} at a projected cash position of`)}

  <div class="bottomline">
    <div class="bl-label">Projected year-end cash</div>
    <div class="bl-value ${projUp ? 'pos' : 'neg'}">${fmt(d.yearEnd)}</div>
    <div class="bl-note">from ${fmt(d.opening)} at the start of ${ctx.year} — a ${projUp ? 'rise' : 'drawdown'} of ${fmt(Math.abs((d.yearEnd ?? 0) - (d.opening ?? 0)))}.</div>
  </div>

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
