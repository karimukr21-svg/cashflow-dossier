import { Navigate, useLocation } from 'react-router-dom'
import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { RoleContext } from '@/lib/role'

const APP_SLUG = 'cashflow-dossier'
const SUPPORT_EMAIL = 'karim.ukr.21@gmail.com'

type AccessState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'granted'; role: string }
  | { status: 'denied' }
  | { status: 'error'; message: string }

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, signOut } = useAuth()
  const loc = useLocation()
  const [access, setAccess] = useState<AccessState>({ status: 'idle' })

  useEffect(() => {
    if (!user) {
      setAccess({ status: 'idle' })
      return
    }
    let cancelled = false
    setAccess({ status: 'checking' })
    supabase
      .schema('public')
      .rpc('has_app_access', { p_app: APP_SLUG })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          setAccess({ status: 'error', message: error.message })
          return
        }
        if (!data) {
          setAccess({ status: 'denied' })
          return
        }
        setAccess({ status: 'granted', role: data as string })
      })
    return () => {
      cancelled = true
    }
    // Depend on the stable user id, NOT the user object: Supabase fires a fresh
    // session (new user object) on every token refresh — which happens on tab
    // focus — and re-running this check would flip to 'checking' and unmount the
    // whole module tree, resetting all in-page state.
  }, [user?.id])

  // Only show the loading screen on the FIRST access check. Once access has been
  // resolved, a background re-check must not tear the mounted tree down.
  if (loading || (user && access.status === 'checking')) {
    return (
      <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--mute)' }}>
        Loading…
      </div>
    )
  }
  if (!user) {
    return <Navigate to="/sign-in" replace state={{ from: loc.pathname }} />
  }
  if (access.status === 'denied' || access.status === 'error') {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'var(--bg)' }}>
        <div style={{ maxWidth: 420, width: '100%', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', padding: 32, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, fontWeight: 500, marginBottom: 12 }}>No access</h1>
          <p style={{ fontSize: 14, color: 'var(--mute)', marginBottom: 16 }}>
            Your account isn't set up to use Treasury Workspace yet. Contact Karim to request access.
          </p>
          <a href={`mailto:${SUPPORT_EMAIL}`} style={{ display: 'inline-block', fontSize: 14, color: 'var(--crimson)', marginBottom: 24 }}>
            {SUPPORT_EMAIL}
          </a>
          <button
            type="button"
            onClick={async () => {
              await signOut()
            }}
            style={{ display: 'block', width: '100%', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', padding: '8px 12px', fontSize: 14 }}
          >
            Sign out
          </button>
        </div>
      </div>
    )
  }
  const role = access.status === 'granted' ? access.role : 'viewer'
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>
}
