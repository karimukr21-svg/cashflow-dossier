/* ScenarioContext — Step 3 plumbing (no UI surface yet).
 *
 * Three-layer state:
 *   1. baseline (cf_versions vintage)   — read from DB, not stored here
 *   2. savedScenario                     — fetched on Load, persisted on Save
 *   3. workingDelta                      — live edits in localStorage
 *
 * localStorage keys (per plan):
 *   cfd_active_scenario_id              → uuid or 'baseline'
 *   cfd_working_delta                   → JSON of unsaved cell/bulk_action changes
 *   cfd_active_baseline_version_code    → version_code mirror (renamed from _id)
 *   cfd_working_draft_<scenario_id>     → crash-recovery slot, 30s autosave
 *
 * Hydration is synchronous in useState initializers so first paint already
 * reflects the active scenario — no baseline-flash on reload.
 *
 * No save/load/discard UI is wired in Step 3 — that's Step 4+. The context
 * just exposes the actions so Step 4 can plug into them without re-doing
 * the state model.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import {
  buildDeltaIndex, EMPTY_DELTA, fetchScenario, logEvent,
  type DeltaIndex, type DeltaPayload, type SavedScenario,
} from './scenario'

const LS = {
  activeId: 'cfd_active_scenario_id',
  workingDelta: 'cfd_working_delta',
  baselineCode: 'cfd_active_baseline_version_code',
  draft: (scenarioId: string) => `cfd_working_draft_${scenarioId}`,
} as const

const AUTOSAVE_INTERVAL_MS = 30_000

/* ── Hydration helpers (synchronous, only run on mount) ─────────────────── */

function readActiveId(): string {
  /* URL param wins over LS — lets the Manage tab in the work dashboard
   * deep-link to a specific scenario by appending ?scenarioId=<uuid>. */
  try {
    const sp = new URLSearchParams(window.location.search)
    const urlId = sp.get('scenarioId')
    if (urlId) return urlId
  } catch {}
  try {
    const v = localStorage.getItem(LS.activeId)
    return v || 'baseline'
  } catch { return 'baseline' }
}

function readWorkingDelta(): DeltaPayload {
  try {
    const raw = localStorage.getItem(LS.workingDelta)
    if (!raw) return EMPTY_DELTA
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return EMPTY_DELTA
    return {
      cells: Array.isArray(parsed.cells) ? parsed.cells : [],
      bulk_actions: Array.isArray(parsed.bulk_actions) ? parsed.bulk_actions : [],
    }
  } catch { return EMPTY_DELTA }
}

function readBaselineCode(): string | null {
  try { return localStorage.getItem(LS.baselineCode) } catch { return null }
}

