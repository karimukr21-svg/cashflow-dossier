import type { NarrativeData, PayTrack } from './Narrative'
import { idxLabel } from './Narrative'
import { buildCashStoryChart, buildPayablesTrack } from './narrativeChart'

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
function bottomLine(d: NarrativeData, scopeLabel: string, pt: PayTrack, year: number): string {
  const nfCls = (d.nfNow ?? 0) < 0 ? 'neg' : 'pos'
  const endCls = d.nfEnd < 0 ? 'neg' : 'pos'
  const arc = d.minNf.value < (d.nfNow ?? 0)
    ? `dips to <b class="neg">${fM(d.minNf.value)}m</b> in ${MONTHS[d.minNf.idx]} before recovering to`
    : (d.nfEnd >= (d.nfNow ?? 0) ? 'strengthens to' : 'eases to')
  const pay = pt.unavailable
    ? `Payables to suppliers and subcontractors are tracked separately — <b>no mapped books for this area</b>.`
    : `Separately, trade payables stand at <b class="neg">${fM(Math.abs(pt.latestValue))}m</b> (USD) as of ${idxLabel(pt.latestIdx, year)}, from ${fM(Math.abs(pt.firstValue))}m at ${idxLabel(pt.firstIdx, year)} — recent months understated while books finish posting.`
  return `After loans and overdrafts, ${scopeLabel}'s net liquid funds stand at <b class="${nfCls}">${fM(d.nfNow)}m</b> today — <b class="pos">${fM(d.now)}m</b> of cash against <b class="neg">${fM(d.debtNow)}m</b> of loans and overdrafts. The position ${arc} <b class="${endCls}">${fM(d.nfEnd)}m</b> by year-end as cash builds and financing is paid down. ${pay}`
}

/** HTML caveat under the print payables track (mirrors payablesCaveat). */
function payablesCaveatHtml(pt: PayTrack, year: number, mode: 'group' | 'area'): string {
  const latestBooks = pt.nBooks13[pt.latestIdx] ?? 0
  const pending = Math.max(0, pt.maxBooks - latestBooks)
  const prov = pending > 0
    ? ` Recent months are <b>provisional</b> — ${pending} of ${pt.maxBooks} books not yet posted for ${idxLabel(pt.latestIdx, year)}, so the latest balance understates (the decline partly reflects books still being rebuilt).`
    : ''
  const approx = mode === 'area' ? ` Area mapped from org_chart by name — <b>approximate</b>, pending the canonical crosswalk.` : ''
  return `Payables = the <b>trade_payables</b> group (suppliers, subcontractors &amp; taxes), defined and editable in the Chart of Accounts module; source is the Midas trial balance, in USD.${prov}${approx}`
}

