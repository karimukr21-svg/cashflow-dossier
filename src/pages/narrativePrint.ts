import type { NarrativeData } from './Narrative'
import { buildTrajectorySvg } from './narrativeChart'

/* Print mirror of the Chairman cash-flow report (ChairmanReport in
 * Narrative.tsx): header → hero transformation → trajectory chart → before→after
 * stat strip → bottom line, on one A4 LANDSCAPE page. Opens in a new window and
 * auto-prints (bankposition/allocations print pattern). */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const fM = (v: number | null | undefined): string => {
  if (v == null || isNaN(v)) return '—'
  const r = Math.round((v / 1e6) * 10) / 10
  if (r === 0) return '0.0'
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return r < 0 ? `(${s})` : s
}
const fMs = (v: number | null | undefined): string => {
  if (v == null) return '—'
  const r = Math.round((v / 1e6) * 10) / 10
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return r < 0 ? `(${s})` : `+${s}`
}
const sign = (v: number | null | undefined) => (v == null || v === 0) ? '' : (v < 0 ? 'neg' : 'pos')
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function bottomLine(d: NarrativeData, scopeLabel: string): string {
  const m = MONTHS[d.minNf.idx] ?? ''
  const gap = d.nfNow < 0
    ? `carries a net funding gap of <b class="neg">${fM(d.nfNow)}m</b> today — debt of <b>${fM(d.debtNow)}m</b> against <b>${fM(d.now)}m</b> of cash`
    : `holds net funds of <b class="pos">${fM(d.nfNow)}m</b> today — <b>${fM(d.now)}m</b> of cash against <b>${fM(d.debtNow)}m</b> of debt`
  const trough = d.minNf.value < d.nfNow ? `The gap deepens to <b class="neg">${fM(d.minNf.value)}m</b> in ${m}, then collections recover and ` : ``
  const end = d.nfEnd >= 0 ? `net funds turn positive (<b class="pos">${fMs(d.nfEnd)}m</b>) by year-end` : `net funds remain at <b class="neg">${fM(d.nfEnd)}m</b> by year-end`
  return `${cap(scopeLabel)} ${gap}. ${trough}debt is paid down from <b>${fM(d.debtPeak)}m</b> to <b>${fM(d.debtEnd)}m</b> — ${end}.`
}

