import { useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/auth'

export default function SignIn() {
  const { user, loading } = useAuth()
  const loc = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!loading && user) {
    const dest = (loc.state as { from?: string } | null)?.from ?? '/'
    return <Navigate to={dest} replace />
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setErr(error.message)
  }

  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div style={{ width: 384, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 24 }}>
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 22, fontWeight: 400 }}>Cycle Dossier</div>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--mute)', marginTop: 4 }}>
            CCC · Group Accounts · live cycle view
          </div>
        </div>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--mute)' }}>Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              style={{ height: 40, padding: '0 12px', border: '1px solid var(--border)', borderRadius: 6 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--mute)' }}>Password</span>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              style={{ height: 40, padding: '0 12px', border: '1px solid var(--border)', borderRadius: 6 }}
            />
          </label>
          {err && <div style={{ fontSize: 12, color: 'var(--crimson)' }}>{err}</div>}
          <button
            type="submit"
            disabled={busy}
            style={{ height: 40, background: 'var(--crimson)', color: '#fff', border: 0, borderRadius: 6, fontWeight: 500, opacity: busy ? 0.5 : 1 }}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
