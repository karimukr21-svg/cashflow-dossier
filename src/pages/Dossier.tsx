import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '@/lib/auth'
import {
  fetchAreas, fetchVersions, fetchLines, fetchActuals,
  type CfVersion, type CfLine,
} from '@/lib/queries'
import TreasuryMovements from './TreasuryMovements'
import AreaDrill from './AreaDrill'
import BankSnapshot from './BankSnapshot'
import LoansOverdrafts from './LoansOverdrafts'
import Operations from './Operations'
import Overall from './Overall'
import AllAreas from './AllAreas'
import CustomPeriodPopover from '@/components/CustomPeriodPopover'

export type Grain = 'monthly' | 'quarterly' | 'yearly'
export type GroupBy = 'category' | 'nature'

type View =
  | { kind: 'summary'; lens: 'overall' | 'treasury' | 'loans' | 'operations' | 'allareas' }
  | { kind: 'bank'; sub: 'snapshot' | 'timeseries' }
  | { kind: 'area'; area: string }
  | { kind: 'audit' }

function parseView(sp: URLSearchParams): View {
  const view = sp.get('view') || 'summary'
  const sub = sp.get('sub') || ''
  if (view === 'bank') return { kind: 'bank', sub: (sub === 'timeseries' ? 'timeseries' : 'snapshot') }
  if (view === 'area' && sp.get('area')) return { kind: 'area', area: sp.get('area')! }
  if (view === 'audit') return { kind: 'audit' }
  const lens = (['overall', 'treasury', 'loans', 'operations', 'allareas'].includes(sub) ? sub : 'overall') as any
  return { kind: 'summary', lens }
}

/* Pages that use a column-grain control */
const USES_GRAIN: Record<string, boolean> = {
  area: true,
  allareas: true,
  timeseries: true,
}

/* Pages that use the section-grouping toggle (Category vs Nature) */
const USES_GROUPBY: Record<string, boolean> = {
  area: true,
  allareas: true,
}

function ymToInt(year: number, month: number) { return year * 100 + month }

/* Period presets — resolved against (today, latestActualYM) */
type PresetKey = 'ytd' | 'last12' | 'q1-26' | 'q2-26' | 'full-26' | 'plan' | 'custom'

function resolvePreset(key: PresetKey, latestActualYM: number, today: Date): { from: string; to: string } {
  const t = today
  const yr = t.getFullYear()
  const mo = t.getMonth() + 1
  if (key === 'ytd') {
    const ay = Math.floor(latestActualYM / 100); const am = latestActualYM % 100
    return { from: `${ay}-01`, to: `${ay}-${String(am).padStart(2, '0')}` }
  }
  if (key === 'last12') {
    const startY = mo <= 12 ? yr - 1 : yr
    return { from: `${startY}-${String(mo).padStart(2, '0')}`, to: `${yr}-${String(mo).padStart(2, '0')}` }
  }
  if (key === 'q1-26') return { from: '2026-01', to: '2026-03' }
  if (key === 'q2-26') return { from: '2026-04', to: '2026-06' }
  if (key === 'full-26') return { from: '2026-01', to: '2026-12' }
  if (key === 'plan') return { from: '2026-01', to: '2028-12' }
  return { from: '2026-01', to: '2026-04' } // custom default
}

const ALL_MONTHS = (() => {
  const arr: string[] = []
  for (let y = 2020; y <= 2028; y++)
    for (let m = 1; m <= 12; m++)
      arr.push(`${y}-${String(m).padStart(2, '0')}`)
  return arr
})()

