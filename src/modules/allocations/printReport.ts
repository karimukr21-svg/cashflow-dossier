/* CCC-branded, self-contained printable statements for the Allocations module.
 * Opens a new window and auto-prints. Three readouts:
 *   - Source & Use statement (a period): inflows → uses + unallocated, and
 *     obligations → funders + outstanding.
 *   - Single inflow statement.
 *   - Single obligation statement.
 * Mirrors the bank-position print styling (Rubik, crimson #E10020, A4). */
import {
  deriveInflow, deriveObligation, computeTotals,
  usd, money, fmtDate, labelSourceType, labelCategory,
  type LedgerData, type PeriodRange, type Inflow, type Obligation,
} from './lib'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function periodLabel(r: PeriodRange): string {
  if (!r.from && !r.to) return 'All time'
  return `${r.from ? fmtDate(r.from) : 'Start'} → ${r.to ? monthEnd(r.to) : 'Now'}`
}
function monthEnd(d: string): string {
  // d is 'YYYY-MM-31' sentinel from the picker; show the month
  const [y, m] = d.split('-')
  const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${MONTHS[Number(m)] || ''} ${y}`
}

const STYLE = `
  @import url('https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500&display=swap');
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Rubik, system-ui, sans-serif; color: #141414; margin: 0; font-size: 10px; line-height: 1.4; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #E10020; padding-bottom: 8px; margin-bottom: 14px; }
  .head h1 { font-size: 17px; font-weight: 500; margin: 0; }
  .head .ctx { color: #E10020; font-weight: 500; font-size: 12px; margin-top: 2px; }
  .head .gen { font-size: 8.5px; color: #6b7280; text-align: right; }
  h2 { font-size: 10.5px; font-weight: 500; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: 0.04em; color: #374151; }
  .kpis { display: flex; gap: 8px; margin-bottom: 4px; }
  .kpi { flex: 1; border: 1px solid #e5e7eb; border-radius: 5px; padding: 7px 9px; }
  .kpi.lead { border-color: #141414; }
  .kpi.warn { border-color: #E10020; }
  .kl { font-size: 7.5px; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; }
  .kv { font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; margin-top: 3px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 3.5px 8px; border-bottom: 1px solid #eee; }
  th { font-size: 7.6px; text-transform: uppercase; letter-spacing: 0.03em; color: #6b7280; font-weight: 500; text-align: right; }
  th.l, td.l { text-align: left; }
  td.r { text-align: right; }
  tr.anchor td { border-top: 1.5px solid #141414; font-weight: 500; background: #f7f7f7; }
  tr.sub td.l { padding-left: 22px; color: #4b5563; }
  tr.sub td.l .ar { color: #9ca3af; margin-right: 5px; }
  tr.resid td.l { padding-left: 22px; font-style: italic; color: #6b7280; }
  tr.total td { border-top: 2px solid #141414; background: #ededed; font-weight: 500; }
  .warn { color: #E10020; }
  .muted { color: #9ca3af; }
  .chip { display: inline-block; font-size: 7px; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 5px; border-radius: 3px; background: #f1f5f9; color: #475569; margin-right: 6px; }
  .meta { color: #6b7280; font-size: 8.5px; }
`

function shell(title: string, ctx: string, bodyHtml: string): string {
  const gen = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${esc(title)} — ${esc(ctx)}</title>
<style>${STYLE}</style></head><body>
  <div class="head">
    <div><h1>${esc(title)}</h1><div class="ctx">${esc(ctx)}</div></div>
    <div class="gen">CCC Treasury · Allocations<br/>USD · Generated ${esc(gen)}</div>
  </div>
  ${bodyHtml}
  <script>window.onload = function(){ window.print(); };</script>
</body></html>`
}

function open(html: string) {
  const w = window.open('', '_blank')
  if (!w) { alert('Allow pop-ups to print the statement.'); return }
  w.document.write(html)
  w.document.close()
}

/* ── Source & Use statement (period) ────────────────────────────── */
export function openSourceUseReport(view: LedgerData, range: PeriodRange) {
  const t = computeTotals(view)
  const kpi = (l: string, v: number, cls = '') =>
    `<div class="kpi ${cls}"><div class="kl">${l}</div><div class="kv ${v < 0 ? 'warn' : ''}">${usd(v)}</div></div>`

  // Source of funds
  const srcRows = view.inflows.map(inf => {
    const der = deriveInflow(inf, view.allocations)
    const links = view.allocations.filter(a => a.inflow_id === inf.id)
    const head = `<tr class="anchor"><td class="l"><span class="chip">${esc(labelSourceType(inf.source_type))}</span>${esc(inf.source_name)} <span class="meta">· ${esc(fmtDate(inf.dated))} · ${esc(money(inf.amount_native, inf.currency))}</span></td><td class="r">${usd(inf.amount_usd)}</td></tr>`
    const kids = links.map(l => {
      const o = view.obligations.find(x => x.id === l.obligation_id)
      return `<tr class="sub"><td class="l"><span class="ar">→</span>${esc(o ? o.description : '(obligation outside range)')}</td><td class="r">${usd(l.amount_usd)}</td></tr>`
    }).join('')
    const resid = `<tr class="resid"><td class="l">Unallocated</td><td class="r ${der.unallocated > 0.005 ? 'warn' : ''}">${usd(der.unallocated)}</td></tr>`
    return head + kids + resid
  }).join('')

  // Use of funds
  const useRows = view.obligations.map(o => {
    const der = deriveObligation(o, view.allocations, view.payments)
    const links = view.allocations.filter(a => a.obligation_id === o.id)
    const head = `<tr class="anchor"><td class="l"><span class="chip">${esc(labelCategory(o.category))}</span>${esc(o.description)} <span class="meta">· ${esc(fmtDate(o.due_date))} · ${esc(money(o.amount_native, o.currency))}</span></td><td class="r">${usd(o.amount_usd)}</td></tr>`
    const kids = links.map(l => {
      const inf = view.inflows.find(x => x.id === l.inflow_id)
      return `<tr class="sub"><td class="l"><span class="ar">←</span>${esc(inf ? inf.source_name : '(inflow outside range)')}</td><td class="r">${usd(l.amount_usd)}</td></tr>`
    }).join('')
    const resid = `<tr class="resid"><td class="l">Outstanding · Paid ${usd(der.paid)}</td><td class="r ${der.outstanding > 0.005 ? 'warn' : ''}">${usd(der.outstanding)}</td></tr>`
    return head + kids + resid
  }).join('')

  const body = `
  <div class="kpis">
    ${kpi('Total in', t.totalIn, 'lead')}${kpi('Obligations', t.totalObligations)}${kpi('Allocated', t.allocated)}${kpi('Unallocated cash', t.unallocatedCash, t.unallocatedCash > 0.005 ? 'warn' : '')}${kpi('Unfunded', t.unfunded, t.unfunded > 0.005 ? 'warn' : '')}${kpi('Paid', t.totalPaid)}
  </div>
  <h2>Source of funds</h2>
  <table><thead><tr><th class="l">Inflow → use</th><th>USD</th></tr></thead><tbody>
    ${srcRows || '<tr><td class="l muted" colspan="2">No inflows in range.</td></tr>'}
    <tr class="total"><td class="l">Total in</td><td class="r">${usd(t.totalIn)}</td></tr>
  </tbody></table>
  <h2>Use of funds</h2>
  <table><thead><tr><th class="l">Obligation ← funded by</th><th>USD</th></tr></thead><tbody>
    ${useRows || '<tr><td class="l muted" colspan="2">No obligations in range.</td></tr>'}
    <tr class="total"><td class="l">Total obligations</td><td class="r">${usd(t.totalObligations)}</td></tr>
  </tbody></table>`

  open(shell('Source & Use Statement', periodLabel(range), body))
}

/* ── Single inflow statement ────────────────────────────────────── */
export function openInflowReport(inf: Inflow, view: LedgerData) {
  const der = deriveInflow(inf, view.allocations)
  const links = view.allocations.filter(a => a.inflow_id === inf.id)
  const rows = links.map(l => {
    const o = view.obligations.find(x => x.id === l.obligation_id)
    return `<tr><td class="l">${esc(o ? o.description : '(obligation outside range)')}</td><td class="l meta">${o ? esc(labelCategory(o.category)) : ''}</td><td class="r">${usd(l.amount_usd)}</td></tr>`
  }).join('')
  const body = `
  <div class="kpis">
    <div class="kpi lead"><div class="kl">Amount</div><div class="kv">${usd(inf.amount_usd)}</div></div>
    <div class="kpi"><div class="kl">Allocated</div><div class="kv">${usd(der.allocated)}</div></div>
    <div class="kpi ${der.unallocated > 0.005 ? 'warn' : ''}"><div class="kl">Unallocated</div><div class="kv">${usd(der.unallocated)}</div></div>
  </div>
  <p class="meta">${esc(labelSourceType(inf.source_type))} · ${esc(fmtDate(inf.dated))} · ${esc(money(inf.amount_native, inf.currency))}${inf.reference ? ' · ' + esc(inf.reference) : ''} · status ${esc(inf.status)}</p>
  <h2>What this funded</h2>
  <table><thead><tr><th class="l">Obligation</th><th class="l">Category</th><th>USD</th></tr></thead><tbody>
    ${rows || '<tr><td class="l muted" colspan="3">Not yet allocated.</td></tr>'}
    <tr class="resid"><td class="l">Unallocated</td><td></td><td class="r ${der.unallocated > 0.005 ? 'warn' : ''}">${usd(der.unallocated)}</td></tr>
    <tr class="total"><td class="l">Total</td><td></td><td class="r">${usd(inf.amount_usd)}</td></tr>
  </tbody></table>`
  open(shell('Inflow Statement', inf.source_name, body))
}

/* ── Single obligation statement ────────────────────────────────── */
export function openObligationReport(o: Obligation, view: LedgerData) {
  const der = deriveObligation(o, view.allocations, view.payments)
  const links = view.allocations.filter(a => a.obligation_id === o.id)
  const pays = view.payments.filter(p => p.obligation_id === o.id)
  const fundRows = links.map(l => {
    const inf = view.inflows.find(x => x.id === l.inflow_id)
    return `<tr><td class="l">${esc(inf ? inf.source_name : '(inflow outside range)')}</td><td class="l meta">${inf ? esc(labelSourceType(inf.source_type)) : ''}</td><td class="r">${usd(l.amount_usd)}</td></tr>`
  }).join('')
  const payRows = pays.map(p =>
    `<tr><td class="l">${esc(fmtDate(p.paid_date))}</td><td class="l meta">${esc(money(p.amount_native, p.currency))}${p.reference ? ' · ' + esc(p.reference) : ''}</td><td class="r">${usd(p.amount_usd)}</td></tr>`,
  ).join('')
  const body = `
  <div class="kpis">
    <div class="kpi lead"><div class="kl">Amount</div><div class="kv">${usd(o.amount_usd)}</div></div>
    <div class="kpi"><div class="kl">Funded</div><div class="kv">${usd(der.funded)}</div></div>
    <div class="kpi ${der.outstanding > 0.005 ? 'warn' : ''}"><div class="kl">Outstanding</div><div class="kv">${usd(der.outstanding)}</div></div>
    <div class="kpi"><div class="kl">Paid</div><div class="kv">${usd(der.paid)}</div></div>
  </div>
  <p class="meta">${esc(labelCategory(o.category))} · due ${esc(fmtDate(o.due_date))} · ${esc(money(o.amount_native, o.currency))}</p>
  <h2>Funded by</h2>
  <table><thead><tr><th class="l">Inflow</th><th class="l">Source</th><th>USD</th></tr></thead><tbody>
    ${fundRows || '<tr><td class="l muted" colspan="3">Not yet funded.</td></tr>'}
    <tr class="resid"><td class="l">Outstanding</td><td></td><td class="r ${der.outstanding > 0.005 ? 'warn' : ''}">${usd(der.outstanding)}</td></tr>
    <tr class="total"><td class="l">Total</td><td></td><td class="r">${usd(o.amount_usd)}</td></tr>
  </tbody></table>
  <h2>Settlement</h2>
  <table><thead><tr><th class="l">Paid date</th><th class="l">Detail</th><th>USD</th></tr></thead><tbody>
    ${payRows || '<tr><td class="l muted" colspan="3">No payments recorded.</td></tr>'}
    <tr class="total"><td class="l">Total paid</td><td></td><td class="r">${usd(der.paid)}</td></tr>
  </tbody></table>`
  open(shell('Obligation Statement', o.description, body))
}
