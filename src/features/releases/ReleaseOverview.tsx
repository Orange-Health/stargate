import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../shared/api'
import { isClosedWithoutMerge } from '../../shared/pullRequests'
import { Skeleton } from '../../shared/Skeleton'
import { ALL_SERVICES_ID } from '../../shared/types'
import type {
  ConnectionStatus,
  DashboardProgress,
  DeploymentFreshness,
  EligibilityReason,
  JiraVersion,
  OrganizationRepository,
  ReleaseDashboard,
  ReleaseItem,
  ServiceRelease,
} from '../../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import {
  featureMergeActions,
  isFeatureForceMergeReady,
  isFeatureMergeReady,
  isFeatureRetargetReady,
} from './featureMerge'
import { BulkQaDeployDialog, deployableQaTargets } from './BulkQaDeployDialog'
import { BulkQaReleaseDialog } from './BulkQaReleaseDialog'
import { StagingReleaseDialog } from './StagingReleaseDialog'
import { ProductionReleaseDialog } from './ProductionReleaseDialog'
import { ReleaseDayOperations } from './ReleaseDayOperations'
import { ReleaseTicketsView } from './ReleaseTicketsView'
import { RemoveTicketDialog } from './RemoveTicketDialog'
import { RepositoryPullRequests } from './RepositoryPullRequests'
import {
  groupReleaseTickets,
  type TicketFilter,
} from './releaseTickets'
import { ServiceOperations } from './ServiceOperations'
import { ThemeToggle } from '../theme/ThemeToggle'

type PendingFeatureMerge = {
  pullNumber: number
  retargetToDev: boolean
  bypassBranchProtection: boolean
}

const PINNED_REPOSITORIES_KEY = 'release-desk-pinned-repositories'

function OverviewViewToggle({
  value,
  onChange,
}: {
  value: 'services' | 'tickets'
  onChange: (view: 'services' | 'tickets') => void
}) {
  return (
    <div
      className="overview-view-toggle"
      role="tablist"
      aria-label="Release overview view"
    >
      <button
        type="button"
        role="tab"
        aria-selected={value === 'services'}
        className={value === 'services' ? 'active' : ''}
        onClick={() => onChange('services')}
      >
        Services
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'tickets'}
        className={value === 'tickets' ? 'active' : ''}
        onClick={() => onChange('tickets')}
      >
        Tickets
      </button>
    </div>
  )
}

function loadPinnedRepositories() {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(PINNED_REPOSITORIES_KEY) ?? '[]',
    )
    return new Set<string>(
      Array.isArray(value)
        ? value.filter((repository): repository is string =>
            Boolean(repository && typeof repository === 'string'),
          )
        : [],
    )
  } catch {
    return new Set<string>()
  }
}

