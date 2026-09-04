import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import type { ReleaseDashboard, ReleaseItem } from '../../shared/types'
import { ReleaseOverview } from './ReleaseOverview'
import { clearServiceViewCache } from './serviceViewCache'
import { removeIssueFromDashboard } from './releaseTickets'
import { replaceIssueItemsInDashboard } from '../../shared/releaseDashboard'

const dashboard: ReleaseDashboard = {
  version: {
    id: '10351',
    name: 'OH Release 26.0716',
    releaseDate: '2026-07-16',
    overdue: false,
    issueCount: 2,
  },
  services: [
    {
      repository: 'orange/service-api',
      defaultBranch: 'main',
      eligibleCount: 0,
      blockedCount: 1,
      mergedCount: 0,
      backMergePending: false,
      items: [
        {
          issue: {
            key: 'OH-123',
            summary: 'Release API',
            status: 'In Progress',
            url: 'https://jira.test/OH-123',
          },
          pullRequest: {
            id: 1,
            number: 8,
            repository: 'orange/service-api',
            title: 'OH-123 Release API',
            url: 'https://github.test/pull/8',
            state: 'open',
            draft: false,
            merged: false,
            baseBranch: 'main',
            headBranch: 'feature/OH-123',
            author: 'dev',
            assignees: [],
            reviewDecision: 'review_required',
            mergeable: true,
            mergeableState: 'clean',
            checks: 'pending',
            updatedAt: '2026-07-13T12:00:00Z',
          },
          eligible: false,
          blockingReasons: ['WRONG_BASE_BRANCH', 'REVIEW_REQUIRED'],
          warningReasons: ['CHECKS_PENDING'],
        },
      ],
    },
  ],
  unmatched: [
    {
      issue: {
        key: 'OH-999',
        summary: 'Missing pull request',
        status: 'To Do',
        url: 'https://jira.test/OH-999',
      },
      eligible: false,
      blockingReasons: ['NO_MATCHING_PR'],
      warningReasons: [],
    },
  ],
  warnings: [],
  fetchedAt: new Date().toISOString(),
  cached: false,
}

