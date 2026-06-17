import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '@/lib/auth'
import {
  fetchVersionsMeta, fetchLatestActualYM,
  type CfVersionMeta, type Grain,
} from '@/lib/projectQueries'
import CustomPeriodPopover from '@/components/CustomPeriodPopover'
import ProjectDrill from './ProjectDrill'
import ForecastAccuracy from './ForecastAccuracy'
import ForecastDrift from './ForecastDrift'

export type AnalyzeView = 'drill' | 'accuracy' | 'drift'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthName = (m: number) => MONTH_NAMES[m - 1] || ''

function resolvePreset(key: string, latestActualYM: number): { from: string; to: string } | null {
  const ay = Math.floor(latestActualYM / 100)
  const am = latestActualYM % 100
  if (key === 'ytd') return { from: `${ay}-01`, to: `${ay}-${String(am).padStart(2, '0')}` }
  if (key === 'last12') {
    // 12 months ending at latest actual
    let y = ay, m = am - 11
    while (m <= 0) { m += 12; y -= 1 }
    return { from: `${y}-${String(m).padStart(2, '0')}`, to: `${ay}-${String(am).padStart(2, '0')}` }
  }
  if (key === 'full-26') return { from: '2026-01', to: '2026-12' }
  return null
}

export type AnalyzeScope = {
  primaryVersion: string
  compareVersion: string
  versions: CfVersionMeta[]
  fromYear: number; fromMonth: number; toYear: number; toMonth: number
  latestActualYM: number
  grain: Grain
}

