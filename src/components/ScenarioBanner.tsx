import { useScenario } from '../lib/ScenarioContext'

type Props = {
  /* The current latest baseline cf_versions.version_code (versions[0] in
   * Dossier). When this != savedScenario.baseline_version_code, the
   * scenario is pinned to a superseded vintage and we surface a callout. */
  latestVersionCode: string
}

export function ScenarioBanner({ latestVersionCode }: Props) {
  const { activeId, savedScenario, recoveryDraft, acceptRecoveryDraft, discardRecoveryDraft } = useScenario()
  if (activeId === 'baseline') return null

  const draftAge = recoveryDraft ? minutesAgo(recoveryDraft.savedAt) : 0
  const baselineSuperseded = savedScenario
    && latestVersionCode
    && savedScenario.baseline_version_code !== latestVersionCode

  if (!recoveryDraft && !baselineSuperseded) return null

  return (
    <div className="scenario-banner-stack">
      {recoveryDraft && (
        <div className="scenario-banner scenario-banner-recovery">
          <span>
            Recover unsaved changes from {draftAge} {draftAge === 1 ? 'minute' : 'minutes'} ago?
          </span>
          <div className="scenario-banner-actions">
            <button onClick={acceptRecoveryDraft} className="primary">Recover</button>
            <button onClick={discardRecoveryDraft}>Discard</button>
          </div>
        </div>
      )}
      {baselineSuperseded && savedScenario && (
        <div className="scenario-banner scenario-banner-baseline">
          <span>
            Viewing scenario <strong>{savedScenario.name}</strong> built on baseline
            {' '}<code>{savedScenario.baseline_version_code}</code>. Latest baseline is
            {' '}<code>{latestVersionCode}</code> — fork a new scenario to use it.
          </span>
        </div>
      )}
    </div>
  )
}

function minutesAgo(iso: string): number {
  try {
    const then = new Date(iso).getTime()
    return Math.max(1, Math.round((Date.now() - then) / 60000))
  } catch { return 0 }
}
