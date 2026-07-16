import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../shared/api'
import type {
  PromotionStep,
  ReleaseDashboard,
  RepositoryReleaseState,
} from '../../shared/types'
import { ReleaseDayOperations } from './ReleaseDayOperations'

const repository = 'Orange-Health/service-api'
const dashboard: ReleaseDashboard = {
  version: {
    id: 'release-1',
    name: 'OH Release 26.0716',
    releaseDate: '2026-07-16',
    overdue: false,
    issueCount: 1,
  },
  services: [
    {
      repository,
      items: [],
      eligibleCount: 0,
      blockedCount: 0,
      mergedCount: 1,
      backMergePending: false,
    },
  ],
  unmatched: [],
  warnings: [],
  fetchedAt: '2026-07-16T08:00:00Z',
  cached: false,
}

function promotionStep(
  route: PromotionStep['route'],
  state: PromotionStep['state'],
): PromotionStep {
  const devRoute = route === 'dev-to-release'
  return {
    route,
    fromBranch: devRoute ? 'dev' : 'release',
    toBranch: devRoute ? 'release' : 'main',
    commitsAhead: state === 'up_to_date' ? 0 : 1,
    commitsBehind: 0,
    state,
    pullRequest:
      state === 'pr_open'
        ? {
            number: devRoute ? 12 : 13,
            title: devRoute ? 'Promote dev to release' : 'Promote release to main',
            url: `https://github.test/pull/${devRoute ? 12 : 13}`,
            baseBranch: devRoute ? 'release' : 'main',
            headBranch: devRoute ? 'dev' : 'release',
            draft: false,
            mergeable: true,
            mergeableState: 'clean',
            reviewDecision: 'approved',
            checks: 'success',
          }
        : undefined,
  }
}

function repositoryState(
  devState: PromotionStep['state'],
  defaultState: PromotionStep['state'],
  repositoryName = repository,
): RepositoryReleaseState {
  return {
    repository: repositoryName,
    defaultBranch: 'main',
    stagingReleases: [],
    productionReleases: [],
    deployedTags: [],
    deploymentLookupFailed: false,
    productionReady: defaultState === 'up_to_date',
    promotionSteps: [
      promotionStep('dev-to-release', devState),
      promotionStep('release-to-default', defaultState),
    ],
    backMergeSteps: [],
    pendingBackMerges: [],
    jenkinsServices: ['service-api'],
    fetchedAt: new Date().toISOString(),
  }
}