export default function AnalyzeShell() {
  const { user, signOut } = useAuth()
  const [sp, setSp] = useSearchParams()

  const [versions, setVersions] = useState<CfVersionMeta[]>([])
  const [latestActualYM, setLatestActualYM] = useState<number>(202604)
  const [loading, setLoading] = useState(true)
  const [showCustom, setShowCustom] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const [v, ym] = await Promise.all([fetchVersionsMeta(), fetchLatestActualYM()])
        setVersions(v)
        setLatestActualYM(ym)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const view = (['drill', 'accuracy', 'drift'].includes(sp.get('view') || '')
    ? sp.get('view') : 'drill') as AnalyzeView

  /* Default primary = the newest cycle for the drill, but the second-newest
   * for accuracy/drift so the "actualized window" / "drift overlap" isn't
   * empty out of the box. */
  const defaultPrimary = useMemo(() => {
    if (versions.length === 0) return ''
    if (view !== 'drill' && versions.length >= 2) return versions[versions.length - 2].version_code
    return versions[versions.length - 1].version_code
  }, [versions, view])
  const defaultCompare = useMemo(() => {
    if (versions.length === 0) return ''
    return versions[versions.length - 1].version_code
  }, [versions])

  const primaryVersion = sp.get('v') || defaultPrimary
  const compareVersion = sp.get('c') || defaultCompare
  const grain = (sp.get('g') || 'monthly') as Grain
  const preset = sp.get('p') || ''

  const presetRange = preset ? resolvePreset(preset, latestActualYM) : null
  const fromYM = sp.get('from') || presetRange?.from || '2024-01'
  const toYM = sp.get('to') || presetRange?.to || '2026-12'
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

  const goView = (v: AnalyzeView) =>
    setUrl({ view: v, area: null }) // clear area focus when switching pages

  const asOfLabel = useMemo(() => {
    const y = Math.floor(latestActualYM / 100)
    const m = latestActualYM % 100
    return `${monthName(m)} ${y}`
  }, [latestActualYM])

  const periodLabel = useMemo(() => {
    if (fy === ty) {
      if (fm === 1 && tm === 12) return `Full ${fy}`
      return `${monthName(fm)} – ${monthName(tm)} ${fy}`
    }
    return `${monthName(fm)} ${fy} – ${monthName(tm)} ${ty}`
  }, [fy, fm, ty, tm])

  const scope: AnalyzeScope = {
    primaryVersion, compareVersion, versions,
    fromYear: fy, fromMonth: fm, toYear: ty, toMonth: tm,
    latestActualYM, grain,
  }

  const versionLabel = (v: CfVersionMeta) =>
    v.final_label ? `${v.version_code} · ${v.final_label}` : v.version_code

  const navItems: { view: AnalyzeView; label: string; hint: string }[] = [
    { view: 'drill', label: 'Project Drill', hint: 'Group → area → project → line → month' },
    { view: 'accuracy', label: 'Forecast Accuracy', hint: 'Actuals vs a chosen cycle' },
    { view: 'drift', label: 'Forecast Drift', hint: 'Cycle vs cycle' },
  ]

  const grainPills: { key: Grain; label: string }[] = [
    { key: 'monthly', label: 'Monthly' },
    { key: 'quarterly', label: 'Quarterly' },
    { key: 'yearly', label: 'Yearly' },
  ]

  const renderContent = () => {
    if (loading) return <div className="placeholder-box">Loading…</div>
    if (versions.length === 0) return <div className="placeholder-box">No published cycles yet.</div>
    if (!primaryVersion) return <div className="placeholder-box">Select a cycle.</div>
    if (view === 'drill') return <ProjectDrill scope={scope} setUrl={setUrl} focusArea={sp.get('area')} />
    if (view === 'accuracy') return <ForecastAccuracy scope={scope} setUrl={setUrl} focusArea={sp.get('area')} />
    return <ForecastDrift scope={scope} setUrl={setUrl} focusArea={sp.get('area')} />
  }

  return (
    <div className="shell">
      <div className="topbar">
        <div className="topbar-row topbar-row-status">
          <div className="brand">Cash Flow Dossier</div>
          <span className="analyze-badge">Analyze · Project grain</span>
          <div className="asof-pill">Actuals · {asOfLabel}</div>
          <button className="period-pill clickable" onClick={() => setShowCustom(true)} title="Change period">
            Period · {periodLabel}
          </button>
          <a className="back-to-dossier" href="/">← Area dossier</a>
          <div style={{ flex: 1 }} />
          <div className="ctrl"><label>{view === 'accuracy' ? 'Judge cycle' : 'Cycle'}</label></div>
          <div className="pill-row">
            {versions.map(v => (
              <button key={v.version_code}
                onClick={() => setUrl({ v: v.version_code })}
                className={`pill-btn ${primaryVersion === v.version_code ? 'active' : ''}`}
                title={versionLabel(v)}>
                {v.version_code}
              </button>
            ))}
          </div>
          {view === 'drift' && (
            <>
              <div className="ctrl" style={{ marginLeft: 8 }}><label>vs cycle</label></div>
              <div className="pill-row">
                {versions.filter(v => v.version_code !== primaryVersion).map(v => (
                  <button key={v.version_code}
                    onClick={() => setUrl({ c: v.version_code })}
                    className={`pill-btn ${compareVersion === v.version_code ? 'active' : ''}`}>
                    {v.version_code}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="topbar-row topbar-row-display">
          <div style={{ flex: 1 }} />
          <div className="ctrl"><label>Grain</label></div>
          <div className="pill-row">
            {grainPills.map(p => (
              <button key={p.key}
                onClick={() => setUrl({ g: p.key === 'monthly' ? null : p.key })}
                className={`pill-btn ${grain === p.key ? 'active' : ''}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {showCustom && (
        <CustomPeriodPopover
          fromYM={fromYM}
          toYM={toYM}
          latestActualYM={latestActualYM}
          activePreset={preset}
          onClose={() => setShowCustom(false)}
          onApply={(f, t) => { setUrl({ p: null, from: f, to: t }); setShowCustom(false) }}
          onApplyPreset={(key) => { setUrl({ p: key, from: null, to: null }); setShowCustom(false) }}
        />
      )}

      <div className="leftnav">
        <div className="leftnav-scroll">
          <div className="group">ANALYZE</div>
          {navItems.map(n => (
            <a key={n.view}
               className={`item ${view === n.view ? 'active' : ''}`}
               onClick={() => goView(n.view)}
               title={n.hint}>
              {n.label}
            </a>
          ))}
          <div className="analyze-nav-note">
            Open browse over the project-grain canonical store. Actuals are the
            continuous settled series; forecasts come from the chosen cycle.
          </div>
        </div>
        <div className="leftnav-footer">
          <div className="user-email">{user?.email}</div>
          <button className="signout" onClick={signOut}>Sign out</button>
        </div>
      </div>

      <div className="content">
        {renderContent()}
      </div>
    </div>
  )
}

export { monthName }
