import type { StmtSection } from './reportModel'

/* Print mirror of the Cash Flow Report (CashReport.tsx). Group → the grouped
 * cash-flow statement + the separated trade-payables position. Area → the
 * per-area matrix. Opens in a new window and auto-prints (narrative/bankposition
 * pattern). CCC-branded, A4 portrait. Values in USD millions. */

const fM = (v: number | null | undefined): string => {
  if (v == null || isNaN(v)) return '—'
  const r = Math.round((v / 1e6) * 10) / 10
  if (r === 0) return '—'
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return r < 0 ? `(${s})` : s
}
const fD = (v: number | null | undefined): string => {
  if (v == null || isNaN(v)) return '—'
  const r = Math.round((v / 1e6) * 10) / 10
  if (r === 0) return '—'
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return r < 0 ? `(${s})` : `+${s}`
}
const cl = (v: number | null | undefined): string => (v == null || Math.abs(v) < 50000) ? '' : (v < 0 ? 'neg' : 'pos')

type Opts = {
  level: 'group' | 'area'
  scopeLabel: string; year: number; asOfLabel: string; startLabel: string
  matchedCount?: number
  statement?: { sections: StmtSection[]; netMovement: number }
  payStart?: number; payEnd?: number; hasPay?: boolean
  areaRows?: { label: string; netOps: number; payStart: number | null; payEnd: number | null }[]
  areaTotals?: { netOps: number; payStart: number; payEnd: number }
}

function sectionRows(sec: StmtSection): string {
  const item = (label: string, v: number) => `<tr><td class="item">${label}</td><td class="r ${cl(v)}">${fM(v)}</td></tr>`
  const sub = (label: string, v: number) => `<tr class="natsub"><td>${label}</td><td class="r ${cl(v)}">${fM(v)}</td></tr>`
  let s = `<tr class="sec"><td>${sec.label}</td><td></td></tr>`
  s += sec.receipts.map(b => item(b.label, b.value)).join('')
  if (sec.receipts.length > 1) s += sub('Total receipts', sec.recTotal)
  s += sec.payments.map(b => item(b.label, b.value)).join('')
  if (sec.payments.length > 1) s += sub('Total payments', sec.payTotal)
  s += `<tr class="subtot"><td>Net ${sec.label.toLowerCase()}</td><td class="r ${cl(sec.net)}">${fM(sec.net)}</td></tr>`
  return s
}

