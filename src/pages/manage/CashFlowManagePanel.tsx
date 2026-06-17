import { useState } from 'react'
import { useRole, canManageCashFlow } from '@/lib/role'
import ImportRunsManager from './ImportRunsManager'
import CycleVersionManager from './CycleVersionManager'
import AdjustForecasts from './AdjustForecasts'
import ForecastLogs from './ForecastLogs'
import './cashflow-manage.css'

// Manage mode (Treasury) — the single home, ported from the work dashboard (S8).
//   Import runs       — upload an area file -> stage + reconcile -> push as a version
//   Cycles & versions — manage versions in each cycle, set current/final, publish
//   Adjust            — edit forecast cells in place (audited) + freeze a labeled version
//   Logs              — upload + forecast-edit audit trail, filterable by cycle/version
//
// Mutations (upload / push / publish / edit / freeze) are also enforced by RLS (cf_
// tables are super-admin write); the role gate just hides the controls for non-Treasury users.
const TABS = [
  { key: 'runs', label: 'Import runs' },
  { key: 'versions', label: 'Cycles & versions' },
  { key: 'adjust', label: 'Adjust' },
  { key: 'logs', label: 'Logs' },
]

export default function CashFlowManagePanel() {
  const role = useRole()
  const canManage = canManageCashFlow(role)
  const [tab, setTab] = useState('runs')

  return (
    <div className="cfm-panel">
      <div className="cfm-head">
        <div>
          <h2 className="cfm-title">Manage Cash Flow — Treasury</h2>
          <p className="cfm-sub">
            Upload area files, reconcile to AREA TOTAL, push as a cycle version, then
            publish into the continuous actuals series.
          </p>
        </div>
        {!canManage && (
          <span className="cfm-readonly" title="Treasury or admin role required">
            Read-only — push / publish need the Treasury role
          </span>
        )}
      </div>

      <div className="cfm-tabs" role="tablist">
        {TABS.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`cfm-tab ${tab === t.key ? 'is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'runs' && <ImportRunsManager canManage={canManage} />}
      {tab === 'versions' && <CycleVersionManager canManage={canManage} />}
      {tab === 'adjust' && <AdjustForecasts canManage={canManage} />}
      {tab === 'logs' && <ForecastLogs />}
    </div>
  )
}
