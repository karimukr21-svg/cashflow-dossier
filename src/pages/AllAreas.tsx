import { useEffect, useMemo, useState } from 'react'
import { fetchActuals, fetchForecasts, type CfCell } from '@/lib/queries'
import { AreaCategoryCards } from './AreaDrill'
import type { Scope } from './Dossier'

/* Consolidated Group view — sums the selected areas into one block,
 * renders the same category cards as the per-area drill. Area selection
 * is controlled via the topbar Areas chip; everything checked = full
 * group consolidation. */
export default function AllAreas({ scope }: { scope: Scope }) {
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

  const selectedSet = useMemo(() => new Set(scope.selectedAreas), [scope.selectedAreas])
  const filteredActuals = useMemo(() => actuals.filter(r => selectedSet.has(r.area)), [actuals, selectedSet])
  const filteredForecasts = useMemo(() => forecasts.filter(r => selectedSet.has(r.area)), [forecasts, selectedSet])

  if (loading) return <div className="placeholder-box">Loading…</div>

  const totalAreas = scope.areas.length
  const selectedCount = scope.selectedAreas.length
  const titleSuffix = selectedCount === totalAreas
    ? `all ${totalAreas} areas`
    : `${selectedCount} of ${totalAreas} areas`

  return (
    <div>
      <h1>Group consolidation</h1>
      <div style={{ marginTop: 4, color: 'var(--mute)', fontSize: 13 }}>
        Summing {titleSuffix}.
      </div>
      <div style={{ height: 16 }} />
      <AreaCategoryCards
        actuals={filteredActuals}
        forecasts={filteredForecasts}
        lines={scope.lines}
        grain={scope.grain}
        scope={scope}
        groupBy={scope.groupBy}
      />
    </div>
  )
}
