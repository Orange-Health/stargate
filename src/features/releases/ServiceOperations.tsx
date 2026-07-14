import { useCallback, useEffect, useState } from 'react'
import { api } from '../../shared/api'
import type {
  BuildStatus,
  PromotionStep,
  RepositoryReleaseState,
  TrackedStagingRelease,
} from '../../shared/types'
import { DeployDialog } from './DeployDialog'

type Props = {
  repository: string
}

const buildLabels: Record<BuildStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  canceled: 'Canceled',
}

function timeAgo(value: string) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000),
  )
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

function mergeBlockReason(
  step: PromotionStep,
  hasBackMerges: boolean,
): string | undefined {
  if (hasBackMerges) return 'Resolve pending back-merges first'
  const pull = step.pullRequest
  if (!pull) return undefined
  if (pull.draft) return 'PR is still a draft'
  if (pull.mergeable === null) return 'GitHub is checking mergeability'
  if (pull.mergeable === false || pull.mergeableState === 'dirty') {
    return 'PR has merge conflicts'
  }
  if (pull.checks === 'pending') return 'Checks are pending'
  if (pull.checks === 'failure') return 'Checks are failing'
  return undefined
}

export function ServiceOperations({ repository }: Props) {
  const [state, setState] = useState<RepositoryReleaseState>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyRoute, setBusyRoute] = useState('')
  const [deployRelease, setDeployRelease] =
    useState<TrackedStagingRelease>()

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      setError('')
      try {
        setState(await api.repositoryState(repository))
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : 'Could not load repository operations.',
        )
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [repository],
  )

  useEffect(() => {
    setState(undefined)
    setLoading(true)
    setError('')
    void load()
    const interval = window.setInterval(() => void load(true), 15_000)
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ repository?: string }>).detail
      if (!detail?.repository || detail.repository === repository) {
        void load(true)
      }
    }
    window.addEventListener('staging-release-created', refresh)
    window.addEventListener('service-refresh-requested', refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('staging-release-created', refresh)
      window.removeEventListener('service-refresh-requested', refresh)
    }
  }, [load, repository])

  async function createPull(step: PromotionStep) {
    setBusyRoute(step.route)
    setError('')
    try {
      await api.createPromotionPullRequest({ repository, route: step.route })
      await load(true)
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not create the PR.',
      )
    } finally {
      setBusyRoute('')
    }
  }

  async function mergePull(step: PromotionStep) {
    if (!step.pullRequest) return
    const confirmed = window.confirm(
      `Merge #${step.pullRequest.number} from ${step.fromBranch} to ${step.toBranch}?`,
    )
    if (!confirmed) return
    setBusyRoute(step.route)
    setError('')
    try {
      await api.mergePromotionPullRequest({
        repository,
        pullNumber: step.pullRequest.number,
      })
      await load(true)
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not merge the PR.',
      )
    } finally {
      setBusyRoute('')
    }
  }

  return (
    <div className="service-operations">
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}

      <section className="operation-section">
        <div className="operation-heading">
          <div>
            <p className="eyebrow">GitHub Actions</p>
            <h3>Staging releases</h3>
          </div>
          <span className="auto-refresh">Live · 15s</span>
        </div>
        {state?.deploymentLookupFailed && (
          <p className="deployment-lookup-note">
            Jenkins deployment status is temporarily unavailable.
          </p>
        )}

        {loading && !state ? (
          <div className="operation-loading">
            <span className="spinner" /> Loading release builds…
          </div>
        ) : state?.stagingReleases.length ? (
          <div className="release-build-list">
            {state.stagingReleases.map((release) => {
              const liveDeployments = state.deployedTags.filter(
                (deployment) => deployment.tag === release.tag,
              )
              return (
                <article className="release-build-row" key={release.id}>
                <span
                  className={`build-indicator ${release.buildStatus}`}
                  aria-hidden="true"
                />
                <div className="release-build-main">
                  <a href={release.url} target="_blank" rel="noreferrer">
                    {release.tag}
                  </a>
                  <span>
                    {release.environment.toUpperCase()} ·{' '}
                    {timeAgo(release.createdAt)}
                  </span>
                  {liveDeployments.length > 0 && (
                    <div className="live-deployments">
                      {liveDeployments.map((deployment) => (
                        <a
                          className="live-deployment"
                          href={deployment.buildUrl || undefined}
                          target="_blank"
                          rel="noreferrer"
                          title={`${deployment.service} · Jenkins build #${deployment.buildNumber}`}
                          key={`${deployment.service}-${deployment.environment}`}
                        >
                          <span aria-hidden="true">●</span> Live in{' '}
                          {deployment.environment.toUpperCase()}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                <span className={`build-status ${release.buildStatus}`}>
                  {buildLabels[release.buildStatus]}
                </span>
                <button
                  className="deploy-button"
                  type="button"
                  disabled={
                    release.buildStatus !== 'succeeded' ||
                    state.jenkinsServices.length === 0
                  }
                  title={
                    state.jenkinsServices.length === 0
                      ? 'No Jenkins service mapping for this repository'
                      : release.buildStatus !== 'succeeded'
                        ? 'Deployment is enabled after a successful build'
                        : 'Deploy this release'
                  }
                  onClick={() => setDeployRelease(release)}
                >
                  Deploy
                </button>
                <div className="workflow-links">
                  {release.runs.length === 0 ? (
                    <small>Waiting for workflow</small>
                  ) : (
                    release.runs.map((run) => (
                      <a
                        href={run.url}
                        target="_blank"
                        rel="noreferrer"
                        key={run.id}
                        title={`${run.status}${run.conclusion ? ` · ${run.conclusion}` : ''}`}
                      >
                        {run.name} ↗
                      </a>
                    ))
                  )}
                </div>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="operation-empty">
            No staging releases found for this service.
          </div>
        )}
      </section>

      <section className="operation-section journey-section">
        <div className="operation-heading">
          <div>
            <p className="eyebrow">Branch promotion</p>
            <h3>Release journey</h3>
          </div>
          {state && (
            <span className="default-branch">
              Default · <code>{state.defaultBranch}</code>
            </span>
          )}
        </div>

        {state?.pendingBackMerges.length ? (
          <div className="back-merge-warning">
            <strong>Pending back-merge detected</strong>
            <span>Resolve before promoting or merging:</span>
            {state.pendingBackMerges.map((pull) => (
              <a href={pull.url} target="_blank" rel="noreferrer" key={pull.number}>
                #{pull.number} {pull.fromBranch} → {pull.toBranch}
              </a>
            ))}
          </div>
        ) : null}

        <div className="journey-track">
          {state?.promotionSteps.map((step, index) => {
            const blockReason = mergeBlockReason(
              step,
              state.pendingBackMerges.length > 0,
            )
            return (
              <article className="journey-step" key={step.route}>
                <div className="journey-branches">
                  <span className="branch-node">{step.fromBranch}</span>
                  <span className="branch-arrow">
                    <small>{step.commitsAhead} commits</small>→
                  </span>
                  <span className="branch-node">{step.toBranch}</span>
                </div>

                {step.state === 'up_to_date' && (
                  <div className="journey-state complete">
                    <span>✓</span>
                    <div>
                      <strong>Up to date</strong>
                      <small>No changes waiting to promote</small>
                    </div>
                  </div>
                )}

                {step.state === 'needs_pr' && (
                  <div className="journey-state">
                    <div>
                      <strong>Ready to create PR</strong>
                      <small>
                        {step.previousTemplate
                          ? 'Uses the previous promotion PR title and description; only branches change.'
                          : 'No previous promotion PR found; a standard title and description will be used.'}
                      </small>
                    </div>
                    <button
                      className="journey-action"
                      type="button"
                      disabled={busyRoute === step.route}
                      onClick={() => void createPull(step)}
                    >
                      {busyRoute === step.route ? 'Creating…' : 'Create PR'}
                    </button>
                  </div>
                )}

                {step.state === 'pr_open' && step.pullRequest && (
                  <div className="journey-state">
                    <div>
                      <strong>
                        <a
                          href={step.pullRequest.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          PR #{step.pullRequest.number} ↗
                        </a>
                      </strong>
                      <small>
                        {step.pullRequest.reviewDecision.replaceAll('_', ' ')} ·{' '}
                        checks {step.pullRequest.checks}
                      </small>
                      {blockReason && (
                        <small className="merge-block">{blockReason}</small>
                      )}
                    </div>
                    <button
                      className="journey-action merge"
                      type="button"
                      disabled={Boolean(blockReason) || busyRoute === step.route}
                      onClick={() => void mergePull(step)}
                    >
                      {busyRoute === step.route
                        ? 'Merging…'
                        : `Merge to ${step.toBranch}`}
                    </button>
                  </div>
                )}

                {index === 0 && <div className="journey-divider" />}
              </article>
            )
          })}
        </div>
      </section>
      {deployRelease && state && (
        <DeployDialog
          repository={repository}
          release={deployRelease}
          services={state.jenkinsServices}
          onClose={() => setDeployRelease(undefined)}
        />
      )}
    </div>
  )
}