function readDraftFor(scenarioId: string): { payload: DeltaPayload; savedAt: string } | null {
  try {
    const raw = localStorage.getItem(LS.draft(scenarioId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.payload || !parsed?.savedAt) return null
    return parsed
  } catch { return null }
}

/* ── Context shape ──────────────────────────────────────────────────────── */

type ScenarioState = {
  activeId: string                    // 'baseline' or scenario uuid
  baselineVersionCode: string | null  // mirrors saved scenario's baseline
  workingDelta: DeltaPayload          // live, includes unsaved edits
  savedScenario: SavedScenario | null // last loaded DB row
  recoveryDraft: { payload: DeltaPayload; savedAt: string } | null
  loadingScenario: boolean
}

type ScenarioActions = {
  /** Load a saved scenario by id and make it active. */
  loadScenario(id: string): Promise<void>
  /** Drop back to baseline view. Working delta is preserved on disk — caller
   *  must confirm + clear separately if a "discard" is intended. */
  exitToBaseline(): void
  /** Replace the working delta wholesale. Used by bulk-ops + cell edits. */
  setWorkingDelta(next: DeltaPayload): void
  /** Reset working delta back to the saved scenario's payload (or empty). */
  resetWorking(): void
  /** Accept / discard the recovery draft surfaced on mount. */
  acceptRecoveryDraft(): void
  discardRecoveryDraft(): void
  /** Recompute indexes after caller mutates via setWorkingDelta — exposed
   *  in case Step 4+ needs them directly. */
  workingIndex: DeltaIndex
  savedIndex: DeltaIndex
}

type ScenarioContextValue = ScenarioState & ScenarioActions

const ScenarioContext = createContext<ScenarioContextValue | null>(null)

/* ── Provider ───────────────────────────────────────────────────────────── */

export function ScenarioProvider({ children }: { children: ReactNode }) {
  /* Synchronous hydration — runs before first render. */
  const [activeId, setActiveId] = useState<string>(() => readActiveId())
  const [baselineVersionCode, setBaselineVersionCode] = useState<string | null>(() => readBaselineCode())
  const [workingDelta, setWorkingDeltaState] = useState<DeltaPayload>(() => readWorkingDelta())
  const [savedScenario, setSavedScenario] = useState<SavedScenario | null>(null)
  const [loadingScenario, setLoadingScenario] = useState<boolean>(activeId !== 'baseline')
  const [recoveryDraft, setRecoveryDraft] = useState<{ payload: DeltaPayload; savedAt: string } | null>(null)

  /* Persist activeId + baselineVersionCode whenever they change. workingDelta
   * gets its own persistence path (on every mutation via setWorkingDelta). */
  useEffect(() => {
    try {
      if (activeId === 'baseline') localStorage.removeItem(LS.activeId)
      else localStorage.setItem(LS.activeId, activeId)
    } catch {}
  }, [activeId])

  useEffect(() => {
    try {
      if (!baselineVersionCode) localStorage.removeItem(LS.baselineCode)
      else localStorage.setItem(LS.baselineCode, baselineVersionCode)
    } catch {}
  }, [baselineVersionCode])

  /* On mount: if activeId points at a saved scenario, fetch it AND check the
   * crash-recovery draft slot. The recovery prompt fires only when the draft
   * is newer than the DB's updated_at — handled by checking savedAt vs
   * savedScenario.updated_at after fetch. */
  useEffect(() => {
    if (activeId === 'baseline') {
      setSavedScenario(null)
      setLoadingScenario(false)
      return
    }
    let cancel = false
    setLoadingScenario(true)
    fetchScenario(activeId)
      .then(s => {
        if (cancel) return
        if (!s) {
          /* Saved scenario disappeared — fall back to baseline cleanly. */
          setActiveId('baseline')
          setBaselineVersionCode(null)
          setSavedScenario(null)
          return
        }
        setSavedScenario(s)
        setBaselineVersionCode(s.baseline_version_code)
        const draft = readDraftFor(s.id)
        if (draft && new Date(draft.savedAt).getTime() > new Date(s.updated_at).getTime()) {
          setRecoveryDraft(draft)
        }
        logEvent('open', { scenario_id: s.id })
      })
      .catch(err => {
        console.warn('Failed to load scenario', err)
        if (!cancel) setActiveId('baseline')
      })
      .finally(() => { if (!cancel) setLoadingScenario(false) })
    return () => { cancel = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  /* setWorkingDelta wrapper persists synchronously to LS so a reload
   * mid-edit doesn't lose data (this is on top of the 30s autosave). */
  const setWorkingDelta = useCallback((next: DeltaPayload) => {
    setWorkingDeltaState(next)
    try {
      if (next.cells.length === 0 && next.bulk_actions.length === 0) {
        localStorage.removeItem(LS.workingDelta)
      } else {
        localStorage.setItem(LS.workingDelta, JSON.stringify(next))
      }
    } catch {}
  }, [])

  /* 30s crash-recovery autosave to a per-scenario slot. Distinct from the
   * always-current workingDelta slot — the draft is a checkpoint that
   * survives a Save-to-DB roundtrip; workingDelta gets cleared on Save. */
  const draftSlotRef = useRef<string | null>(null)
  draftSlotRef.current = activeId === 'baseline' ? null : LS.draft(activeId)
  useEffect(() => {
    const tick = () => {
      const slot = draftSlotRef.current
      if (!slot) return
      if (workingDelta.cells.length === 0 && workingDelta.bulk_actions.length === 0) return
      try {
        localStorage.setItem(slot, JSON.stringify({
          payload: workingDelta,
          savedAt: new Date().toISOString(),
        }))
      } catch {}
    }
    const id = window.setInterval(tick, AUTOSAVE_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [workingDelta])

  /* Multi-tab sync (v1: last-write-wins). Storage events fire in OTHER tabs
   * when this tab writes. We listen + re-hydrate the touched keys. */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS.workingDelta) {
        setWorkingDeltaState(readWorkingDelta())
      } else if (e.key === LS.activeId) {
        const next = readActiveId()
        if (next !== activeId) setActiveId(next)
      } else if (e.key === LS.baselineCode) {
        setBaselineVersionCode(readBaselineCode())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [activeId])

  /* ── Actions ──────────────────────────────────────────────────────────── */

  const loadScenario = useCallback(async (id: string) => {
    setActiveId(id)
    /* Working delta is NOT cleared automatically on load — the recovery
     * prompt will surface mid-flight changes. Caller can clear via
     * setWorkingDelta(EMPTY_DELTA) if a clean load is wanted. */
  }, [])

  const exitToBaseline = useCallback(() => {
    setActiveId('baseline')
    setBaselineVersionCode(null)
    setSavedScenario(null)
    setWorkingDelta(EMPTY_DELTA)
  }, [setWorkingDelta])

  const resetWorking = useCallback(() => {
    setWorkingDelta(savedScenario?.delta_payload ?? EMPTY_DELTA)
  }, [savedScenario, setWorkingDelta])

  const acceptRecoveryDraft = useCallback(() => {
    if (!recoveryDraft) return
    setWorkingDelta(recoveryDraft.payload)
    setRecoveryDraft(null)
  }, [recoveryDraft, setWorkingDelta])

  const discardRecoveryDraft = useCallback(() => {
    if (!recoveryDraft || activeId === 'baseline') { setRecoveryDraft(null); return }
    try { localStorage.removeItem(LS.draft(activeId)) } catch {}
    setRecoveryDraft(null)
  }, [recoveryDraft, activeId])

  /* ── Memoized indexes for fast per-cell lookup ────────────────────────── */

  const workingIndex = useMemo(() => buildDeltaIndex(workingDelta), [workingDelta])
  const savedIndex = useMemo(
    () => buildDeltaIndex(savedScenario?.delta_payload ?? null),
    [savedScenario],
  )

  const value: ScenarioContextValue = {
    activeId,
    baselineVersionCode,
    workingDelta,
    savedScenario,
    recoveryDraft,
    loadingScenario,
    loadScenario,
    exitToBaseline,
    setWorkingDelta,
    resetWorking,
    acceptRecoveryDraft,
    discardRecoveryDraft,
    workingIndex,
    savedIndex,
  }

  return <ScenarioContext.Provider value={value}>{children}</ScenarioContext.Provider>
}

export function useScenario(): ScenarioContextValue {
  const ctx = useContext(ScenarioContext)
  if (!ctx) throw new Error('useScenario must be used within <ScenarioProvider>')
  return ctx
}

/* Per-cell active value. Caller passes the baseline value (already in hand
 * from the cf_actuals/cf_forecasts fetch). The hook layers working + saved
 * deltas on top. Cheap — index lookups are O(1) after memo. */
export function useScenarioCell(
  area: string,
  line_code: string,
  year: number,
  month: number,
  baseline_value: number,
): number {
  const { workingIndex, savedIndex } = useScenario()
  const key = `${area}${line_code}${year}${month}`
  const w = workingIndex.get(key)
  if (w !== undefined) return w
  const s = savedIndex.get(key)
  if (s !== undefined) return s
  return baseline_value
}
