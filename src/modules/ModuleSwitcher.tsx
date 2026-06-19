import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useRole } from '@/lib/role'
import { activeModule, visibleModules, type WorkspaceModule } from './registry'

/* Top-left launcher → animated left drawer listing the registered modules.
 * Role-gated via the registry. With one module today the menu has a single
 * entry — the switching mechanism is what this provides. */
export function ModuleSwitcher() {
  const role = useRole()
  const nav = useNavigate()
  const loc = useLocation()
  const [open, setOpen] = useState(false)

  const modules = visibleModules(role)
  const current = activeModule(role, loc.pathname)

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  function go(m: WorkspaceModule) {
    setOpen(false)
    if (current?.key !== m.key) nav(m.route)
  }

  return (
    <>
      <button
        type="button"
        className="ws-launcher"
        onClick={() => setOpen(v => !v)}
        aria-label="Switch module"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1.6" />
          <rect x="14" y="3" width="7" height="7" rx="1.6" />
          <rect x="3" y="14" width="7" height="7" rx="1.6" />
          <rect x="14" y="14" width="7" height="7" rx="1.6" />
        </svg>
      </button>

      <div
        className={`ws-drawer-backdrop ${open ? 'open' : ''}`}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      <aside className={`ws-drawer ${open ? 'open' : ''}`} role="menu" aria-hidden={!open}>
        <div className="ws-drawer-head">
          <span className="ws-drawer-title">Treasury Workspace</span>
          <button
            type="button"
            className="ws-drawer-close"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <nav className="ws-drawer-list">
          {modules.map((m, i) => (
            <button
              key={m.key}
              type="button"
              role="menuitem"
              className={`ws-mod ${current?.key === m.key ? 'active' : ''}`}
              style={{ animationDelay: `${60 + i * 40}ms` }}
              onClick={() => go(m)}
            >
              <span className="ws-mod-icon">{m.icon}</span>
              <span className="ws-mod-label">{m.label}</span>
            </button>
          ))}
        </nav>
      </aside>
    </>
  )
}
