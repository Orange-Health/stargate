import { useEffect, useMemo, useState } from 'react'
import { api } from '../../shared/api'
import type {
  ConnectionStatus,
  DeploymentFreshness,
  EligibilityReason,
  JiraVersion,
  ReleaseDashboard,
  ReleaseItem,
  ServiceRelease,
} from '../../shared/types'
import { StagingReleaseDialog } from './StagingReleaseDialog'
import { ServiceOperations } from './ServiceOperations'
import { ThemeToggle } from '../theme/ThemeToggle'

type Props = {
  connection: ConnectionStatus
  releases: JiraVersion[]
  selectedVersionId: string
  dashboard?: ReleaseDashboard
  loading: boolean
  error?: string
  onSelectVersion: (versionId: string) => void
  onRefresh: () => void | Promise<void>
  onDisconnect: () => void
}

const reasonLabels: Record<EligibilityReason, string> = {
  NO_MATCHING_PR: 'No matching PR',
  WRONG_BASE_BRANCH: 'Not targeting dev',
  REVIEW_REQUIRED: 'Review required',
  CHANGES_REQUESTED: 'Changes requested',
  HAS_CONFLICTS: 'Merge conflicts',
  MERGEABILITY_PENDING: 'Checking conflicts',
  CHECKS_PENDING: 'Checks pending',
  CHECKS_FAILED: 'Checks failed',
  DRAFT: 'Draft PR',
  ALREADY_MERGED: 'Merged',
}

