import { useState } from 'react'
import { api } from '../../shared/api'
import type { EitriBuild } from '../../shared/types'

type Props = {
  repository: string
  build: EitriBuild
  onClose: () => void
  onQueued: () => void
}

const DEFAULT_STAGING_ENV_UPDATE_JOB = 'DEV/DEV Deployer'

function replayParameters(build: EitriBuild) {
  return [
    { label: 'SERVICE_NAME', value: build.service },
    { label: 'NAMESPACE', value: build.namespace },
    {
      label: 'BRANCH',
      value: build.branch || `deploy/${build.namespace} (default)`,
    },
    {
      label: 'COMMIT_SHA',
      value: build.commitSha || '—',
    },
    {
      label: 'STAGING_ENV_UPDATE_JOB',
      value: build.stagingEnvUpdateJob || DEFAULT_STAGING_ENV_UPDATE_JOB,
    },
  ]
}

export function EitriReplayDialog({
  repository,
  build,
  onClose,
  onQueued,
}: Props) {
  const [replaying, setReplaying] = useState(false)
  const [error, setError] = useState('')
  const parameters = replayParameters(build)

  async function confirmReplay() {
    setReplaying(true)
    setError('')
    try {
      await api.triggerEitriDeployment({
        repository,
        service: build.service,
        namespace: build.namespace,
        ...(build.branch ? { branch: build.branch } : {}),
        ...(build.commitSha ? { commitSha: build.commitSha } : {}),
        stagingEnvUpdateJob:
          build.stagingEnvUpdateJob || DEFAULT_STAGING_ENV_UPDATE_JOB,
      })
      onQueued()
      onClose()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not replay the Jenkins EITRI build.',
      )
    } finally {
      setReplaying(false)
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="release-dialog confirm-dialog eitri-replay-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="eitri-replay-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="dialog-close"
          type="button"
          onClick={onClose}
          aria-label="Close"
          disabled={replaying}
        >
          ×
        </button>
        <p className="eyebrow">Replay EITRI build</p>
        <h2 id="eitri-replay-title">Re-trigger #{build.buildNumber}?</h2>
        <p className="dialog-copy">
          This queues the same Stag EITRI job with the parameters below.
        </p>
        <dl className="eitri-replay-params">
          {parameters.map((parameter) => (
            <div key={parameter.label}>
              <dt>{parameter.label}</dt>
              <dd>
                <code>{parameter.value}</code>
              </dd>
            </div>
          ))}
        </dl>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={onClose}
            disabled={replaying}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => void confirmReplay()}
            disabled={replaying}
          >
            {replaying ? 'Queuing replay…' : 'Replay build'}
          </button>
        </div>
      </section>
    </div>
  )
}
