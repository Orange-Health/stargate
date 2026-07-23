import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ConnectionConfig,
  WorkflowRun,
} from '../../src/shared/types.js'
import {
  aggregateBuildStatus,
  backMergeBranches,
  clearRepositoryCaches,
  comparisonHasAnyFileChanges,
  comparisonHasSourceFileChanges,
  getReleaseBuildStatuses,
  getRepositoryReleaseState,
  hasActualMergeConflict,
  mergeBackMergePullRequest,
  mergeFeaturePullRequest,
  promotionBranches,
  releaseTimestamp,
  sortReleasesNewestFirst,
} from './githubOperations.js'

afterEach(() => vi.unstubAllGlobals())

function run(
  status: string,
  conclusion?: string,
): WorkflowRun {
  return {
    id: Math.random(),
    name: 'Build image',
    status,
    conclusion,
    url: 'https://github.test/run',
    startedAt: '2026-07-13T12:00:00Z',
    updatedAt: '2026-07-13T12:01:00Z',
  }
}

describe('aggregateBuildStatus', () => {
  it('reports starting while GitHub has not created a run', () => {
    expect(aggregateBuildStatus([])).toBe('starting')
    expect(aggregateBuildStatus([run('queued')])).toBe('starting')
  })

  it('reports running when any workflow is in progress', () => {
    expect(
      aggregateBuildStatus([
        run('completed', 'success'),
        run('in_progress'),
      ]),
    ).toBe('running')
  })

  it('fails the release when any workflow fails', () => {
    expect(
      aggregateBuildStatus([
        run('completed', 'success'),
        run('completed', 'failure'),
      ]),
    ).toBe('failed')
  })

  it('reports canceled when a workflow is canceled without a failure', () => {
    expect(
      aggregateBuildStatus([
        run('completed', 'success'),
        run('completed', 'cancelled'),
      ]),
    ).toBe('canceled')
  })

  it('succeeds only after all workflows complete successfully', () => {
    expect(
      aggregateBuildStatus([
        run('completed', 'success'),
        run('completed', 'skipped'),
      ]),
    ).toBe('succeeded')
  })
})

describe('promotionBranches', () => {
  it('uses release as the intermediate branch', () => {
    expect(promotionBranches('dev-to-release', 'main')).toEqual({
      fromBranch: 'dev',
      toBranch: 'release',
    })
  })

  it('uses each repository default branch for final promotion', () => {
    expect(promotionBranches('release-to-default', 'master')).toEqual({
      fromBranch: 'release',
      toBranch: 'master',
    })
  })
})

describe('backMergeBranches', () => {
  it('uses the repository default branch when syncing release', () => {
    expect(backMergeBranches('default-to-release', 'master')).toEqual({
      fromBranch: 'master',
      toBranch: 'release',
    })
  })

  it('syncs release changes back to dev', () => {
    expect(backMergeBranches('release-to-dev', 'main')).toEqual({
      fromBranch: 'release',
      toBranch: 'dev',
    })
  })
})

describe('branch comparison content checks', () => {
  it('ignores commits that produce no file changes', () => {
    const comparison = { ahead_by: 1, behind_by: 0, files: [] }

    expect(comparisonHasSourceFileChanges(comparison)).toBe(false)
    expect(comparisonHasAnyFileChanges(comparison)).toBe(false)
  })

  it('detects file changes even when merge history has also diverged', () => {
    const comparison = {
      ahead_by: 2,
      behind_by: 1,
      files: [{ filename: 'src/index.ts' }],
    }

    expect(comparisonHasSourceFileChanges(comparison)).toBe(true)
    expect(comparisonHasAnyFileChanges(comparison)).toBe(true)
  })
})

describe('merge conflict classification', () => {
  it('does not treat bypassable branch protection as a conflict', () => {
    expect(hasActualMergeConflict(true, 'blocked')).toBe(false)
  })

  it('detects actual Git merge conflicts', () => {
    expect(hasActualMergeConflict(false, 'dirty')).toBe(true)
  })
})

