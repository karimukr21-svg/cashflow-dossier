import { createContext, useContext } from 'react'

/* The app role for the signed-in user, resolved by has_app_access('cashflow-dossier')
 * in RequireAuth and provided to the tree. Viewers see only Analyze; admin|treasury
 * additionally see Manage mode. RLS (super-admin write on cf_* tables) is the hard
 * enforcement — this gate just hides controls for non-Treasury users. */
export const RoleContext = createContext<string>('viewer')

export function useRole(): string {
  return useContext(RoleContext)
}

export function canManageCashFlow(role: string): boolean {
  return role === 'admin' || role === 'treasury'
}