export default function Dossier() {
  const { user, signOut } = useAuth()
  const [sp, setSp] = useSearchParams()
  const view = parseView(sp)

  const [versions, setVersions] = useState<CfVersion[]>([])
  const [areas, setAreas] = useState<string[]>([])
  const [lines, setLines] = useState<CfLine[]>([])
  const [latestActualYM, setLatestActualYM] = useState<number>(202604) // fallback
  const [loadingCatalog, setLoadingCatalog] = useState(true)

  useEffect(() => {
    (async () => {
      try {
        const [v, a, l] = await Promise.all([fetchVersions(), fetchAreas(), fetchLines()])
        setVersions(v)
        setAreas(a)
        setLines(l)
        // Find latest actual month from a cheap query
        const sample = await fetchActuals({ fromYear: 2024, fromMonth: 1, toYear: 2030, toMonth: 12 })
        const max = sample.reduce((m, c) => Math.max(m, ymToInt(c.year, c.month)), 0)
        if (max) setLatestActualYM(max)
      } finally {
        setLoadingCatalog(false)
      }
    })()
  }, [])

  // Resolve state from URL
  const primaryVersion = sp.get('v') || versions[0]?.version_code || ''
  const compareVersion = sp.get('c') || ''
  const preset = (sp.get('p') || 'ytd') as PresetKey
  const grain = (sp.get('g') || 'monthly') as Grain
  const groupBy = (sp.get('gb') === 'nature' ? 'nature' : 'category') as GroupBy

  const { from: presetFrom, to: presetTo } =
    resolvePreset(preset === 'custom' ? 'custom' : preset, latestActualYM, new Date())
  const fromYM = preset === 'custom' ? (sp.get('from') || presetFrom) : presetFrom
  const toYM = preset === 'custom' ? (sp.get('to') || presetTo) : presetTo
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

  const asOfLabel = useMemo(() => {
    const y = Math.floor(latestActualYM / 100)
    const m = latestActualYM % 100
    const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1] || ''
    return `${monthName} ${y}`
  }, [latestActualYM])

  const monthName = (m: number) => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1] || ''
  const periodLabel = useMemo(() => {
    if (fy === ty) {
      if (fm === 1 && tm === 12) return `Full ${fy}`
      return `${monthName(fm)} – ${monthName(tm)} ${fy}`
    }
    return `${monthName(fm)} ${fy} – ${monthName(tm)} ${ty}`
  }, [fy, fm, ty, tm])

  const [showCustom, setShowCustom] = useState(false)

  const navItems: { label: string; group: string; view: View; placeholder?: boolean }[] = [
    { group: 'SUMMARY', label: 'Overall',            view: { kind: 'summary', lens: 'overall' } },
    { group: 'SUMMARY', label: 'Treasury Movements', view: { kind: 'summary', lens: 'treasury' } },
    { group: 'SUMMARY', label: 'Loans & Overdrafts', view: { kind: 'summary', lens: 'loans' } },
    { group: 'SUMMARY', label: 'Operations',         view: { kind: 'summary', lens: 'operations' } },
    { group: 'SUMMARY', label: 'All Areas',          view: { kind: 'summary', lens: 'allareas' } },
    { group: 'BANK POSITION', label: 'Snapshot',     view: { kind: 'bank', sub: 'snapshot' } },
    { group: 'BANK POSITION', label: 'Time Series',  view: { kind: 'bank', sub: 'timeseries' }, placeholder: true },
    ...areas.map(a => ({ group: 'AREAS', label: a, view: { kind: 'area' as const, area: a } })),
    { group: 'AUDIT', label: 'Audit Trail', view: { kind: 'audit' }, placeholder: true },
  ]

  const goto = (v: View) => {
    if (v.kind === 'summary') setUrl({ view: 'summary', sub: v.lens, area: null })
    else if (v.kind === 'bank') setUrl({ view: 'bank', sub: v.sub, area: null })
    else if (v.kind === 'area') setUrl({ view: 'area', area: v.area, sub: null })
    else setUrl({ view: 'audit', sub: null, area: null })
  }

  const isActive = (item: View) => JSON.stringify(item) === JSON.stringify(view)

  const grainKey = (() => {
    if (view.kind === 'summary') return view.lens
    if (view.kind === 'bank') return view.sub
    if (view.kind === 'area') return 'area'
    return 'audit'
  })()
  const showGrain = !!USES_GRAIN[grainKey]
  const showGroupBy = !!USES_GROUPBY[grainKey]

  const renderContent = () => {
    if (loadingCatalog) return <div className="placeholder-box">Loading…</div>
    if (!primaryVersion) return <div className="placeholder-box">No version available.</div>

    const scope = {
      primaryVersion, compareVersion,
      fromYear: fy, fromMonth: fm, toYear: ty, toMonth: tm,
      areas, lines, latestActualYM, grain, groupBy,
    }

    if (view.kind === 'summary') {
      if (view.lens === 'overall')    return <Overall scope={scope} />
      if (view.lens === 'treasury')   return <TreasuryMovements scope={scope} />
      if (view.lens === 'loans')      return <LoansOverdrafts scope={scope} />
      if (view.lens === 'operations') return <Operations scope={scope} />
      if (view.lens === 'allareas')   return <AllAreas scope={scope} />
    }
    if (view.kind === 'bank' && view.sub === 'snapshot') return <BankSnapshot />
    if (view.kind === 'bank' && view.sub === 'timeseries')
      return <div className="placeholder-box">Time series coming next session.</div>
    if (view.kind === 'area') return <AreaDrill area={view.area} scope={scope} />
    if (view.kind === 'audit') return <div className="placeholder-box">Audit trail coming next session.</div>
    return null
  }

  /* Period preset pills */
  const periodPills: { key: PresetKey; label: string }[] = [
    { key: 'ytd', label: 'YTD' },
    { key: 'last12', label: 'Last 12 mo' },
    { key: 'full-26', label: 'Full 2026' },
    { key: 'custom', label: 'Custom' },
  ]

  const grainPills: { key: Grain; label: string }[] = [
    { key: 'monthly', label: 'Monthly' },
    { key: 'quarterly', label: 'Quarterly' },
    { key: 'yearly', label: 'Yearly' },
  ]

  const groupByPills: { key: GroupBy; label: string }[] = [
    { key: 'category', label: 'By Category' },
    { key: 'nature', label: 'By Nature' },
  ]

  return (
    <div className="shell">
      <div className="topbar">
        <div className="topbar-row">
          {/* Left cluster — status pills (variable width is fine; only the spacer between flexes) */}
          <div className="brand">Cash Flow Dossier</div>
          <div className="asof-pill">Actuals · {asOfLabel}</div>
          <div className="period-pill">Period · {periodLabel}</div>

          {showGrain && (
            <>
              <div className="ctrl" style={{ marginLeft: 8 }}><label>Grain</label></div>
              <div className="pill-row">
                {grainPills.map(p => (
                  <button key={p.key}
                    onClick={() => setUrl({ g: p.key })}
                    className={`pill-btn ${grain === p.key ? 'active' : ''}`}>
                    {p.label}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Spacer absorbs left-side width changes so the right cluster stays put */}
          <div style={{ flex: 1 }} />

          {/* Right cluster — toggles. Order: Version · Compare · Period */}
          <div className="ctrl"><label>Version</label></div>
          <div className="pill-row">
            {versions.map(v => (
              <button key={v.version_code}
                onClick={() => setUrl({ v: v.version_code })}
                className={`pill-btn ${primaryVersion === v.version_code ? 'active' : ''}`}>
                {v.version_code}
              </button>
            ))}
          </div>

          <div className="ctrl" style={{ marginLeft: 8 }}><label>Compare</label></div>
          <div className="pill-row">
            <button onClick={() => setUrl({ c: null })}
              className={`pill-btn ${compareVersion === '' ? 'active' : ''}`}>None</button>
            {versions.filter(v => v.version_code !== primaryVersion).map(v => (
              <button key={v.version_code}
                onClick={() => setUrl({ c: v.version_code })}
                className={`pill-btn ${compareVersion === v.version_code ? 'active' : ''}`}>
                {v.version_code}
              </button>
            ))}
            <button onClick={() => setUrl({ c: 'Actual' })}
              className={`pill-btn ${compareVersion === 'Actual' ? 'active' : ''}`}>Actual</button>
          </div>

          <div className="ctrl" style={{ marginLeft: 8 }}><label>Period</label></div>
          <div className="pill-row">
            {periodPills.map(p => (
              <button key={p.key}
                onClick={() => {
                  if (p.key === 'custom') { setShowCustom(true) }
                  else { setUrl({ p: p.key, from: null, to: null }) }
                }}
                className={`pill-btn ${preset === p.key ? 'active' : ''}`}>
                {p.label}
              </button>
            ))}
          </div>

          {showGroupBy && (
            <>
              <div className="ctrl" style={{ marginLeft: 8 }}><label>Sections</label></div>
              <div className="pill-row">
                {groupByPills.map(p => (
                  <button key={p.key}
                    onClick={() => setUrl({ gb: p.key === 'category' ? null : p.key })}
                    className={`pill-btn ${groupBy === p.key ? 'active' : ''}`}>
                    {p.label}
                  </button>
                ))}
              </div>
            </>
          )}

        </div>
      </div>

      {showCustom && (
        <CustomPeriodPopover
          fromYM={fromYM}
          toYM={toYM}
          latestActualYM={latestActualYM}
          onClose={() => setShowCustom(false)}
          onApply={(f, t) => {
            setUrl({ p: 'custom', from: f, to: t })
            setShowCustom(false)
          }}
        />
      )}

      <div className="leftnav">
        <div className="leftnav-scroll">
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
        <div className="leftnav-footer">
          <div className="user-email">{user?.email}</div>
          <button className="signout" onClick={signOut}>Sign out</button>
        </div>
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
  latestActualYM: number;
  grain: Grain;
  groupBy: GroupBy;
}