describe('back-merge PR merging', () => {
  it('always requests a merge commit instead of a squash merge', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/repos/Orange-Health/service-api')) {
        return new Response(JSON.stringify({ default_branch: 'main' }), {
          status: 200,
        })
      }
      if (url.endsWith('/pulls/42')) {
        return new Response(
          JSON.stringify({
            number: 42,
            title: 'Back-merge main to release',
            body: null,
            html_url: 'https://github.test/pull/42',
            draft: false,
            merged_at: null,
            mergeable: true,
            mergeable_state: 'clean',
            base: { ref: 'release' },
            head: { ref: 'main', sha: 'abc123' },
          }),
          { status: 200 },
        )
      }
      if (url.includes('/reviews?')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/check-runs?')) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 })
      }
      if (url.endsWith('/pulls/42/merge')) {
        expect(init?.method).toBe('PUT')
        expect(JSON.parse(String(init?.body))).toEqual({
          merge_method: 'merge',
        })
        return new Response(
          JSON.stringify({ merged: true, message: 'Pull Request successfully merged' }),
          { status: 200 },
        )
      }
      throw new Error(`Unexpected GitHub request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const config: ConnectionConfig = {
      jiraSite: 'https://jira.test',
      jiraEmail: 'rm@test.com',
      jiraToken: 'jira',
      githubOrg: 'Orange-Health',
      githubToken: 'github',
      jenkinsUrl: 'https://jenkins.test',
      jenkinsUsername: 'rm',
      jenkinsToken: 'jenkins',
    }

    await expect(
      mergeBackMergePullRequest(config, 'Orange-Health/service-api', 42),
    ).resolves.toMatchObject({ merged: true })
  })
})

describe('feature PR force merge', () => {
  const config: ConnectionConfig = {
    jiraSite: 'https://jira.test',
    jiraEmail: 'rm@test.com',
    jiraToken: 'jira',
    githubOrg: 'Orange-Health',
    githubToken: 'github',
    jenkinsUrl: 'https://jenkins.test',
    jenkinsUsername: 'rm',
    jenkinsToken: 'jenkins',
  }

  function featurePullFixture(overrides: Record<string, unknown> = {}) {
    return {
      number: 8,
      node_id: 'PR_kwDOForceMerge',
      title: 'OH-123 Ship it',
      body: null,
      html_url: 'https://github.test/pull/8',
      draft: false,
      merged_at: null,
      mergeable: true,
      mergeable_state: 'blocked',
      base: { ref: 'dev' },
      head: { ref: 'feature/OH-123', sha: 'abc123' },
      ...overrides,
    }
  }

  function mockFeatureMergeApis(options: {
    pull?: Record<string, unknown>
    reviews?: unknown[]
    checkRuns?: unknown[]
    onGraphql?: (body: unknown) => void
    onRestMerge?: () => void
  }) {
    const pull = featurePullFixture(options.pull)
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/repos/Orange-Health/service-api')) {
        return new Response(JSON.stringify({ default_branch: 'main' }), {
          status: 200,
        })
      }
      if (url.includes('/pulls?')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/compare/')) {
        return new Response(
          JSON.stringify({ ahead_by: 0, behind_by: 0, files: [] }),
          { status: 200 },
        )
      }
      if (url.endsWith('/pulls/8')) {
        return new Response(JSON.stringify(pull), { status: 200 })
      }
      if (url.includes('/reviews?')) {
        return new Response(JSON.stringify(options.reviews ?? []), {
          status: 200,
        })
      }
      if (url.includes('/check-runs?')) {
        return new Response(
          JSON.stringify({
            check_runs: options.checkRuns ?? [
              { status: 'in_progress', conclusion: null },
            ],
          }),
          { status: 200 },
        )
      }
      if (url === 'https://api.github.com/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        options.onGraphql?.(body)
        return new Response(
          JSON.stringify({
            data: {
              mergePullRequest: {
                pullRequest: {
                  merged: true,
                  mergeCommit: { oid: 'deadbeef' },
                },
              },
            },
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/pulls/8/merge')) {
        options.onRestMerge?.()
        return new Response(
          JSON.stringify({ merged: true, message: 'merged' }),
          { status: 200 },
        )
      }
      throw new Error(`Unexpected GitHub request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('force merges via GraphQL without requiring approval or completed checks', async () => {
    let graphqlBody: unknown
    mockFeatureMergeApis({
      onGraphql: (body) => {
        graphqlBody = body
      },
    })

    await expect(
      mergeFeaturePullRequest(config, 'Orange-Health/service-api', 8, true),
    ).resolves.toMatchObject({
      merged: true,
      sha: 'deadbeef',
      message: 'Force-merged with branch protection bypass.',
    })

    expect(graphqlBody).toMatchObject({
      variables: {
        input: {
          pullRequestId: 'PR_kwDOForceMerge',
          mergeMethod: 'MERGE',
        },
      },
    })
  })

  it('rejects force merge when the PR has real conflicts', async () => {
    mockFeatureMergeApis({
      pull: { mergeable: false, mergeable_state: 'dirty' },
    })

    await expect(
      mergeFeaturePullRequest(config, 'Orange-Health/service-api', 8, true),
    ).rejects.toMatchObject({ code: 'FEATURE_PR_NOT_MERGEABLE' })
  })

  it('still requires approval on the normal merge path', async () => {
    let restMergeCalled = false
    mockFeatureMergeApis({
      onRestMerge: () => {
        restMergeCalled = true
      },
    })

    await expect(
      mergeFeaturePullRequest(config, 'Orange-Health/service-api', 8, false),
    ).rejects.toMatchObject({ code: 'FEATURE_PR_NOT_APPROVED' })
    expect(restMergeCalled).toBe(false)
  })
})

describe('release ordering', () => {
  it('sorts by publication time and uses it for display', () => {
    const older = {
      tag: 'v-s2-v26.0715.1',
      created_at: '2026-07-15T10:00:00Z',
      published_at: '2026-07-15T10:00:00Z',
    }
    const newlyPublished = {
      tag: 'v-qa-v26.0716.1',
      created_at: '2026-07-15T08:00:00Z',
      published_at: '2026-07-16T06:00:00Z',
    }

    expect(sortReleasesNewestFirst([older, newlyPublished])).toEqual([
      newlyPublished,
      older,
    ])
    expect(releaseTimestamp(newlyPublished)).toBe('2026-07-16T06:00:00Z')
  })

  it('falls back to creation time when publication time is unavailable', () => {
    expect(releaseTimestamp({ created_at: '2026-07-16T06:00:00Z' })).toBe(
      '2026-07-16T06:00:00Z',
    )
  })
})

describe('repository state cache', () => {
  it('coalesces reads and treats history-only differences as up to date', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/repos/Orange-Health/service-api')) {
        return new Response(
          JSON.stringify({
            full_name: 'Orange-Health/service-api',
            default_branch: 'main',
          }),
          { status: 200 },
        )
      }
      if (url.includes('/releases?')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/compare/')) {
        return new Response(
          JSON.stringify({ ahead_by: 1, behind_by: 0, files: [] }),
          { status: 200 },
        )
      }
      if (url.includes('/pulls?')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      throw new Error(`Unexpected GitHub request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const config: ConnectionConfig = {
      jiraSite: 'https://jira.test',
      jiraEmail: 'rm@test.com',
      jiraToken: 'jira',
      githubOrg: 'Orange-Health',
      githubToken: 'github',
      jenkinsUrl: 'https://jenkins.test',
      jenkinsUsername: 'rm',
      jenkinsToken: 'jenkins',
    }
    clearRepositoryCaches(config, 'Orange-Health/service-api')

    const [first, second] = await Promise.all([
      getRepositoryReleaseState(config, 'Orange-Health/service-api'),
      getRepositoryReleaseState(config, 'Orange-Health/service-api'),
    ])

    expect(first).toBe(second)
    expect(first.productionReady).toBe(true)
    expect(
      [...first.promotionSteps, ...first.backMergeSteps].every(
        (step) => step.state === 'up_to_date' && step.filesChanged === 0,
      ),
    ).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(12)
    clearRepositoryCaches(config, 'Orange-Health/service-api')
  })
})

describe('release build status polling', () => {
  it('fetches only workflow runs for the requested active tag', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 7,
              name: 'Build image',
              event: 'release',
              head_branch: 'v-26.0715.1',
              status: 'completed',
              conclusion: 'success',
              html_url: 'https://github.test/actions/7',
              run_started_at: '2026-07-15T09:00:00Z',
              updated_at: '2026-07-15T09:02:00Z',
            },
          ],
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const config: ConnectionConfig = {
      jiraSite: 'https://jira.test',
      jiraEmail: 'rm@test.com',
      jiraToken: 'jira',
      githubOrg: 'Orange-Health',
      githubToken: 'github',
      jenkinsUrl: 'https://jenkins.test',
      jenkinsUsername: 'rm',
      jenkinsToken: 'jenkins',
    }

    const [result] = await getReleaseBuildStatuses(config, [
      {
        repository: 'Orange-Health/service-api',
        tag: 'v-26.0715.1',
        createdAt: '2026-07-15T08:59:00Z',
      },
    ])

    expect(result.buildStatus).toBe('succeeded')
    expect(result.runs).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/actions/runs?branch=v-26.0715.1',
    )
    const [cached] = await getReleaseBuildStatuses(config, [
      {
        repository: 'Orange-Health/service-api',
        tag: 'v-26.0715.1',
        createdAt: '2026-07-15T08:59:00Z',
      },
    ])
    expect(cached).toEqual(result)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [refreshed] = await getReleaseBuildStatuses(
      config,
      [
        {
          repository: 'Orange-Health/service-api',
          tag: 'v-26.0715.1',
          createdAt: '2026-07-15T08:59:00Z',
        },
      ],
      true,
    )
    expect(refreshed).toEqual(result)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    clearRepositoryCaches(
      config,
      'Orange-Health/service-api',
      [],
      true,
    )
  })
})