type Props = {
  connection: ConnectionStatus
  releases: JiraVersion[]
  selectedVersionId: string
  dashboard?: ReleaseDashboard
  loading: boolean
  dashboardProgress?: DashboardProgress
  error?: string
  onSelectVersion: (versionId: string) => void
  selectedRepository?: string
  onSelectRepository?: (repository: string) => void
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

function hasPullRequestIssues(service: ServiceRelease) {
  return service.items.some((item) => {
    const pull = item.pullRequest
    if (!pull || pull.merged) return false
    if (
      service.defaultBranch &&
      pull.baseBranch === service.defaultBranch
    ) {
      return true
    }
    return (
      pull.baseBranch === 'dev' &&
      (pull.reviewDecision !== 'approved' ||
        item.blockingReasons.includes('HAS_CONFLICTS'))
    )
  })
}

function reasonLabel(
  reason: EligibilityReason,
  item: ReleaseItem,
  defaultBranch?: string,
) {
  if (
    reason === 'WRONG_BASE_BRANCH' &&
    item.pullRequest?.baseBranch === defaultBranch
  ) {
    return 'Targets default branch'
  }
  return reasonLabels[reason]
}

function isClearedMerge(item: ReleaseItem) {
  return (
    Boolean(item.pullRequest?.merged) &&
    (item.pullRequest?.baseBranch === 'dev' ||
      item.pullRequest?.baseBranch === 'main')
  )
}

function withoutClosedPullRequests(service: ServiceRelease): ServiceRelease {
  const items = service.items.filter(
    (item) => !isClosedWithoutMerge(item.pullRequest),
  )
  if (items.length === service.items.length) return service
  return {
    ...service,
    items,
    eligibleCount: items.filter((item) => item.eligible).length,
    blockedCount: items.filter(
      (item) => !item.eligible && !item.pullRequest?.merged,
    ).length,
    mergedCount: items.filter(isClearedMerge).length,
  }
}

function formatDate(value?: string) {
  if (!value) return 'No date set'
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${value}T00:00:00`))
}

function relativeTime(value: string, now = Date.now()) {
  const seconds = Math.max(
    0,
    Math.round((now - new Date(value).getTime()) / 1000),
  )
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

function ReleasePicker({
  releases,
  selectedVersionId,
  onSelect,
}: {
  releases: JiraVersion[]
  selectedVersionId: string
  onSelect: (versionId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const selected = releases.find((release) => release.id === selectedVersionId)
  const allServicesSelected = selectedVersionId === ALL_SERVICES_ID

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [])

  return (
    <div className="release-picker" ref={root}>
      <button
        className="release-picker-trigger"
        type="button"
        aria-label="Active Jira release"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>
          {allServicesSelected
            ? 'All services'
            : selected?.name ?? 'Select a release'}
        </span>
        <span className="release-picker-chevron" aria-hidden="true">
          {open ? '⌃' : '⌄'}
        </span>
      </button>
      {open && (
        <div className="release-picker-menu" role="listbox">
          <button
            type="button"
            role="option"
            aria-selected={allServicesSelected}
            className={allServicesSelected ? 'selected' : ''}
            onClick={() => {
              setOpen(false)
              onSelect(ALL_SERVICES_ID)
            }}
          >
            <span>All services</span>
            <small>Organization-wide operations</small>
          </button>
          {releases.map((release) => (
            <button
              type="button"
              role="option"
              aria-selected={release.id === selectedVersionId}
              className={release.id === selectedVersionId ? 'selected' : ''}
              key={release.id}
              onClick={() => {
                setOpen(false)
                onSelect(release.id)
              }}
            >
              <span>{release.name}</span>
              <small>{formatDate(release.releaseDate)}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
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
  service: initialService,
  selectedVersionId,
  onCreateRelease,
  onCreateProductionRelease,
  onDataChanged,
  productionEnabled,
}: {
  service: ServiceRelease
  selectedVersionId: string
  onCreateRelease: () => void
  onCreateProductionRelease: () => void
  onDataChanged: () => void | Promise<void>
  productionEnabled: boolean
}) {
  const [service, setService] = useState(initialService)
  const name = service.repository.split('/').at(-1)
  const [merging, setMerging] = useState<number>()
  const [bulkMerging, setBulkMerging] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [mergeError, setMergeError] = useState('')
  const [activeTab, setActiveTab] = useState<'prs' | 'releases' | 'branches'>(
    'prs',
  )
  const [operationsActivated, setOperationsActivated] = useState(false)
  const [optimisticallyMerged, setOptimisticallyMerged] = useState<Set<number>>(
    new Set(),
  )
  const [pendingMerge, setPendingMerge] = useState<PendingFeatureMerge>()
  const [pendingBulkMerge, setPendingBulkMerge] = useState(false)
  const readyMergeActions = featureMergeActions(service, optimisticallyMerged)
  const mergeBusy = bulkMerging || merging !== undefined

  useEffect(() => {
    setService(initialService)
  }, [initialService])

  function requestMerge(
    pullNumber: number,
    options: { retargetToDev?: boolean; bypassBranchProtection?: boolean } = {},
  ) {
    setPendingBulkMerge(false)
    setPendingMerge({
      pullNumber,
      retargetToDev: options.retargetToDev ?? false,
      bypassBranchProtection: options.bypassBranchProtection ?? false,
    })
  }

  function requestBulkMerge() {
    if (readyMergeActions.length === 0 || mergeBusy) return
    setPendingMerge(undefined)
    setPendingBulkMerge(true)
  }

  async function mergePullRequest(pending: PendingFeatureMerge) {
    const { pullNumber, retargetToDev, bypassBranchProtection } = pending
    setPendingMerge(undefined)
    setMerging(pullNumber)
    setMergeError('')
    try {
      await api.mergeFeaturePullRequest({
        repository: service.repository,
        pullNumber,
        retargetToDev,
        ...(bypassBranchProtection ? { bypassBranchProtection: true } : {}),
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

  async function mergeAllReadyPullRequests() {
    if (readyMergeActions.length === 0 || mergeBusy) return
    setPendingBulkMerge(false)
    setBulkMerging(true)
    setMergeError('')
    const merged = new Set<number>()
    const failures: string[] = []
    for (const action of readyMergeActions) {
      try {
        await api.mergeFeaturePullRequest({
          repository: action.repository,
          pullNumber: action.pullNumber,
          retargetToDev: Boolean(action.retargetToDev),
        })
        merged.add(action.pullNumber)
      } catch (reason) {
        failures.push(
          `#${action.pullNumber}: ${
            reason instanceof Error ? reason.message : 'Could not merge the PR.'
          }`,
        )
      }
    }
    if (merged.size > 0) {
      setOptimisticallyMerged((current) => new Set([...current, ...merged]))
      await onDataChanged()
    }
    if (failures.length > 0) {
      setMergeError(
        `Merged ${merged.size}/${readyMergeActions.length}. ${failures.join(' ')}`,
      )
    }
    setBulkMerging(false)
  }

  const pendingMergeCopy = pendingMerge
    ? pendingMerge.bypassBranchProtection
      ? {
          title: 'Force merge to dev?',
          message: `Force merge feature PR #${pendingMerge.pullNumber} into dev?\n\nThis bypasses approvals and required checks. Your GitHub token must have branch-protection bypass access.`,
          confirmLabel: 'Force merge',
        }
      : pendingMerge.retargetToDev
        ? {
            title: 'Retarget and merge?',
            message: `Retarget feature PR #${pendingMerge.pullNumber} to dev and merge it?`,
            confirmLabel: 'Retarget and merge',
          }
        : {
            title: 'Merge to dev?',
            message: `Merge feature PR #${pendingMerge.pullNumber} into dev?`,
            confirmLabel: 'Merge',
          }
    : undefined

  const bulkMergeRetargetCount = readyMergeActions.filter(
    (action) => action.retargetToDev,
  ).length
  const pendingBulkMergeCopy = pendingBulkMerge
    ? {
        title: 'Merge all ready to dev?',
        message:
          bulkMergeRetargetCount > 0
            ? `Merge ${readyMergeActions.length} ready PR(s) into dev for ${service.repository}?\n\n${bulkMergeRetargetCount} will be retargeted from the default branch first.`
            : `Merge ${readyMergeActions.length} ready PR(s) into dev for ${service.repository}?`,
        confirmLabel: 'Merge all',
      }
    : undefined

  async function refreshService() {
    setRefreshing(true)
    setMergeError('')
    try {
      const result = await api.refreshService(
        selectedVersionId,
        service.repository,
        service.items.map((item) => item.issue.key),
        false,
      )
      setService(result.service)
      if (result.repositoryState) {
        window.dispatchEvent(
          new CustomEvent('service-refresh-requested', {
            detail: {
              repository: service.repository,
              state: result.repositoryState,
            },
          }),
        )
      }
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

  function selectTab(tab: 'prs' | 'releases' | 'branches') {
    setActiveTab(tab)
    if (tab !== 'prs') setOperationsActivated(true)
  }

  return (
    <section className="detail-panel">
      <div className="detail-heading">
        <div>
          <h2>{name}</h2>
          <p className="muted">{service.repository}</p>
        </div>
        <div className="detail-actions">
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

      <div className="service-detail-tabs" role="tablist" aria-label="Service details">
        {[
          ['prs', 'PRs'],
          ['branches', 'Branch Ops'],
          ['releases', 'Releases'],
        ].map(([tab, label]) => (
          <button
            className={activeTab === tab ? 'active' : ''}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            key={tab}
            onClick={() =>
              selectTab(tab as 'prs' | 'releases' | 'branches')
            }
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'prs' && (
      <div
        className="service-operations"
        role="tabpanel"
        aria-label="PRs"
      >
        <div className="service-tab-panel-actions">
          <div className="service-bulk-merge-actions">
            <button
              className="merge-feature-button"
              type="button"
              aria-label="Merge all ready PRs into dev for this service"
              onClick={() => requestBulkMerge()}
              disabled={
                readyMergeActions.length === 0 || mergeBusy || refreshing
              }
            >
              {bulkMerging
                ? 'Merging all…'
                : readyMergeActions.length > 0
                  ? `Merge all ready to dev (${readyMergeActions.length})`
                  : 'No ready PRs to merge'}
            </button>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void refreshService()}
            disabled={refreshing || mergeBusy}
          >
            {refreshing ? 'Refreshing…' : '↻ Refresh PRs'}
          </button>
        </div>
      <div className="operation-section">
      <div className="pr-list">
        {service.items.map((item) => {
          const mergeReady = isFeatureMergeReady(
            item,
            service,
            optimisticallyMerged,
          )
          const retargetReady = isFeatureRetargetReady(
            item,
            service,
            optimisticallyMerged,
          )
          const forceMergeReady =
            !mergeReady &&
            item.pullRequest?.baseBranch === 'dev' &&
            isFeatureForceMergeReady(item, service, optimisticallyMerged)
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
                    {reasonLabel(reason, item, service.defaultBranch)}
                  </span>
                ),
              )}
              {item.eligible && item.warningReasons.length === 0 && (
                <span className="reason success">All criteria met</span>
              )}
              {retargetReady && item.pullRequest && (
                <button
                  className="merge-feature-button"
                  type="button"
                  disabled={mergeBusy}
                  onClick={() =>
                    requestMerge(item.pullRequest!.number, {
                      retargetToDev: true,
                    })
                  }
                >
                  {merging === item.pullRequest.number
                    ? 'Retargeting…'
                    : 'Retarget to dev and merge'}
                </button>
              )}
              {mergeReady && item.pullRequest && (
                <button
                  className="merge-feature-button"
                  type="button"
                  disabled={mergeBusy}
                  onClick={() => requestMerge(item.pullRequest!.number)}
                >
                  {merging === item.pullRequest.number
                    ? 'Merging…'
                    : 'Merge to dev'}
                </button>
              )}
              {forceMergeReady && item.pullRequest && (
                <button
                  className="merge-feature-button"
                  type="button"
                  disabled={mergeBusy}
                  onClick={() =>
                    requestMerge(item.pullRequest!.number, {
                      bypassBranchProtection: true,
                    })
                  }
                >
                  {merging === item.pullRequest.number
                    ? 'Force merging…'
                    : 'Force merge to dev'}
                </button>
              )}
            </div>
          </article>
          )
        })}
      </div>
      </div>
      </div>
      )}
      {pendingMergeCopy && pendingMerge && (
        <ConfirmDialog
          title={pendingMergeCopy.title}
          message={pendingMergeCopy.message}
          confirmLabel={pendingMergeCopy.confirmLabel}
          onCancel={() => setPendingMerge(undefined)}
          onConfirm={() => void mergePullRequest(pendingMerge)}
        />
      )}
      {pendingBulkMergeCopy && pendingBulkMerge && (
        <ConfirmDialog
          title={pendingBulkMergeCopy.title}
          message={pendingBulkMergeCopy.message}
          confirmLabel={pendingBulkMergeCopy.confirmLabel}
          onCancel={() => setPendingBulkMerge(false)}
          onConfirm={() => void mergeAllReadyPullRequests()}
        />
      )}
      {operationsActivated && (
        <div
          role="tabpanel"
          aria-label={activeTab === 'branches' ? 'Branch Ops' : 'Releases'}
          hidden={activeTab === 'prs'}
        >
          <ServiceOperations
            key={service.repository}
            repository={service.repository}
            productionEnabled={productionEnabled}
            onCreateStagingRelease={onCreateRelease}
            onCreateProductionRelease={
              productionEnabled ? onCreateProductionRelease : undefined
            }
            view={
              activeTab === 'releases'
                ? 'releases'
                : activeTab === 'branches'
                  ? 'branches'
                  : 'hidden'
            }
          />
        </div>
      )}
    </section>
  )
}

