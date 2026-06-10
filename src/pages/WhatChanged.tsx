import { useEffect, useMemo, useState } from 'react'
import {
  fetchForecasts, fetchVersions, fetchCashflowBridge,
  type CfCell, type CfVersion, type BridgeEntry,
} from '@/lib/queries'
import { fmt, classNum } from '@/lib/format'
import DivergingBars from '@/charts/DivergingBars'
import type { Scope } from './Dossier'

/* What Changed — cycle vs cycle
 * ─────────────────────────────
 * Answers: "what major shifts happened between one report and another, and
 * who are the biggest movers?"
 *
 * Compares two cf_forecasts versions over their common month window. Vintages
 * can be stored at different grains (cf_area vs cf_country), so both sides are
 * rolled up to canonical area level via the cashflow_sheets bridge before
 * comparison. Not scenario-aware by design — it compares saved cycles.
 */

type Props = { scope: Scope }

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const STOCK_LINES = new Set(['opening_balance', 'ending_balance', 'accum_loans', 'accum_od'])

function ymLabel(ym: number) { return `${MONTH_NAMES[(ym % 100) - 1]} ${Math.floor(ym / 100)}` }

export default function WhatChanged({ scope }: Props) {
  const [versions, setVersions] = useState<CfVersion[]>([])
  const [verA, setVerA] = useState<string | null>(null)  // baseline cycle
  const [verB, setVerB] = useState<string | null>(null)  // current cycle
  const [rowsA, setRowsA] = useState<CfCell[]>([])
  const [rowsB, setRowsB] = useState<CfCell[]>([])
  const [bridge, setBridge] = useState<Map<string, BridgeEntry> | null>(null)
  const [loading, setLoading] = useState(true)
  const [openArea, setOpenArea] = useState<string | null>(null)

  /* Version catalog + bridge, once */
  useEffect(() => {
    let cancel = false
    Promise.all([fetchVersions(), fetchCashflowBridge()]).then(([vs, br]) => {
      if (cancel) return
      setVersions(vs)
      setBridge(br)
      if (vs.length >= 2) {
        setVerB(scope.primaryVersion)
        const older = vs.find(v => v.version_code !== scope.primaryVersion)
        setVerA(older ? older.version_code : null)
      }
    })
    return () => { cancel = true }
  }, [scope.primaryVersion])

  /* Both versions' forecast rows over a wide window */
  useEffect(() => {
    if (!verA || !verB) return
    let cancel = false
    setLoading(true)
    Promise.all([
      fetchForecasts({ version: verA, fromYear: 2024, fromMonth: 1, toYear: 2029, toMonth: 12 }),
      fetchForecasts({ version: verB, fromYear: 2024, fromMonth: 1, toYear: 2029, toMonth: 12 }),
    ])
      .then(([a, b]) => {
        if (cancel) return
        setRowsA(a)
        setRowsB(b)
      })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [verA, verB])

  const lineByCode = useMemo(() => new Map(scope.lines.map(l => [l.line_code, l])), [scope.lines])

  const cmp = useMemo(() => {
    if (loading || !bridge || rowsA.length === 0 || rowsB.length === 0) return null

    /* Common month window — both cycles must cover a month for it to count */
    const ymsA = new Set(rowsA.map(r => r.year * 100 + r.month))
    const ymsB = new Set(rowsB.map(r => r.year * 100 + r.month))
    const common = [...ymsA].filter(ym => ymsB.has(ym)).sort((a, b) => a - b)
    if (common.length === 0) return null
    const commonSet = new Set(common)
    const lastYm = common[common.length - 1]

    type Acc = {
      netA: number; netB: number
      recA: number; recB: number
      payA: number; payB: number
      lines: Map<string, { a: number; b: number }>
    }
    const byArea = new Map<string, Acc>()
    const unmapped = new Set<string>()
    let endA = 0, endB = 0

    const process = (r: CfCell, side: 'a' | 'b') => {
      const ym = r.year * 100 + r.month
      if (!commonSet.has(ym)) return
      if (r.line_code === 'ending_balance') {
        if (ym === lastYm) { if (side === 'a') endA += r.value; else endB += r.value }
        return
      }
      if (STOCK_LINES.has(r.line_code)) return
      const entry = bridge.get(r.area)
      if (!entry) { unmapped.add(r.area); return }
      let acc = byArea.get(entry.area_id)
      if (!acc) {
        acc = { netA: 0, netB: 0, recA: 0, recB: 0, payA: 0, payB: 0, lines: new Map() }
        byArea.set(entry.area_id, acc)
      }
      const nature = lineByCode.get(r.line_code)?.nature
      if (side === 'a') {
        acc.netA += r.value
        if (nature === 'Receipts') acc.recA += r.value
        if (nature === 'Payments') acc.payA += r.value
      } else {
        acc.netB += r.value
        if (nature === 'Receipts') acc.recB += r.value
        if (nature === 'Payments') acc.payB += r.value
      }
      let lc = acc.lines.get(r.line_code)
      if (!lc) { lc = { a: 0, b: 0 }; acc.lines.set(r.line_code, lc) }
      if (side === 'a') lc.a += r.value; else lc.b += r.value
    }
    for (const r of rowsA) process(r, 'a')
    for (const r of rowsB) process(r, 'b')

    const labelByAreaId = new Map<string, { label: string; sort: number }>()
    for (const e of bridge.values()) labelByAreaId.set(e.area_id, { label: e.area_label, sort: e.sort_order })

    const movers = [...byArea.entries()]
      .map(([areaId, acc]) => ({
        areaId,
        label: labelByAreaId.get(areaId)?.label ?? areaId,
        delta: acc.netB - acc.netA,
        acc,
      }))
      .filter(m => Math.abs(m.delta) > 0.5)
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))

    let totRecA = 0, totRecB = 0, totPayA = 0, totPayB = 0, totNetA = 0, totNetB = 0
    for (const acc of byArea.values()) {
      totRecA += acc.recA; totRecB += acc.recB
      totPayA += acc.payA; totPayB += acc.payB
      totNetA += acc.netA; totNetB += acc.netB
    }

    return {
      common, lastYm, movers, unmapped: [...unmapped],
      endA, endB,
      totRecA, totRecB, totPayA, totPayB, totNetA, totNetB,
    }
  }, [loading, bridge, rowsA, rowsB, lineByCode])

  if (loading && !cmp) return <div className="placeholder-box">Loading…</div>
  if (versions.length < 2) return <div className="placeholder-box">Need at least two forecast cycles to compare.</div>

  const windowLabel = cmp ? `${ymLabel(cmp.common[0])} – ${ymLabel(cmp.lastYm)}` : ''
  const openMover = cmp?.movers.find(m => m.areaId === openArea) || null

  return (
    <div className="heatmap-page">
      <h1>What Changed</h1>
      <div className="heatmap-subtitle">
        Cycle-over-cycle shifts, rolled up to canonical areas · common window {windowLabel}
      </div>

      <div className="wc-controls">
        <select value={verA ?? ''} onChange={e => { setVerA(e.target.value); setOpenArea(null) }}>
          {versions.map(v => <option key={v.version_code} value={v.version_code}>{v.version_code}</option>)}
        </select>
        <span className="wc-arrow">→</span>
        <select value={verB ?? ''} onChange={e => { setVerB(e.target.value); setOpenArea(null) }}>
          {versions.map(v => <option key={v.version_code} value={v.version_code}>{v.version_code}</option>)}
        </select>
      </div>

      {!cmp && <div className="placeholder-box">The selected cycles share no common months.</div>}

      {cmp && (
        <>
          <div className="heatmap-kpis">
            <div className="heatmap-kpi">
              <div className="heatmap-kpi-label">Δ Ending cash · {ymLabel(cmp.lastYm)}</div>
              <div className={`heatmap-kpi-value ${cmp.endB - cmp.endA >= 0 ? 'pos' : 'neg'}`}>{fmt(cmp.endB - cmp.endA)}</div>
            </div>
            <div className="heatmap-kpi">
              <div className="heatmap-kpi-label">Δ Net flows · window</div>
              <div className={`heatmap-kpi-value ${cmp.totNetB - cmp.totNetA >= 0 ? 'pos' : 'neg'}`}>{fmt(cmp.totNetB - cmp.totNetA)}</div>
            </div>
            <div className="heatmap-kpi">
              <div className="heatmap-kpi-label">Δ Receipts</div>
              <div className={`heatmap-kpi-value ${cmp.totRecB - cmp.totRecA >= 0 ? 'pos' : 'neg'}`}>{fmt(cmp.totRecB - cmp.totRecA)}</div>
            </div>
            <div className="heatmap-kpi">
              <div className="heatmap-kpi-label">Δ Payments</div>
              <div className={`heatmap-kpi-value ${cmp.totPayB - cmp.totPayA >= 0 ? 'pos' : 'neg'}`}>{fmt(cmp.totPayB - cmp.totPayA)}</div>
            </div>
          </div>

          <div className="sum-section">
            <h3>Biggest movers · Δ net cash flow ({verA} → {verB})</h3>
            <DivergingBars
              rows={cmp.movers.map(m => ({
                key: m.areaId,
                label: m.label,
                neg: m.delta < 0 ? Math.abs(m.delta) : 0,
                pos: m.delta > 0 ? m.delta : 0,
                net: m.delta,
                active: m.areaId === openArea,
                onClick: () => setOpenArea(openArea === m.areaId ? null : m.areaId),
              }))}
              negHeader="Deteriorated"
              posHeader="Improved"
              showNet
            />
          </div>

          {openMover && (
            <div className="sum-section">
              <h3>{openMover.label} — what drove the {fmt(openMover.delta)} shift</h3>
              <table className="cf-table wc-lines" style={{ maxWidth: 640 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Line</th>
                    <th>{verA}</th>
                    <th>{verB}</th>
                    <th>Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {[...openMover.acc.lines.entries()]
                    .map(([code, v]) => ({ code, ...v, d: v.b - v.a }))
                    .filter(l => Math.abs(l.d) > 0.5)
                    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
                    .slice(0, 14)
                    .map(l => {
                      const line = lineByCode.get(l.code)
                      return (
                        <tr key={l.code}>
                          <td style={{ textAlign: 'left' }}>{line ? `${line.category} · ${line.description}` : l.code}</td>
                          <td className={classNum(l.a)}>{fmt(l.a)}</td>
                          <td className={classNum(l.b)}>{fmt(l.b)}</td>
                          <td className={classNum(l.d)}>{fmt(l.d)}</td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
          )}

          {cmp.unmapped.length > 0 && (
            <div className="heatmap-subtitle" style={{ marginTop: 16 }}>
              Excluded (no canonical mapping): {cmp.unmapped.join(', ')}
            </div>
          )}
        </>
      )}
    </div>
  )
}
