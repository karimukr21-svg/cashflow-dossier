import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchActuals, fetchForecasts, fetchFxRate, type CfCell } from '@/lib/queries'
import AllAreasPivot from './AllAreasPivot'
import { DispFmtCtx, makeDisp, DENOM, type Denom, useTopbarExtras } from '@/lib/displayFmt'
import type { Scope } from './Dossier'

/* Consolidated Group view — sums the selected areas into one block,
 * pivots by the chip ordering (`ord` in scope). Area selection is still
 * controlled via the topbar Areas chip; the pivot operates over the
 * resulting `scope.selectedAreas` set. */
export default function AllAreas({ scope, onSelectArea }: { scope: Scope; onSelectArea: (areaId: string) => void }) {
  const [actuals, setActuals] = useState<(CfCell & { source_version: string; currency?: string })[]>([])
  const [forecasts, setForecasts] = useState<(CfCell & { version: string; currency?: string })[]>([])
  const [fxMap, setFxMap] = useState<Map<string, number | null>>(new Map())
  const [loading, setLoading] = useState(true)

  // Denomination toggle (Millions / '000 / Units) — a display divisor. Every area
  // is FX-converted to USD before summing (rate at the version's as-of), so the
  // consolidation is a single currency. Shares the per-area page's denom key.
  const [denom, setDenom] = useState<Denom>(() => (localStorage.getItem('dossier-area-denom-v1') as Denom) || 'u')
  useEffect(() => { try { localStorage.setItem('dossier-area-denom-v1', denom) } catch { /* ignore */ } }, [denom])
  const disp = useMemo(() => makeDisp(1, denom), [denom])
  const slot = useTopbarExtras()
  const controls = (
    <>
      <div className="ctrl" style={{ marginLeft: 8 }}><label>Units</label></div>
      <div className="pill-row">
        {(['m', 'k', 'u'] as Denom[]).map(d => (
          <button key={d} className={`pill-btn ${denom === d ? 'active' : ''}`} onClick={() => setDenom(d)}>{DENOM[d].btn}</button>
        ))}
      </div>
    </>
  )

  useEffect(() => {
    let cancel = false
    setLoading(true)
    ;(async () => {
      try {
        const [a, f] = await Promise.all([
          fetchActuals({ fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth }),
          fetchForecasts({ version: scope.primaryVersion, fromYear: scope.fromYear, fromMonth: scope.fromMonth, toYear: scope.toYear, toMonth: scope.toMonth }),
        ])
        if (cancel) return
        setActuals(a); setForecasts(f)
        // Build the currency → USD-per-unit map (USD = 1; a currency with no rate
        // in gacc.fx_rates resolves to null and its area is excluded + flagged).
        const curs = [...new Set([...a, ...f].map(c => c.currency).filter(Boolean))] as string[]
        const asOfDate = scope.versions.find(v => v.version_code === scope.primaryVersion)?.as_of_date
          || `${scope.toYear}-${String(scope.toMonth).padStart(2, '0')}-01`
        const entries = await Promise.all(curs.map(async c =>
          [c, c === 'USD' ? 1 : await fetchFxRate(c, asOfDate)] as const))
        if (!cancel) setFxMap(new Map(entries))
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [scope.primaryVersion, scope.fromYear, scope.fromMonth, scope.toYear, scope.toMonth])

  /* Each canonical area carries the cf_areas it folds; union them into one
   * lookup set so cf_actuals rows resolve to "selected or not" in one pass. */
  const cfAreaAllowed = useMemo(() => {
    const set = new Set<string>()
    for (const a of scope.selectedAreas) for (const cf of a.cf_areas) set.add(cf)
    return set
  }, [scope.selectedAreas])
  const filteredActuals = useMemo(() => actuals.filter(r => cfAreaAllowed.has(r.area)), [actuals, cfAreaAllowed])
  const filteredForecasts = useMemo(() => forecasts.filter(r => cfAreaAllowed.has(r.area)), [forecasts, cfAreaAllowed])

  /* Convert every cell to USD (value × the currency's rate) before the pivot sums
   * them. USD → 1. A currency with no rate (null) can't be consolidated, so its
   * rows are dropped and the area is flagged below. */
  const { usdActuals, usdForecasts, excluded } = useMemo(() => {
    const excluded = new Set<string>()
    const conv = <T extends CfCell & { currency?: string }>(rows: T[]): T[] => {
      const out: T[] = []
      for (const r of rows) {
        const rate = (r.currency || 'USD') === 'USD' ? 1 : (fxMap.get(r.currency || '') ?? null)
        if (rate == null) { excluded.add(r.area); continue }
        out.push({ ...r, value: r.value * rate })
      }
      return out
    }
    return { usdActuals: conv(filteredActuals), usdForecasts: conv(filteredForecasts), excluded }
  }, [filteredActuals, filteredForecasts, fxMap])

  if (loading) return <div className="placeholder-box">Loading…</div>

  const totalAreas = scope.areas.length
  const selectedCount = scope.selectedAreas.length
  const titleSuffix = selectedCount === totalAreas
    ? `all ${totalAreas} areas`
    : `${selectedCount} of ${totalAreas} areas`

  /* The ORD chip control sits in the topbar (Dossier.tsx). This page just
   * passes scope.ord through to the pivot renderer. */
  const ordPretty = scope.ord.split('').map(c => ({ A: 'Area', N: 'Nature', C: 'Category' }[c])).join(' ▸ ')

  return (
    <div>
      <h1>Group consolidation</h1>
      <div style={{ marginTop: 4, color: 'var(--mute)', fontSize: 13 }}>
        Summing {titleSuffix} · USD · grouped {ordPretty}.
        {excluded.size > 0 && (
          <span style={{ color: 'var(--warn, #c0842b)' }}>
            {' '}· excluded (no FX rate): {[...excluded].join(', ')}
          </span>
        )}
      </div>
      {slot ? createPortal(controls, slot) : <div className="area-toolbar no-print">{controls}</div>}
      <div style={{ height: 16 }} />
      <DispFmtCtx.Provider value={disp}>
        <AllAreasPivot
          actuals={usdActuals}
          forecasts={usdForecasts}
          lines={scope.lines}
          scope={scope}
          areas={scope.selectedAreas}
          onSelectArea={onSelectArea}
        />
      </DispFmtCtx.Provider>
    </div>
  )
}
