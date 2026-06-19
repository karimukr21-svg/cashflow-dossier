import type { ReactNode } from 'react'
import { canManageCashFlow } from '@/lib/role'

/* ------------------------------------------------------------------ *
 * Treasury Workspace — module registry
 *
 * This is the single seam the workspace shell switches across. Each
 * Treasury module is ONE entry here. The switcher (ModuleSwitcher.tsx)
 * reads this list, role-gates it, and routes to `route` on click.
 *
 * Adding a module later = add ONE entry below + build that module's own
 * folder/route. The shell needs no other change.
 * ------------------------------------------------------------------ */

export type ModuleRequirement = 'manage' // extend as new gates appear

export interface WorkspaceModule {
  key: string
  label: string
  icon: ReactNode
  route: string
  /** Omit to show to everyone with app access. 'manage' = admin|treasury only. */
  requiredRole?: ModuleRequirement
}

function CashFlowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h13l-3-3" />
      <path d="M20 16H7l3 3" />
    </svg>
  )
}

export const MODULES: WorkspaceModule[] = [
  {
    key: 'cash-flow',
    label: 'Cash Flow',
    icon: <CashFlowIcon />,
    route: '/',
  },

  // ── Future modules plug in here — one entry each, nothing else: ──
  // { key: 'bank-position', label: 'Bank Position', icon: <BankIcon />,    route: '/bank-position' },
  // { key: 'allocations',   label: 'Allocations',   icon: <AllocIcon />,   route: '/allocations'   },
  // { key: 'reports',       label: 'Reports',       icon: <ReportIcon />,  route: '/reports', requiredRole: 'manage' },
]

function satisfies(role: string, req?: ModuleRequirement): boolean {
  if (!req) return true
  if (req === 'manage') return canManageCashFlow(role)
  return false
}

/** Modules the given role is allowed to see, in registry order. */
export function visibleModules(role: string): WorkspaceModule[] {
  return MODULES.filter(m => satisfies(role, m.requiredRole))
}

/** The module that owns the current path. Cash Flow ('/') also owns /analyze. */
export function activeModule(role: string, pathname: string): WorkspaceModule | undefined {
  const mods = visibleModules(role)
  const nonRoot = mods.find(
    m => m.route !== '/' && (pathname === m.route || pathname.startsWith(m.route + '/')),
  )
  return nonRoot ?? mods.find(m => m.route === '/')
}
