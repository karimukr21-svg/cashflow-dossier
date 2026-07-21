import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchVersions, type CfVersion } from '@/lib/queries'

/* Submission templates — the INPUT side of the cycle.
 *
 * Generates the locked, pre-filled workbook each area fills in: a sheet per project
 * plus a formula-only SUMMARY rollup. Actuals through the cycle as-of month are
 * pre-filled and locked; the forecast tail is theirs to enter.
 *
 * The whole file is DERIVED from published canonical data (cf_lines for the row
 * taxonomy, cf_actuals/cf_forecasts for the values), so the file that comes back
 * next cycle matches what the DB generated — which is what makes intake mechanical
 * later. Nothing here writes to the database.
 *
 * NOTE: /api functions only exist on a Vercel deployment — under plain `vite dev`
 * the Generate button will 404. */

type VRow = CfVersion & { label?: string | null; is_current?: boolean; is_active?: boolean }

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
const cycleKeyOf = (v: VRow) => `${v.cycle_year}-${v.cycle_month}`
const cycleRank = (v: VRow) => v.cycle_year * 100 + v.cycle_month
const cycleLabel = (v: VRow) => `${MONTH_FULL[v.cycle_month - 1] ?? v.cycle_month} ${v.cycle_year}`
const isOrig = (v?: VRow) => !!v && ((v.label ?? '') === 'Original' || v.version_code.endsWith('-ORIG'))