export function buildNarrativeHtml(
  d: NarrativeData,
  ctx: { scopeLabel: string; year: number; asOfLabel: string; mode: 'group' | 'area'; unit: string; months: string[] },
): string {
  const swing = d.nfEnd - d.nfNow
  const decRetire = d.debtEnd - d.liabilities[10]
  const plateau = Math.round((d.liabilities.slice(0, 11).reduce((a, b) => a + b, 0) / 11) / 1e6 / 50) * 50
  const swingCaption = d.nfNow < 0 && d.nfEnd >= 0 ? 'From deficit to surplus'
    : d.nfNow >= 0 && d.nfEnd < 0 ? 'From surplus to deficit'
    : swing >= 0 ? 'Net improvement over the year' : 'Net deterioration over the year'
  const chart = buildTrajectorySvg({ months: ctx.months || MONTHS, liabilities: d.liabilities, netFunds: d.netFunds, asOfMonth: d.asOfMonth })

  const stat = (label: string, body: string, note: string) =>
    `<div class="stat"><div class="stat-l">${label}</div><div class="stat-v">${body}</div><div class="stat-n">${note}</div></div>`

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cash Flow Story — ${ctx.scopeLabel}</title>
<style>
  @page { size: A4 landscape; margin: 9mm 11mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #15233b; }
  .neg { color: #E10020; } .pos { color: #057a55; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.5px solid #E10020; padding-bottom: 7px; }
  h1 { font-size: 21px; } .sub { font-size: 10.5px; color: #64748b; margin-top: 2px; }
  .brand { text-align: right; } .brand-mark { font-size: 11px; font-weight: 700; }
  .glyph { display: inline-block; background: #E10020; color: #fff; width: 15px; height: 15px; border-radius: 3px; text-align: center; line-height: 15px; font-size: 10px; margin-right: 3px; }
  .asof { font-size: 8.5px; letter-spacing: 1px; color: #64748b; margin-top: 2px; }
  .hero { display: flex; align-items: center; gap: 26px; padding: 12px 0 10px; border-bottom: 1px solid #e9ecf1; }
  .hero-eyebrow { font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: #64748b; font-weight: 700; align-self: flex-start; padding-top: 6px; }
  .hero-pt { text-align: left; } .hero-num { font-size: 54px; font-weight: 800; line-height: 1; } .hero-cap { font-size: 9.5px; color: #64748b; margin-top: 3px; }
  .hero-arrow { font-size: 26px; color: #94a3b8; } .hero-unit { font-size: 13px; color: #64748b; font-weight: 600; align-self: flex-end; padding-bottom: 8px; }
  .hero-swing { margin-left: auto; text-align: right; border-left: 1px solid #e9ecf1; padding-left: 22px; }
  .swing-num { font-size: 30px; font-weight: 800; } .swing-cap { font-size: 9.5px; color: #64748b; max-width: 230px; margin-left: auto; }
  .chartwrap { padding: 8px 0 4px; }
  .chart-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
  .chart-title { font-size: 11px; font-weight: 700; color: #15233b; } .chart-title span { color: #94a3b8; font-weight: 500; }
  .legend { font-size: 9.5px; color: #64748b; display: flex; gap: 14px; }
  .leg { display: inline-flex; align-items: center; gap: 5px; } .leg i { width: 16px; height: 3px; display: inline-block; border-radius: 2px; }
  .leg-band { height: 9px !important; background: rgba(225,0,32,0.18); } .leg-nf { background: #15233b; height: 3px; } .leg-fc { background: repeating-linear-gradient(90deg,#64748b 0 4px,transparent 4px 7px); }
  .chart svg { display: block; width: 100%; }
  .strip { display: flex; border-top: 1px solid #e9ecf1; border-bottom: 1px solid #e9ecf1; }
  .stat { flex: 1; padding: 9px 16px; border-left: 1px solid #e9ecf1; } .stat:first-child { border-left: none; }
  .stat-l { font-size: 8.5px; letter-spacing: .5px; text-transform: uppercase; color: #64748b; font-weight: 700; }
  .stat-v { font-size: 19px; font-weight: 800; margin: 3px 0 2px; } .stat-v .arr { color: #94a3b8; font-weight: 400; margin: 0 6px; font-size: 15px; }
  .stat-n { font-size: 9px; color: #64748b; }
  .bl { margin-top: 11px; background: #15233b; border-radius: 6px; padding: 11px 16px; display: flex; align-items: baseline; gap: 12px; }
  .bl-tag { background: #E10020; color: #fff; font-size: 8.5px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; padding: 3px 8px; border-radius: 4px; white-space: nowrap; }
  .bl-text { color: #e8edf4; font-size: 12px; line-height: 1.5; } .bl-text b { color: #fff; } .bl-text b.neg { color: #ff6b81; } .bl-text b.pos { color: #34d399; }
</style></head><body>
  <div class="head">
    <div><h1>Group Cash Flow — ${ctx.scopeLabel} · ${ctx.year}</h1>
      <div class="sub">Actuals through ${ctx.asOfLabel} · forecast to year-end · figures in ${ctx.unit}</div></div>
    <div class="brand"><div class="brand-mark"><span class="glyph">C</span>CCC · Treasury</div><div class="asof">AS OF ${ctx.asOfLabel}</div></div>
  </div>

  <div class="hero">
    <div class="hero-eyebrow">Net funds<br>position</div>
    <div class="hero-pt"><div class="hero-num ${sign(d.nfNow)}">${fM(d.nfNow)}</div><div class="hero-cap">Today · ${ctx.asOfLabel}</div></div>
    <div class="hero-arrow">→</div>
    <div class="hero-pt"><div class="hero-num ${sign(d.nfEnd)}">${fMs(d.nfEnd)}</div><div class="hero-cap">Forecast · Dec ${ctx.year}</div></div>
    <div class="hero-unit">${ctx.unit.replace(' millions', ' m')}</div>
    <div class="hero-swing"><div class="swing-num ${sign(swing)}">${fMs(swing)}</div><div class="swing-cap">${swingCaption}</div></div>
  </div>

  <div class="chartwrap">
    <div class="chart-head"><div class="chart-title">The year in one shape <span>· net funds &amp; debt across ${ctx.year}</span></div>
      <div class="legend"><span class="leg"><i class="leg-band"></i>Liabilities (debt)</span><span class="leg"><i class="leg-nf"></i>Net funds</span><span class="leg"><i class="leg-fc"></i>Forecast</span></div></div>
    <div class="chart">${chart}</div>
  </div>

  <div class="strip">
    ${stat('Cash position', `<span class="${sign(d.now)}">${fM(d.now)}</span><span class="arr">→</span><span class="${sign(d.yearEnd)}">${fM(d.yearEnd)}</span>`, `Today → year-end · ${fMs((d.yearEnd ?? 0) - (d.now ?? 0))} over the year`)}
    ${stat('Liabilities (debt)', `<span class="neg">${fM(-Math.abs(d.debtNow))}</span><span class="arr">→</span><span class="neg">${fM(-Math.abs(d.debtEnd))}</span>`, `Held ≈ ${plateau}m all year · ${fMs(decRetire)} in Dec`)}
    ${stat('Net funds', `<span class="${sign(d.nfNow)}">${fM(d.nfNow)}</span><span class="arr">→</span><span class="${sign(d.nfEnd)}">${fM(d.nfEnd)}</span>`, d.nfNow < 0 && d.nfEnd >= 0 ? 'Deficit → surplus · positive only at year-end' : 'Cash net of debt')}
    ${stat('Full-year flow', `<span class="pos">${fM(d.recvFull)}</span>`, `Receipts vs ${fM(Math.abs(d.payFull))} payments · net ${fMs(d.recvFull + d.payFull)}`)}
  </div>

  <div class="bl"><span class="bl-tag">Bottom line</span><span class="bl-text">${bottomLine(d, ctx.scopeLabel)}</span></div>

  <script>window.onload = function () { window.print(); };</script>
</body></html>`
}