function formatDate(value?: string) {
  if (!value) return 'No date set'
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${value}T00:00:00`))
}

function relativeTime(value: string) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000),
  )
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

function ItemStatus({ item }: { item: ReleaseItem }) {
  if (item.pullRequest?.merged) {
    return <span className="status-pill merged">Merged</span>
  }
  if (item.eligible) {
    return <span className="status-pill ready">Ready</span>
  }
  return <span className="status-pill blocked">Blocked</span>
}

function ServiceCard({
  service,
  selected,
  onClick,
}: {
  service: ServiceRelease
  selected: boolean
  onClick: () => void
}) {
  const name = service.repository.split('/').at(-1)
  const total = service.items.length
  const completed = service.mergedCount
  const progress = total === 0 ? 0 : Math.round((completed / total) * 100)

  return (
    <button
      className={`service-card ${selected ? 'selected' : ''}`}
      onClick={onClick}
      type="button"
    >
      <div className="service-card-header">
        <span className="service-avatar">{name?.slice(0, 2).toUpperCase()}</span>
        <span>
          <strong>{name}</strong>
          <small>{service.repository}</small>
        </span>
        <span className="chevron">›</span>
      </div>
      <div className="service-metrics">
        <span>
          <strong>{service.eligibleCount}</strong> ready
        </span>
        <span>
          <strong>{service.blockedCount}</strong> blocked
        </span>
        <span>
          <strong>{service.mergedCount}</strong> merged
        </span>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={`${name} release readiness`}
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
    </button>
  )
}

function ServiceDetail({
  service,
  onCreateRelease,
  onDataChanged,
}: {
  service: ServiceRelease
  onCreateRelease: () => void
  onDataChanged: () => void | Promise<void>
}) {
  const name = service.repository.split('/').at(-1)
  const [merging, setMerging] = useState<number>()
  const [refreshing, setRefreshing] = useState(false)
  const [mergeError, setMergeError] = useState('')
  const [optimisticallyMerged, setOptimisticallyMerged] = useState<Set<number>>(
    new Set(),
  )

  async function mergePullRequest(pullNumber: number) {
    if (!window.confirm(`Merge feature PR #${pullNumber} into dev?`)) return
    setMerging(pullNumber)
    setMergeError('')
    try {
      await api.mergeFeaturePullRequest({
        repository: service.repository,
        pullNumber,
      })
      setOptimisticallyMerged((current) => new Set(current).add(pullNumber))
      await onDataChanged()
    } catch (reason) {
      setMergeError(
        reason instanceof Error ? reason.message : 'Could not merge the PR.',
      )
    } finally {
      setMerging(undefined)
    }
  }

  async function refreshService() {
    setRefreshing(true)
    setMergeError('')
    try {
      await api.refreshRepository(service.repository)
      window.dispatchEvent(
        new CustomEvent('service-refresh-requested', {
          detail: { repository: service.repository },
        }),
      )
      await onDataChanged()
    } catch (reason) {
      setMergeError(
        reason instanceof Error
          ? reason.message
          : 'Could not refresh the service.',
      )
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section className="detail-panel">
      <div className="detail-heading">
        <div>
          <p className="eyebrow">Service detail</p>
          <h2>{name}</h2>
          <p className="muted">{service.repository}</p>
        </div>
        <div className="detail-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => void refreshService()}
            disabled={refreshing || merging !== undefined}
          >
            {refreshing ? 'Refreshing…' : '↻ Refresh service'}
          </button>
          <button
            className="create-release-button"
            type="button"
            onClick={onCreateRelease}
          >
            <span aria-hidden="true">＋</span> Create staging release
          </button>
          <div className="summary-badge">
            {service.eligibleCount + service.mergedCount}/{service.items.length}
            <small>clear</small>
          </div>
        </div>
      </div>

      {mergeError && (
        <div className="alert error detail-alert" role="alert">
          {mergeError}
        </div>
      )}

      <div className="pr-list">
        {service.items.map((item) => {
          const mergeReady =
            item.eligible &&
            !item.warningReasons.includes('CHECKS_PENDING') &&
            !service.backMergePending &&
            !item.pullRequest?.merged &&
            !optimisticallyMerged.has(item.pullRequest?.number ?? -1)
          return (
            <article
              className="pr-row"
              key={`${item.issue.key}-${item.pullRequest?.id ?? 'unmatched'}`}
            >
            <div className="pr-main">
              <div className="pr-title-row">
                <a href={item.issue.url} target="_blank" rel="noreferrer">
                  {item.issue.key}
                </a>
                {item.pullRequest &&
                optimisticallyMerged.has(item.pullRequest.number) ? (
                  <span className="status-pill merged">Merged</span>
                ) : (
                  <ItemStatus item={item} />
                )}
              </div>
              <h3>
                {item.pullRequest ? (
                  <a
                    href={item.pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.pullRequest.title}
                  </a>
                ) : (
                  item.issue.summary
                )}
              </h3>
              {item.pullRequest && (
                <>
                  <p className="branch-line">
                    <code>{item.pullRequest.headBranch}</code>
                    <span>→</span>
                    <code>{item.pullRequest.baseBranch}</code>
                    <span>#{item.pullRequest.number}</span>
                  </p>
                  {Boolean(item.pullRequest.participants?.length) && (
                    <div
                      className="participant-list"
                      aria-label="People involved"
                    >
                      {item.pullRequest.participants
                        ?.slice(0, 6)
                        .map((person) => (
                          <img
                            src={person.avatarUrl}
                            alt={person.login}
                            title={`${person.login} · ${person.role}`}
                            key={person.login}
                          />
                        ))}
                      {(item.pullRequest.participants?.length ?? 0) > 6 && (
                        <span>
                          +{(item.pullRequest.participants?.length ?? 0) - 6}
                        </span>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="reason-list">
              {[...item.blockingReasons, ...item.warningReasons].map(
                (reason) => (
                  <span
                    className={`reason ${item.warningReasons.includes(reason) ? 'warning' : ''}`}
                    key={reason}
                  >
                    {reasonLabels[reason]}
                  </span>
                ),
              )}
              {item.eligible && item.warningReasons.length === 0 && (
                <span className="reason success">All criteria met</span>
              )}
              {mergeReady && item.pullRequest && (
                <button
                  className="merge-feature-button"
                  type="button"
                  disabled={merging === item.pullRequest.number}
                  onClick={() =>
                    void mergePullRequest(item.pullRequest!.number)
                  }
                >
                  {merging === item.pullRequest.number
                    ? 'Merging…'
                    : 'Merge to dev'}
                </button>
              )}
            </div>
          </article>
          )
        })}
      </div>
      <ServiceOperations
        key={service.repository}
        repository={service.repository}
      />
    </section>
  )
}

export function ReleaseOverview({
  connection,
  releases,
  selectedVersionId,
  dashboard,
  loading,
  error,
  onSelectVersion,
  onRefresh,
  onDisconnect,
}: Props) {
  const [selectedRepository, setSelectedRepository] = useState('')
  const [releaseRepository, setReleaseRepository] = useState('')
  const [serviceFilter, setServiceFilter] = useState<
    'all' | 'pending' | 'issues' | 'outdated'
  >('all')
  const [serviceSearch, setServiceSearch] = useState('')
  const [repositoryRisks, setRepositoryRisks] = useState<
    Record<string, { backMergePending: boolean; checkFailed: boolean }>
  >({})
  const [risksLoading, setRisksLoading] = useState(false)
  const [deploymentFreshness, setDeploymentFreshness] = useState<
    Record<string, DeploymentFreshness>
  >({})
  const [freshnessLoading, setFreshnessLoading] = useState(false)

  useEffect(() => {
    const repositories =
      dashboard?.services.map((service) => service.repository) ?? []
    setRepositoryRisks({})
    if (repositories.length === 0) {
      setRisksLoading(false)
      return
    }
    let active = true
    setRisksLoading(true)
    api
      .repositoryRisks(repositories)
      .then((risks) => {
        if (!active) return
        setRepositoryRisks(
          Object.fromEntries(
            risks.map((risk) => [
              risk.repository,
              {
                backMergePending: risk.backMergePending,
                checkFailed: risk.checkFailed,
              },
            ]),
          ),
        )
      })
      .catch(() => {
        if (!active) return
        setRepositoryRisks(
          Object.fromEntries(
            repositories.map((repository) => [
              repository,
              { backMergePending: false, checkFailed: true },
            ]),
          ),
        )
      })
      .finally(() => {
        if (active) setRisksLoading(false)
      })
    return () => {
      active = false
    }
  }, [dashboard])

  useEffect(() => {
    const repositories =
      dashboard?.services.map((service) => service.repository) ?? []
    setDeploymentFreshness({})
    if (repositories.length === 0) {
      setFreshnessLoading(false)
      return
    }
    let active = true
    setFreshnessLoading(true)
    api
      .deploymentFreshness(repositories)
      .then((statuses) => {
        if (!active) return
        setDeploymentFreshness(
          Object.fromEntries(
            statuses.map((status) => [status.repository, status]),
          ),
        )
      })
      .catch(() => {
        if (!active) return
        setDeploymentFreshness(
          Object.fromEntries(
            repositories.map((repository) => [
              repository,
              {
                repository,
                liveQaTags: [],
                outdated: false,
                checkFailed: true,
              },
            ]),
          ),
        )
      })
      .finally(() => {
        if (active) setFreshnessLoading(false)
      })
    return () => {
      active = false
    }
  }, [dashboard])

  const filteredServices = useMemo(() => {
    if (!dashboard) return []
    let services = dashboard.services
    if (serviceFilter === 'pending') {
      services = services.filter((service) =>
        service.items.some(
          (item) => item.pullRequest && !item.pullRequest.merged,
        ),
      )
    }
    if (serviceFilter === 'issues') {
      services = services.filter(
        (service) =>
          (repositoryRisks[service.repository]?.backMergePending ??
            service.backMergePending) ||
          service.items.some((item) =>
            item.blockingReasons.includes('HAS_CONFLICTS'),
          ),
      )
    }
    if (serviceFilter === 'outdated') {
      services = services.filter(
        (service) => deploymentFreshness[service.repository]?.outdated,
      )
    }
    const query = serviceSearch.trim().toLowerCase()
    if (!query) return services
    return services.filter((service) =>
      service.repository.toLowerCase().includes(query),
    )
  }, [
    dashboard,
    deploymentFreshness,
    repositoryRisks,
    serviceFilter,
    serviceSearch,
  ])
  const selectedService = useMemo(
    () =>
      filteredServices.find(
        (service) => service.repository === selectedRepository,
      ) ?? filteredServices[0],
    [filteredServices, selectedRepository],
  )
  const mergedIssueKeys = new Set(
    dashboard?.services.flatMap((service) =>
      service.items
        .filter(
          (item) =>
            item.pullRequest?.merged && item.pullRequest.baseBranch === 'dev',
        )
        .map((item) => item.issue.key),
    ) ?? [],
  )
  const totalItems = dashboard?.version.issueCount ?? 0
  const readyItems = mergedIssueKeys.size
  const pendingServiceCount =
    dashboard?.services.filter((service) =>
      service.items.some(
        (item) => item.pullRequest && !item.pullRequest.merged,
      ),
    ).length ?? 0
  const issueServiceCount =
    dashboard?.services.filter(
      (service) =>
        (repositoryRisks[service.repository]?.backMergePending ??
          service.backMergePending) ||
        service.items.some((item) =>
          item.blockingReasons.includes('HAS_CONFLICTS'),
        ),
    ).length ?? 0
  const outdatedServiceCount =
    dashboard?.services.filter(
      (service) => deploymentFreshness[service.repository]?.outdated,
    ).length ?? 0
  const selectedServiceWithRisk = selectedService
    ? {
        ...selectedService,
        backMergePending:
          repositoryRisks[selectedService.repository]?.backMergePending ??
          selectedService.backMergePending,
        riskCheckFailed:
          repositoryRisks[selectedService.repository]?.checkFailed ??
          selectedService.riskCheckFailed,
      }
    : undefined

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark compact">RD</span>
          <span>
            <strong>Release Desk</strong>
            <small>Operations console</small>
          </span>
        </div>
        <div className="topbar-actions">
          <ThemeToggle />
          <span className="connection-dot" />
          <span className="connected-label">
            {connection.githubOrg} · {connection.projectKey}
          </span>
          <button className="text-button" type="button" onClick={onDisconnect}>
            Disconnect
          </button>
        </div>
      </header>

      <main className="dashboard">
        <section className="release-toolbar">
          <div>
            <p className="eyebrow">Active release</p>
            <select
              aria-label="Active Jira release"
              value={selectedVersionId}
              onChange={(event) => {
                setSelectedRepository('')
                setServiceFilter('all')
                setServiceSearch('')
                onSelectVersion(event.target.value)
              }}
            >
              {releases.map((release) => (
                <option value={release.id} key={release.id}>
                  {release.name}
                </option>
              ))}
            </select>
          </div>
          <div className="release-meta">
            <span>
              Target
              <strong>{formatDate(dashboard?.version.releaseDate)}</strong>
            </span>
            {dashboard && (
              <span>
                Last synced
                <strong>{relativeTime(dashboard.fetchedAt)}</strong>
              </span>
            )}
            <button
              className="secondary-button"
              type="button"
              onClick={onRefresh}
              disabled={loading || !selectedVersionId}
            >
              {loading ? 'Syncing…' : '↻ Refresh'}
            </button>
          </div>
        </section>

        {error && (
          <div className="alert error" role="alert">
            <strong>Couldn’t load this release.</strong> {error}
          </div>
        )}

        {loading && !dashboard && (
          <div className="loading-state">
            <span className="spinner" />
            <h2>Mapping release tickets to pull requests…</h2>
            <p>This can take a moment for larger releases.</p>
          </div>
        )}

        {loading && dashboard && (
          <div className="sync-state" role="status">
            <span className="spinner" />
            Refreshing release data…
          </div>
        )}

        {!loading && releases.length === 0 && (
          <div className="empty-state">
            <h2>No unreleased Jira versions found</h2>
            <p>Create or unarchive a release in project OH, then refresh.</p>
          </div>
        )}

        {dashboard && (
          <>
            <section className="overview-strip">
              <div className="readiness-score">
                <span>
                  {totalItems === 0
                    ? 0
                    : Math.round((readyItems / totalItems) * 100)}
                  <small>%</small>
                </span>
                <div>
                  <strong>Release readiness</strong>
                  <p>
                    {readyItems} of {totalItems} tickets merged to dev
                  </p>
                </div>
              </div>
              <div className="stat">
                <strong>{dashboard.services.length}</strong>
                <span>Services</span>
              </div>
              <div className="stat">
                <strong>{dashboard.unmatched.length}</strong>
                <span>Unmatched tickets</span>
              </div>
              <div className="stat">
                <strong>{dashboard.githubRateLimit?.remaining ?? '—'}</strong>
                <span>GitHub calls left</span>
              </div>
              {dashboard.cached && <span className="cache-pill">Cached</span>}
            </section>

            {dashboard.warnings.map((warning, index) => (
              <div className="alert warning" key={`${warning.message}-${index}`}>
                <strong>Partial GitHub data.</strong> {warning.message}
              </div>
            ))}

            <div className="dashboard-grid">
              <section className="services-panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Release scope</p>
                    <h2>Services</h2>
                  </div>
                  <span>
                    {filteredServices.length}/{dashboard.services.length}
                  </span>
                </div>
                <label className="service-search">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle cx="11" cy="11" r="6.5" />
                    <path d="m16 16 4 4" />
                  </svg>
                  <input
                    type="search"
                    value={serviceSearch}
                    onChange={(event) => {
                      setServiceSearch(event.target.value)
                      setSelectedRepository('')
                    }}
                    placeholder="Search services"
                    aria-label="Search services"
                  />
                </label>
                <div className="service-filters" aria-label="Filter services">
                  <button
                    className={serviceFilter === 'all' ? 'active' : ''}
                    type="button"
                    onClick={() => {
                      setServiceFilter('all')
                      setSelectedRepository('')
                    }}
                  >
                    All <span>{dashboard.services.length}</span>
                  </button>
                  <button
                    className={serviceFilter === 'pending' ? 'active' : ''}
                    type="button"
                    onClick={() => {
                      setServiceFilter('pending')
                      setSelectedRepository('')
                    }}
                  >
                    Pending merge <span>{pendingServiceCount}</span>
                  </button>
                  <button
                    className={serviceFilter === 'issues' ? 'active' : ''}
                    type="button"
                    onClick={() => {
                      setServiceFilter('issues')
                      setSelectedRepository('')
                    }}
                  >
                    Issues{' '}
                    <span>{risksLoading ? '…' : issueServiceCount}</span>
                  </button>
                  <button
                    className={serviceFilter === 'outdated' ? 'active' : ''}
                    type="button"
                    onClick={() => {
                      setServiceFilter('outdated')
                      setSelectedRepository('')
                    }}
                    title="Latest successful QA build is not currently deployed in QA"
                  >
                    Outdated{' '}
                    <span>
                      {freshnessLoading ? '…' : outdatedServiceCount}
                    </span>
                  </button>
                </div>
                <div className="service-list">
                  {filteredServices.length ? (
                    filteredServices.map((service) => (
                      <ServiceCard
                        service={service}
                        selected={
                          selectedService?.repository === service.repository
                        }
                        onClick={() =>
                          setSelectedRepository(service.repository)
                        }
                        key={service.repository}
                      />
                    ))
                  ) : (
                    <div className="service-search-empty">
                      No services match your search.
                    </div>
                  )}
                </div>
              </section>
              {selectedServiceWithRisk ? (
                <ServiceDetail
                  service={selectedServiceWithRisk}
                  onCreateRelease={() =>
                    setReleaseRepository(selectedServiceWithRisk.repository)
                  }
                  onDataChanged={onRefresh}
                />
              ) : (
                <section className="detail-panel empty-state">
                  <h2>
                    {serviceSearch
                      ? 'No matching services'
                      : 'No pull requests found'}
                  </h2>
                  <p>
                    {serviceSearch
                      ? 'Try a different service name.'
                      : 'Review unmatched tickets below or refresh the release.'}
                  </p>
                </section>
              )}
            </div>

            {dashboard.unmatched.length > 0 && (
              <section className="unmatched-panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Needs attention</p>
                    <h2>Tickets without a matching PR</h2>
                  </div>
                  <span>{dashboard.unmatched.length}</span>
                </div>
                <div className="unmatched-grid">
                  {dashboard.unmatched.map((item) => (
                    <a
                      href={item.issue.url}
                      target="_blank"
                      rel="noreferrer"
                      key={item.issue.key}
                    >
                      <strong>{item.issue.key}</strong>
                      <span>{item.issue.summary}</span>
                      <small>
                        {item.issue.assignee ?? 'Unassigned'} ·{' '}
                        {item.issue.status}
                      </small>
                    </a>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
      {releaseRepository && (
        <StagingReleaseDialog
          repository={releaseRepository}
          onClose={() => setReleaseRepository('')}
        />
      )}
    </div>
  )
}
