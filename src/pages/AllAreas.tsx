import { useEffect, useMemo, useState } from 'react'
import { fetchActuals, fetchForecasts, type CfCell } from '@/lib/queries'
import AllAreasPivot from './AllAreasPivot'
import type { Scope } from './Dossier'

/* Consolidated Group view — sums the selected areas into one block,
 * pivots by the chip ordering (`ord` in scope). Area selection is still
 * controlled via the topbar Areas chip; the pivot operates over the
 * resulting `scope.selectedAreas` set. */
export default function AllAreas({ scope, onSelectArea }: { scope: Scope; onSelectArea: (areaId: string) => void }) {
  const [actuals, setActuals] = useState<(CfCell & { source_version: string })[]>([])
  const [forecasts, setForecasts] = useState<(CfCell & { version: string })[]>([])
  const [loading, setLoading] = useState(true)

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
        Summing {titleSuffix} · grouped {ordPretty}.
      </div>
      <div style={{ height: 16 }} />
      <AllAreasPivot
        actuals={filteredActuals}
        forecasts={filteredForecasts}
        lines={scope.lines}
        scope={scope}
        areas={scope.selectedAreas}
        onSelectArea={onSelectArea}
      />
    </div>
  )
}
