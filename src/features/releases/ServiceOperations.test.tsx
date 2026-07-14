import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import type { RepositoryReleaseState } from '../../shared/types'
import { ServiceOperations } from './ServiceOperations'

const repositoryState: RepositoryReleaseState = {
  repository: 'Orange-Health/service-api',
  defaultBranch: 'master',
  stagingReleases: [
    {
      id: 1,
      tag: 'v-qa-v26.0713.2',
      environment: 'qa',
      url: 'https://github.test/release/1',
      createdAt: '2026-07-13T12:00:00Z',
      buildStatus: 'running',
      runs: [
        {
          id: 2,
          name: 'Build service',
          status: 'in_progress',
          url: 'https://github.test/run/2',
          startedAt: '2026-07-13T12:00:10Z',
          updatedAt: '2026-07-13T12:01:00Z',
        },
      ],
    },
    {
      id: 3,
      tag: 'v-s1-v26.0713.1',
      environment: 's1',
      url: 'https://github.test/release/3',
      createdAt: '2026-07-13T11:00:00Z',
      buildStatus: 'succeeded',
      runs: [],
    },
  ],
  productionReleases: [
    {
      id: 4,
      tag: 'v-26.0713.1',
      url: 'https://github.test/release/4',
      createdAt: '2026-07-13T13:00:00Z',
      buildStatus: 'succeeded',
      runs: [],
    },
  ],
  deployedTags: [
    {
      service: 'accounts',
      tag: 'v-s1-v26.0713.1',
      environment: 's1',
      buildNumber: 2152,
      buildUrl: 'https://jenkins.test/job/DEV/job/DEV%20Deployer/2152/',
      deployedAt: '2026-07-13T11:30:00Z',
    },
  ],
  deploymentLookupFailed: false,
  productionReady: true,
  promotionSteps: [
    {
      route: 'dev-to-release',
      fromBranch: 'dev',
      toBranch: 'release',
      commitsAhead: 4,
      commitsBehind: 0,
      state: 'needs_pr',
      previousTemplate: {
        title: 'Promote dev to release',
        body: 'Previous body',
        url: 'https://github.test/pull/1',
      },
    },
    {
      route: 'release-to-default',
      fromBranch: 'release',
      toBranch: 'master',
      commitsAhead: 2,
      commitsBehind: 0,
      state: 'pr_open',
      pullRequest: {
        number: 42,
        title: 'Promote release to master',
        url: 'https://github.test/pull/42',
        baseBranch: 'master',
        headBranch: 'release',
        draft: false,
        mergeable: true,
        mergeableState: 'clean',
        reviewDecision: 'review_required',
        checks: 'success',
      },
    },
  ],
  pendingBackMerges: [],
  jenkinsServices: ['accounts'],
  fetchedAt: '2026-07-13T12:01:00Z',
}

afterEach(() => vi.restoreAllMocks())

describe('ServiceOperations', () => {
  it('shows tag build status and repository-specific branch journey', async () => {
    vi.spyOn(api, 'repositoryState').mockResolvedValue(repositoryState)
    render(<ServiceOperations repository="Orange-Health/service-api" />)

    expect(await screen.findByText('v-qa-v26.0713.2')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Build service ↗')).toHaveAttribute(
      'href',
      'https://github.test/run/2',
    )
    expect(screen.getByText('Default ·')).toHaveTextContent('master')
    expect(screen.getByRole('link', { name: 'Live in S1' })).toHaveAttribute(
      'href',
      'https://jenkins.test/job/DEV/job/DEV%20Deployer/2152/',
    )
    expect(
      screen.getByRole('button', { name: 'Merge to master' }),
    ).toBeEnabled()
    const deployButtons = screen.getAllByRole('button', { name: 'Deploy' })
    expect(deployButtons[0]).toBeDisabled()
    expect(deployButtons[1]).toBeEnabled()
  })

  it('creates a missing promotion PR and merges an eligible existing PR', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'repositoryState').mockResolvedValue(repositoryState)
    const create = vi
      .spyOn(api, 'createPromotionPullRequest')
      .mockResolvedValue(repositoryState.promotionSteps[1].pullRequest!)
    const merge = vi
      .spyOn(api, 'mergePromotionPullRequest')
      .mockResolvedValue({ merged: true, message: 'Merged' })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ServiceOperations repository="Orange-Health/service-api" />)

    await user.click(await screen.findByRole('button', { name: 'Create PR' }))
    expect(create).toHaveBeenCalledWith({
      repository: 'Orange-Health/service-api',
      route: 'dev-to-release',
    })

    await user.click(screen.getByRole('button', { name: 'Merge to master' }))
    expect(merge).toHaveBeenCalledWith({
      repository: 'Orange-Health/service-api',
      pullNumber: 42,
    })
  })

  it('shows an in-app notification when a build completes', async () => {
    const completedState: RepositoryReleaseState = {
      ...repositoryState,
      stagingReleases: repositoryState.stagingReleases.map((release, index) =>
        index === 0 ? { ...release, buildStatus: 'succeeded' } : release,
      ),
    }
    vi.spyOn(api, 'repositoryState')
      .mockResolvedValueOnce(repositoryState)
      .mockResolvedValue(completedState)
    render(<ServiceOperations repository="Orange-Health/service-api" />)
    await screen.findByText('v-qa-v26.0713.2')

    act(() => {
      window.dispatchEvent(
        new CustomEvent('service-refresh-requested', {
          detail: { repository: 'Orange-Health/service-api' },
        }),
      )
    })

    expect(
      await screen.findByText('v-qa-v26.0713.2 succeeded'),
    ).toBeVisible()
  })

  it('temporarily allows production deployment while branches differ', async () => {
    vi.spyOn(api, 'repositoryState').mockResolvedValue({
      ...repositoryState,
      productionReady: false,
    })
    render(
      <ServiceOperations
        repository="Orange-Health/service-api"
        productionEnabled
      />,
    )

    expect(
      await screen.findByRole('button', { name: 'Deploy production' }),
    ).toBeEnabled()
  })

  it('opens production deployment when the branches are identical', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'repositoryState').mockResolvedValue(repositoryState)
    render(
      <ServiceOperations
        repository="Orange-Health/service-api"
        productionEnabled
      />,
    )

    await user.click(
      await screen.findByRole('button', { name: 'Deploy production' }),
    )

    expect(
      screen.getByRole('dialog', { name: 'Deploy to production' }),
    ).toBeVisible()
  })
})
