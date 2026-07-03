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

function BankPositionIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10l9-5 9 5" />
      <path d="M5 10v8M10 10v8M14 10v8M19 10v8" />
      <path d="M3 21h18" />
    </svg>
  )
}

function EntitiesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="5" rx="1" />
      <rect x="3" y="16" width="6" height="5" rx="1" />
      <rect x="15" y="16" width="6" height="5" rx="1" />
      <path d="M12 8v4M12 12H6v4M12 12h6v4" />
    </svg>
  )
}

function AllocationsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="6" r="3" />
      <path d="M9 6h4a3 3 0 0 1 3 3v0a3 3 0 0 0 3 3h2" />
      <path d="M9 6h4a3 3 0 0 0 3-3" />
      <path d="M18 15l3 3-3 3" />
    </svg>
  )
}

function ManageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="18" r="2" fill="currentColor" stroke="none" />
    </svg>
  )
}

export const MODULES: WorkspaceModule[] = [
  {
    key: 'cash-flow',
    label: 'Cash Flow',   // reports / viewing (editing lives in the "Adjust" module)
    icon: <CashFlowIcon />,
    route: '/',
  },
  {
    key: 'cash-flow-manage',
    label: 'Adjust',
    icon: <ManageIcon />,
    route: '/manage',
    requiredRole: 'manage', // import/stage/push, versions, adjustments — admin|treasury only
  },
  {
    key: 'bank-position',
    label: 'Bank Position',
    icon: <BankPositionIcon />,
    route: '/bank-position',
    requiredRole: 'manage', // Treasury manages the monthly group cash position
  },
  {
    key: 'entities',
    label: 'Areas & Projects',
    icon: <EntitiesIcon />,
    route: '/entities',
    // No requiredRole: reading the canonical tree is open. Editing nodes (admin)
    // and aliases (manage) is gated inside the module + by RLS.
  },

  {
    key: 'allocations',
    label: 'Allocations',
    icon: <AllocationsIcon />,
    route: '/allocations',
    requiredRole: 'manage', // Treasury source-and-use ledger — admin|treasury only
  },

  // ── Future modules plug in here — one entry each, nothing else: ──
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
