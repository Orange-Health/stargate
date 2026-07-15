import { render, screen, waitFor, within } from '@testing-library/react'
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
): RepositoryReleaseState {
  return {
    repository,
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
    expect(screen.getByText('Merged PR #12.')).toBeVisible()
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