describe('ReleaseDayOperations', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => vi.restoreAllMocks())

  it('shows initial repository synchronization progress', async () => {
    let resolveState!: (state: RepositoryReleaseState) => void
    vi.spyOn(api, 'repositoryState').mockReturnValue(
      new Promise((resolve) => {
        resolveState = resolve
      }),
    )

    render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )

    expect(
      await screen.findByRole('button', { name: 'Syncing 0/1' }),
    ).toBeDisabled()
    expect(screen.getByText('Syncing')).toBeVisible()

    await act(async () => {
      resolveState(repositoryState('needs_pr', 'needs_pr'))
    })

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '↻ Refresh status' }),
      ).toBeEnabled(),
    )
    expect(screen.getByText('Synced')).toBeVisible()
  })

  it('logs existing PRs and unlocks the next phase only after merge', async () => {
    const user = userEvent.setup()
    let state = repositoryState('pr_open', 'needs_pr')
    vi.spyOn(api, 'repositoryState').mockImplementation(async () => state)
    vi.spyOn(api, 'mergePromotionPullRequest').mockImplementation(async () => {
      state = repositoryState('up_to_date', 'needs_pr')
      return { merged: true, message: 'Merged' }
    })
    vi.spyOn(api, 'refreshRepository').mockResolvedValue()

    render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )
    await screen.findByText('PR #12')

    expect(
      screen.getByRole('button', { name: 'Create PRs' }),
    ).toBeDisabled()
    const devMergeStep = screen
      .getByText('Merge Dev → Release PRs')
      .closest('article')
    expect(devMergeStep).not.toBeNull()
    await user.click(
      within(devMergeStep as HTMLElement).getByRole('button', {
        name: 'Merge ready PRs',
      }),
    )

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Create PRs' }),
      ).toBeEnabled(),
    )
    expect(screen.getByText('Result: merged PR #12 into release.')).toBeVisible()
    expect(api.refreshRepository).not.toHaveBeenCalled()
    expect(api.repositoryState).toHaveBeenCalledTimes(1)
  })

  it('creates PRs sequentially and patches state without full reconciliation', async () => {
    const user = userEvent.setup()
    const secondRepository = 'Orange-Health/service-web'
    const twoServiceDashboard: ReleaseDashboard = {
      ...dashboard,
      services: [
        dashboard.services[0],
        {
          ...dashboard.services[0],
          repository: secondRepository,
        },
      ],
    }
    let activeStateRequests = 0
    let maxActiveStateRequests = 0
    const repositoryStateRequest = vi
      .spyOn(api, 'repositoryState')
      .mockImplementation(async (repositoryName) => {
        activeStateRequests += 1
        maxActiveStateRequests = Math.max(
          maxActiveStateRequests,
          activeStateRequests,
        )
        await Promise.resolve()
        activeStateRequests -= 1
        return repositoryState('needs_pr', 'needs_pr', repositoryName)
      })
    let resolveFirst!: () => void
    const firstPending = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const creationOrder: string[] = []
    const create = vi
      .spyOn(api, 'createPromotionPullRequest')
      .mockImplementation(async ({ repository: repositoryName }) => {
        creationOrder.push(repositoryName)
        if (repositoryName === repository) await firstPending
        return {
          number: repositoryName === repository ? 21 : 22,
          title: 'Promote dev to release',
          url: `https://github.test/${repositoryName}/pull`,
          baseBranch: 'release',
          headBranch: 'dev',
          draft: false,
          mergeable: true,
          mergeableState: 'clean',
          reviewDecision: 'approved',
          checks: 'success',
        }
      })

    render(
      <ReleaseDayOperations
        dashboard={twoServiceDashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(repositoryStateRequest).toHaveBeenCalledTimes(2))
    expect(
      screen.getAllByText('Checking repository promotion and release state.'),
    ).toHaveLength(2)
    const createStep = screen
      .getByText('Create Dev → Release PRs')
      .closest('article')
    expect(createStep).not.toBeNull()
    await user.click(
      within(createStep as HTMLElement).getByRole('button', {
        name: 'Create PRs',
      }),
    )

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(creationOrder).toEqual([repository])
    expect(maxActiveStateRequests).toBe(1)
    expect(screen.getByText('Creating PR')).toBeVisible()
    expect(
      screen.getByText(
        'Discovery: no open dev → release PR in loaded state.',
      ),
    ).toBeVisible()
    expect(
      screen.getByText('Attempting Dev → Release PR creation (1/2).'),
    ).toBeVisible()

    resolveFirst()
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(creationOrder).toEqual([repository, secondRepository])
    await waitFor(() =>
      expect(
        screen.getByText('Attempting Dev → Release PR creation (2/2).'),
      ).toBeVisible(),
    )
    expect(screen.getByText('GitHub created PR #21.')).toBeVisible()
    expect(screen.getByText('GitHub created PR #22.')).toBeVisible()
    expect(repositoryStateRequest).toHaveBeenCalledTimes(2)
  })

  it('creates an idempotent production release and unlocks deploy after success', async () => {
    const user = userEvent.setup()
    let state = repositoryState('up_to_date', 'up_to_date')
    const created = {
      id: 91,
      repository,
      tag: 'v-26.0716.1',
      sourceBranch: 'release',
      url: 'https://github.test/releases/91',
      createdAt: '2026-07-16T08:05:00Z',
    }
    vi.spyOn(api, 'repositoryState').mockImplementation(async () => state)
    const createRelease = vi
      .spyOn(api, 'createProductionRelease')
      .mockImplementation(async () => {
        state = {
          ...state,
          productionReleases: [
            {
              id: created.id,
              tag: created.tag,
              url: created.url,
              createdAt: created.createdAt,
              buildStatus: 'succeeded',
              runs: [],
            },
          ],
        }
        return created
      })

    render(
      <ReleaseDayOperations
        dashboard={dashboard}
        productionEnabled={true}
        onClose={vi.fn()}
      />,
    )
    await screen.findAllByText('Merged')
    await user.click(
      screen.getByRole('button', { name: 'Create releases' }),
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled(),
    )
    expect(createRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        repository,
        date: '2026-07-16',
        operationId: expect.any(String),
      }),
    )
    expect(
      screen.getByRole('link', { name: new RegExp(created.tag) }),
    ).toBeVisible()
  })
})
