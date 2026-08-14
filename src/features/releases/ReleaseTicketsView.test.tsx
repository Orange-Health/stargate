import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import type {
  ReleaseDashboard,
  ReleaseItem,
  ServiceRelease,
} from '../../shared/types'
import { ReleaseTicketsView } from './ReleaseTicketsView'
import { groupReleaseTickets } from './releaseTickets'

const basePull: NonNullable<ReleaseItem['pullRequest']> = {
  id: 1,
  number: 8,
  repository: 'orange/service-api',
  title: 'OH-123 Release API',
  url: 'https://github.test/pull/8',
  state: 'open',
  draft: false,
  merged: false,
  baseBranch: 'dev',
  headBranch: 'feature/OH-123',
  author: 'dev',
  assignees: [],
  reviewDecision: 'approved',
  mergeable: true,
  mergeableState: 'clean',
  checks: 'success',
  updatedAt: '2026-07-13T12:00:00Z',
}

const baseItem: ReleaseItem = {
  issue: {
    key: 'OH-123',
    summary: 'Release API',
    status: 'In Progress',
    url: 'https://jira.test/OH-123',
  },
  pullRequest: basePull,
  eligible: true,
  blockingReasons: [],
  warningReasons: [],
}

function dashboardWith(
  items: ReleaseItem[],
  serviceOverrides: Partial<ServiceRelease> = {},
): ReleaseDashboard {
  return {
    version: {
      id: '10351',
      name: 'OH Release 26.0716',
      releaseDate: '2026-07-16',
      overdue: false,
      issueCount: items.length,
    },
    services: [
      {
        repository: 'orange/service-api',
        defaultBranch: 'main',
        eligibleCount: items.filter((item) => item.eligible).length,
        blockedCount: items.filter(
          (item) => !item.eligible && !item.pullRequest?.merged,
        ).length,
        mergedCount: items.filter((item) => item.pullRequest?.merged).length,
        backMergePending: false,
        items,
        ...serviceOverrides,
      },
    ],
    unmatched: [],
    warnings: [],
    fetchedAt: '2026-07-13T12:00:00Z',
    cached: false,
  }
}

function renderTickets(
  dashboard: ReleaseDashboard,
  onDataChanged = vi.fn(),
) {
  const tickets = groupReleaseTickets(dashboard)
  return {
    onDataChanged,
    ...render(
      <ReleaseTicketsView
        tickets={tickets}
        services={dashboard.services}
        ticketFilter="all"
        ticketAssigneeFilter=""
        ticketSearch=""
        selectedIssueKey={tickets[0]?.issue.key ?? ''}
        removeError=""
        onFilterChange={vi.fn()}
        onAssigneeFilterChange={vi.fn()}
        onSearchChange={vi.fn()}
        onSelectTicket={vi.fn()}
        onRemoveTicket={vi.fn()}
        onRefreshTicket={vi.fn().mockResolvedValue(undefined)}
        onDataChanged={onDataChanged}
      />,
    ),
  }
}

describe('ReleaseTicketsView merge options', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows check failures and merges a ready feature PR', async () => {
    const user = userEvent.setup()
    const merge = vi
      .spyOn(api, 'mergeFeaturePullRequest')
      .mockResolvedValue({ merged: true, message: 'Merged' })
    const { onDataChanged } = renderTickets(
      dashboardWith([
        {
          ...baseItem,
          pullRequest: { ...basePull, checks: 'failure' },
          warningReasons: ['CHECKS_FAILED'],
        },
      ]),
    )

    expect(screen.getByText('Checks failed')).toBeVisible()
    expect(screen.getByText('Checks failed').className).toContain('warning')
    expect(screen.queryByText('All criteria met')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Merge to dev' }))
    await user.click(screen.getByRole('button', { name: 'Merge' }))
    expect(merge).toHaveBeenCalledWith({
      repository: 'orange/service-api',
      pullNumber: 8,
      retargetToDev: false,
    })
    expect(onDataChanged).toHaveBeenCalled()
    expect(
      screen.queryByRole('button', { name: 'Merge to dev' }),
    ).not.toBeInTheDocument()
    expect(document.querySelector('.status-pill.merged')).toHaveTextContent(
      'Merged',
    )
  })

  it('shows pending checks and force merges an unapproved PR targeting dev', async () => {
    const user = userEvent.setup()
    const merge = vi
      .spyOn(api, 'mergeFeaturePullRequest')
      .mockResolvedValue({ merged: true, message: 'Force-merged' })
    renderTickets(
      dashboardWith([
        {
          ...baseItem,
          eligible: false,
          blockingReasons: ['REVIEW_REQUIRED'],
          warningReasons: ['CHECKS_PENDING'],
          pullRequest: {
            ...basePull,
            reviewDecision: 'review_required',
            checks: 'pending',
          },
        },
      ]),
    )

    expect(screen.getByText('Review required')).toBeVisible()
    expect(screen.getByText('Checks pending')).toBeVisible()
    expect(screen.getByText('Checks pending').className).toContain('warning')
    expect(
      screen.queryByRole('button', { name: 'Merge to dev' }),
    ).not.toBeInTheDocument()

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
  })

  it('retargets a default-branch PR to dev and merges it', async () => {
    const user = userEvent.setup()
    const merge = vi
      .spyOn(api, 'mergeFeaturePullRequest')
      .mockResolvedValue({ merged: true, message: 'Merged' })
    renderTickets(
      dashboardWith([
        {
          ...baseItem,
          eligible: false,
          blockingReasons: ['WRONG_BASE_BRANCH'],
          pullRequest: { ...basePull, baseBranch: 'main', checks: 'success' },
        },
      ]),
    )

    expect(screen.getByText('Targets default branch')).toBeVisible()
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
  })

  it('shows all-criteria-met and bulk merges ready PRs for the ticket', async () => {
    const user = userEvent.setup()
    const merge = vi
      .spyOn(api, 'mergeFeaturePullRequest')
      .mockResolvedValue({ merged: true, message: 'Merged' })
    const second: ReleaseItem = {
      ...baseItem,
      pullRequest: {
        ...basePull,
        id: 2,
        number: 9,
        repository: 'orange/billing-api',
        title: 'OH-123 Billing',
        url: 'https://github.test/pull/9',
        baseBranch: 'main',
      },
      eligible: false,
      blockingReasons: ['WRONG_BASE_BRANCH'],
    }
    const dashboard: ReleaseDashboard = {
      ...dashboardWith([baseItem]),
      services: [
        dashboardWith([baseItem]).services[0],
        {
          repository: 'orange/billing-api',
          defaultBranch: 'main',
          eligibleCount: 0,
          blockedCount: 1,
          mergedCount: 0,
          backMergePending: false,
          items: [second],
        },
      ],
    }
    renderTickets(dashboard)

    expect(screen.getByText('All criteria met')).toBeVisible()
    await user.click(
      screen.getByRole('button', {
        name: 'Merge all ready PRs into dev for this ticket',
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
  })
})
