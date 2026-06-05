import { useEffect, useRef } from 'react'

/* Popover for the All Areas tab — select which areas roll up into the
 * consolidated block. Stores the EXCLUDED set in localStorage so areas
 * added later to the dossier default in (no need to remember to re-check
 * them after each canonical refresh). */
export default function AreaFilterPopover({
  areas, excluded, onChange, onClose,
}: {
  areas: string[];
  excluded: Set<string>;
  onChange: (next: Set<string>) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const toggle = (a: string) => {
    const next = new Set(excluded)
    if (next.has(a)) next.delete(a)
    else next.add(a)
    onChange(next)
  }

  const selectAll = () => onChange(new Set())
  const clearAll = () => onChange(new Set(areas))

  const selectedCount = areas.length - excluded.size

  return (
    <div className="area-filter-popover" ref={ref}>
      <div className="afp-header">
        <div className="afp-title">Areas in this view</div>
        <div className="afp-count">{selectedCount} of {areas.length}</div>
      </div>
      <div className="afp-actions">
        <button className="afp-link" onClick={selectAll} disabled={excluded.size === 0}>Select all</button>
        <span className="afp-sep">·</span>
        <button className="afp-link" onClick={clearAll} disabled={excluded.size === areas.length}>Clear</button>
      </div>
      <div className="afp-list">
        {areas.map(a => {
          const checked = !excluded.has(a)
          return (
            <label key={a} className={`afp-row ${checked ? '' : 'unchecked'}`}>
              <input type="checkbox" checked={checked} onChange={() => toggle(a)} />
              <span>{a}</span>
            </label>
          )
        })}
      </div>
    </div>
  )
}
