import { Outlet, useLocation } from 'react-router-dom'
import { useRole } from '@/lib/role'
import { activeModule } from './registry'
import { ModuleSwitcher } from './ModuleSwitcher'
import './workspace.css'

/* Thin chrome around whichever Treasury module is mounted. Renders the
 * module-switcher rail on top and the active module (via <Outlet/>) below.
 * The module keeps its own internal UI untouched — workspace.css just lets
 * its 100vh shell fit inside the remaining height. */
export function WorkspaceShell() {
  const role = useRole()
  const loc = useLocation()
  const current = activeModule(role, loc.pathname)

  return (
    <div className="workspace-root">
      <header className="workspace-bar">
        <ModuleSwitcher />
        <span className="workspace-bar-brand">Treasury Workspace</span>
        {current && (
          <>
            <span className="workspace-bar-sep">/</span>
            <span className="workspace-bar-module">{current.label}</span>
          </>
        )}
      </header>
      <div className="workspace-body">
        <Outlet />
      </div>
    </div>
  )
}
