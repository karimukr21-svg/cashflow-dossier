import { useState, useEffect } from 'react'

/* usePersistedState — useState whose value survives a component unmount/remount
   within the same browser tab (sessionStorage). The Manage panel mounts each
   sub-tab conditionally ({tab === 'runs' && <ImportRunsManager/>}), so switching
   to "Cycles & versions" — or any Treasury Workspace module — unmounts the runs
   manager and would otherwise reset which run is expanded, the filter, and each
   grid's year/compare view. Persisting the view state keeps the reviewer's place.

   sessionStorage (not localStorage) so it clears when the tab is closed — this is
   transient view state, not a saved preference. JSON-serialisable values only. */
export function usePersistedState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key)
      return raw != null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* quota / private-mode — view state is best-effort, never fatal */
    }
  }, [key, value])
  return [value, setValue]
}
