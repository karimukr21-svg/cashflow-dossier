import { Fragment, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '@/lib/auth'
import { useRole, canManageCashFlow } from '@/lib/role'
import CashFlowManagePanel from './manage/CashFlowManagePanel'
import {
  fetchCanonicalAreas, fetchVersions, fetchLines, fetchActuals,
  type CfVersion, type CfLine, type CanonicalArea, type AreaGroup,
} from '@/lib/queries'
import AreaDrill from './AreaDrill'
import Narrative from './Narrative'
import CashReport from './CashReport'
import DebtPosition from './DebtPosition'
import AllAreas from './AllAreas'
import AdjustmentsView from './AdjustmentsView'
import CustomPeriodPopover from '@/components/CustomPeriodPopover'
import AreaFilterPopover from '@/components/AreaFilterPopover'
import { TopbarExtrasCtx } from '@/lib/displayFmt'

export type Grain = 'monthly' | 'quarterly' | 'yearly'
export type GroupBy = 'category' | 'nature'

/* 3-letter permutation of Area / Nature / Category — drives the AllAreas
 * pivot. Leftmost = outermost group, rightmost = innermost (leaf).
 * Area at innermost renders per-area totals (no line items); Area at
 * outermost or middle keeps line items at the leaf. */
export type GrainOrd = 'ANC' | 'ACN' | 'NCA' | 'NAC' | 'CNA' | 'CAN'
const VALID_ORDS: GrainOrd[] = ['ANC', 'ACN', 'NCA', 'NAC', 'CNA', 'CAN']
function parseOrd(raw: string | null): GrainOrd {
  if (raw && (VALID_ORDS as string[]).includes(raw)) return raw as GrainOrd
  return 'CNA' // default: Category outer → Nature middle → per-area totals at leaf
}

type View =
  | { kind: 'summary'; lens: 'report' | 'narrative' | 'loans' | 'allareas' | 'adjustments' }
  | { kind: 'area'; area: string }
  | { kind: 'manage' }

function parseView(sp: URLSearchParams): View {
  const view = sp.get('view') || 'summary'
  const sub = sp.get('sub') || ''
  if (view === 'manage') return { kind: 'manage' }
  if (view === 'area' && sp.get('area')) return { kind: 'area', area: sp.get('area')! }
  const lens = (['report', 'narrative', 'loans', 'allareas', 'adjustments'].includes(sub) ? sub : 'report') as any
  return { kind: 'summary', lens }
}

/* Pages that use a column-grain control */
const USES_GRAIN: Record<string, boolean> = {
  area: true,
  allareas: true,
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
  const role = useRole()
  const canManage = canManageCashFlow(role)
  const [sp, setSp] = useSearchParams()
  const view = parseView(sp)

  const [versions, setVersions] = useState<CfVersion[]>([])
  const [areas, setAreas] = useState<CanonicalArea[]>([])
  const [lines, setLines] = useState<CfLine[]>([])
  const [latestActualYM, setLatestActualYM] = useState<number>(202604) // fallback
  const [loadingCatalog, setLoadingCatalog] = useState(true)

  useEffect(() => {
    (async () => {
      try {
        const [v, a, l] = await Promise.all([fetchVersions(), fetchCanonicalAreas(), fetchLines()])
        setVersions(v)
        setAreas(a)
        setLines(l)
        // As-of = latest closed actual month. Prefer the real data (MAX over
        // cf_actuals); when actuals are empty (the normal pre-publish state),
        // fall back to the newest version's as_of_date — never a bare literal.
        const sample = await fetchActuals({ fromYear: 2024, fromMonth: 1, toYear: 2030, toMonth: 12 })
        const max = sample.reduce((m, c) => Math.max(m, ymToInt(c.year, c.month)), 0)
        if (max) setLatestActualYM(max)
        else if (v[0]?.as_of_date) {
          const [ay, am] = v[0].as_of_date.split('-').map(Number)
          if (ay && am) setLatestActualYM(ay * 100 + am)
        }
      } finally {
        setLoadingCatalog(false)
      }
    })()
  }, [])

  // Resolve state from URL
  const primaryVersion = sp.get('v') || versions[0]?.version_code || ''
  const preset = (sp.get('p') || 'ytd') as PresetKey
  const grain = (sp.get('g') || 'monthly') as Grain
  const groupBy = (sp.get('gb') === 'nature' ? 'nature' : 'category') as GroupBy
  const ord = parseOrd(sp.get('ord'))

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
  const [showAreaFilter, setShowAreaFilter] = useState(false)
  // Top-bar slot (Row 2) the active page can portal its own display controls into.
  const [extrasNode, setExtrasNode] = useState<HTMLDivElement | null>(null)

  /* All Areas page filter — stores EXCLUDED canonical area_ids so newly-added
   * areas default in without Karim having to re-tick them. Bumped to v2
   * because semantics changed from cf strings to canonical area_ids when the
   * dossier flipped to public.areas as source of truth (2026-06-05). */
  const ALLAREAS_EXCLUDED_KEY = 'dossier-allareas-excluded-v2'
  const [excludedAreas, setExcludedAreas] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(ALLAREAS_EXCLUDED_KEY)
      return new Set(raw ? JSON.parse(raw) : [])
    } catch { return new Set() }
  })
  const updateExcluded = (next: Set<string>) => {
    setExcludedAreas(next)
    try { localStorage.setItem(ALLAREAS_EXCLUDED_KEY, JSON.stringify([...next])) } catch {}
  }
  const selectedAreas = areas.filter(a => !excludedAreas.has(a.area_id))

  /* Left-nav per-group collapsed state. Persisted in LS. SUMMARY + BANK
   * POSITION ignore this — always open. */
  const NAV_COLLAPSED_KEY = 'dossier-nav-collapsed-v1'
  const [navCollapsed, setNavCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(NAV_COLLAPSED_KEY)
      return new Set(raw ? JSON.parse(raw) : ['SUBSIDIARIES', 'CORPORATE', 'CONTINGENCY'])
    } catch { return new Set(['SUBSIDIARIES', 'CORPORATE', 'CONTINGENCY']) }
  })
  const toggleNavGroup = (g: string) => {
    setNavCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(g)) next.delete(g)
      else next.add(g)
      try { localStorage.setItem(NAV_COLLAPSED_KEY, JSON.stringify([...next])) } catch {}
      return next
    })
  }

  /* 2026-06-05: dossier flattened to country grain. Three buckets are
   * Tony's canonical groupings — Operations / Subsidiaries / Corporate. */
  const AREA_GROUP_LABEL: Record<AreaGroup, string> = {
    Operations: 'OPERATIONS',
    Subsidiaries: 'SUBSIDIARIES',
    Corporate: 'CORPORATE',
    Contingency: 'CONTINGENCY',
  }
  const areaNavGroups: { label: string; group: AreaGroup }[] = []
  for (const g of ['Operations', 'Subsidiaries', 'Corporate', 'Contingency'] as AreaGroup[]) {
    if (areas.some(a => a.group_name === g)) {
      areaNavGroups.push({ label: AREA_GROUP_LABEL[g], group: g })
    }
  }

  type NavItem = { label: string; group: string; view: View; area?: CanonicalArea }
  /* SUMMARY = the presentation set: one page per CFO question, in the order
   * a CFO conversation runs. EXPLORE = analyst tools. */
  const navItems: NavItem[] = [
    // Management & editing lives in its own "Manage & Adjust" module now
    // (src/modules/manage) — this module is the reports/viewing surface.
    { group: 'REPORT', label: 'Cash Flow Report',      view: { kind: 'summary', lens: 'report' } },
    { group: 'SUMMARY', label: 'Cash Flow Story',       view: { kind: 'summary', lens: 'narrative' } },
    { group: 'SUMMARY', label: 'Debt Position',        view: { kind: 'summary', lens: 'loans' } },
    { group: 'SUMMARY', label: 'Adjustments',          view: { kind: 'summary', lens: 'adjustments' } },
    { group: 'EXPLORE', label: 'All Areas',            view: { kind: 'summary', lens: 'allareas' } },
    ...areas.map(a => ({
      group: AREA_GROUP_LABEL[a.group_name],
      label: a.display_name,
      view: { kind: 'area' as const, area: a.area_id },
      area: a,
    })),
  ]
  const navGroupOrder: string[] = [
    // Management & editing moved to its own "Adjust" module (src/modules/manage);
    // this reports/viewing module no longer carries a Manage nav group.
    'REPORT', 'SUMMARY', 'EXPLORE',
    ...areaNavGroups.map(g => g.label),
  ]

  const goto = (v: View) => {
    if (v.kind === 'summary') setUrl({ view: 'summary', sub: v.lens, area: null })
    else if (v.kind === 'area') setUrl({ view: 'area', area: v.area, sub: null })
    else if (v.kind === 'manage') setUrl({ view: 'manage', sub: null, area: null })
  }

  const isActive = (item: View) => JSON.stringify(item) === JSON.stringify(view)

  const grainKey = (() => {
    if (view.kind === 'summary') return view.lens
    if (view.kind === 'area') return 'area'
    return 'audit'
  })()
  const showGrain = !!USES_GRAIN[grainKey]
  const showGroupBy = !!USES_GROUPBY[grainKey]
  const showAreaFilterChip = view.kind === 'summary' && view.lens === 'allareas'
  /* AllAreas uses the 3-chip ord reorder control instead of the 2-pill
   * groupBy toggle. AreaDrill keeps the 2-pill (Area is implicitly outermost
   * there — there's no Area dimension to reorder). */
  const isAllAreas = view.kind === 'summary' && view.lens === 'allareas'
  const showOrdControl = isAllAreas
  const showGroupByPills = showGroupBy && !isAllAreas

  /* Swap two adjacent positions in the current ord string. */
  const swapOrdAt = (i: 0 | 1) => {
    const arr = ord.split('')
    ;[arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]
    setUrl({ ord: arr.join('') === 'CNA' ? null : arr.join('') })
  }
  const ORD_LABEL: Record<string, string> = { A: 'Area', N: 'Nature', C: 'Category' }

  const renderContent = () => {
    if (view.kind === 'manage') {
      return canManage
        ? <CashFlowManagePanel />
        : <div className="placeholder-box">Manage mode requires the Treasury role.</div>
    }
    if (loadingCatalog) return <div className="placeholder-box">Loading…</div>
    if (!primaryVersion) return <div className="placeholder-box">No version available.</div>

    /* cfToCanonical lets every page resolve a Tony cf-area string to its
     * canonical area in O(1). Built once per render from scope.areas. */
    const cfToCanonical = new Map<string, CanonicalArea>()
    for (const a of areas) for (const cf of a.cf_areas) cfToCanonical.set(cf, a)

    const scope = {
      primaryVersion,
      fromYear: fy, fromMonth: fm, toYear: ty, toMonth: tm,
      areas, lines, versions, latestActualYM, grain, groupBy, ord,
      selectedAreas, cfToCanonical,
    }

    if (view.kind === 'summary') {
      if (view.lens === 'report')     return <CashReport scope={scope} onSelectArea={(areaId) => goto({ kind: 'area', area: areaId })} />
      if (view.lens === 'narrative')  return <Narrative scope={scope} />
      if (view.lens === 'loans')      return <DebtPosition scope={scope} />
      if (view.lens === 'adjustments') return <AdjustmentsView scope={scope} />
      if (view.lens === 'allareas')   return <AllAreas scope={scope} onSelectArea={(areaId) => goto({ kind: 'area', area: areaId })} />
    }
    if (view.kind === 'area') return <AreaDrill area={view.area} scope={scope} />
    return null
  }

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
    <TopbarExtrasCtx.Provider value={extrasNode}>
    <div className="shell">
      <div className="topbar">
        {/* Row 1 — data context: what is being viewed.
           Slots are fixed left-to-right; conditional items collapse out
           without reordering anything to their right. */}
        <div className="topbar-row topbar-row-status">
          <div className="brand">Treasury Workspace</div>
          <div className="asof-pill">Actuals · {asOfLabel}</div>
          <button className="period-pill clickable"
                  onClick={() => setShowCustom(true)}
                  title="Change period">
            Period · {periodLabel}
          </button>
          {showAreaFilterChip && (
            <button
              className={`areas-pill ${excludedAreas.size > 0 ? 'filtered' : ''}`}
              onClick={() => setShowAreaFilter(true)}>
              Areas · {selectedAreas.length} of {areas.length}
            </button>
          )}
          <div style={{ flex: 1 }} />
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
        </div>

        {/* Row 2 — display toggles: how to format the view.
           Empty on pages that don't use Grain/Sections; positions held
           so toggling views never shifts what stays. */}
        <div className="topbar-row topbar-row-display">
          <div style={{ flex: 1 }} />
          {showGrain && (
            <>
              <div className="ctrl"><label>Grain</label></div>
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
          {showGroupByPills && (
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
          {showOrdControl && (
            <>
              <div className="ctrl" style={{ marginLeft: 8 }}><label>Grain</label></div>
              <div className="ord-row" title="Outermost on the left, innermost on the right. Click ⇄ to swap two chips.">
                {ord.split('').map((ch, i) => (
                  <Fragment key={i}>
                    <span className="ord-chip">{ORD_LABEL[ch]}</span>
                    {i < 2 && (
                      <button
                        className="ord-swap"
                        aria-label={`Swap ${ORD_LABEL[ch]} with ${ORD_LABEL[ord[i + 1]]}`}
                        title={`Swap ${ORD_LABEL[ch]} ⇄ ${ORD_LABEL[ord[i + 1]]}`}
                        onClick={() => swapOrdAt(i as 0 | 1)}>⇄</button>
                    )}
                  </Fragment>
                ))}
              </div>
            </>
          )}
          {/* Slot for the active page's own display controls (AreaDrill's
              currency + denomination pills portal in here). */}
          <div className="topbar-extras" ref={setExtrasNode} />
        </div>
      </div>

      {showCustom && (
        <CustomPeriodPopover
          fromYM={fromYM}
          toYM={toYM}
          latestActualYM={latestActualYM}
          activePreset={preset}
          onClose={() => setShowCustom(false)}
          onApply={(f, t) => {
            setUrl({ p: 'custom', from: f, to: t })
            setShowCustom(false)
          }}
          onApplyPreset={(key) => {
            setUrl({ p: key, from: null, to: null })
            setShowCustom(false)
          }}
        />
      )}

      {showAreaFilter && (
        <AreaFilterPopover
          areas={areas}
          excluded={excludedAreas}
          onChange={updateExcluded}
          onClose={() => setShowAreaFilter(false)}
          groupLabels={AREA_GROUP_LABEL}
        />
      )}

      <div className="leftnav">
        <div className="leftnav-scroll">
          {navGroupOrder.map(group => {
            const items = navItems.filter(n => n.group === group)
            const hasActive = items.some(n => isActive(n.view))
            const alwaysOpen = group === 'REPORT' || group === 'SUMMARY' || group === 'BANK POSITION'
            const collapsed = !alwaysOpen && !hasActive && navCollapsed.has(group)
            return (
              <div key={group}>
                <div
                  className={`group ${alwaysOpen ? '' : 'group-collapsible'} ${collapsed ? 'group-collapsed' : ''}`}
                  onClick={() => { if (!alwaysOpen) toggleNavGroup(group) }}
                >
                  {!alwaysOpen && <span className="group-chevron">{collapsed ? '▶' : '▼'}</span>}
                  <span>{group}</span>
                  {!alwaysOpen && collapsed && <span className="group-count">{items.length}</span>}
                </div>
                {!collapsed && items.map(n => (
                  <a key={`${group}-${n.label}`}
                     className={`item ${isActive(n.view) ? 'active' : ''}`}
                     onClick={() => goto(n.view)}>
                    {n.label}
                  </a>
                ))}
              </div>
            )
          })}
        </div>
        <div className="leftnav-footer">
          <a className="analyze-link" href="/analyze">Project Analyze →</a>
          <div className="user-email">{user?.email}</div>
          <button className="signout" onClick={signOut}>Sign out</button>
        </div>
      </div>

      <div className="content">{renderContent()}</div>
    </div>
    </TopbarExtrasCtx.Provider>
  )
}

export type Scope = {
  primaryVersion: string;
  fromYear: number; fromMonth: number; toYear: number; toMonth: number;
  /* Canonical areas (public.areas joined with public.cashflow_sheets).
   * Each row carries the cf_areas list — Tony's labels in cf_actuals.area
   * that fold into this canonical area. */
  areas: CanonicalArea[];
  lines: CfLine[];
  /* All forecast versions (newest first). The Cash Flow Story derives its
   * reporting year + as-of from the SELECTED version's cycle_year/as_of_date,
   * so the period follows the version pills rather than a global actuals scan. */
  versions: CfVersion[];
  latestActualYM: number;
  grain: Grain;
  groupBy: GroupBy;
  /* Chip ordering for the AllAreas pivot. Unused on per-area drills
   * (Area is implicitly outermost when the rail picks a country). */
  ord: GrainOrd;
  /* Areas selected for aggregation on the All Areas view. Other views
   * read `areas` directly and ignore this. */
  selectedAreas: CanonicalArea[];
  /* Tony cf-area string → canonical area (every cf row in cf_actuals /
   * cf_forecasts can be resolved through this in O(1)). cf strings not
   * in the bridge (orphans) return undefined and should be skipped. */
  cfToCanonical: Map<string, CanonicalArea>;
}