export function ReleaseOverview({
  connection,
  releases,
  selectedVersionId,
  dashboard,
  loading,
  dashboardProgress,
  error,
  onSelectVersion,
  selectedRepository = '',
  onSelectRepository = () => {},
  onRefresh,
  onDisconnect,
}: Props) {
  const [releaseRepository, setReleaseRepository] = useState('')
  const [productionReleaseRepository, setProductionReleaseRepository] =
    useState('')
  const [bulkQaReleaseOpen, setBulkQaReleaseOpen] = useState(false)
  const [bulkQaDeployOpen, setBulkQaDeployOpen] = useState(false)
  const [serviceFilter, setServiceFilter] = useState<
    'all' | 'pending' | 'issues' | 'backmerges' | 'outdated'
  >('all')
  const [overviewView, setOverviewView] = useState<'services' | 'tickets'>(
    'services',
  )
  const [ticketFilter, setTicketFilter] = useState<TicketFilter>('all')
  const [ticketSearch, setTicketSearch] = useState('')
  const [selectedIssueKey, setSelectedIssueKey] = useState('')
  const [pendingRemoveIssueKey, setPendingRemoveIssueKey] = useState('')
  const [removingTicket, setRemovingTicket] = useState(false)
  const [removeTicketError, setRemoveTicketError] = useState('')
  const [serviceSearch, setServiceSearch] = useState('')
  const [repositorySearch, setRepositorySearch] = useState('')
  const [pinnedRepositories, setPinnedRepositories] = useState(
    loadPinnedRepositories,
  )
  const [organizationRepositories, setOrganizationRepositories] = useState<
    OrganizationRepository[]
  >([])
  const [repositoriesLoading, setRepositoriesLoading] = useState(false)
  const [repositoriesError, setRepositoriesError] = useState('')
  const [repositoriesReload, setRepositoriesReload] = useState(0)
  const [allServicesActiveTab, setAllServicesActiveTab] = useState<
    'prs' | 'releases' | 'branches'
  >('releases')
  const [syncedClock, setSyncedClock] = useState(() => Date.now())
  const [releaseDayOpen, setReleaseDayOpen] = useState(
    () =>
      new URLSearchParams(window.location.search).get('view') ===
      'release-day',
  )
  const [repositoryRisks, setRepositoryRisks] = useState<
    Record<
      string,
      {
        backMergePending: boolean
        backMergeOutdated: boolean
        checkFailed: boolean
      }
    >
  >({})
  const [risksLoading, setRisksLoading] = useState(false)
  const [deploymentFreshness, setDeploymentFreshness] = useState<
    Record<string, DeploymentFreshness>
  >({})
  const [freshnessLoading, setFreshnessLoading] = useState(false)
  const [bulkMerging, setBulkMerging] = useState(false)
  const [bulkMergeError, setBulkMergeError] = useState('')
  const [pendingReleaseBulkMerge, setPendingReleaseBulkMerge] = useState(false)
  const serviceListRef = useRef<HTMLDivElement>(null)
  const [serviceListOverflow, setServiceListOverflow] = useState({
    top: false,
    bottom: false,
  })
  const visibleServices = useMemo(
    () =>
      dashboard?.services
        .map(withoutClosedPullRequests)
        .filter((service) => service.items.length > 0) ?? [],
    [dashboard],
  )
  const visibleDashboard = useMemo(
    () => (dashboard ? { ...dashboard, services: visibleServices } : undefined),
    [dashboard, visibleServices],
  )
  const releaseTickets = useMemo(
    () =>
      visibleDashboard ? groupReleaseTickets(visibleDashboard) : [],
    [visibleDashboard],
  )
  const otherReleaseTargets = useMemo(
    () => releases.filter((release) => release.id !== selectedVersionId),
    [releases, selectedVersionId],
  )
  const repositoryScope =
    visibleServices
      .map((service) => service.repository)
      .sort()
      .join('\n')
  const allServicesSelected = selectedVersionId === ALL_SERVICES_ID
  const filteredOrganizationRepositories = useMemo(() => {
    const query = repositorySearch.trim().toLowerCase()
    const matches = query
      ? organizationRepositories.filter(
          (repository) =>
            repository.name.toLowerCase().includes(query) ||
            repository.repository.toLowerCase().includes(query),
        )
      : organizationRepositories
    return [
      ...matches.filter((repository) =>
        pinnedRepositories.has(repository.repository),
      ),
      ...matches.filter(
        (repository) => !pinnedRepositories.has(repository.repository),
      ),
    ]
  }, [organizationRepositories, pinnedRepositories, repositorySearch])
  const selectedOrganizationRepository =
    organizationRepositories.find(
      (repository) => repository.repository === selectedRepository,
    ) ?? filteredOrganizationRepositories[0]

  function toggleRepositoryPin(repository: string) {
    setPinnedRepositories((current) => {
      const next = new Set(current)
      if (next.has(repository)) next.delete(repository)
      else next.add(repository)
      window.localStorage.setItem(
        PINNED_REPOSITORIES_KEY,
        JSON.stringify([...next]),
      )
      return next
    })
  }

  useEffect(() => {
    if (!allServicesSelected) return
    let active = true
    setRepositoriesLoading(true)
    setRepositoriesError('')
    api
      .repositories()
      .then((repositories) => {
        if (active) setOrganizationRepositories(repositories)
      })
      .catch((reason) => {
        if (!active) return
        setRepositoriesError(
          reason instanceof Error
            ? reason.message
            : 'Could not load repositories.',
        )
      })
      .finally(() => {
        if (active) setRepositoriesLoading(false)
      })
    return () => {
      active = false
    }
  }, [allServicesSelected, repositoriesReload])

  useEffect(() => {
    const syncView = () =>
      setReleaseDayOpen(
        new URLSearchParams(window.location.search).get('view') ===
          'release-day',
      )
    window.addEventListener('popstate', syncView)
    return () => window.removeEventListener('popstate', syncView)
  }, [])

  useEffect(() => {
    if (!dashboard?.fetchedAt) return
    setSyncedClock(Date.now())
    const timer = window.setInterval(() => setSyncedClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [dashboard?.fetchedAt])

  function showReleaseDay(open: boolean) {
    const url = new URL(window.location.href)
    if (open) url.searchParams.set('view', 'release-day')
    else url.searchParams.delete('view')
    window.history.pushState({}, '', url)
    setReleaseDayOpen(open)
  }

  useEffect(() => {
    const repositories = repositoryScope ? repositoryScope.split('\n') : []
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
                backMergeOutdated: risk.backMergeOutdated,
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
              {
                backMergePending: false,
                backMergeOutdated: false,
                checkFailed: true,
              },
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
  }, [repositoryScope])

  useEffect(() => {
    const repositories = repositoryScope ? repositoryScope.split('\n') : []
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
                jenkinsServices: [],
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
  }, [repositoryScope])

  const filteredServices = useMemo(() => {
    if (!dashboard) return []
    let services = visibleServices
    if (serviceFilter === 'pending') {
      services = services.filter((service) =>
        service.items.some(
          (item) => item.pullRequest && !item.pullRequest.merged,
        ),
      )
    }
    if (serviceFilter === 'issues') {
      services = services.filter(hasPullRequestIssues)
    }
    if (serviceFilter === 'backmerges') {
      services = services.filter(
        (service) =>
          repositoryRisks[service.repository]?.backMergeOutdated ||
          repositoryRisks[service.repository]?.backMergePending ||
          service.backMergePending,
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
    visibleServices,
  ])
  const selectedService = useMemo(
    () =>
      visibleServices.find(
        (service) => service.repository === selectedRepository,
      ) ?? filteredServices[0],
    [filteredServices, selectedRepository, visibleServices],
  )
  const mergedIssueKeys = new Set(
    visibleServices.flatMap((service) =>
      service.items
        .filter(isClearedMerge)
        .map((item) => item.issue.key),
    ),
  )
  const totalItems = dashboard?.version.issueCount ?? 0
  const readyItems = mergedIssueKeys.size
  const pendingServiceCount =
    visibleServices.filter((service) =>
      service.items.some(
        (item) => item.pullRequest && !item.pullRequest.merged,
      ),
    ).length
  const issueServiceCount =
    visibleServices.filter(hasPullRequestIssues).length
  const backMergeServiceCount =
    visibleServices.filter(
      (service) =>
        repositoryRisks[service.repository]?.backMergeOutdated ||
        repositoryRisks[service.repository]?.backMergePending ||
        service.backMergePending,
    ).length
  const outdatedServiceCount =
    visibleServices.filter(
      (service) => deploymentFreshness[service.repository]?.outdated,
    ).length
  const releaseMergeActions = useMemo(
    () => visibleServices.flatMap((service) => featureMergeActions(service)),
    [visibleServices],
  )
  const qaDeployTargets = useMemo(
    () => deployableQaTargets(visibleServices, deploymentFreshness),
    [deploymentFreshness, visibleServices],
  )
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

  useEffect(() => {
    if (overviewView !== 'tickets') return
    if (
      selectedIssueKey &&
      releaseTickets.some((ticket) => ticket.issue.key === selectedIssueKey)
    ) {
      return
    }
    setSelectedIssueKey(releaseTickets[0]?.issue.key ?? '')
  }, [overviewView, releaseTickets, selectedIssueKey])

  useEffect(() => {
    if (allServicesSelected && overviewView === 'tickets') {
      setOverviewView('services')
    }
  }, [allServicesSelected, overviewView])

  async function confirmRemoveTicket(targetVersionId?: string) {
    if (!pendingRemoveIssueKey || !selectedVersionId) return
    setRemovingTicket(true)
    setRemoveTicketError('')
    try {
      await api.removeReleaseIssue(
        selectedVersionId,
        pendingRemoveIssueKey,
        targetVersionId,
      )
      setPendingRemoveIssueKey('')
      setSelectedIssueKey('')
      await onRefresh()
    } catch (reason) {
      setRemoveTicketError(
        reason instanceof Error
          ? reason.message
          : 'Could not remove the ticket from this release.',
      )
      setPendingRemoveIssueKey('')
    } finally {
      setRemovingTicket(false)
    }
  }

  async function mergeAllReadyFeaturePullRequests() {
    if (releaseMergeActions.length === 0 || bulkMerging || loading) return
    setPendingReleaseBulkMerge(false)
    setBulkMerging(true)
    setBulkMergeError('')
    let mergedCount = 0
    const failures: string[] = []
    for (const action of releaseMergeActions) {
      try {
        await api.mergeFeaturePullRequest({
          repository: action.repository,
          pullNumber: action.pullNumber,
          retargetToDev: Boolean(action.retargetToDev),
        })
        mergedCount += 1
      } catch (reason) {
        failures.push(
          `${action.repository}#${action.pullNumber}: ${
            reason instanceof Error ? reason.message : 'Could not merge the PR.'
          }`,
        )
      }
    }
    await onRefresh()
    if (failures.length > 0) {
      setBulkMergeError(
        `Merged ${mergedCount}/${releaseMergeActions.length}. ${failures.join(' ')}`,
      )
    }
    setBulkMerging(false)
  }

  const releaseBulkRetargetCount = releaseMergeActions.filter(
    (action) => action.retargetToDev,
  ).length
  const releaseBulkServiceCount = new Set(
    releaseMergeActions.map((action) => action.repository),
  ).size
  const pendingReleaseBulkMergeCopy = pendingReleaseBulkMerge
    ? {
        title: 'Merge all ready to dev?',
        message:
          releaseBulkRetargetCount > 0
            ? `Merge ${releaseMergeActions.length} ready PR(s) into dev across ${releaseBulkServiceCount} service(s)?

${releaseBulkRetargetCount} will be retargeted from the default branch first.`
            : `Merge ${releaseMergeActions.length} ready PR(s) into dev across ${releaseBulkServiceCount} service(s)?`,
        confirmLabel: 'Merge all',
      }
    : undefined

  useEffect(() => {
    const list = serviceListRef.current
    if (!list) return
    const update = () => {
      const top = list.scrollTop > 1
      const bottom =
        list.scrollTop + list.clientHeight < list.scrollHeight - 1
      setServiceListOverflow((current) =>
        current.top === top && current.bottom === bottom
          ? current
          : { top, bottom },
      )
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(list)
    return () => observer.disconnect()
  }, [filteredServices])

  if (releaseDayOpen && visibleDashboard) {
    return (
      <div className="app-shell release-day-app-shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark compact">RD</span>
            <span>
              <strong>Release Desk</strong>
              <small>Release-day control room</small>
            </span>
          </div>
          <div className="topbar-actions">
            <ThemeToggle />
            <span className="connection-dot" />
            <span className="connected-label">
              {connection.githubOrg} · {connection.projectKey}
            </span>
          </div>
        </header>
        <main className="release-day-page-shell">
          <ReleaseDayOperations
            key={visibleDashboard.version.id}
            dashboard={visibleDashboard}
            productionEnabled={Boolean(connection.productionEnabled)}
            onClose={() => showReleaseDay(false)}
          />
        </main>
      </div>
    )
  }

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
          <button
            className="create-release-button topbar-release-button"
            type="button"
            onClick={() => showReleaseDay(true)}
            disabled={!dashboard}
          >
            Open release control room
          </button>
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
            <p className="eyebrow">
              {allServicesSelected ? 'Operations scope' : 'Active release'}
            </p>
            <ReleasePicker
              releases={releases}
              selectedVersionId={selectedVersionId}
              onSelect={(versionId) => {
                onSelectRepository('')
                setServiceFilter('all')
                setServiceSearch('')
                onSelectVersion(versionId)
              }}
            />
          </div>
          <div className="release-meta">
            {!allServicesSelected && (
              <span>
                Target
                <strong>{formatDate(dashboard?.version.releaseDate)}</strong>
              </span>
            )}
            {dashboard && (
              <span>
                Last synced
                <strong>
                  {relativeTime(dashboard.fetchedAt, syncedClock)}
                </strong>
              </span>
            )}
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                if (allServicesSelected) {
                  setRepositoriesReload((current) => current + 1)
                } else {
                  void onRefresh()
                }
              }}
              disabled={
                loading ||
                (allServicesSelected && repositoriesLoading) ||
                bulkMerging ||
                !selectedVersionId
              }
            >
              {loading || (allServicesSelected && repositoriesLoading)
                ? 'Syncing…'
                : '↻ Refresh'}
            </button>
          </div>
        </section>

        {error && (
          <div className="alert error" role="alert">
            <strong>Couldn’t load this release.</strong> {error}
          </div>
        )}

        {bulkMergeError && (
          <div className="alert error" role="alert">
            <strong>Bulk merge unfinished.</strong> {bulkMergeError}
          </div>
        )}

        {allServicesSelected && (
          <div className="dashboard-grid">
            <section className="services-panel">
              <div className="section-heading">
                <div>
                  <h2>All services</h2>
                </div>
                <span>
                  {filteredOrganizationRepositories.length}/
                  {organizationRepositories.length}
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
                  value={repositorySearch}
                  onChange={(event) => setRepositorySearch(event.target.value)}
                  placeholder="Search services"
                  aria-label="Search all services"
                />
              </label>
              {repositoriesLoading ? (
                <div
                  className="service-list all-services-list skeleton-list"
                  role="status"
                  aria-label="Loading services"
                >
                  {Array.from({ length: 7 }, (_, index) => (
                    <div className="all-service-row" key={index}>
                      <div className="all-service-card skeleton-card">
                        <Skeleton className="skeleton-service-name" />
                        <Skeleton className="skeleton-branch" />
                      </div>
                      <Skeleton className="skeleton-pin" />
                    </div>
                  ))}
                </div>
              ) : repositoriesError ? (
                <div className="alert warning">{repositoriesError}</div>
              ) : (
                <div className="service-list all-services-list">
                  {filteredOrganizationRepositories.length > 0 ? (
                    filteredOrganizationRepositories.map((repository) => (
                      <div
                        className="all-service-row"
                        key={repository.repository}
                      >
                        <button
                          className={`all-service-card ${
                            selectedOrganizationRepository?.repository ===
                            repository.repository
                              ? 'selected'
                              : ''
                          }`}
                          type="button"
                          onClick={() =>
                            onSelectRepository(repository.repository)
                          }
                        >
                          <span>{repository.name}</span>
                          <small>
                            {repository.archived
                              ? 'Archived'
                              : repository.defaultBranch}
                          </small>
                        </button>
                        <button
                          className={`pin-service-button ${
                            pinnedRepositories.has(repository.repository)
                              ? 'pinned'
                              : ''
                          }`}
                          type="button"
                          aria-label={`${
                            pinnedRepositories.has(repository.repository)
                              ? 'Unpin'
                              : 'Pin'
                          } ${repository.name}`}
                          title={`${
                            pinnedRepositories.has(repository.repository)
                              ? 'Unpin from'
                              : 'Pin to'
                          } top`}
                          onClick={() =>
                            toggleRepositoryPin(repository.repository)
                          }
                        >
                          {pinnedRepositories.has(repository.repository)
                            ? '★'
                            : '☆'}
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="service-search-empty">
                      No services match your search.
                    </div>
                  )}
                </div>
              )}
            </section>
            {selectedOrganizationRepository ? (
              <section
                className="detail-panel all-service-detail"
                key={selectedOrganizationRepository.repository}
              >
                <div className="detail-heading">
                  <div>
                    <h2>{selectedOrganizationRepository.name}</h2>
                    <a
                      className="muted"
                      href={selectedOrganizationRepository.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {selectedOrganizationRepository.repository}
                    </a>
                  </div>
                </div>
                <div
                  className="service-detail-tabs"
                  role="tablist"
                  aria-label="Service details"
                >
                  {[
                    ['prs', 'PRs'],
                    ['releases', 'Releases'],
                    ['branches', 'Branch Ops'],
                  ].map(([tab, label]) => (
                    <button
                      className={allServicesActiveTab === tab ? 'active' : ''}
                      type="button"
                      role="tab"
                      aria-selected={allServicesActiveTab === tab}
                      key={tab}
                      onClick={() =>
                        setAllServicesActiveTab(
                          tab as 'prs' | 'releases' | 'branches',
                        )
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div
                  role="tabpanel"
                  aria-label={
                    allServicesActiveTab === 'prs'
                      ? 'PRs'
                      : allServicesActiveTab === 'releases'
                      ? 'Releases'
                      : 'Branch Ops'
                  }
                >
                  {allServicesActiveTab === 'prs' ? (
                    <RepositoryPullRequests
                      repository={selectedOrganizationRepository.repository}
                    />
                  ) : (
                    <ServiceOperations
                      repository={selectedOrganizationRepository.repository}
                      productionEnabled={Boolean(connection.productionEnabled)}
                      includeAllVReleases
                      view={allServicesActiveTab}
                      onCreateStagingRelease={() =>
                        setReleaseRepository(
                          selectedOrganizationRepository.repository,
                        )
                      }
                      onCreateProductionRelease={
                        connection.productionEnabled
                          ? () =>
                              setProductionReleaseRepository(
                                selectedOrganizationRepository.repository,
                              )
                          : undefined
                      }
                    />
                  )}
                </div>
              </section>
            ) : (
              !repositoriesLoading && (
                <section className="detail-panel empty-state">
                  <h2>No service selected</h2>
                  <p>Choose a repository to manage its release operations.</p>
                </section>
              )
            )}
          </div>
        )}

        {!allServicesSelected && loading && !dashboard && (
          <div className="loading-state" role="status" aria-live="polite">
            <span className="spinner" />
            <h2>Mapping release tickets to pull requests…</h2>
            <p className="loading-progress-message">
              {dashboardProgress?.message ??
                'This can take a moment for larger releases.'}
            </p>
            {dashboardProgress?.total &&
              dashboardProgress.current !== undefined && (
                <div
                  className="loading-progress-track"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={dashboardProgress.total}
                  aria-valuenow={dashboardProgress.current}
                >
                  <span
                    style={{
                      width: `${Math.min(
                        100,
                        (dashboardProgress.current /
                          dashboardProgress.total) *
                          100,
                      )}%`,
                    }}
                  />
                </div>
              )}
          </div>
        )}

        {!allServicesSelected && loading && dashboard && (
          <div className="sync-state" role="status">
            <span className="spinner" />
            {dashboardProgress?.message ?? 'Refreshing release data…'}
          </div>
        )}

        {!loading && releases.length === 0 && (
          <div className="empty-state">
            <h2>No unreleased Jira versions found</h2>
            <p>Create or unarchive a release in project OH, then refresh.</p>
          </div>
        )}

        {!allServicesSelected && dashboard && (
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
                  <div className="overview-bulk-merge-actions">
                    <button
                      className="merge-feature-button overview-bulk-merge"
                      type="button"
                      aria-label="Merge all ready release PRs into dev"
                      onClick={() => setPendingReleaseBulkMerge(true)}
                      disabled={
                        loading ||
                        bulkMerging ||
                        releaseMergeActions.length === 0
                      }
                    >
                      {bulkMerging
                        ? 'Merging all to dev…'
                        : releaseMergeActions.length > 0
                          ? `Merge all ready to dev (${releaseMergeActions.length})`
                          : 'No ready PRs to merge'}
                    </button>
                    <button
                      className="secondary-button overview-bulk-merge"
                      type="button"
                      aria-label="Create QA tags for all services in this release"
                      onClick={() => setBulkQaReleaseOpen(true)}
                      disabled={
                        loading ||
                        bulkMerging ||
                        visibleServices.length === 0
                      }
                    >
                      {visibleServices.length > 0
                        ? `Create QA tags (${visibleServices.length})`
                        : 'No services for QA tags'}
                    </button>
                    <button
                      className="secondary-button overview-bulk-merge"
                      type="button"
                      aria-label="Deploy QA for all merged services in this release"
                      onClick={() => setBulkQaDeployOpen(true)}
                      disabled={
                        loading ||
                        bulkMerging ||
                        freshnessLoading ||
                        qaDeployTargets.length === 0
                      }
                    >
                      {freshnessLoading
                        ? 'Checking QA deploys…'
                        : qaDeployTargets.length > 0
                          ? `Deploy QA (${qaDeployTargets.length})`
                          : 'No QA deploys ready'}
                    </button>
                  </div>
                </div>
              </div>
              <div className="stat">
                <strong>{visibleServices.length}</strong>
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

            {overviewView === 'tickets' ? (
              <ReleaseTicketsView
                tickets={releaseTickets}
                ticketFilter={ticketFilter}
                ticketSearch={ticketSearch}
                selectedIssueKey={selectedIssueKey}
                removeError={removeTicketError}
                viewToggle={
                  <OverviewViewToggle
                    value={overviewView}
                    onChange={(view) => {
                      setRemoveTicketError('')
                      setOverviewView(view)
                    }}
                  />
                }
                onFilterChange={setTicketFilter}
                onSearchChange={setTicketSearch}
                onSelectTicket={(issueKey) => {
                  setRemoveTicketError('')
                  setSelectedIssueKey(issueKey)
                }}
                onRemoveTicket={() => {
                  if (!selectedIssueKey) return
                  setRemoveTicketError('')
                  setPendingRemoveIssueKey(selectedIssueKey)
                }}
              />
            ) : (
            <div className="dashboard-grid">
              <section className="services-panel">
                <div className="section-heading">
                  <div className="section-heading-start">
                    <h2>Services</h2>
                    <OverviewViewToggle
                      value={overviewView}
                      onChange={(view) => {
                        setRemoveTicketError('')
                        setOverviewView(view)
                      }}
                    />
                  </div>
                  <span>
                    {filteredServices.length}/{visibleServices.length}
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
                    onChange={(event) => setServiceSearch(event.target.value)}
                    placeholder="Search services"
                    aria-label="Search services"
                  />
                </label>
                <div className="service-filters" aria-label="Filter services">
                  <button
                    className={serviceFilter === 'all' ? 'active' : ''}
                    type="button"
                    data-tooltip="Shows every service included in the selected Jira release, regardless of its dev, release, or main branch status."
                    onClick={() => {
                      setServiceFilter('all')
                      onSelectRepository('')
                    }}
                  >
                    All <span>{visibleServices.length}</span>
                  </button>
                  <button
                    className={serviceFilter === 'pending' ? 'active' : ''}
                    type="button"
                    data-tooltip="Shows services with at least one linked release PR that is still open and not merged into dev."
                    onClick={() => {
                      setServiceFilter('pending')
                      onSelectRepository('')
                    }}
                  >
                    Pending merge <span>{pendingServiceCount}</span>
                  </button>
                  <button
                    className={serviceFilter === 'issues' ? 'active' : ''}
                    type="button"
                    data-tooltip="Shows services with an open PR targeting the default branch instead of dev, or an open PR into dev that is not reviewer-approved or has Git merge conflicts."
                    onClick={() => {
                      setServiceFilter('issues')
                      onSelectRepository('')
                    }}
                  >
                    Issues{' '}
                    <span>{issueServiceCount}</span>
                  </button>
                  <button
                    className={serviceFilter === 'backmerges' ? 'active' : ''}
                    type="button"
                    data-tooltip="Shows services where main/default is ahead of release or release is ahead of dev, including services without an open back-merge PR."
                    onClick={() => {
                      setServiceFilter('backmerges')
                      onSelectRepository('')
                    }}
                  >
                    Back-merges{' '}
                    <span>
                      {risksLoading ? '…' : backMergeServiceCount}
                    </span>
                  </button>
                  <button
                    className={serviceFilter === 'outdated' ? 'active' : ''}
                    type="button"
                    data-tooltip="Shows services whose latest successful QA tag from GitHub Actions is not deployed to every mapped QA service in Jenkins."
                    onClick={() => {
                      setServiceFilter('outdated')
                      onSelectRepository('')
                    }}
                  >
                    Outdated{' '}
                    <span>
                      {freshnessLoading ? '…' : outdatedServiceCount}
                    </span>
                  </button>
                </div>
                <div className="service-list-wrap">
                  <span
                    className={`service-list-gradient top ${serviceListOverflow.top ? 'visible' : ''}`}
                    aria-hidden="true"
                  />
                <div
                  className="service-list"
                  ref={serviceListRef}
                  onScroll={() => {
                    const list = serviceListRef.current
                    if (!list) return
                    setServiceListOverflow({
                      top: list.scrollTop > 1,
                      bottom:
                        list.scrollTop + list.clientHeight <
                        list.scrollHeight - 1,
                    })
                  }}
                >
                  {filteredServices.length ? (
                    filteredServices.map((service) => (
                      <ServiceCard
                        service={service}
                        selected={
                          selectedService?.repository === service.repository
                        }
                        onClick={() =>
                          onSelectRepository(service.repository)
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
                  <span
                    className={`service-list-gradient bottom ${serviceListOverflow.bottom ? 'visible' : ''}`}
                    aria-hidden="true"
                  />
                </div>
              </section>
              {selectedServiceWithRisk ? (
                <ServiceDetail
                  key={selectedServiceWithRisk.repository}
                  service={selectedServiceWithRisk}
                  selectedVersionId={selectedVersionId}
                  onCreateRelease={() =>
                    setReleaseRepository(selectedServiceWithRisk.repository)
                  }
                  onCreateProductionRelease={() =>
                    setProductionReleaseRepository(
                      selectedServiceWithRisk.repository,
                    )
                  }
                  onDataChanged={onRefresh}
                  productionEnabled={Boolean(connection.productionEnabled)}
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
            )}

            {overviewView === 'services' && dashboard.unmatched.length > 0 && (
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
          releaseDate={dashboard?.version.releaseDate ?? ''}
          allowBranchSelection={allServicesSelected}
          onClose={() => setReleaseRepository('')}
        />
      )}
      {bulkQaReleaseOpen && dashboard && (
        <BulkQaReleaseDialog
          repositories={visibleServices.map((service) => service.repository)}
          releaseDate={dashboard.version.releaseDate ?? ''}
          releaseName={dashboard.version.name}
          onClose={() => setBulkQaReleaseOpen(false)}
        />
      )}
      {bulkQaDeployOpen && dashboard && (
        <BulkQaDeployDialog
          services={visibleServices}
          freshness={deploymentFreshness}
          releaseName={dashboard.version.name}
          onClose={() => setBulkQaDeployOpen(false)}
        />
      )}
      {productionReleaseRepository && (
        <ProductionReleaseDialog
          repository={productionReleaseRepository}
          onClose={() => setProductionReleaseRepository('')}
        />
      )}
      {pendingReleaseBulkMergeCopy && pendingReleaseBulkMerge && (
        <ConfirmDialog
          title={pendingReleaseBulkMergeCopy.title}
          message={pendingReleaseBulkMergeCopy.message}
          confirmLabel={pendingReleaseBulkMergeCopy.confirmLabel}
          onCancel={() => setPendingReleaseBulkMerge(false)}
          onConfirm={() => void mergeAllReadyFeaturePullRequests()}
        />
      )}
      {pendingRemoveIssueKey && dashboard && (
        <RemoveTicketDialog
          issueKey={pendingRemoveIssueKey}
          releaseName={dashboard.version.name}
          otherReleases={otherReleaseTargets}
          busy={removingTicket}
          onCancel={() => {
            if (removingTicket) return
            setPendingRemoveIssueKey('')
          }}
          onConfirm={(targetVersionId) => {
            void confirmRemoveTicket(targetVersionId)
          }}
        />
      )}
    </div>
  )
}