export function buildReportHtml(o: Opts): string {
  const title = o.level === 'area' ? 'Cash Flow Report — Areas' : `Cash Flow Report — ${o.scopeLabel}`
  const sub = `Actual to date · Jan–${o.asOfLabel} · USD millions${o.matchedCount != null ? ` · ${o.matchedCount} matched areas` : ''}`

  let body = ''
  if (o.level === 'group' && o.statement) {
    const payDelta = o.hasPay ? (o.payEnd ?? 0) - (o.payStart ?? 0) : null
    body = `
    <table class="t">
      <thead><tr><th>Line item</th><th class="r">USD m</th></tr></thead>
      <tbody>
        ${o.statement.sections.map(sectionRows).join('')}
        <tr class="total"><td>Net cash movement</td><td class="r ${cl(o.statement.netMovement)}">${fM(o.statement.netMovement)}</td></tr>
      </tbody>
    </table>
    <div class="poscard">
      <div class="posh">Trade payables · position</div>
      ${o.hasPay ? `<table class="t tpos">
        <thead><tr><th>Liabilities</th><th class="r">${o.startLabel}</th><th class="r">${o.asOfLabel}</th><th class="r">Δ</th></tr></thead>
        <tbody><tr class="total"><td>Trade payables</td>
          <td class="r ${cl(o.payStart)}">${fM(o.payStart)}</td>
          <td class="r ${cl(o.payEnd)}">${fM(o.payEnd)}</td>
          <td class="r ${cl(payDelta)}">${fD(payDelta)}</td></tr></tbody></table>
        <div class="note">Suppliers, subcontractors &amp; taxes — the editable <b>trade_payables</b> group (Midas trial balance, USD). Δ positive = paid down. Recent months are still posting, so the latest may understate.</div>`
        : `<div class="note">No matched payables for this scope.</div>`}
    </div>`
  } else if (o.level === 'area' && o.areaRows) {
    const t = o.areaTotals!
    const row = (label: string, netOps: number, ps: number | null, pe: number | null, tot = false) => {
      const d = (ps != null && pe != null) ? pe - ps : null
      return `<tr${tot ? ' class="total"' : ''}><td>${label}</td>
        <td class="r ${cl(netOps)}">${fM(netOps)}</td>
        <td class="r sepl ${cl(ps)}">${fM(ps)}</td>
        <td class="r ${cl(pe)}">${fM(pe)}</td>
        <td class="r ${cl(d)}">${fD(d)}</td></tr>`
    }
    body = `
    <table class="t tarea">
      <thead><tr><th>Area</th><th class="r">Net cash from ops</th><th class="r sepl">Payables ${o.startLabel}</th><th class="r">Payables ${o.asOfLabel}</th><th class="r">Δ</th></tr></thead>
      <tbody>
        ${o.areaRows.map(a => row(a.label, a.netOps, a.payStart, a.payEnd)).join('')}
        ${row(`Group (${o.areaRows.length} areas)`, t.netOps, t.payStart, t.payEnd, true)}
      </tbody>
    </table>
    <div class="note">Net cash from operations (receipts − payments, USD-converted). Payables = the trade_payables group (Midas trial balance). Δ positive = paid down.</div>`
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  @page { size: A4 portrait; margin: 12mm 12mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #15233b; font-size: 12px; }
  .neg { color: #E10020; } .pos { color: #057a55; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.5px solid #E10020; padding-bottom: 8px; margin-bottom: 12px; }
  h1 { font-size: 19px; } .sub { font-size: 10.5px; color: #64748b; margin-top: 3px; }
  .brand { font-size: 11px; font-weight: 700; white-space: nowrap; }
  .glyph { display: inline-block; background: #E10020; color: #fff; width: 15px; height: 15px; border-radius: 3px; text-align: center; line-height: 15px; font-size: 10px; margin-right: 3px; }
  table.t { width: 100%; border-collapse: collapse; }
  .t th { text-align: left; font-size: 9px; letter-spacing: .4px; text-transform: uppercase; color: #64748b; font-weight: 700; padding: 4px 8px; border-bottom: 1px solid #e2e8f0; }
  .t th.r, .t td.r { text-align: right; font-variant-numeric: tabular-nums; }
  .t td { padding: 3.5px 8px; }
  .t .sec td { font-size: 9px; letter-spacing: .4px; text-transform: uppercase; color: #64748b; font-weight: 700; padding-top: 9px; }
  .t td.item { padding-left: 18px; color: #334155; }
  .t .natsub td { font-style: italic; color: #475569; }
  .t .subtot td { font-weight: 700; border-top: 1px solid #e2e8f0; }
  .t .total td { font-weight: 800; border-top: 2px solid #15233b; padding-top: 6px; }
  .t .tpos .total td, .t.tpos .total td { border-top: 0; }
  .sepl { border-left: 1px solid #e2e8f0; }
  .poscard { margin-top: 16px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; break-inside: avoid; }
  .posh { font-size: 12px; font-weight: 700; margin-bottom: 6px; }
  .tpos .total td { border-top: 0 !important; }
  .note { font-size: 9.5px; color: #64748b; line-height: 1.5; margin-top: 10px; }
  .note b { color: #15233b; }
</style></head><body>
  <div class="head">
    <div><h1>${title}</h1><div class="sub">${sub}</div></div>
    <div class="brand"><span class="glyph">C</span>CCC · Treasury</div>
  </div>
  ${body}
  <script>window.onload = function () { window.print(); };</script>
</body></html>`
}
