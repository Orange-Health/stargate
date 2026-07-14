import { render, screen } from '@testing-library/react'
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
    expect(screen.getByText('Not targeting dev')).toBeInTheDocument()
    expect(screen.getByText('Review required')).toBeInTheDocument()
    expect(screen.getByText('Checks pending')).toBeInTheDocument()
    expect(screen.getByText('OH-999')).toBeInTheDocument()
  })

  it('opens staging-only release creation for the selected service', async () => {
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
    const refreshRepository = vi
      .spyOn(api, 'refreshRepository')
      .mockResolvedValue()
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
      screen.getByRole('button', { name: '↻ Refresh service' }),
    )

    expect(refreshRepository).toHaveBeenCalledWith('orange/service-api')
    expect(onRefresh).toHaveBeenCalled()
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
        checkFailed: false,
      },
    ])
    const issueDashboard: ReleaseDashboard = {
      ...dashboard,
      services: [{ ...dashboard.services[0], backMergePending: true }],
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
    await user.click(await screen.findByRole('button', { name: 'Issues 1' }))
    expect(screen.getAllByText('service-api')).toHaveLength(2)
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
    })
    expect(onRefresh).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Merge to dev' })).not.toBeInTheDocument()
    expect(screen.getByText('Merged')).toBeInTheDocument()
  })
})
