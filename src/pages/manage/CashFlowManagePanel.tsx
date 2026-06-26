import { useState } from 'react'
import { useRole, canManageCashFlow } from '@/lib/role'
import ImportRunsManager from './ImportRunsManager'
import CycleVersionManager from './CycleVersionManager'
import LabelsManager from './LabelsManager'
import './cashflow-manage.css'

// Manage mode (Treasury) — the single home, ported from the work dashboard (S8).
//   Import runs       — upload an area file -> stage + reconcile -> push as a version
//   Cycles & versions — manage versions in each cycle, set current/final, publish
//
// Mutations (upload / push / publish) are also enforced by RLS (cf_ tables are
// super-admin write); the role gate just hides the controls for non-Treasury users.
const TABS = [
  { key: 'runs', label: 'Import runs' },
  { key: 'versions', label: 'Cycles & versions' },
  { key: 'labels', label: 'Labels & mappings' },
]

export default function CashFlowManagePanel() {
  const role = useRole()
  const canManage = canManageCashFlow(role)
  const [tab, setTab] = useState('runs')

  return (
    <div className="cfm-panel">
      {!canManage && (
        <div className="cfm-head">
          <span className="cfm-readonly" title="Treasury or admin role required">
            Read-only — push / publish need the Treasury role
          </span>
        </div>
      )}

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
      {tab === 'labels' && <LabelsManager canManage={canManage} />}
    </div>
  )
}
