import { useEffect, useMemo, useRef } from 'react'
import type { CanonicalArea, AreaGroup } from '@/lib/queries'

/* Popover for the All Areas tab — select which canonical areas roll up
 * into the consolidated block. Stores the EXCLUDED area_id set in
 * localStorage so areas added later default in (no need to remember to
 * re-check them after each canonical refresh).
 *
 * Renders the list grouped by canonical group_name (Operations →
 * Subsidiaries → Area Items → Contingency) so the structural shape of
 * public.areas is legible at a glance. Corporate ("Area Items") rows
 * get a crimson left accent — they aren't territorial areas, they're
 * non-project corporate line holders (MOA, EPSO, Cyprus, Others, etc.). */
export default function AreaFilterPopover({
  areas, excluded, onChange, onClose, groupLabels,
}: {
  areas: CanonicalArea[];
  excluded: Set<string>;
  onChange: (next: Set<string>) => void;
  onClose: () => void;
  groupLabels: Record<AreaGroup, string>;
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

  const grouped = useMemo(() => {
    const order: AreaGroup[] = ['Operations', 'Subsidiaries', 'Corporate', 'Contingency']
    return order
      .map(g => ({ group: g, lines: areas.filter(a => a.group_name === g) }))
      .filter(b => b.lines.length > 0)
  }, [areas])

  const toggle = (id: string) => {
    const next = new Set(excluded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }

  const selectAll = () => onChange(new Set())
  const clearAll = () => onChange(new Set(areas.map(a => a.area_id)))

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
        {grouped.map(blk => (
          <div key={blk.group} className={`afp-group afp-group-${blk.group.toLowerCase()}`}>
            <div className="afp-group-header">{groupLabels[blk.group]}</div>
            {blk.lines.map(a => {
              const checked = !excluded.has(a.area_id)
              return (
                <label key={a.area_id} className={`afp-row ${checked ? '' : 'unchecked'}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(a.area_id)} />
                  <span className="afp-row-id">{a.area_id}</span>
                  <span className="afp-row-name">{a.display_name}</span>
                </label>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