export function buildNarrativeHtml(
  d: NarrativeData,
  ctx: { scopeLabel: string; year: number; asOfLabel: string; mode: 'group' | 'area'; unit: string; months: string[];
         payTrack: PayTrack },
): string {
  const fullSwing = d.nfEnd - d.nfOpen                            // net journey, opening → year-end
  const fullSwingCap = fullSwing >= 0 ? `Net funds recover over ${ctx.year}` : `Net funds erode over ${ctx.year}`
  const netFlow = d.recvFull + d.payFull
  const cash13 = [d.opening ?? 0, ...d.cashClosing]
  const net13 = [d.nfOpen, ...d.netFunds]
  const chart = buildCashStoryChart({ months: ['', ...(ctx.months || MONTHS)], cash: cash13, net: net13, asIdx: d.asOfMonth, asOfLabel: ctx.asOfLabel, year: ctx.year })
  const pt = ctx.payTrack
  const payChart = pt.unavailable ? '' : buildPayablesTrack({ months: ['', ...(ctx.months || MONTHS)], payables: pt.payables13, nBooks: pt.nBooks13, maxBooks: pt.maxBooks })

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
  .hero { display: flex; align-items: center; gap: 17px; padding: 12px 0 10px; border-bottom: 1px solid #e9ecf1; }
  .hero-eyebrow { font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: #64748b; font-weight: 700; align-self: flex-start; padding-top: 6px; max-width: 64px; }
  .hero-pt { text-align: left; } .hero-num { font-size: 52px; font-weight: 800; line-height: 1; } .hero-num.sm { font-size: 33px; opacity: .82; } .hero-cap { font-size: 9.5px; color: #64748b; margin-top: 3px; }
  .hero-arrow { font-size: 26px; color: #94a3b8; } .hero-unit { font-size: 13px; color: #64748b; font-weight: 600; align-self: flex-end; padding-bottom: 8px; }
  .hero-swing { margin-left: auto; text-align: right; border-left: 1px solid #e9ecf1; padding-left: 22px; }
  .swing-num { font-size: 30px; font-weight: 800; } .swing-cap { font-size: 9.5px; color: #64748b; max-width: 230px; margin-left: auto; }
  .chartwrap { padding: 8px 0 4px; }
  .chart-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
  .chart-title { font-size: 11px; font-weight: 700; color: #15233b; } .chart-title span { color: #94a3b8; font-weight: 500; }
  .legend { font-size: 9.5px; color: #64748b; display: flex; gap: 14px; }
  .leg { display: inline-flex; align-items: center; gap: 5px; } .leg i { width: 16px; height: 3px; display: inline-block; border-radius: 2px; }
  .leg-cash { background: #3f6aa3; } .leg-nf { background: #15233b; height: 3px; } .leg-band { height: 9px; background: rgba(225,0,32,0.16); } .leg-fc { background: repeating-linear-gradient(90deg,#64748b 0 4px,transparent 4px 7px); }
  .chart svg { display: block; width: 100%; }
  .paywrap { border-top: 1px solid #e9ecf1; margin-top: 8px; padding-top: 6px; }
  .paynote { font-size: 9.5px; line-height: 1.5; color: #64748b; margin-top: 3px; }
  .paynote b { color: #15233b; }
  .paynote--empty { font-style: italic; color: #94a3b8; padding: 10px 0; }
  .owe-head { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: #15233b; margin: 10px 0 1px; }
  .owe-head span { color: #94a3b8; font-weight: 500; text-transform: none; letter-spacing: 0; }
  .pending { color: #94a3b8; font-weight: 600; font-style: italic; font-size: 15px; }
  .strip { display: flex; border-top: 1px solid #e9ecf1; border-bottom: 1px solid #e9ecf1; }
  .stat { flex: 1; padding: 9px 16px; border-left: 1px solid #e9ecf1; } .stat:first-child { border-left: none; }
  .stat-l { font-size: 8.5px; letter-spacing: .5px; text-transform: uppercase; color: #64748b; font-weight: 700; }
  .stat-v { font-size: 19px; font-weight: 800; margin: 3px 0 2px; } .stat-v .arr { color: #94a3b8; font-weight: 400; margin: 0 6px; font-size: 15px; }
  .stat-n { font-size: 9px; color: #64748b; }
  .foot { display: flex; border-top: 1px solid #e9ecf1; border-bottom: 1px solid #e9ecf1; margin-top: 9px; }
  .foot-item { flex: 1; padding: 8px 16px; border-left: 1px solid #e9ecf1; } .foot-item:first-child { border-left: none; padding-left: 0; }
  .foot-label { font-size: 8.5px; letter-spacing: .5px; text-transform: uppercase; color: #64748b; font-weight: 700; }
  .foot-val { font-size: 18px; font-weight: 800; margin: 3px 0 2px; } .foot-val .sep { color: #cbd5e1; margin: 0 4px; font-weight: 400; } .foot-ccy { font-size: 11px; color: #94a3b8; font-weight: 600; }
  .foot-note { font-size: 9px; color: #64748b; }
  .foot-item--note { display: flex; flex-direction: column; justify-content: center; }
  .foot-note--lg { font-size: 10.5px; line-height: 1.5; margin-top: 2px; }
  .bl { margin-top: 11px; background: #15233b; border-radius: 6px; padding: 11px 16px; display: flex; align-items: baseline; gap: 12px; }
  .bl-tag { background: #E10020; color: #fff; font-size: 8.5px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; padding: 3px 8px; border-radius: 4px; white-space: nowrap; }
  .bl-text { color: #e8edf4; font-size: 12px; line-height: 1.5; } .bl-text b { color: #fff; } .bl-text b.neg { color: #ff6b81; } .bl-text b.pos { color: #34d399; }
</style></head><body>
  <div class="head">
    <div><h1>Group Cash Flow — ${ctx.scopeLabel} · ${ctx.year}</h1>
      <div class="sub">Actuals through ${ctx.asOfLabel} · forecast to year-end · figures in ${ctx.unit}${ctx.mode === 'group' && ctx.unit.startsWith('mixed') ? ' (native currencies summed — USD consolidation pending the FX layer)' : ''}</div></div>
    <div class="brand"><div class="brand-mark"><span class="glyph">C</span>CCC · Treasury</div><div class="asof">AS OF ${ctx.asOfLabel}</div></div>
  </div>

  <div class="hero">
    <div class="hero-eyebrow">Net liquid<br>funds</div>
    <div class="hero-pt"><div class="hero-num sm ${sign(d.nfOpen)}">${fM(d.nfOpen)}</div><div class="hero-cap">Start · Jan ${ctx.year}</div></div>
    <div class="hero-arrow">→</div>
    <div class="hero-pt"><div class="hero-num ${sign(d.nfNow)}">${fM(d.nfNow)}</div><div class="hero-cap">Today · ${ctx.asOfLabel}</div></div>
    <div class="hero-arrow">→</div>
    <div class="hero-pt"><div class="hero-num sm ${sign(d.nfEnd)}">${fM(d.nfEnd)}</div><div class="hero-cap">Forecast · Dec ${ctx.year}</div></div>
    <div class="hero-unit">${ctx.unit.replace(' millions', ' m')}</div>
    <div class="hero-swing"><div class="swing-num ${sign(fullSwing)}">${fMs(fullSwing)}</div><div class="swing-cap">${fullSwingCap} · cash less loans &amp; overdrafts</div></div>
  </div>

  <div class="chartwrap">
    <div class="chart-head"><div class="chart-title">The year's cash story <span>· cash held, financing, and the net position from the year's open to December</span></div>
      <div class="legend"><span class="leg"><i class="leg-cash"></i>Cash on hand</span><span class="leg"><i class="leg-nf"></i>Net liquid funds</span><span class="leg"><i class="leg-band"></i>Loans &amp; overdrafts</span><span class="leg"><i class="leg-fc"></i>Forecast</span></div></div>
    <div class="chart">${chart}</div>
  </div>

  <div class="chartwrap paywrap">
    <div class="chart-head"><div class="chart-title">Payables trajectory <span>· trade liabilities to suppliers &amp; subcontractors, by month</span></div></div>
    ${pt.unavailable
      ? `<div class="paynote paynote--empty">Payables trail unavailable for ${ctx.scopeLabel} — its books aren’t yet mapped to a cash-flow area (pending the canonical crosswalk). The Group view shows the full trajectory.</div>`
      : `<div class="chart">${payChart}</div><div class="paynote">${payablesCaveatHtml(pt, ctx.year, ctx.mode)}</div>`}
  </div>

  <div class="foot">
    <div class="foot-item foot-item--note">
      <div class="foot-label">Payables · suppliers &amp; subcontractors</div>
      <div class="foot-note foot-note--lg">${pt.unavailable
        ? 'No mapped books for this area — see the Group view'
        : `Now <b class="neg">${fM(Math.abs(pt.latestValue))}m</b> USD (${idxLabel(pt.latestIdx, ctx.year)}), from ${fM(Math.abs(pt.firstValue))}m at ${idxLabel(pt.firstIdx, ctx.year)} · monthly, from the Midas trial balance`}</div>
    </div>
    <div class="foot-item">
      <div class="foot-label">Full-year cash flow</div>
      <div class="foot-val"><span class="pos">${fM(d.recvFull)}</span> in <span class="sep">·</span> <span class="neg">${fM(Math.abs(d.payFull))}</span> out</div>
      <div class="foot-note">Net movement ${fMs(netFlow)} over ${ctx.year}</div>
    </div>
  </div>

  <div class="bl"><span class="bl-tag">Bottom line</span><span class="bl-text">${bottomLine(d, ctx.scopeLabel, pt, ctx.year)}</span></div>

  <script>window.onload = function () { window.print(); };</script>
</body></html>`
}