describe('ReleaseOverview', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.spyOn(api, 'repositories').mockResolvedValue([])
    vi.spyOn(api, 'repositoryRisks').mockImplementation(async (repositories) =>
      repositories.map((repository) => ({
        repository,
        backMergePending: false,
        backMergeOutdated: false,
        checkFailed: false,
      })),
    )
    vi.spyOn(api, 'deploymentFreshness').mockImplementation(
      async (repositories) =>
        repositories.map((repository) => ({
          repository,
          liveQaTags: [],
          jenkinsServices: [],
          outdated: false,
          checkFailed: false,
        })),
    )
    vi.spyOn(api, 'listStagingTags').mockImplementation(async (input) =>
      input.repositories.map((repository) => ({
        repository,
        tags: [],
        checkFailed: false,
      })),
    )
    vi.spyOn(api, 'repositoryDeploymentStatuses').mockResolvedValue({
      results: [],
      fetchedAt: '2026-07-16T12:00:00Z',
    })
    vi.spyOn(api, 'releaseBuildStatuses').mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    clearServiceViewCache()
  })

  it('shows service skeletons while all services are loading', () => {
    vi.mocked(api.repositories).mockReturnValue(new Promise(() => {}))

    render(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[dashboard.version]}
        selectedVersionId="all-services"
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('status', { name: 'Loading services' }),
    ).toBeVisible()
    expect(document.querySelectorAll('.skeleton-card')).toHaveLength(7)
    expect(
      screen.getByRole('status', { name: 'Loading service details' }),
    ).toBeVisible()
    expect(document.querySelectorAll('.skeleton-pr-row')).toHaveLength(4)
  })

  it('offers release operations for repositories outside a Jira release', async () => {
    const user = userEvent.setup()
    const onSelectRepository = vi.fn()
    vi.spyOn(api, 'repositoryReleaseData').mockReturnValue(new Promise(() => {}))
    vi.mocked(api.repositories).mockResolvedValueOnce([
      {
        repository: 'orange/service-api',
        name: 'service-api',
        defaultBranch: 'main',
        url: 'https://github.test/orange/service-api',
        archived: false,
        private: true,
      },
      {
        repository: 'orange/operations',
        name: 'operations',
        defaultBranch: 'master',
        url: 'https://github.test/orange/operations',
        archived: false,
        private: true,
      },
    ])
    render(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[dashboard.version]}
        selectedVersionId="all-services"
        selectedRepository="orange/operations"
        loading={false}
        onSelectVersion={vi.fn()}
        onSelectRepository={onSelectRepository}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    expect(await screen.findByRole('heading', { name: 'All services' }))
      .toBeVisible()
    expect(screen.getByRole('heading', { name: 'operations' })).toBeVisible()
    await waitFor(() =>
      expect(api.repositoryReleaseData).toHaveBeenCalledWith(
        'orange/operations',
        true,
        5,
      ),
    )
    expect(screen.getByRole('link', { name: /orange\/operations/ })).toHaveAttribute(
      'href',
      'https://github.test/orange/operations',
    )
    expect(
      screen.getByRole('button', { name: /Create staging release/ }),
    ).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Releases' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(
      screen.getByRole('button', { name: '↻ Refresh releases' }),
    ).toBeVisible()

    const search = screen.getByRole('searchbox', { name: 'Search all services' })
    await user.type(search, 'service-api')

    expect(screen.getByRole('heading', { name: 'operations' })).toBeVisible()
    expect(onSelectRepository).not.toHaveBeenCalled()

    await user.clear(search)
    await user.click(screen.getByRole('tab', { name: 'Branch Ops' }))

    expect(
      screen.getByRole('button', { name: '↻ Refresh branch ops' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: /Create staging release/ }),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Pin operations' }))

    expect(
      screen.getByRole('button', { name: 'Unpin operations' }),
    ).toBeVisible()
    expect(
      JSON.parse(
        window.localStorage.getItem('release-desk-pinned-repositories') ?? '[]',
      ),
    ).toEqual(['orange/operations'])
    const operationsRow = screen
      .getByRole('button', { name: /operationsmaster/ })
      .closest('.all-service-row')
    const serviceApiRow = screen
      .getByRole('button', { name: /service-apimain/ })
      .closest('.all-service-row')
    expect(operationsRow).not.toBeNull()
    expect(serviceApiRow).not.toBeNull()
    expect(
      operationsRow!.compareDocumentPosition(serviceApiRow!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shows the current Jira or GitHub operation while loading', () => {
    render(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        loading
        dashboardProgress={{
          phase: 'github-details',
          message: 'Loading pull request details…',
          current: 1,
          total: 8,
        }}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    expect(screen.getByText('Loading pull request details…')).toBeVisible()
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '46',
    )
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuemax',
      '100',
    )
  })

  it('ticks Last synced from the dashboard fetchedAt timestamp', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:13Z'))

    render(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={{
          ...dashboard,
          fetchedAt: '2026-07-15T12:00:00Z',
        }}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    expect(screen.getByText('13s ago')).toBeVisible()
    await act(async () => {
      await Promise.resolve()
    })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(screen.getByText('15s ago')).toBeVisible()
  })

  it('uses the themed release picker to change releases', async () => {
    const user = userEvent.setup()
    const onSelectVersion = vi.fn()
    render(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[
          dashboard.version,
          {
            ...dashboard.version,
            id: '10352',
            name: 'OH Release 26.0723',
          },
        ]}
        selectedVersionId="10351"
        dashboard={dashboard}
        loading={false}
        onSelectVersion={onSelectVersion}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    await user.click(
      screen.getByRole('button', { name: 'Active Jira release' }),
    )
    await user.click(
      screen.getByRole('option', { name: /OH Release 26\.0723/ }),
    )

    expect(onSelectVersion).toHaveBeenCalledWith('10352')
  })

  it('renders service readiness and explicit blocking reasons', () => {
    render(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={dashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    expect(screen.getAllByText('service-api')).toHaveLength(2)
    expect(screen.getByText('Targets default branch')).toBeInTheDocument()
    expect(screen.getByText('Review required')).toBeInTheDocument()
    expect(screen.getByText('Checks pending')).toBeInTheDocument()
    expect(screen.getByText('OH-999')).toBeInTheDocument()
  })

  it('opens staging-only release creation for the selected service', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'repositoryState').mockReturnValue(new Promise(() => {}))
    render(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={dashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('tab', { name: 'Releases' }))
    await user.click(
      screen.getByRole('button', { name: /create staging release/i }),
    )

    expect(
      screen.getByRole('dialog', { name: 'Create GitHub release' }),
    ).toBeInTheDocument()
    expect(screen.getByDisplayValue('orange/service-api')).toBeDisabled()
    expect(screen.getByText(/A pre-release tag will be created/)).toBeVisible()
    expect(screen.queryByLabelText(/release date/i)).not.toBeInTheDocument()
    expect(screen.getByText('v-qa-26.0716.N')).toBeVisible()
    expect(
      screen.queryByRole('option', { name: 'Production' }),
    ).not.toBeInTheDocument()
  })

  it('refreshes the selected service on demand', async () => {
    const user = userEvent.setup()
    const refreshedService = {
      ...dashboard.services[0],
      items: [
        {
          ...dashboard.services[0].items[0],
          pullRequest: {
            ...dashboard.services[0].items[0].pullRequest!,
            title: 'OH-123 Refreshed pull request',
          },
        },
      ],
    }
    const refreshService = vi.spyOn(api, 'refreshService').mockResolvedValue({
      service: refreshedService,
      repositoryState: {
        repository: 'orange/service-api',
        defaultBranch: 'main',
        stagingReleases: [],
        productionReleases: [],
        deployedTags: [],
        deploymentLookupFailed: false,
        productionReady: false,
        promotionSteps: [],
        backMergeSteps: [],
        pendingBackMerges: [],
        jenkinsServices: [],
        fetchedAt: new Date().toISOString(),
      },
    })
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    const onServiceUpdated = vi.fn()
    let currentDashboard = dashboard
    const view = render(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={currentDashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={onRefresh}
        onServiceUpdated={(service) => {
          onServiceUpdated(service)
          currentDashboard = {
            ...currentDashboard,
            services: currentDashboard.services.map((entry) =>
              entry.repository === service.repository ? service : entry,
            ),
            cached: false,
          }
        }}
        onDisconnect={vi.fn()}
      />,
    )

    await user.click(
      screen.getByRole('button', { name: '↻ Refresh PRs' }),
    )

    expect(refreshService).toHaveBeenCalledWith(
      '10351',
      'orange/service-api',
      ['OH-123'],
      false,
    )
    expect(
      screen.getByText('OH-123 Refreshed pull request'),
    ).toBeVisible()
    expect(onRefresh).not.toHaveBeenCalled()
    expect(onServiceUpdated).toHaveBeenCalledWith(refreshedService)

    // Parent re-render (e.g. synced clock / risk overlay) must keep fresh data.
    view.rerender(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={currentDashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={onRefresh}
        onServiceUpdated={onServiceUpdated}
        onDisconnect={vi.fn()}
      />,
    )
    expect(
      screen.getByText('OH-123 Refreshed pull request'),
    ).toBeVisible()
  })

  it('searches the service list by repository name', async () => {
    const user = userEvent.setup()
    render(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={dashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    await user.type(screen.getByRole('searchbox', { name: 'Search services' }), 'missing')

    expect(screen.getByText('No services match your search.')).toBeVisible()
    expect(screen.getByText('No matching services')).toBeVisible()
  })

  it('lazy-loads operations once and redistributes content across tabs', async () => {
    const user = userEvent.setup()
    const releaseHistory = vi
      .spyOn(api, 'repositoryReleaseData')
      .mockReturnValue(new Promise(() => {}))
    const repositoryState = vi
      .spyOn(api, 'repositoryState')
      .mockReturnValue(new Promise(() => {}))
    const view = render(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={dashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    expect(screen.getByText('OH-123 Release API')).toBeVisible()
    expect(
      screen.getByRole('button', { name: '↻ Refresh PRs' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: /Create staging release/ }),
    ).not.toBeInTheDocument()
    expect(releaseHistory).not.toHaveBeenCalled()
    expect(repositoryState).not.toHaveBeenCalled()

    await user.click(screen.getByRole('tab', { name: 'Releases' }))
    expect(
      screen.getByRole('button', { name: /Create staging release/ }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: '↻ Refresh releases' }),
    ).toBeVisible()
    expect(screen.getByText(/Loading release builds/)).toBeVisible()
    expect(
      screen.queryByText(/Checking dev, release, and default branches/),
    ).not.toBeInTheDocument()
    expect(releaseHistory).toHaveBeenCalledTimes(1)
    expect(repositoryState).not.toHaveBeenCalled()

    await user.click(screen.getByRole('tab', { name: 'Branch Ops' }))
    expect(
      screen.getByText(/Checking dev, release, and default branches/),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: '↻ Refresh branch ops' }),
    ).toBeVisible()
    expect(screen.queryByText(/Loading release builds/)).not.toBeInTheDocument()
    expect(repositoryState).toHaveBeenCalledTimes(1)

    view.rerender(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={{ ...dashboard, fetchedAt: '2026-07-15T11:00:00Z' }}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )
    expect(repositoryState).toHaveBeenCalledTimes(1)
  })

  it('omits closed unmerged PRs from service lists and counts', () => {
    const closedDashboard: ReleaseDashboard = {
      ...dashboard,
      services: [
        {
          ...dashboard.services[0],
          items: [
            {
              ...dashboard.services[0].items[0],
              pullRequest: {
                ...dashboard.services[0].items[0].pullRequest!,
                state: 'closed',
                merged: false,
              },
            },
          ],
        },
      ],
    }
    render(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={closedDashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    expect(screen.queryByText('OH-123 Release API')).not.toBeInTheDocument()
    expect(screen.getByText('No services match your search.')).toBeVisible()
  })

  it('filters services whose latest QA build is not live', async () => {
    const user = userEvent.setup()
    vi.mocked(api.deploymentFreshness).mockResolvedValueOnce([
      {
        repository: 'orange/service-api',
        latestBuiltQaTag: 'v-qa-26.0714.2',
        liveQaTags: ['v-qa-26.0714.1'],
        jenkinsServices: ['service-api'],
        outdated: true,
        checkFailed: false,
      },
      {
        repository: 'orange/other-api',
        latestBuiltQaTag: 'v-qa-26.0714.1',
        liveQaTags: ['v-qa-26.0714.1'],
        jenkinsServices: ['other-api'],
        outdated: false,
        checkFailed: false,
      },
    ])
    const freshnessDashboard: ReleaseDashboard = {
      ...dashboard,
      services: [
        ...dashboard.services,
        {
          ...dashboard.services[0],
          repository: 'orange/other-api',
        },
      ],
    }
    render(
      <ReleaseOverview
        connection={{ connected: true, githubOrg: 'orange', projectKey: 'OH' }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={freshnessDashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    await user.click(
      await screen.findByRole('button', { name: 'Outdated 1' }),
    )

    expect(screen.queryByText('orange/other-api')).not.toBeInTheDocument()
    expect(screen.getAllByText('orange/service-api').length).toBeGreaterThan(0)
  })

  it('filters services with pending merges and issues', async () => {
    const user = userEvent.setup()
    vi.mocked(api.repositoryRisks).mockResolvedValueOnce([
      {
        repository: 'orange/service-api',
        backMergePending: true,
        backMergeOutdated: true,
        checkFailed: false,
      },
    ])
    const issueDashboard: ReleaseDashboard = {
      ...dashboard,
      services: [
        {
          ...dashboard.services[0],
          backMergePending: true,
          items: dashboard.services[0].items.map((item) => ({
            ...item,
            pullRequest: item.pullRequest
              ? { ...item.pullRequest, baseBranch: 'dev' }
              : undefined,
          })),
        },
      ],
    }
    render(
      <ReleaseOverview
        connection={{ connected: true, githubOrg: 'orange', projectKey: 'OH' }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={issueDashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('button', { name: 'Pending merge 1' }),
    ).toBeInTheDocument()
    const backMergeFilter = await screen.findByRole('button', {
      name: 'Back-merges 1',
    })
    expect(backMergeFilter).toHaveAttribute(
      'data-tooltip',
      'Shows services where main/default is ahead of release or release is ahead of dev, including services without an open back-merge PR.',
    )
    await user.click(backMergeFilter)
    expect(screen.getAllByText('service-api')).toHaveLength(2)
    await user.click(await screen.findByRole('button', { name: 'Issues 1' }))
    expect(screen.getAllByText('service-api')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Issues 1' })).toHaveAttribute(
      'data-tooltip',
      'Shows services with an open PR targeting the default branch instead of dev, or an open PR into dev that is not reviewer-approved, has unresolved review comments, or has Git merge conflicts.',
    )
  })

  it('includes divergent branches without an open back-merge PR', async () => {
    const user = userEvent.setup()
    vi.mocked(api.repositoryRisks).mockResolvedValueOnce([
      {
        repository: 'orange/service-api',
        backMergePending: false,
        backMergeOutdated: true,
        checkFailed: false,
      },
      {
        repository: 'orange/current-api',
        backMergePending: false,
        backMergeOutdated: false,
        checkFailed: false,
      },
    ])
    render(
      <ReleaseOverview
        connection={{ connected: true, githubOrg: 'orange', projectKey: 'OH' }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={{
          ...dashboard,
          services: [
            dashboard.services[0],
            { ...dashboard.services[0], repository: 'orange/current-api' },
          ],
        }}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    await user.click(
      await screen.findByRole('button', { name: 'Back-merges 1' }),
    )
    expect(screen.queryByText('orange/current-api')).not.toBeInTheDocument()
    expect(screen.getAllByText('orange/service-api').length).toBeGreaterThan(0)
  })

  it('shows participants and merges a ready feature PR', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    const merge = vi
      .spyOn(api, 'mergeFeaturePullRequest')
      .mockResolvedValue({ merged: true, message: 'Merged' })
    const readyItem = {
      ...dashboard.services[0].items[0],
      pullRequest: {
        ...dashboard.services[0].items[0].pullRequest!,
        baseBranch: 'dev',
        reviewDecision: 'approved' as const,
        checks: 'failure' as const,
        participants: [
          {
            login: 'reviewer',
            avatarUrl: 'https://avatars.test/reviewer.png',
            role: 'reviewer' as const,
          },
          {
            login: 'alice',
            avatarUrl: 'https://avatars.test/alice.png',
            role: 'author' as const,
          },
        ],
      },
      eligible: true,
      blockingReasons: [],
      warningReasons: ['CHECKS_FAILED' as const],
    }
    const readyDashboard: ReleaseDashboard = {
      ...dashboard,
      version: { ...dashboard.version, issueCount: 1 },
      unmatched: [],
      services: [
        {
          ...dashboard.services[0],
          eligibleCount: 1,
          blockedCount: 0,
          items: [readyItem],
        },
      ],
    }
    render(
      <ReleaseOverview
        connection={{ connected: true, githubOrg: 'orange', projectKey: 'OH' }}
        releases={[readyDashboard.version]}
        selectedVersionId="10351"
        dashboard={readyDashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={onRefresh}
        onDisconnect={vi.fn()}
      />,
    )

    expect(screen.getByAltText('reviewer')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View people involved' }))
    expect(
      await screen.findByRole('dialog', { name: '#8 Contributors' }),
    ).toBeVisible()
    expect(screen.getByText('alice')).toBeVisible()
    expect(screen.getByText(/author · 1 PR/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: '#8 Contributors' })).not.toBeInTheDocument()

    expect(screen.getByText('0 of 1 tickets merged to dev')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Merge to dev' }))
    await user.click(screen.getByRole('button', { name: 'Merge' }))
    expect(merge).toHaveBeenCalledWith({
      repository: 'orange/service-api',
      pullNumber: 8,
      retargetToDev: false,
    })
    expect(onRefresh).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Merge to dev' })).not.toBeInTheDocument()
    expect(screen.getByText('Merged')).toBeInTheDocument()
  })

  it('bulk merges all ready feature PRs into dev across services', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    const merge = vi
      .spyOn(api, 'mergeFeaturePullRequest')
      .mockResolvedValue({ merged: true, message: 'Merged' })
    const firstReady = {
      ...dashboard.services[0].items[0],
      pullRequest: {
        ...dashboard.services[0].items[0].pullRequest!,
        number: 8,
        baseBranch: 'dev',
        reviewDecision: 'approved' as const,
        checks: 'success' as const,
      },
      eligible: true,
      blockingReasons: [],
      warningReasons: [],
    }
    const secondReady = {
      ...dashboard.services[0].items[0],
      issue: {
        ...dashboard.services[0].items[0].issue,
        key: 'OH-456',
        url: 'https://jira.test/OH-456',
      },
      pullRequest: {
        ...dashboard.services[0].items[0].pullRequest!,
        id: 2,
        number: 9,
        repository: 'orange/billing-api',
        title: 'OH-456 Billing',
        url: 'https://github.test/pull/9',
        baseBranch: 'main',
        reviewDecision: 'approved' as const,
        checks: 'success' as const,
      },
      eligible: false,
      blockingReasons: ['WRONG_BASE_BRANCH' as const],
      warningReasons: [],
    }
    const readyDashboard: ReleaseDashboard = {
      ...dashboard,
      unmatched: [],
      services: [
        {
          ...dashboard.services[0],
          eligibleCount: 1,
          blockedCount: 0,
          items: [firstReady],
        },
        {
          repository: 'orange/billing-api',
          defaultBranch: 'main',
          eligibleCount: 0,
          blockedCount: 1,
          mergedCount: 0,
          backMergePending: false,
          items: [secondReady],
        },
      ],
    }
    render(
      <ReleaseOverview
        connection={{ connected: true, githubOrg: 'orange', projectKey: 'OH' }}
        releases={[readyDashboard.version]}
        selectedVersionId="10351"
        dashboard={readyDashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={onRefresh}
        onDisconnect={vi.fn()}
      />,
    )

    await user.click(
      screen.getByRole('button', {
        name: 'Merge all ready release PRs into dev',
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Merge all' }))
    expect(merge).toHaveBeenCalledTimes(2)
    expect(merge).toHaveBeenNthCalledWith(1, {
      repository: 'orange/service-api',
      pullNumber: 8,
      retargetToDev: false,
    })
    expect(merge).toHaveBeenNthCalledWith(2, {
      repository: 'orange/billing-api',
      pullNumber: 9,
      retargetToDev: true,
    })
    expect(onRefresh).toHaveBeenCalled()
  })

  it('bulk merges all ready feature PRs for the selected service', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    const merge = vi
      .spyOn(api, 'mergeFeaturePullRequest')
      .mockResolvedValue({ merged: true, message: 'Merged' })
    const firstReady = {
      ...dashboard.services[0].items[0],
      pullRequest: {
        ...dashboard.services[0].items[0].pullRequest!,
        number: 8,
        baseBranch: 'dev',
        reviewDecision: 'approved' as const,
        checks: 'success' as const,
      },
      eligible: true,
      blockingReasons: [],
      warningReasons: [],
    }
    const secondReady = {
      ...dashboard.services[0].items[0],
      issue: {
        ...dashboard.services[0].items[0].issue,
        key: 'OH-456',
        url: 'https://jira.test/OH-456',
      },
      pullRequest: {
        ...dashboard.services[0].items[0].pullRequest!,
        id: 2,
        number: 9,
        title: 'OH-456 Extra',
        url: 'https://github.test/pull/9',
        baseBranch: 'dev',
        reviewDecision: 'approved' as const,
        checks: 'success' as const,
      },
      eligible: true,
      blockingReasons: [],
      warningReasons: [],
    }
    const readyDashboard: ReleaseDashboard = {
      ...dashboard,
      unmatched: [],
      services: [
        {
          ...dashboard.services[0],
          eligibleCount: 2,
          blockedCount: 0,
          items: [firstReady, secondReady],
        },
      ],
    }
    render(
      <ReleaseOverview
        connection={{ connected: true, githubOrg: 'orange', projectKey: 'OH' }}
        releases={[readyDashboard.version]}
        selectedVersionId="10351"
        dashboard={readyDashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={onRefresh}
        onDisconnect={vi.fn()}
      />,
    )

    await user.click(
      screen.getByRole('button', {
        name: 'Merge all ready PRs into dev for this service',
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Merge all' }))
    expect(merge).toHaveBeenCalledTimes(2)
    expect(merge).toHaveBeenCalledWith({
      repository: 'orange/service-api',
      pullNumber: 8,
      retargetToDev: false,
    })
    expect(merge).toHaveBeenCalledWith({
      repository: 'orange/service-api',
      pullNumber: 9,
      retargetToDev: false,
    })
    expect(onRefresh).toHaveBeenCalled()
  })

  it('retargets a default-branch PR to dev and merges it', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    const merge = vi
      .spyOn(api, 'mergeFeaturePullRequest')
      .mockResolvedValue({ merged: true, message: 'Merged' })
    const retargetItem = {
      ...dashboard.services[0].items[0],
      pullRequest: {
        ...dashboard.services[0].items[0].pullRequest!,
        baseBranch: 'main',
        reviewDecision: 'approved' as const,
        checks: 'success' as const,
      },
      eligible: false,
      blockingReasons: ['WRONG_BASE_BRANCH' as const],
      warningReasons: [],
    }
    const retargetDashboard: ReleaseDashboard = {
      ...dashboard,
      services: [
        {
          ...dashboard.services[0],
          items: [retargetItem],
        },
      ],
    }
    render(
      <ReleaseOverview
        connection={{ connected: true, githubOrg: 'orange', projectKey: 'OH' }}
        releases={[retargetDashboard.version]}
        selectedVersionId="10351"
        dashboard={retargetDashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={onRefresh}
        onDisconnect={vi.fn()}
      />,
    )

    expect(screen.getByText('Targets default branch')).toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: 'Retarget to dev and merge' }),
    )
    await user.click(
      screen.getByRole('button', { name: 'Retarget and merge' }),
    )
    expect(merge).toHaveBeenCalledWith({
      repository: 'orange/service-api',
      pullNumber: 8,
      retargetToDev: true,
    })
    expect(onRefresh).toHaveBeenCalled()
  })

  it('force merges an unapproved feature PR targeting dev', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    const merge = vi
      .spyOn(api, 'mergeFeaturePullRequest')
      .mockResolvedValue({ merged: true, message: 'Force-merged' })
    const blockedItem = {
      ...dashboard.services[0].items[0],
      pullRequest: {
        ...dashboard.services[0].items[0].pullRequest!,
        baseBranch: 'dev',
        reviewDecision: 'review_required' as const,
        checks: 'pending' as const,
      },
      eligible: false,
      blockingReasons: ['REVIEW_REQUIRED' as const],
      warningReasons: ['CHECKS_PENDING' as const],
    }
    const blockedDashboard: ReleaseDashboard = {
      ...dashboard,
      unmatched: [],
      services: [
        {
          ...dashboard.services[0],
          eligibleCount: 0,
          blockedCount: 1,
          items: [blockedItem],
        },
      ],
    }
    render(
      <ReleaseOverview
        connection={{ connected: true, githubOrg: 'orange', projectKey: 'OH' }}
        releases={[blockedDashboard.version]}
        selectedVersionId="10351"
        dashboard={blockedDashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={onRefresh}
        onDisconnect={vi.fn()}
      />,
    )

    await user.click(
      screen.getByRole('button', { name: 'Force merge to dev' }),
    )
    await user.click(screen.getByRole('button', { name: 'Force merge' }))
    expect(merge).toHaveBeenCalledWith({
      repository: 'orange/service-api',
      pullNumber: 8,
      retargetToDev: false,
      bypassBranchProtection: true,
    })
    expect(onRefresh).toHaveBeenCalled()
  })

  it('does not reload enrichment when only dashboard freshness changes', async () => {
    const props = {
      connection: {
        connected: true as const,
        githubOrg: 'orange',
        projectKey: 'OH',
      },
      releases: [dashboard.version],
      selectedVersionId: '10351',
      loading: false,
      onSelectVersion: vi.fn(),
      onRefresh: vi.fn(),
      onDisconnect: vi.fn(),
    }
    const view = render(<ReleaseOverview {...props} dashboard={dashboard} />)
    await waitFor(() =>
      expect(api.repositoryRisks).toHaveBeenCalledTimes(1),
    )
    await waitFor(() =>
      expect(api.deploymentFreshness).toHaveBeenCalledTimes(1),
    )

    view.rerender(
      <ReleaseOverview
        {...props}
        dashboard={{
          ...dashboard,
          fetchedAt: '2026-07-15T10:00:00Z',
          cached: true,
        }}
      />,
    )

    expect(api.repositoryRisks).toHaveBeenCalledTimes(1)
    expect(api.deploymentFreshness).toHaveBeenCalledTimes(1)
  })

  it('opens bulk QA tag creation for all release services', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'createStagingRelease').mockResolvedValue({
      id: 1,
      repository: 'orange/service-api',
      environment: 'qa',
      tag: 'v-qa-26.0716.1',
      sourceBranch: 'dev',
      url: 'https://github.test/releases/1',
      createdAt: '2026-07-16T10:00:00Z',
    })

    render(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={dashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    await user.click(
      screen.getByRole('button', {
        name: 'Create QA tags for all services in this release',
      }),
    )
    expect(
      screen.getByRole('heading', {
        name: 'Create QA tags',
      }),
    ).toBeVisible()
    expect(screen.getByText('v-qa-26.0716.N')).toBeVisible()
    expect(
      screen.getByRole('list', { name: 'Services' }),
    ).toHaveTextContent('service-api')
  })

  it('opens bulk QA deploy for merged services with a successful tag', async () => {
    const user = userEvent.setup()
    const mergedDashboard: ReleaseDashboard = {
      ...dashboard,
      unmatched: [],
      services: [
        {
          ...dashboard.services[0],
          eligibleCount: 0,
          blockedCount: 0,
          mergedCount: 1,
          items: [
            {
              ...dashboard.services[0].items[0],
              eligible: false,
              blockingReasons: ['ALREADY_MERGED'],
              warningReasons: [],
              pullRequest: {
                ...dashboard.services[0].items[0].pullRequest!,
                merged: true,
                state: 'closed',
                baseBranch: 'dev',
              },
            },
          ],
        },
      ],
    }
    vi.mocked(api.deploymentFreshness).mockResolvedValue([
      {
        repository: 'orange/service-api',
        latestBuiltQaTag: 'v-qa-26.0716.1',
        liveQaTags: [],
        jenkinsServices: ['service-api'],
        outdated: true,
        checkFailed: false,
      },
    ])
    vi.spyOn(api, 'triggerDeployment').mockResolvedValue({
      queueId: 11,
      queueUrl: 'https://jenkins.test/queue/11',
      jobName: 'QA/QA-DEPLOYMENT',
      service: 'service-api',
      tag: 'v-qa-26.0716.1',
      environment: 'qa',
    })

    render(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[mergedDashboard.version]}
        selectedVersionId="10351"
        dashboard={mergedDashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: 'Deploy QA for all merged services in this release',
        }),
      ).toBeEnabled(),
    )
    await user.click(
      screen.getByRole('button', {
        name: 'Deploy QA for all merged services in this release',
      }),
    )
    expect(
      screen.getByRole('heading', {
        name: 'Deploy QA for merged services',
      }),
    ).toBeVisible()
    expect(screen.getByText(/v-qa-26.0716.1/)).toBeVisible()
  })

  it('switches to tickets view and removes a ticket from the release', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    const removeReleaseIssue = vi
      .spyOn(api, 'removeReleaseIssue')
      .mockResolvedValue({
        issueKey: 'OH-123',
        removedFromVersionId: '10351',
        addedToVersionId: '10400',
      })
    const ticketsDashboard: ReleaseDashboard = {
      ...dashboard,
      services: [
        {
          ...dashboard.services[0],
          items: [
            {
              ...dashboard.services[0].items[0],
              issue: {
                ...dashboard.services[0].items[0].issue,
                assignee: 'Ada Lovelace',
              },
            },
          ],
        },
        {
          repository: 'orange/service-web',
          defaultBranch: 'main',
          eligibleCount: 0,
          blockedCount: 0,
          mergedCount: 1,
          backMergePending: false,
          items: [
            {
              issue: {
                key: 'OH-200',
                summary: 'Already merged',
                status: 'Done',
                assignee: 'Grace Hopper',
                url: 'https://jira.test/OH-200',
              },
              pullRequest: {
                id: 2,
                number: 12,
                repository: 'orange/service-web',
                title: 'OH-200 Already merged',
                url: 'https://github.test/pull/12',
                state: 'closed',
                draft: false,
                merged: true,
                baseBranch: 'dev',
                headBranch: 'feature/OH-200',
                author: 'dev',
                assignees: [],
                reviewDecision: 'approved',
                mergeable: null,
                mergeableState: 'unknown',
                checks: 'success',
                updatedAt: '2026-07-13T12:00:00Z',
              },
              eligible: false,
              blockingReasons: ['ALREADY_MERGED'],
              warningReasons: [],
            },
          ],
        },
      ],
    }
    let currentDashboard = ticketsDashboard
    const onIssueRemoved = vi.fn((issueKey: string) => {
      currentDashboard = removeIssueFromDashboard(currentDashboard, issueKey)
      view.rerender(
        <ReleaseOverview
          connection={{
            connected: true,
            githubOrg: 'orange',
            projectKey: 'OH',
          }}
          releases={[
            dashboard.version,
            {
              id: '10400',
              name: 'OH Release 26.0723',
              releaseDate: '2026-07-23',
              overdue: false,
            },
          ]}
          selectedVersionId="10351"
          dashboard={currentDashboard}
          loading={false}
          onSelectVersion={vi.fn()}
          onRefresh={onRefresh}
          onIssueRemoved={onIssueRemoved}
          onDisconnect={vi.fn()}
        />,
      )
    })
    const view = render(
      <ReleaseOverview
        connection={{
          connected: true,
          githubOrg: 'orange',
          projectKey: 'OH',
        }}
        releases={[
          dashboard.version,
          {
            id: '10400',
            name: 'OH Release 26.0723',
            releaseDate: '2026-07-23',
            overdue: false,
          },
        ]}
        selectedVersionId="10351"
        dashboard={currentDashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={onRefresh}
        onIssueRemoved={onIssueRemoved}
        onDisconnect={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('tab', { name: 'Tickets' }))

    expect(screen.getByRole('heading', { name: 'Tickets' })).toBeVisible()
    expect(screen.getByRole('button', { name: /OH-123/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /OH-999/ })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'OH-123' })).toBeVisible()

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by assignee' }),
      'Ada Lovelace',
    )
    expect(screen.getByRole('button', { name: /OH-123/ })).toBeVisible()
    expect(screen.queryByRole('button', { name: /OH-999/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /OH-200/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^All 1$/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /^Merged 0$/ })).toBeVisible()

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by assignee' }),
      'Unassigned',
    )
    expect(screen.getByRole('button', { name: /OH-999/ })).toBeVisible()
    expect(screen.queryByRole('button', { name: /OH-123/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^All 1$/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /^Unmatched 1$/ })).toBeVisible()

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by assignee' }),
      'All assignees',
    )
    expect(screen.getByRole('button', { name: /OH-123/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /OH-999/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /^All 3$/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /^Merged 1$/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /^Unmatched 1$/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /^Blocked / })).toHaveAttribute(
      'data-tooltip',
      'Shows tickets with an open PR blocked by a hard issue such as missing review, merge conflicts, wrong base branch, or draft status.',
    )
    expect(
      screen.getByRole('button', { name: /^Not merge-ready / }),
    ).toHaveAttribute(
      'data-tooltip',
      'Shows tickets whose open PRs are not eligible to merge yet — including hard blockers and softer issues like pending or failed checks.',
    )
    expect(
      screen.getByRole('button', { name: /^Unmatched / }),
    ).toHaveAttribute(
      'data-tooltip',
      'Shows tickets with no matching pull request linked across the release services.',
    )

    await user.click(screen.getByRole('button', { name: /OH-200/ }))
    expect(
      screen.getByRole('button', { name: 'Remove from release' }),
    ).toBeEnabled()

    await user.click(screen.getByRole('button', { name: /OH-123/ }))
    expect(
      screen.getByRole('button', { name: 'Remove from release' }),
    ).toBeEnabled()
    await user.click(
      screen.getByRole('button', { name: 'Remove from release' }),
    )
    expect(
      screen.getByRole('heading', {
        name: 'Remove OH-123 from release?',
      }),
    ).toBeVisible()

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Move to another release' }),
      '10400',
    )
    await user.click(
      screen.getByRole('button', { name: 'Remove and move' }),
    )

    await waitFor(() =>
      expect(removeReleaseIssue).toHaveBeenCalledWith(
        '10351',
        'OH-123',
        '10400',
      ),
    )
    expect(onIssueRemoved).toHaveBeenCalledWith('OH-123')
    expect(onRefresh).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /OH-123/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /OH-999/ })).toBeVisible()
  })

  it('refreshes PR status for the selected ticket without reloading the release', async () => {
    const user = userEvent.setup()
    const blockedItem = dashboard.services[0].items[0]
    const refreshedItem: ReleaseItem = {
      ...blockedItem,
      eligible: true,
      blockingReasons: [],
      warningReasons: [],
      pullRequest: {
        ...blockedItem.pullRequest!,
        baseBranch: 'dev',
        reviewDecision: 'approved' as const,
        checks: 'success' as const,
        title: 'OH-123 Ready after review',
      },
    }
    const refreshTicket = vi.spyOn(api, 'refreshTicket').mockResolvedValue({
      items: [refreshedItem],
    })
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    const onTicketRefreshed = vi.fn()
    let currentDashboard = dashboard
    const overviewProps = () => ({
      connection: {
        connected: true as const,
        githubOrg: 'orange',
        projectKey: 'OH',
      },
      releases: [dashboard.version],
      selectedVersionId: '10351',
      dashboard: currentDashboard,
      loading: false,
      onSelectVersion: vi.fn(),
      onRefresh,
      onTicketRefreshed: (issueKey: string, items: ReleaseItem[]) => {
        onTicketRefreshed(issueKey, items)
        currentDashboard = replaceIssueItemsInDashboard(
          currentDashboard,
          issueKey,
          items,
        )
        view.rerender(<ReleaseOverview {...overviewProps()} />)
      },
      onDisconnect: vi.fn(),
    })
    const view = render(<ReleaseOverview {...overviewProps()} />)

    await user.click(screen.getByRole('tab', { name: 'Tickets' }))
    expect(screen.getAllByText('Blocked').length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: '↻ Refresh PRs' }))

    await waitFor(() =>
      expect(refreshTicket).toHaveBeenCalledWith('10351', 'OH-123', [
        'orange/service-api',
      ]),
    )
    expect(onRefresh).not.toHaveBeenCalled()
    expect(onTicketRefreshed).toHaveBeenCalledWith('OH-123', [refreshedItem])
    await waitFor(() =>
      expect(screen.getByText(/OH-123 Ready after review/)).toBeVisible(),
    )
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /^Blocked 0$/ })).toBeVisible()
    expect(screen.getByText('All criteria met')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Merge to dev' })).toBeEnabled()
  })

  it('merges a ready feature PR from the tickets view', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    const merge = vi
      .spyOn(api, 'mergeFeaturePullRequest')
      .mockResolvedValue({ merged: true, message: 'Merged' })
    const readyItem = {
      ...dashboard.services[0].items[0],
      pullRequest: {
        ...dashboard.services[0].items[0].pullRequest!,
        baseBranch: 'dev',
        reviewDecision: 'approved' as const,
        checks: 'failure' as const,
      },
      eligible: true,
      blockingReasons: [],
      warningReasons: ['CHECKS_FAILED' as const],
    }
    const readyDashboard: ReleaseDashboard = {
      ...dashboard,
      unmatched: [],
      services: [
        {
          ...dashboard.services[0],
          eligibleCount: 1,
          blockedCount: 0,
          items: [readyItem],
        },
      ],
    }
    render(
      <ReleaseOverview
        connection={{ connected: true, githubOrg: 'orange', projectKey: 'OH' }}
        releases={[readyDashboard.version]}
        selectedVersionId="10351"
        dashboard={readyDashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={onRefresh}
        onDisconnect={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('tab', { name: 'Tickets' }))
    expect(screen.getByText('Checks failed')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Merge to dev' }))
    await user.click(screen.getByRole('button', { name: 'Merge' }))
    expect(merge).toHaveBeenCalledWith({
      repository: 'orange/service-api',
      pullNumber: 8,
      retargetToDev: false,
    })
    expect(onRefresh).toHaveBeenCalled()
  })

  it('shows a local release progress bar and persists it after tag data loads', async () => {
    vi.mocked(api.listStagingTags).mockResolvedValue([
      {
        repository: 'orange/service-api',
        tags: ['v-qa-26.0716.1'],
        checkFailed: false,
      },
    ])
    vi.mocked(api.deploymentFreshness).mockResolvedValue([
      {
        repository: 'orange/service-api',
        latestBuiltQaTag: 'v-qa-26.0716.1',
        liveQaTags: ['v-qa-26.0716.1'],
        jenkinsServices: ['service-api'],
        outdated: false,
        checkFailed: false,
      },
    ])

    render(
      <ReleaseOverview
        connection={{ connected: true, githubOrg: 'orange', projectKey: 'OH' }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={dashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    const progress = await screen.findByRole('list', {
      name: 'Release progress',
    })
    expect(progress.closest('.release-toolbar')).toBeInTheDocument()
    expect(progress).toHaveTextContent('Tickets finalised')
    expect(progress).toHaveTextContent("PR's merged")
    expect(progress).toHaveTextContent('Tags created')
    expect(progress).toHaveTextContent('Deployed on QA')
    expect(progress).toHaveTextContent('1 of 2')
    expect(progress).toHaveTextContent('0 of 2')
    expect(
      screen.getByRole('listitem', {
        name: /PR's merged.*Yet to merge: service-api/i,
      }),
    ).toBeVisible()

    await waitFor(() => expect(progress).toHaveTextContent('1 of 1'))
    await waitFor(() => {
      const stored = window.localStorage.getItem('release-desk-progress:10351')
      expect(stored).toBeTruthy()
      expect(JSON.parse(stored!)).toMatchObject({
        versionId: '10351',
        ticketsFinalised: { current: 1, total: 2 },
        prsMerged: { current: 0, total: 2 },
        tagsCreated: { current: 1, total: 1 },
        deployedOnQa: { current: 1, total: 1 },
      })
    })
  })

  it('lists remaining repositories on incomplete merge, tag, and deploy steps', async () => {
    vi.mocked(api.listStagingTags).mockResolvedValue([
      {
        repository: 'orange/service-api',
        tags: ['v-qa-26.0716.1'],
        checkFailed: false,
      },
      { repository: 'orange/bifrost', tags: [], checkFailed: false },
    ])
    vi.mocked(api.deploymentFreshness).mockResolvedValue([
      {
        repository: 'orange/service-api',
        latestBuiltQaTag: 'v-qa-26.0716.1',
        liveQaTags: [],
        jenkinsServices: ['service-api'],
        outdated: true,
        checkFailed: false,
      },
      {
        repository: 'orange/bifrost',
        liveQaTags: [],
        jenkinsServices: ['bifrost'],
        outdated: false,
        checkFailed: false,
      },
    ])
    const twoServiceDashboard: ReleaseDashboard = {
      ...dashboard,
      unmatched: [],
      version: { ...dashboard.version, issueCount: 2 },
      services: [
        dashboard.services[0],
        {
          ...dashboard.services[0],
          repository: 'orange/bifrost',
          items: [
            {
              ...dashboard.services[0].items[0],
              issue: {
                ...dashboard.services[0].items[0].issue,
                key: 'OH-200',
                summary: 'Bifrost upgrade',
                url: 'https://jira.test/OH-200',
              },
              pullRequest: {
                ...dashboard.services[0].items[0].pullRequest!,
                id: 2,
                number: 9,
                repository: 'orange/bifrost',
                title: 'OH-200 Bifrost upgrade',
                merged: true,
                state: 'closed',
                baseBranch: 'dev',
              },
              eligible: false,
              blockingReasons: ['ALREADY_MERGED'],
              warningReasons: [],
            },
          ],
        },
      ],
    }

    render(
      <ReleaseOverview
        connection={{ connected: true, githubOrg: 'orange', projectKey: 'OH' }}
        releases={[twoServiceDashboard.version]}
        selectedVersionId="10351"
        dashboard={twoServiceDashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(
        screen.getByRole('listitem', {
          name: /Tags created.*Yet to tag: bifrost/i,
        }),
      ).toBeVisible(),
    )
    expect(
      screen.getByRole('listitem', {
        name: /PR's merged.*Yet to merge: service-api/i,
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('listitem', {
        name: /Deployed on QA.*Yet to deploy: service-api/i,
      }),
    ).toBeVisible()
    expect(
      screen.queryByRole('listitem', { name: /Yet to merge: bifrost/i }),
    ).not.toBeInTheDocument()
  })

  it('refetches staging tags when the dashboard refresh timestamp changes', async () => {
    const view = render(
      <ReleaseOverview
        connection={{ connected: true, githubOrg: 'orange', projectKey: 'OH' }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={dashboard}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )
    await waitFor(() => expect(api.listStagingTags).toHaveBeenCalledTimes(1))

    view.rerender(
      <ReleaseOverview
        connection={{ connected: true, githubOrg: 'orange', projectKey: 'OH' }}
        releases={[dashboard.version]}
        selectedVersionId="10351"
        dashboard={{
          ...dashboard,
          fetchedAt: '2026-07-15T10:00:00Z',
        }}
        loading={false}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    await waitFor(() => expect(api.listStagingTags).toHaveBeenCalledTimes(2))
    expect(api.listStagingTags).toHaveBeenLastCalledWith({
      repositories: ['orange/service-api'],
      environment: 'qa',
      date: '2026-07-16',
    })
  })
})
