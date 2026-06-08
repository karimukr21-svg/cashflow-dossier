import { useEffect, useRef, useState } from 'react'
import { useScenario } from '../lib/ScenarioContext'
import {
  createScenario, fetchScenarioList, logEvent,
  type ScenarioListRow,
} from '../lib/scenario'

type Props = {
  primaryVersionCode: string  // active cf_versions baseline (used for + New)
}

export function ScenarioPill({ primaryVersionCode }: Props) {
  const { activeId, savedScenario, baselineVersionCode, loadScenario, exitToBaseline, workingDelta } = useScenario()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<ScenarioListRow[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const popRef = useRef<HTMLDivElement>(null)

  const isActive = activeId !== 'baseline'
  const pillLabel = isActive
    ? `Scenario · ${savedScenario?.name || 'Loading…'}`
    : 'Scenario · Baseline'
  const unsavedCount = workingDelta.cells.length
  const showUnsavedDot = isActive && unsavedCount > 0

  /* Refresh the list on every open so newly-saved scenarios appear. */
  useEffect(() => {
    if (!open) return
    let cancel = false
    fetchScenarioList().then(r => { if (!cancel) setList(r) }).catch(console.warn)
    return () => { cancel = true }
  }, [open])

  /* Outside-click close. */
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!popRef.current) return
      if (!popRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  const onCreate = async () => {
    const name = newName.trim()
    if (!name) return
    const baseline = baselineVersionCode || primaryVersionCode
    if (!baseline) {
      alert('No baseline version available to pin scenario to.')
      return
    }
    try {
      const s = await createScenario({
        name,
        baseline_version_code: baseline,
        delta_payload: { cells: [], bulk_actions: [] },
      })
      logEvent('save', { scenario_id: s.id, meta: { kind: 'create' } })
      setNewName('')
      setCreating(false)
      await loadScenario(s.id)
      setOpen(false)
    } catch (e: any) {
      alert('Create failed: ' + (e?.message || e))
    }
  }

  const grouped = list.reduce<Map<string, ScenarioListRow[]>>((m, r) => {
    const k = r.baseline_version_code
    if (!m.has(k)) m.set(k, [])
    m.get(k)!.push(r)
    return m
  }, new Map())

  return (
    <div className="scenario-pill-wrap">
      <button
        className={`scenario-pill ${isActive ? 'active' : ''}`}
        onClick={() => setOpen(o => !o)}
        title={isActive ? `Active scenario based on ${baselineVersionCode}` : 'Open scenario menu'}
      >
        {pillLabel}
        {showUnsavedDot && <span className="scenario-pill-dot" title={`${unsavedCount} unsaved cells`}>•</span>}
      </button>

      {open && (
        <div className="scenario-pop" ref={popRef}>
          <button
            className={`scenario-pop-row ${activeId === 'baseline' ? 'selected' : ''}`}
            onClick={() => { exitToBaseline(); setOpen(false) }}
          >
            <span>Baseline</span>
            {activeId === 'baseline' && <span className="scenario-pop-check">●</span>}
          </button>

          {!creating ? (
            <button className="scenario-pop-row scenario-pop-new" onClick={() => setCreating(true)}>
              <span>+ New scenario…</span>
            </button>
          ) : (
            <div className="scenario-pop-new-form">
              <input
                autoFocus
                className="scenario-pop-input"
                placeholder={`<theme> · ${primaryVersionCode} · Karim`}
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') onCreate(); if (e.key === 'Escape') setCreating(false) }}
              />
              <div className="scenario-pop-new-actions">
                <button onClick={onCreate} disabled={!newName.trim()}>Create</button>
                <button onClick={() => { setCreating(false); setNewName('') }}>Cancel</button>
              </div>
            </div>
          )}

          {grouped.size > 0 && (
            <>
              <div className="scenario-pop-divider">Saved</div>
              {[...grouped.entries()].map(([baseline, rows]) => (
                <div key={baseline}>
                  <div className="scenario-pop-baseline">Baseline {baseline}</div>
                  {rows.map(r => (
                    <button
                      key={r.id}
                      className={`scenario-pop-row ${activeId === r.id ? 'selected' : ''} ${!r.is_active ? 'inactive' : ''}`}
                      onClick={() => { loadScenario(r.id); setOpen(false) }}
                      title={r.final_label ? `Final: ${r.final_label}` : ''}
                    >
                      <span className="scenario-pop-name">{r.name}</span>
                      <span className="scenario-pop-meta">
                        {r.delta_cell_count} Δ {r.final_label && <span className="scenario-pop-final">{r.final_label}</span>}
                      </span>
                      {activeId === r.id && <span className="scenario-pop-check">●</span>}
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}

          <div className="scenario-pop-divider">Manage</div>
          <a
            className="scenario-pop-row scenario-pop-link"
            href={import.meta.env.VITE_WORK_DASHBOARD_URL || '#'}
            target="_blank"
            rel="noreferrer"
            onClick={e => {
              if (!import.meta.env.VITE_WORK_DASHBOARD_URL) {
                e.preventDefault()
                alert('Manage in work dashboard → /intake?source=_cf_versions')
              }
            }}
          >
            Open Manage Scenarios →
          </a>
        </div>
      )}
    </div>
  )
}