async function postTemplates(body: unknown) {
  const { data: { session } } = await supabase.auth.getSession()
  return fetch('/api/cf-templates', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token || ''}`,
    },
    body: JSON.stringify(body),
  })
}

export default function TemplatesManager({ canManage }: { canManage: boolean }) {
  const [versions, setVersions] = useState<VRow[]>([])
  const [version, setVersion] = useState<string>('')
  const [areas, setAreas] = useState<string[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [areasLoading, setAreasLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const ver = useMemo(() => versions.find(v => v.version_code === version), [versions, version])
  const cycles = useMemo(() => {
    const seen = new Set<string>()
    return versions
      .slice()
      .sort((a, b) => cycleRank(b) - cycleRank(a))
      .filter(v => (seen.has(cycleKeyOf(v)) ? false : (seen.add(cycleKeyOf(v)), true)))
  }, [versions])
  const cycleVersions = ver ? versions.filter(v => cycleKeyOf(v) === cycleKeyOf(ver)) : []

  /* The as-of is the cycle itself: actuals run through the cycle month, and
   * everything after it is the forecast the area is being asked to fill in. */
  const asOfYm = ver ? ver.cycle_year * 100 + ver.cycle_month : 0
  const asOfLabel = ver ? `${MONTH_FULL[ver.cycle_month - 1]} ${ver.cycle_year}` : ''

  /* ── bootstrap: versions, defaulting to the newest cycle's Original ── */
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const vs = (await fetchVersions()) as VRow[]
        if (!alive) return
        const rows = vs.filter(v => v.is_active !== false)
        setVersions(rows)
        const newest = rows.length ? rows.filter(v => cycleRank(v) === cycleRank(rows[0])) : []
        // Templates pre-fill from the faithful extraction, not an adjustments scenario —
        // areas should see their own submitted numbers, with our adjustments kept on the ledger.
        setVersion((newest.find(isOrig) ?? newest[0])?.version_code ?? '')
      } catch (e) {
        if (alive) setErr((e as Error).message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  /* ── per-version: which areas can be generated ── */
  useEffect(() => {
    if (!version) return
    let alive = true
    setAreasLoading(true); setErr(null); setMsg(null)
    ;(async () => {
      try {
        const res = await postTemplates({ version, list: true })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json.error || `list failed (${res.status})`)
        if (!alive) return
        const list: string[] = json.areas ?? []
        setAreas(list)
        setPicked(new Set(list))
      } catch (e) {
        if (alive) { setAreas([]); setPicked(new Set()); setErr((e as Error).message) }
      } finally {
        if (alive) setAreasLoading(false)
      }
    })()
    return () => { alive = false }
  }, [version])

  const toggle = (a: string) => setPicked(p => {
    const n = new Set(p)
    n.has(a) ? n.delete(a) : n.add(a)
    return n
  })

  async function generate() {
    if (!version || !picked.size) return
    setBusy(true); setErr(null); setMsg(null)
    try {
      const chosen = areas.filter(a => picked.has(a))
      const res = await postTemplates({
        version,
        as_of_ym: asOfYm,
        areas: chosen,
        cycle_label: ver ? `${cycleLabel(ver)} Cycle` : undefined,
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || `generate failed (${res.status})`)
      }
      const blob = await res.blob()
      const cd = res.headers.get('content-disposition') || ''
      const match = /filename="?([^"]+)"?/.exec(cd)
      const name = match?.[1] || (chosen.length === 1
        ? `CashFlow-${chosen[0]}-${asOfYm}.xlsx`
        : `CashFlow-Templates-${asOfYm}.zip`)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = name; a.click()
      URL.revokeObjectURL(url)
      setMsg(`Generated ${chosen.length} ${chosen.length === 1 ? 'workbook' : 'workbooks'} — ${name}`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="cfm-body"><div className="cfm-empty">Loading…</div></div>

  return (
    <div className="cfm-body adje">
      <div className="adje-toolbar">
        <label className="adje-ctl">
          <span>Cycle</span>
          <select
            value={ver ? cycleKeyOf(ver) : ''}
            onChange={e => {
              const inCycle = versions.filter(v => cycleKeyOf(v) === e.target.value)
              setVersion((inCycle.find(isOrig) ?? inCycle[0])?.version_code ?? '')
            }}
          >
            {cycles.map(c => (
              <option key={cycleKeyOf(c)} value={cycleKeyOf(c)}>{cycleLabel(c)}</option>
            ))}
          </select>
        </label>
        <label className="adje-ctl">
          <span>Pre-fill from</span>
          <select value={version} onChange={e => setVersion(e.target.value)}>
            {cycleVersions.map(v => (
              <option key={v.version_code} value={v.version_code}>
                {(v.label ? `${v.label} — ` : '') + v.version_code}
              </option>
            ))}
          </select>
        </label>
        <button
          className="cfm-upload-btn tmpl-gen"
          disabled={busy || areasLoading || !picked.size}
          onClick={generate}
        >
          {busy ? 'Generating…' : picked.size === 1
            ? 'Generate workbook'
            : `Generate ${picked.size} workbooks (.zip)`}
        </button>
      </div>

      <p className="tmpl-note">
        Actuals through <strong>{asOfLabel}</strong> are pre-filled and locked; everything
        after it is left open for the area to fill in. Each workbook carries a sheet per
        project plus a formula-only <strong>SUMMARY</strong> rollup.
      </p>

      {err && <div className="cfm-readonly tmpl-err">{err}</div>}
      {msg && <div className="cfm-readonly tmpl-ok">{msg}</div>}

      {areasLoading ? (
        <div className="cfm-empty-sm">Loading areas…</div>
      ) : !areas.length ? (
        <div className="cfm-empty">No cash-flow data in this version.</div>
      ) : (
        <>
          <div className="tmpl-bar">
            <span className="tmpl-count">{picked.size} of {areas.length} areas</span>
            <button className="cfm-chip" onClick={() => setPicked(new Set(areas))}>Select all</button>
            <button className="cfm-chip" onClick={() => setPicked(new Set())}>Clear</button>
          </div>
          <div className="tmpl-grid">
            {areas.map(a => (
              <label key={a} className={'tmpl-area' + (picked.has(a) ? ' is-on' : '')}>
                <input type="checkbox" checked={picked.has(a)} onChange={() => toggle(a)} />
                <span>{a}</span>
              </label>
            ))}
          </div>
        </>
      )}
      {!canManage && (
        <div className="cfm-readonly">
          Read-only role — generating templates does not change any data.
        </div>
      )}
    </div>
  )
}
