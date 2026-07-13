import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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
})
