import { useEffect, useState } from 'react'
import { fetchActuals, fetchForecasts, type CfCell } from '@/lib/queries'
import { AreaCategoryCards } from './AreaDrill'
import type { Scope } from './Dossier'

/* Consolidated Group view — sums every area into one block, renders the
 * same category cards as the per-area drill. */
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

  if (loading) return <div className="placeholder-box">Loading…</div>

  return (
    <div>
      <h1>Group consolidation</h1>
      <div style={{ height: 16 }} />
      <AreaCategoryCards
        actuals={actuals}
        forecasts={forecasts}
        lines={scope.lines}
        grain={scope.grain}
        scope={scope}
      />
    </div>
  )
}
