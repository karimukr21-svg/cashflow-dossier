import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '@/lib/auth'
import {
  fetchAreas, fetchVersions, fetchLines, type CfVersion, type CfLine,
} from '@/lib/queries'
import TreasuryMovements from './TreasuryMovements'
import AreaDrill from './AreaDrill'
import BankSnapshot from './BankSnapshot'
import LoansOverdrafts from './LoansOverdrafts'
import Operations from './Operations'

type View =
  | { kind: 'summary'; lens: 'treasury' | 'loans' | 'operations' }
  | { kind: 'bank'; sub: 'snapshot' | 'timeseries' }
  | { kind: 'area'; area: string }
  | { kind: 'audit' }

function parseView(sp: URLSearchParams): View {
  const view = sp.get('view') || 'summary'
  const sub = sp.get('sub') || ''
  if (view === 'bank') return { kind: 'bank', sub: (sub === 'timeseries' ? 'timeseries' : 'snapshot') }
  if (view === 'area' && sp.get('area')) return { kind: 'area', area: sp.get('area')! }
  if (view === 'audit') return { kind: 'audit' }
  return { kind: 'summary', lens: (sub === 'loans' || sub === 'operations' ? sub : 'treasury') as any }
}

const ALL_MONTHS_2025_TO_2028 = (() => {
  const arr: { year: number; month: number; label: string }[] = []
  for (let y = 2024; y <= 2028; y++) {
    for (let m = 1; m <= 12; m++) {
      arr.push({ year: y, month: m, label: `${y}-${String(m).padStart(2,'0')}` })
    }
  }
  return arr
})()

export default function Dossier() {
  const { user, signOut } = useAuth()
  const [sp, setSp] = useSearchParams()
  const view = parseView(sp)

  const [versions, setVersions] = useState<CfVersion[]>([])
  const [areas, setAreas] = useState<string[]>([])
  const [lines, setLines] = useState<CfLine[]>([])
  const [loadingCatalog, setLoadingCatalog] = useState(true)

  useEffect(() => {
    (async () => {
      try {
        const [v, a, l] = await Promise.all([fetchVersions(), fetchAreas(), fetchLines()])
        setVersions(v)
        setAreas(a)
        setLines(l)
      } finally {
        setLoadingCatalog(false)
      }
    })()
  }, [])

  // Resolve control state from URL with sensible defaults
  const primaryVersion = sp.get('v') || versions[0]?.version_code || ''
  const compareVersion = sp.get('c') || ''  // empty = no compare
  const fromYM = sp.get('from') || '2026-01'
  const toYM = sp.get('to') || '2026-04'
  const [fy, fm] = fromYM.split('-').map(Number)
  const [ty, tm] = toYM.split('-').map(Number)

  const setUrl = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp)
    Object.entries(patch).forEach(([k, v]) => {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    })
    setSp(next, { replace: true })
  }

  const navItems: { label: string; group: string; view: View; placeholder?: boolean }[] = [
    { group: 'SUMMARY', label: 'Treasury Movements', view: { kind: 'summary', lens: 'treasury' } },
    { group: 'SUMMARY', label: 'Loans & Overdrafts', view: { kind: 'summary', lens: 'loans' } },
    { group: 'SUMMARY', label: 'Operations', view: { kind: 'summary', lens: 'operations' } },
    { group: 'BANK POSITION', label: 'Snapshot', view: { kind: 'bank', sub: 'snapshot' } },
    { group: 'BANK POSITION', label: 'Time Series', view: { kind: 'bank', sub: 'timeseries' }, placeholder: true },
    ...areas.map(a => ({ group: 'AREAS', label: a, view: { kind: 'area' as const, area: a } })),
    { group: 'AUDIT', label: 'Audit Trail', view: { kind: 'audit' }, placeholder: true },
  ]

  const goto = (v: View) => {
    if (v.kind === 'summary') setUrl({ view: 'summary', sub: v.lens, area: null })
    else if (v.kind === 'bank') setUrl({ view: 'bank', sub: v.sub, area: null })
    else if (v.kind === 'area') setUrl({ view: 'area', area: v.area, sub: null })
    else setUrl({ view: 'audit', sub: null, area: null })
  }

  const isActive = (item: View) =>
    JSON.stringify(item) === JSON.stringify(view)

  const renderContent = () => {
    if (loadingCatalog) return <div className="placeholder-box">Loading…</div>
    if (!primaryVersion) return <div className="placeholder-box">No version available.</div>

    const scope = {
      primaryVersion, compareVersion,
      fromYear: fy, fromMonth: fm, toYear: ty, toMonth: tm,
      areas, lines,
    }

    if (view.kind === 'summary' && view.lens === 'treasury')
      return <TreasuryMovements scope={scope} />
    if (view.kind === 'summary' && view.lens === 'loans')
      return <LoansOverdrafts scope={scope} />
    if (view.kind === 'summary' && view.lens === 'operations')
      return <Operations scope={scope} />
    if (view.kind === 'bank' && view.sub === 'snapshot')
      return <BankSnapshot />
    if (view.kind === 'bank' && view.sub === 'timeseries')
      return <div className="placeholder-box">Time series coming next session.</div>
    if (view.kind === 'area')
      return <AreaDrill area={view.area} scope={scope} />
    if (view.kind === 'audit')
      return <div className="placeholder-box">Audit trail coming next session.</div>
    return null
  }

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">Cash Flow Dossier</div>
        <div className="ctrl">
          <label>Version</label>
          <select value={primaryVersion} onChange={e => setUrl({ v: e.target.value })}>
            {versions.map(v => <option key={v.version_code} value={v.version_code}>{v.version_code}</option>)}
          </select>
        </div>
        <div className="ctrl">
          <label>Compare</label>
          <select value={compareVersion} onChange={e => setUrl({ c: e.target.value || null })}>
            <option value="">None</option>
            {versions.filter(v => v.version_code !== primaryVersion)
              .map(v => <option key={v.version_code} value={v.version_code}>{v.version_code}</option>)}
          </select>
        </div>
        <div className="ctrl">
          <label>From</label>
          <select value={fromYM} onChange={e => setUrl({ from: e.target.value })}>
            {ALL_MONTHS_2025_TO_2028.map(m => <option key={m.label} value={m.label}>{m.label}</option>)}
          </select>
        </div>
        <div className="ctrl">
          <label>To</label>
          <select value={toYM} onChange={e => setUrl({ to: e.target.value })}>
            {ALL_MONTHS_2025_TO_2028.map(m => <option key={m.label} value={m.label}>{m.label}</option>)}
          </select>
        </div>
        <div className="spacer" />
        <div className="user">{user?.email}</div>
        <button className="signout" onClick={signOut}>Sign out</button>
      </div>

      <div className="leftnav">
        {(['SUMMARY', 'BANK POSITION', 'AREAS', 'AUDIT'] as const).map(group => (
          <div key={group}>
            <div className="group">{group}</div>
            {navItems.filter(n => n.group === group).map(n => (
              <a key={`${group}-${n.label}`}
                 className={`item ${isActive(n.view) ? 'active' : ''} ${n.placeholder ? 'placeholder' : ''}`}
                 onClick={() => !n.placeholder && goto(n.view)}>
                {n.label}{n.placeholder ? ' (soon)' : ''}
              </a>
            ))}
          </div>
        ))}
      </div>

      <div className="content">{renderContent()}</div>
    </div>
  )
}

export type Scope = {
  primaryVersion: string;
  compareVersion: string;
  fromYear: number; fromMonth: number; toYear: number; toMonth: number;
  areas: string[];
  lines: CfLine[];
}
