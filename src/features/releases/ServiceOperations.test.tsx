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
  backMergeSteps: [
    {
      route: 'default-to-release',
      fromBranch: 'master',
      toBranch: 'release',
      commitsAhead: 2,
      commitsBehind: 0,
      state: 'needs_pr',
    },
    {
      route: 'release-to-dev',
      fromBranch: 'release',
      toBranch: 'dev',
      commitsAhead: 0,
      commitsBehind: 0,
      state: 'up_to_date',
    },
  ],
  pendingBackMerges: [],
  jenkinsServices: ['accounts'],
  fetchedAt: '2026-07-13T12:01:00Z',
}

afterEach(() => vi.restoreAllMocks())

describe('ServiceOperations', () => {
  it('shows loading states while branch data is being resolved', () => {
    vi.spyOn(api, 'repositoryState').mockReturnValue(new Promise(() => {}))
    render(<ServiceOperations repository="Orange-Health/service-api" />)

    expect(
      screen.getByText(/Checking dev, release, and default branches/),
    ).toBeVisible()
    expect(
      screen.getByText(/Loading Dev → Release → Default journey/),
    ).toBeVisible()
  })

  it('shows tag build status and repository-specific branch journey', async () => {
    vi.spyOn(api, 'repositoryState').mockResolvedValue(repositoryState)
    render(<ServiceOperations repository="Orange-Health/service-api" />)

    expect(await screen.findByText('v-qa-v26.0713.2')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Build service ↗')).toHaveAttribute(
      'href',
      'https://github.test/run/2',
    )
    expect(screen.getAllByText('Default ·')).toHaveLength(2)
    expect(screen.getAllByText('Default ·')[0]).toHaveTextContent('master')
    expect(screen.getByRole('link', { name: 'Live in S1' })).toHaveAttribute(
      'href',
      'https://jenkins.test/job/DEV/job/DEV%20Deployer/2152/',
    )
    expect(
      screen.getByRole('button', { name: 'Merge to master' }),
    ).toBeEnabled()
    expect(screen.getByRole('link', { name: 'View diff ↗' })).toHaveAttribute(
      'href',
      'https://github.com/Orange-Health/service-api/compare/release...dev',
    )
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

  it('polls only active build status without reloading repository state', async () => {
    const stateRequest = vi
      .spyOn(api, 'repositoryState')
      .mockResolvedValue(repositoryState)
    const buildStatusRequest = vi
      .spyOn(api, 'releaseBuildStatuses')
      .mockResolvedValue([
        {
          repository: 'Orange-Health/service-api',
          tag: 'v-qa-v26.0713.2',
          createdAt: '2026-07-13T12:00:00Z',
          buildStatus: 'succeeded',
          runs: [
            {
              id: 2,
              name: 'Build service',
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.test/run/2',
              startedAt: '2026-07-13T12:00:10Z',
              updatedAt: '2026-07-13T12:02:00Z',
            },
          ],
        },
      ])
    render(<ServiceOperations repository="Orange-Health/service-api" />)
    await screen.findByText('v-qa-v26.0713.2')

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(buildStatusRequest).toHaveBeenCalledWith([
      {
        repository: 'Orange-Health/service-api',
        tag: 'v-qa-v26.0713.2',
        createdAt: '2026-07-13T12:00:00Z',
      },
    ])
    expect(stateRequest).toHaveBeenCalledTimes(1)
    expect((await screen.findAllByText('Succeeded')).length).toBeGreaterThan(1)
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

  it('highlights outdated branches and merges an existing back-merge PR', async () => {
    const user = userEvent.setup()
    const merge = vi
      .spyOn(api, 'mergeBackMergePullRequest')
      .mockResolvedValue({ merged: true, message: 'Merged' })
    vi.spyOn(api, 'repositoryState').mockResolvedValue({
      ...repositoryState,
      backMergeSteps: [
        repositoryState.backMergeSteps[0],
        {
          route: 'release-to-dev',
          fromBranch: 'release',
          toBranch: 'dev',
          commitsAhead: 3,
          commitsBehind: 0,
          state: 'pr_open',
          pullRequest: {
            number: 43,
            title: 'Back-merge release into dev',
            url: 'https://github.test/pull/43',
            baseBranch: 'dev',
            headBranch: 'release',
            draft: false,
            mergeable: true,
            mergeableState: 'blocked',
            reviewDecision: 'review_required',
            checks: 'failure',
          },
        },
      ],
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ServiceOperations repository="Orange-Health/service-api" />)

    expect(await screen.findByText('release is 2 commits behind')).toBeVisible()
    expect(
      screen.getByRole('link', {
        name: /PR #43 · Back-merge release into dev/,
      }),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Merge to dev' }))

    expect(merge).toHaveBeenCalledWith({
      repository: 'Orange-Health/service-api',
      pullNumber: 43,
    })
  })

  it('creates a missing back-merge PR and switches to its details', async () => {
    const user = userEvent.setup()
    const createdPull = {
      number: 44,
      title: 'Back-merge master into release',
      url: 'https://github.test/pull/44',
      baseBranch: 'release',
      headBranch: 'master',
      draft: false,
      mergeable: true,
      mergeableState: 'clean',
      reviewDecision: 'review_required' as const,
      checks: 'success' as const,
    }
    const repositoryStateRequest = vi
      .spyOn(api, 'repositoryState')
      .mockResolvedValueOnce(repositoryState)
      .mockResolvedValue({
        ...repositoryState,
        backMergeSteps: [
          {
            ...repositoryState.backMergeSteps[0],
            state: 'pr_open',
            pullRequest: createdPull,
          },
          repositoryState.backMergeSteps[1],
        ],
      })
    const create = vi
      .spyOn(api, 'createBackMergePullRequest')
      .mockResolvedValue(createdPull)
    render(<ServiceOperations repository="Orange-Health/service-api" />)

    await user.click(
      await screen.findByRole('button', { name: 'Create back-merge PR' }),
    )

    expect(create).toHaveBeenCalledWith({
      repository: 'Orange-Health/service-api',
      route: 'default-to-release',
    })
    expect(
      await screen.findByRole('link', {
        name: /PR #44 · Back-merge master into release/,
      }),
    ).toHaveAttribute('href', 'https://github.test/pull/44')
    expect(repositoryStateRequest).toHaveBeenCalledTimes(2)
  })
})
