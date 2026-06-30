import type { NarrativeData } from './Narrative'

/* The cash bridge (waterfall) — the visual hero of the narrative. Shows the
 * cash POSITION journey at a readable scale (gross in/out dwarf the net
 * position for a contractor, so they're called out as labels, not bars):
 *   Started → Net so far → Now → Forecast → Year-end
 * Pure SVG string so the on-screen page and the print document share it. */

const f = (v: number | null | undefined): string => {
  if (v == null || isNaN(v)) return '—'
  const r = Math.round((v / 1e6) * 10) / 10
  if (r === 0) return '0.0'
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return r < 0 ? `(${s})` : s
}
const fSigned = (v: number): string => {
  const r = Math.round((v / 1e6) * 10) / 10
  if (r === 0) return '0.0'
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return r < 0 ? `−${s}` : `+${s}`
}

const INK = '#1a1a2e', SLATE = '#64748b', GOOD = '#057a55', BAD = '#E10020', GRID = '#e5e7eb'

export function buildBridgeSvg(d: NarrativeData): string {
  const opening = d.opening ?? 0, now = d.now ?? 0, yearEnd = d.yearEnd ?? 0
  type Step = { label: string; kind: 'anchor' | 'delta'; from: number; to: number; val: number; hi?: boolean; sub?: string }
  const steps: Step[] = [
    { label: 'Started', kind: 'anchor', from: 0, to: opening, val: opening },
    { label: 'Net so far', kind: 'delta', from: opening, to: now, val: now - opening,
      sub: `in ${f(d.recvYTD)} · out ${f(d.payYTD)}` },
    { label: 'Now', kind: 'anchor', from: 0, to: now, val: now, hi: true },
    { label: 'Forecast', kind: 'delta', from: now, to: yearEnd, val: yearEnd - now },
    { label: 'Year-end', kind: 'anchor', from: 0, to: yearEnd, val: yearEnd },
  ]

  const allV = [0, opening, now, yearEnd]
  let ymin = Math.min(...allV), ymax = Math.max(...allV)
  const pad = (ymax - ymin) * 0.14 || 1
  ymax += pad; ymin -= pad
  const range = (ymax - ymin) || 1

  const W = 1000, chartTop = 30, chartH = 168, labelY = chartTop + chartH + 4
  const colW = W / steps.length, barW = colW * 0.44
  const y = (v: number) => chartTop + ((ymax - v) / range) * chartH
  const zeroY = y(0)

  let svg = `<svg viewBox="0 0 ${W} 260" width="100%" preserveAspectRatio="xMidYMid meet" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`
  // zero baseline
  svg += `<line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`

  steps.forEach((s, i) => {
    const cx = i * colW + colW / 2
    const x = cx - barW / 2
    const lo = Math.min(s.from, s.to), hi = Math.max(s.from, s.to)
    const yTop = y(hi), barH = Math.max(1.5, y(lo) - y(hi))
    const color = s.kind === 'anchor' ? (s.hi ? INK : SLATE) : (s.val >= 0 ? GOOD : BAD)
    svg += `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" fill="${color}"${s.kind === 'anchor' && !s.hi ? ' opacity="0.85"' : ''}/>`

    // connector to next step at the carried level (s.to)
    if (i < steps.length - 1) {
      const ly = y(s.to)
      const nx = (i + 1) * colW + colW / 2 - barW / 2
      svg += `<line x1="${(x + barW).toFixed(1)}" y1="${ly.toFixed(1)}" x2="${nx.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="${SLATE}" stroke-width="1" stroke-dasharray="2,2" opacity="0.6"/>`
    }

    // value label (anchors: position; deltas: signed change), placed outside the bar
    const labelTxt = s.kind === 'anchor' ? f(s.val) : fSigned(s.val)
    const above = (s.kind === 'anchor' ? s.val : hi) >= 0
    const vy = above ? yTop - 7 : y(lo) + 15
    svg += `<text x="${cx.toFixed(1)}" y="${vy.toFixed(1)}" text-anchor="middle" font-size="15" font-weight="700" fill="${color}">${labelTxt}</text>`

    // category label
    svg += `<text x="${cx.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-size="12" font-weight="600" fill="${INK}">${s.label}</text>`
    if (s.sub) {
      svg += `<text x="${cx.toFixed(1)}" y="${(labelY + 15).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="${SLATE}">${s.sub}</text>`
    }
  })

  svg += `</svg>`
  return svg
}
