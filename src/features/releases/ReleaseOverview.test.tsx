import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import type { ReleaseDashboard } from '../../shared/types'
import { ReleaseOverview } from './ReleaseOverview'

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
          outdated: false,
          checkFailed: false,
        })),
    )
  })

  afterEach(() => vi.restoreAllMocks())

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
          phase: 'github-search',
          message: 'Searching GitHub for pull requests linked to OH-123…',
          current: 3,
          total: 8,
        }}
        onSelectVersion={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    )

    expect(
      screen.getByText(
        'Searching GitHub for pull requests linked to OH-123…',
      ),
    ).toBeVisible()
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '3',
    )
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
        onRefresh={onRefresh}
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
    expect(repositoryState).toHaveBeenCalledTimes(1)

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
        latestBuiltQaTag: 'v-qa-v26.0714.2',
        liveQaTags: ['v-qa-v26.0714.1'],
        outdated: true,
        checkFailed: false,
      },
      {
        repository: 'orange/other-api',
        latestBuiltQaTag: 'v-qa-v26.0714.1',
        liveQaTags: ['v-qa-v26.0714.1'],
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
      'Shows services with an open PR targeting the default branch instead of dev, or an open PR into dev that is not reviewer-approved or has Git merge conflicts.',
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
    vi.spyOn(window, 'confirm').mockReturnValue(true)
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
    expect(screen.getByText('0 of 1 tickets merged to dev')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Merge to dev' }))
    expect(merge).toHaveBeenCalledWith({
      repository: 'orange/service-api',
      pullNumber: 8,
      retargetToDev: false,
    })
    expect(onRefresh).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Merge to dev' })).not.toBeInTheDocument()
    expect(screen.getByText('Merged')).toBeInTheDocument()
  })

  it('retargets a default-branch PR to dev and merges it', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    const merge = vi
      .spyOn(api, 'mergeFeaturePullRequest')
      .mockResolvedValue({ merged: true, message: 'Merged' })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
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
    expect(merge).toHaveBeenCalledWith({
      repository: 'orange/service-api',
      pullNumber: 8,
      retargetToDev: true,
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
})
