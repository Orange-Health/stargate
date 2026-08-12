import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../../shared/api'
import type {
  EitriNamespace,
  TriggeredEitriDeployment,
} from '../../shared/types'
import { DialogBackdrop } from './DialogBackdrop'

type Props = {
  repository: string
  services: string[]
  onClose: () => void
  onQueued?: (deployment: TriggeredEitriDeployment) => void
}

const namespaces: Array<{ value: EitriNamespace; label: string }> = [
  { value: 's1', label: 'S1 · Doctors' },
  { value: 's2', label: 'S2 · D2C CRM' },
  { value: 's3', label: 'S3 · Logistics' },
  { value: 's4', label: 'S4 · Lab' },
  { value: 's5', label: 'S5 · Partnerships' },
]

const DEFAULT_STAGING_ENV_UPDATE_JOB = 'DEV/DEV Deployer'
const BRANCH_DATALIST_ID = 'eitri-source-branches'

function defaultBranchForNamespace(
  namespace: EitriNamespace,
  branches: string[],
) {
  const preferred = `deploy/${namespace}`
  return branches.includes(preferred) ? preferred : ''
}

export function EitriDialog({
  repository,
  services,
  onClose,
  onQueued,
}: Props) {
  const [service, setService] = useState(services[0] ?? '')
  const [namespace, setNamespace] = useState<EitriNamespace>('s1')
  const [branch, setBranch] = useState('')
  const [commitSha, setCommitSha] = useState('')
  const [stagingEnvUpdateJob, setStagingEnvUpdateJob] = useState(
    DEFAULT_STAGING_ENV_UPDATE_JOB,
  )
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(true)
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState('')
  const [deployment, setDeployment] = useState<TriggeredEitriDeployment>()

  useEffect(() => {
    if (!services.includes(service)) {
      setService(services[0] ?? '')
    }
  }, [service, services])

  useEffect(() => {
    let active = true
    setBranchesLoading(true)
    api
      .repositoryBranches(repository)
      .then((items) => {
        if (!active) return
        setBranches(items)
        setBranch((current) => {
          if (current && items.includes(current)) return current
          return defaultBranchForNamespace('s1', items)
        })
      })
      .catch(() => {
        if (active) setBranches([])
      })
      .finally(() => {
        if (active) setBranchesLoading(false)
      })
    return () => {
      active = false
    }
  }, [repository])

  useEffect(() => {
    if (branchesLoading || branches.length === 0) return
    setBranch((current) => {
      const deployDefaults = new Set(
        ['s1', 's2', 's3', 's4', 's5'].map((value) => `deploy/${value}`),
      )
      if (
        current &&
        !deployDefaults.has(current) &&
        branches.includes(current)
      ) {
        return current
      }
      return defaultBranchForNamespace(namespace, branches)
    })
  }, [branches, branchesLoading, namespace])

  useEffect(() => {
    if (!deployment || deployment.buildUrl) return
    let active = true
    let timeout: number | undefined

    async function pollQueue() {
      if (!deployment || !active) return
      try {
        const status = await api.jenkinsQueueStatus(deployment.queueId)
        if (!active) return
        if (status.status === 'started' && status.buildUrl) {
          setError('')
          setDeployment((current) =>
            current
              ? {
                  ...current,
                  buildUrl: status.buildUrl,
                  buildNumber: status.buildNumber,
                }
              : current,
          )
          return
        }
        if (status.status === 'canceled') {
          setError(status.message ?? 'The Jenkins EITRI build was canceled.')
          return
        }
      } catch (reason) {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : 'Could not resolve the Jenkins build URL.',
          )
        }
      }
      if (active) timeout = window.setTimeout(pollQueue, 1_500)
    }

    void pollQueue()
    return () => {
      active = false
      if (timeout) window.clearTimeout(timeout)
    }
  }, [deployment])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setDeploying(true)
    setError('')
    try {
      const result = await api.triggerEitriDeployment({
        repository,
        service,
        namespace,
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        ...(commitSha.trim() ? { commitSha: commitSha.trim() } : {}),
        stagingEnvUpdateJob:
          stagingEnvUpdateJob.trim() || DEFAULT_STAGING_ENV_UPDATE_JOB,
      })
      setDeployment(result)
      onQueued?.(result)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not trigger the Jenkins EITRI build.',
      )
    } finally {
      setDeploying(false)
    }
  }

  return (
    <DialogBackdrop onMouseDown={onClose}>
      <section
        className="release-dialog deploy-dialog eitri-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="eitri-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="dialog-close"
          type="button"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>

        {deployment ? (
          <div className="release-created">
            <span className="created-icon deploy" aria-hidden="true">
              ↗
            </span>
            <p className="eyebrow">Jenkins EITRI queued</p>
            <h2 id="eitri-title">{deployment.namespace.toUpperCase()}</h2>
            <p>
              <code>{deployment.service}</code> will build and deploy through{' '}
              <code>{deployment.jobName}</code>
              {deployment.branch ? (
                <>
                  {' '}
                  from <code>{deployment.branch}</code>
                </>
              ) : (
                <>
                  {' '}
                  from <code>deploy/{deployment.namespace}</code>
                </>
              )}
              .
            </p>
            {deployment.buildUrl ? (
              <a
                className="primary-button release-link"
                href={deployment.buildUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Jenkins build <span aria-hidden="true">↗</span>
              </a>
            ) : (
              <div className="jenkins-queue-wait">
                <span className="spinner" />
                Waiting for Jenkins to assign a build number…
              </div>
            )}
            {error && (
              <div className="alert error deployment-error" role="alert">
                {error}
              </div>
            )}
            <button className="text-button done-button" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <form className="eitri-dialog-form" onSubmit={submit}>
            <div className="eitri-dialog-header">
              <p className="eyebrow">Jenkins · Stag EITRI</p>
              <h2 id="eitri-title">Build & deploy</h2>
              <p className="dialog-copy">
                EITRI builds the service and deploys it to staging in one Jenkins
                job. No separate deploy step is required.
              </p>
            </div>
            <div className="eitri-dialog-body">
              <label>
                Service name
                <select
                  value={service}
                  onChange={(event) => setService(event.target.value)}
                  required
                >
                  {services.map((item) => (
                    <option value={item} key={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <p className="field-hint">Select the service to build</p>
              <label>
                Namespace
                <select
                  value={namespace}
                  onChange={(event) =>
                    setNamespace(event.target.value as EitriNamespace)
                  }
                >
                  {namespaces.map((item) => (
                    <option value={item.value} key={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="field-hint">
                Helm environment folder: s1_env, s2_env, etc.
              </p>
              <label>
                Branch
                <input
                  type="search"
                  list={BRANCH_DATALIST_ID}
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder={
                    branchesLoading
                      ? 'Loading branches…'
                      : `deploy/${namespace}`
                  }
                  autoComplete="off"
                />
                <datalist id={BRANCH_DATALIST_ID}>
                  {branches.map((item) => (
                    <option value={item} key={item} />
                  ))}
                </datalist>
              </label>
              <p className="field-hint">
                Optional. Defaults to deploy/{namespace}
                {branchesLoading ? ' · loading branches…' : ''}
              </p>
              <label>
                Commit SHA
                <input
                  type="text"
                  value={commitSha}
                  onChange={(event) => setCommitSha(event.target.value)}
                  placeholder="Optional"
                  spellCheck={false}
                />
              </label>
              <p className="field-hint">
                Optional; takes precedence over branch when set
              </p>
              <label>
                Staging env update job
                <input
                  type="text"
                  value={stagingEnvUpdateJob}
                  onChange={(event) =>
                    setStagingEnvUpdateJob(event.target.value)
                  }
                  required
                />
              </label>
              <p className="field-hint">
                Downstream job that runs staging-env-update
              </p>
              <div className="deployment-summary">
                <span>Job</span>
                <code>DEV / Stag EITRI</code>
                <small>
                  Builds and deploys staging in a single pipeline step.
                </small>
              </div>
              {error && (
                <div className="alert error" role="alert">
                  {error}
                </div>
              )}
            </div>
            <div className="eitri-dialog-footer dialog-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={deploying || !service}
              >
                {deploying ? 'Queuing EITRI…' : 'Build & deploy'}
              </button>
            </div>
          </form>
        )}
      </section>
    </DialogBackdrop>
  )
}
