import type { StmtSection } from './reportModel'
import { waterfallSvg, areaBarsSvg } from './reportCharts'

/* Print mirror of the Cash Flow Report (CashReport.tsx), A4 LANDSCAPE.
 * Group → a KPI band + the grouped statement + a cash-movement waterfall and the
 * trade-payables position. Area → a KPI band + the per-area matrix + a net-cash-
 * from-operations bar. Opens in a new window and auto-prints. USD millions. */

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

/* ── KPI tile band ──────────────────────────────────────────────────────── */
function kpis(cards: { label: string; value: string; cls?: string; sub?: string }[]): string {
  return `<div class="kpis">${cards.map(c =>
    `<div class="kpi"><div class="kpi-l">${c.label}</div><div class="kpi-v ${c.cls || ''}">${c.value}</div>${c.sub ? `<div class="kpi-s">${c.sub}</div>` : ''}</div>`).join('')}</div>`
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

  let band = '', left = '', right = ''

  if (o.level === 'group' && o.statement) {
    const secBy = (label: string) => o.statement!.sections.find(s => s.label === label)?.net ?? 0
    const opsNet = secBy('Operations'), finNet = secBy('Bank Financing')
    const payDelta = o.hasPay ? (o.payEnd ?? 0) - (o.payStart ?? 0) : null
    band = kpis([
      { label: 'Net from operations', value: fM(opsNet), cls: cl(opsNet) },
      { label: 'Net financing', value: fM(finNet), cls: cl(finNet) },
      { label: 'Net cash movement', value: fM(o.statement.netMovement), cls: cl(o.statement.netMovement) },
      { label: `Trade payables · ${o.asOfLabel}`, value: fM(o.payEnd), cls: cl(o.payEnd), sub: o.hasPay ? `${fD(payDelta)} since ${o.startLabel}` : '' },
    ])
    left = `<table class="t">
      <thead><tr><th>Line item</th><th class="r">USD m</th></tr></thead>
      <tbody>
        ${o.statement.sections.map(sectionRows).join('')}
        <tr class="total"><td>Net cash movement</td><td class="r ${cl(o.statement.netMovement)}">${fM(o.statement.netMovement)}</td></tr>
      </tbody></table>`
    const waterItems = o.statement.sections.map(s => ({ label: s.label, value: s.net }))
    right = `
      <div class="chartcard">
        <div class="ch-h">How the cash moved <span>· section nets → net movement</span></div>
        ${waterfallSvg(waterItems, o.statement.netMovement)}
      </div>
      <div class="chartcard">
        <div class="ch-h">Trade payables · position</div>
        ${o.hasPay ? `<table class="t tpos">
          <thead><tr><th>Liabilities</th><th class="r">${o.startLabel}</th><th class="r">${o.asOfLabel}</th><th class="r">Δ</th></tr></thead>
          <tbody><tr class="total"><td>Trade payables</td>
            <td class="r ${cl(o.payStart)}">${fM(o.payStart)}</td>
            <td class="r ${cl(o.payEnd)}">${fM(o.payEnd)}</td>
            <td class="r ${cl(payDelta)}">${fD(payDelta)}</td></tr></tbody></table>
          <div class="note">Suppliers, subcontractors &amp; taxes — the editable <b>trade_payables</b> group (Midas TB). Δ positive = paid down. Recent months still posting.</div>`
          : `<div class="note">No matched payables for this scope.</div>`}
      </div>`
  } else if (o.level === 'area' && o.areaRows) {
    const t = o.areaTotals!
    const payDelta = t.payEnd - t.payStart
    const top = [...o.areaRows].sort((a, b) => b.netOps - a.netOps)[0]
    band = kpis([
      { label: 'Group net from ops', value: fM(t.netOps), cls: cl(t.netOps) },
      { label: `Trade payables · ${o.asOfLabel}`, value: fM(t.payEnd), cls: cl(t.payEnd), sub: `${fD(payDelta)} since ${o.startLabel}` },
      { label: 'Matched areas', value: String(o.areaRows.length) },
      { label: 'Top cash generator', value: top ? top.label : '—', sub: top ? `${fM(top.netOps)} m` : '' },
    ])
    const row = (label: string, netOps: number, ps: number | null, pe: number | null, tot = false) => {
      const d = (ps != null && pe != null) ? pe - ps : null
      return `<tr${tot ? ' class="total"' : ''}><td>${label}</td>
        <td class="r ${cl(netOps)}">${fM(netOps)}</td>
        <td class="r sepl ${cl(ps)}">${fM(ps)}</td>
        <td class="r ${cl(pe)}">${fM(pe)}</td>
        <td class="r ${cl(d)}">${fD(d)}</td></tr>`
    }
    left = `<table class="t tarea">
      <thead><tr><th>Area</th><th class="r">Net cash from ops</th><th class="r sepl">Payables ${o.startLabel}</th><th class="r">Payables ${o.asOfLabel}</th><th class="r">Δ</th></tr></thead>
      <tbody>
        ${o.areaRows.map(a => row(a.label, a.netOps, a.payStart, a.payEnd)).join('')}
        ${row(`Group (${o.areaRows.length} areas)`, t.netOps, t.payStart, t.payEnd, true)}
      </tbody></table>`
    right = `<div class="chartcard">
      <div class="ch-h">Net cash from operations <span>· by area</span></div>
      ${areaBarsSvg(o.areaRows.map(a => ({ label: a.label, value: a.netOps })))}
      <div class="note">Green = cash generated, crimson = cash consumed (USD, YTD).</div>
    </div>`
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  @page { size: A4 landscape; margin: 10mm 12mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #15233b; font-size: 11.5px; }
  .neg { color: #E10020; } .pos { color: #057a55; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.5px solid #E10020; padding-bottom: 7px; margin-bottom: 10px; }
  h1 { font-size: 19px; } .sub { font-size: 10px; color: #64748b; margin-top: 2px; }
  .brand { font-size: 11px; font-weight: 700; white-space: nowrap; }
  .glyph { display: inline-block; background: #E10020; color: #fff; width: 15px; height: 15px; border-radius: 3px; text-align: center; line-height: 15px; font-size: 10px; margin-right: 3px; }
  .kpis { display: flex; gap: 10px; margin-bottom: 12px; }
  .kpi { flex: 1; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 12px; border-left: 3px solid #E10020; }
  .kpi-l { font-size: 8.5px; letter-spacing: .4px; text-transform: uppercase; color: #64748b; font-weight: 700; }
  .kpi-v { font-size: 22px; font-weight: 800; margin-top: 2px; }
  .kpi-s { font-size: 9px; color: #64748b; margin-top: 1px; }
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
  .ch-h { font-size: 11px; font-weight: 700; margin-bottom: 4px; } .ch-h span { color: #94a3b8; font-weight: 500; }
  .note { font-size: 9px; color: #64748b; line-height: 1.5; margin-top: 8px; } .note b { color: #15233b; }
</style></head><body>
  <div class="head">
    <div><h1>${title}</h1><div class="sub">${sub}</div></div>
    <div class="brand"><span class="glyph">C</span>CCC · Treasury</div>
  </div>
  ${band}
  <div class="cols"><div>${left}</div><div>${right}</div></div>
  <script>window.onload = function () { window.print(); };</script>
</body></html>`
}
