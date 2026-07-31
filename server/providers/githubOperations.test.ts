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
  getReleaseControlRoomState,
  getReleaseControlRoomStatesBatch,
  getRepositoryReleaseHistory,
  getRepositoryReleaseState,
  hasActualMergeConflict,
  listRepositoryPullRequestAuthors,
  listRepositoryPullRequests,
  mergeBackMergePullRequest,
  mergeFeaturePullRequest,
  mergePromotionPullRequest,
  mergeRepositoryPullRequest,
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

describe('repository pull requests', () => {
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

  it('lists five recent pull requests and reports another page', async () => {
    const pulls = Array.from({ length: 5 }, (_, index) => ({
      number: index + 1,
      node_id: `PR_${index + 1}`,
      title: `Pull ${index + 1}`,
      body: null,
      html_url: `https://github.test/pull/${index + 1}`,
      draft: false,
      state: 'open',
      merged_at: null,
      mergeable: true,
      mergeable_state: 'clean',
      updated_at: '2026-07-27T10:00:00Z',
      user: { login: 'developer' },
      base: { ref: 'dev' },
      head: {
        ref: `feature/${index + 1}`,
        sha: `sha-${index + 1}`,
        repo: { full_name: 'Orange-Health/recent-service' },
      },
    }))
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            full_name: 'Orange-Health/recent-service',
            default_branch: 'main',
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(pulls)))
    vi.stubGlobal('fetch', fetchMock)

    const result = await listRepositoryPullRequests(
      config,
      'Orange-Health/recent-service',
      { state: 'open', base: 'dev', page: 2 },
    )

    expect(result.items).toHaveLength(5)
    expect(result.hasMore).toBe(true)
    expect(result.page).toBe(2)
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      'state=open&sort=updated&direction=desc&per_page=5&page=2&base=dev',
    )
  })

  it('merges an open non-draft pull request', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 9,
            state: 'open',
            draft: false,
            merged_at: null,
            mergeable: true,
            head: { ref: 'feature/OH-9' },
            base: { ref: 'dev' },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ merged: true, message: 'Merged', sha: 'abc' }),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await mergeRepositoryPullRequest(
      config,
      'Orange-Health/recent-service',
      9,
    )

    expect(result.merged).toBe(true)
    expect(fetchMock.mock.calls[1][1]?.method).toBe('PUT')
  })

  it('lists unique recent pull request authors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          { user: { login: 'zoe' } },
          { user: { login: 'alex' } },
          { user: { login: 'zoe' } },
        ]),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const authors = await listRepositoryPullRequestAuthors(
      config,
      'Orange-Health/author-service',
    )

    expect(authors).toEqual(['alex', 'zoe'])
  })

  it('searches pull requests by author', async () => {
    const pull = {
      number: 8,
      title: 'Authored pull',
      html_url: 'https://github.test/pull/8',
      draft: false,
      state: 'open',
      merged_at: null,
      updated_at: '2026-07-27T10:00:00Z',
      user: { login: 'developer' },
      base: { ref: 'dev' },
      head: { ref: 'feature/OH-8' },
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'main' })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total_count: 1, items: [{ number: 8 }] })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(pull)))
    vi.stubGlobal('fetch', fetchMock)

    const result = await listRepositoryPullRequests(
      config,
      'Orange-Health/recent-service',
      { state: 'open', author: 'developer', page: 1 },
    )

    expect(result.items[0]?.author).toBe('developer')
    expect(decodeURIComponent(String(fetchMock.mock.calls[1][0]))).toContain(
      'author:developer',
    )
  })
})

describe('all-services release builds', () => {
  it('includes every GitHub release whose tag starts with v-', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input)
        if (url.includes('/releases?')) {
          return new Response(
            JSON.stringify([
              {
                id: 1,
                tag_name: 'v-feature-OH-42',
                html_url: 'https://github.test/releases/1',
                prerelease: false,
                created_at: '2026-07-28T10:00:00Z',
              },
              {
                id: 2,
                tag_name: 'build-without-prefix',
                html_url: 'https://github.test/releases/2',
                prerelease: true,
                created_at: '2026-07-28T09:00:00Z',
              },
            ]),
          )
        }
        if (url.includes('/actions/runs?')) {
          return new Response(JSON.stringify({ workflow_runs: [] }))
        }
        throw new Error(`Unexpected GitHub request: ${url}`)
      }),
    )
    const history = await getRepositoryReleaseHistory(
      {
        jiraSite: 'https://jira.test',
        jiraEmail: 'rm@test.com',
        jiraToken: 'jira',
        githubOrg: 'Orange-Health',
        githubToken: 'github',
        jenkinsUrl: 'https://jenkins.test',
        jenkinsUsername: 'rm',
        jenkinsToken: 'jenkins',
      },
      'Orange-Health/all-release-builds',
      true,
    )

    expect(history.stagingReleases).toHaveLength(1)
    expect(history.stagingReleases[0]).toMatchObject({
      tag: 'v-feature-OH-42',
      environment: 'custom',
    })
  })

  it('includes v- tags found only in GitHub Actions runs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input)
        if (url.includes('/releases?')) {
          return new Response(JSON.stringify([]))
        }
        if (url.includes('/actions/runs?')) {
          return new Response(
            JSON.stringify({
              workflow_runs: [
                {
                  id: 44,
                  name: 'Sapphire build',
                  event: 'push',
                  head_branch: 'v-qa-citrus-4',
                  status: 'in_progress',
                  conclusion: null,
                  html_url: 'https://github.test/actions/runs/44',
                  run_started_at: '2026-07-28T10:00:00Z',
                  updated_at: '2026-07-28T10:01:00Z',
                },
                {
                  id: 45,
                  name: 'Sapphire web production build',
                  event: 'push',
                  head_branch: 'v-prod-26.0728.1',
                  status: 'in_progress',
                  conclusion: null,
                  html_url: 'https://github.test/actions/runs/45',
                  run_started_at: '2026-07-28T10:02:00Z',
                  updated_at: '2026-07-28T10:03:00Z',
                },
              ],
            }),
          )
        }
        throw new Error(`Unexpected GitHub request: ${url}`)
      }),
    )

    const history = await getRepositoryReleaseHistory(
      {
        jiraSite: 'https://jira.test',
        jiraEmail: 'rm@test.com',
        jiraToken: 'jira',
        githubOrg: 'Orange-Health',
        githubToken: 'github',
        jenkinsUrl: 'https://jenkins.test',
        jenkinsUsername: 'rm',
        jenkinsToken: 'jenkins',
      },
      'Orange-Health/sapphire',
      true,
    )

    expect(history.stagingReleases[0]).toMatchObject({
      tag: 'v-qa-citrus-4',
      environment: 'custom',
      buildStatus: 'running',
      url: 'https://github.test/actions/runs/44',
    })
    expect(history.productionReleases[0]).toMatchObject({
      tag: 'v-prod-26.0728.1',
      buildStatus: 'running',
      url: 'https://github.test/actions/runs/45',
    })
  })
})

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

  it('force merges via GraphQL when bypassing branch protection', async () => {
    let graphqlCalled = false
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
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
            node_id: 'PR_kwDOBackForce',
            title: 'Back-merge main to release',
            body: null,
            html_url: 'https://github.test/pull/42',
            draft: false,
            merged_at: null,
            mergeable: true,
            mergeable_state: 'blocked',
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
        return new Response(
          JSON.stringify({
            check_runs: [{ status: 'in_progress', conclusion: null }],
          }),
          { status: 200 },
        )
      }
      if (url === 'https://api.github.com/graphql') {
        graphqlCalled = true
        return new Response(
          JSON.stringify({
            data: {
              mergePullRequest: {
                pullRequest: {
                  merged: true,
                  mergeCommit: { oid: 'backforce' },
                },
              },
            },
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/pulls/42/merge')) {
        throw new Error('REST merge should not be used for force merge')
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
      mergeBackMergePullRequest(config, 'Orange-Health/service-api', 42, true),
    ).resolves.toMatchObject({
      merged: true,
      message: 'Force-merged with branch protection bypass.',
      sha: 'backforce',
    })
    expect(graphqlCalled).toBe(true)
  })
})

describe('promotion PR force merge', () => {
  it('force merges via GraphQL when bypassing branch protection', async () => {
    let graphqlCalled = false
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
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
      if (url.endsWith('/pulls/55')) {
        return new Response(
          JSON.stringify({
            number: 55,
            node_id: 'PR_kwDOPromoForce',
            title: 'Promote release to main',
            body: null,
            html_url: 'https://github.test/pull/55',
            draft: false,
            merged_at: null,
            mergeable: true,
            mergeable_state: 'blocked',
            base: { ref: 'main' },
            head: { ref: 'release', sha: 'def456' },
          }),
          { status: 200 },
        )
      }
      if (url.includes('/reviews?')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/check-runs?')) {
        return new Response(
          JSON.stringify({
            check_runs: [{ status: 'in_progress', conclusion: null }],
          }),
          { status: 200 },
        )
      }
      if (url === 'https://api.github.com/graphql') {
        graphqlCalled = true
        return new Response(
          JSON.stringify({
            data: {
              mergePullRequest: {
                pullRequest: {
                  merged: true,
                  mergeCommit: { oid: 'promoforce' },
                },
              },
            },
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/pulls/55/merge')) {
        throw new Error('REST merge should not be used for force merge')
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
      mergePromotionPullRequest(config, 'Orange-Health/service-api', 55, true),
    ).resolves.toMatchObject({
      merged: true,
      message: 'Force-merged with branch protection bypass.',
      sha: 'promoforce',
    })
    expect(graphqlCalled).toBe(true)
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
      mergeFeaturePullRequest(
        config,
        'Orange-Health/service-api',
        8,
        false,
        true,
      ),
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
      mergeFeaturePullRequest(
        config,
        'Orange-Health/service-api',
        8,
        false,
        true,
      ),
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
      tag: 'v-s2-26.0715.1',
      created_at: '2026-07-15T10:00:00Z',
      published_at: '2026-07-15T10:00:00Z',
    }
    const newlyPublished = {
      tag: 'v-qa-26.0716.1',
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
  it('includes production tags found only in GitHub Actions', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/repos/Orange-Health/service-api')) {
        return new Response(
          JSON.stringify({
            full_name: 'Orange-Health/service-api',
            default_branch: 'main',
          }),
        )
      }
      if (url.includes('/releases?')) return new Response(JSON.stringify([]))
      if (url.includes('/actions/runs?')) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 94,
                name: 'Production build',
                event: 'push',
                head_branch: 'v26.0716.1',
                status: 'completed',
                conclusion: 'success',
                html_url: 'https://github.test/actions/runs/94',
                run_started_at: '2026-07-16T08:05:00Z',
                updated_at: '2026-07-16T08:10:00Z',
              },
            ],
          }),
        )
      }
      if (url.includes('/pulls?')) return new Response(JSON.stringify([]))
      if (url.includes('/compare/')) {
        return new Response(
          JSON.stringify({ ahead_by: 0, behind_by: 0, files: [] }),
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
    clearRepositoryCaches(config, 'Orange-Health/service-api')

    const state = await getReleaseControlRoomState(
      config,
      'Orange-Health/service-api',
    )

    expect(state.productionReleases[0]).toMatchObject({
      id: 94,
      tag: 'v26.0716.1',
      url: 'https://github.test/actions/runs/94',
      buildStatus: 'succeeded',
    })
    clearRepositoryCaches(config, 'Orange-Health/service-api')
  })

  it('loads the control room state within a six-request cold-sync budget', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/repos/Orange-Health/service-api')) {
        return new Response(
          JSON.stringify({
            full_name: 'Orange-Health/service-api',
            default_branch: 'main',
          }),
        )
      }
      if (url.includes('/releases?')) return new Response(JSON.stringify([]))
      if (url.includes('/actions/runs?')) {
        return new Response(JSON.stringify({ workflow_runs: [] }))
      }
      if (url.includes('/pulls?')) return new Response(JSON.stringify([]))
      if (url.includes('/compare/')) {
        return new Response(
          JSON.stringify({ ahead_by: 0, behind_by: 0, files: [] }),
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
    clearRepositoryCaches(config, 'Orange-Health/service-api')

    const [first, second] = await Promise.all([
      getReleaseControlRoomState(config, 'Orange-Health/service-api'),
      getReleaseControlRoomState(config, 'Orange-Health/service-api'),
    ])

    expect(first).toBe(second)
    expect(first.productionReady).toBe(true)
    expect(first.promotionSteps).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('state=closed'),
      ),
    ).toBe(false)
    clearRepositoryCaches(config, 'Orange-Health/service-api')
  })

  it('batches GraphQL state and falls back only a missing repository alias', async () => {
    const repositories = [
      'Orange-Health/service-api',
      'Orange-Health/service-web',
    ]
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url === 'https://api.github.com/graphql') {
        return new Response(
          JSON.stringify({
            data: {
              r0: {
                defaultBranchRef: { name: 'main' },
                releases: { nodes: [] },
                pullRequests: {
                  nodes: [
                    {
                      number: 42,
                      title: 'Promote dev to release',
                      body: null,
                      url: 'https://github.test/pull/42',
                      isDraft: false,
                      mergeable: 'MERGEABLE',
                      mergeStateStatus: 'CLEAN',
                      updatedAt: '2026-07-31T08:00:00Z',
                      baseRefName: 'release',
                      headRefName: 'dev',
                      headRefOid: 'abc123',
                      headRepository: {
                        nameWithOwner: repositories[0],
                      },
                      reviewDecision: 'APPROVED',
                      latestReviews: { nodes: [{ state: 'APPROVED' }] },
                      commits: {
                        nodes: [
                          {
                            commit: {
                              statusCheckRollup: { state: 'SUCCESS' },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
              r1: null,
            },
          }),
        )
      }
      if (url.endsWith('/repos/Orange-Health/service-web')) {
        return new Response(
          JSON.stringify({
            full_name: repositories[1],
            default_branch: 'main',
          }),
        )
      }
      if (url.includes('/releases?')) return new Response(JSON.stringify([]))
      if (url.includes('/actions/runs?')) {
        return new Response(JSON.stringify({ workflow_runs: [] }))
      }
      if (url.includes('/pulls?')) return new Response(JSON.stringify([]))
      if (url.includes('/compare/')) {
        return new Response(
          JSON.stringify(
            url.includes('/service-api/')
              ? { ahead_by: 1, behind_by: 0, files: [{}] }
              : { ahead_by: 0, behind_by: 0, files: [] },
          ),
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
    for (const repository of repositories) {
      clearRepositoryCaches(config, repository)
    }

    const result = await getReleaseControlRoomStatesBatch(config, repositories)

    expect(result.results.map((item) => item.state?.repository)).toEqual(
      repositories,
    )
    expect(result.results[0].state?.promotionSteps[0].pullRequest).toMatchObject(
      {
        number: 42,
        reviewDecision: 'approved',
        checks: 'success',
      },
    )
    expect(result.stats).toMatchObject({
      cacheHits: 0,
      graphqlRequests: 1,
      restRequests: 9,
      fallbackCount: 1,
    })
    expect(fetchMock).toHaveBeenCalledTimes(10)
    for (const repository of repositories) {
      clearRepositoryCaches(config, repository)
    }
  })

  it('keeps a twenty-repository cold sync within the hybrid request budget', async () => {
    const repositories = Array.from(
      { length: 20 },
      (_, index) => `Orange-Health/batch-service-${index}`,
    )
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url === 'https://api.github.com/graphql') {
        const body = JSON.parse(String(init?.body)) as {
          variables: Record<string, string>
        }
        const names = Object.entries(body.variables)
          .filter(([key]) => key.startsWith('name'))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, value]) => value)
        return new Response(
          JSON.stringify({
            data: Object.fromEntries(
              names.map((_, index) => [
                `r${index}`,
                {
                  defaultBranchRef: { name: 'main' },
                  releases: { nodes: [] },
                  pullRequests: { nodes: [] },
                },
              ]),
            ),
          }),
        )
      }
      if (url.includes('/actions/runs?')) {
        return new Response(JSON.stringify({ workflow_runs: [] }))
      }
      if (url.includes('/compare/')) {
        return new Response(
          JSON.stringify({ ahead_by: 0, behind_by: 0, files: [] }),
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
    for (const repository of repositories) {
      clearRepositoryCaches(config, repository)
    }

    const result = await getReleaseControlRoomStatesBatch(config, repositories)

    expect(result.results).toHaveLength(20)
    expect(result.results.every((item) => item.state)).toBe(true)
    expect(result.stats).toMatchObject({
      graphqlRequests: 2,
      restRequests: 60,
      fallbackCount: 0,
    })
    expect(fetchMock).toHaveBeenCalledTimes(62)
    for (const repository of repositories) {
      clearRepositoryCaches(config, repository)
    }
  })

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
    expect(fetchMock).toHaveBeenCalledTimes(7)
    clearRepositoryCaches(config, 'Orange-Health/service-api')
  })

  it('reports when default branch is ahead of the latest production tag', async () => {
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
        return new Response(
          JSON.stringify([
            {
              id: 10,
              tag_name: 'v26.0723.1',
              html_url: 'https://github.test/releases/10',
              created_at: '2026-07-23T08:00:00Z',
              published_at: '2026-07-23T08:00:00Z',
              prerelease: false,
              body: null,
            },
          ]),
          { status: 200 },
        )
      }
      if (url.includes('/actions/runs?')) {
        return new Response(JSON.stringify({ workflow_runs: [] }), {
          status: 200,
        })
      }
      if (url.includes('/compare/v26.0723.1...main')) {
        return new Response(
          JSON.stringify({
            ahead_by: 2,
            behind_by: 0,
            files: [{ filename: 'src/index.ts' }, { filename: 'README.md' }],
          }),
          { status: 200 },
        )
      }
      if (url.includes('/compare/')) {
        return new Response(
          JSON.stringify({ ahead_by: 0, behind_by: 0, files: [] }),
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

    const state = await getRepositoryReleaseState(
      config,
      'Orange-Health/service-api',
    )

    expect(state.latestProductionTagDelta).toEqual({
      tag: 'v26.0723.1',
      commitsAhead: 2,
      filesChanged: 2,
      hasSourceChanges: true,
    })
    clearRepositoryCaches(config, 'Orange-Health/service-api')
  })

  it('finds promotion PRs for repositories forked within the same organization', async () => {
    const repository = 'Orange-Health/asbru'
    const promotionPull = {
      number: 196,
      node_id: 'PR_kwDOAsbru',
      title: 'Promote release to main',
      body: null,
      html_url: 'https://github.test/Orange-Health/asbru/pull/196',
      draft: false,
      merged_at: null,
      mergeable: true,
      mergeable_state: 'blocked',
      base: { ref: 'main' },
      head: {
        ref: 'release',
        sha: 'release-sha',
        repo: { full_name: repository },
      },
    }
    const sameBranchFromAnotherFork = {
      ...promotionPull,
      number: 195,
      head: {
        ...promotionPull.head,
        repo: { full_name: 'Orange-Health/bifrost' },
      },
    }
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith(`/repos/${repository}`)) {
        return new Response(
          JSON.stringify({ full_name: repository, default_branch: 'main' }),
          { status: 200 },
        )
      }
      if (url.includes('/releases?')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/compare/')) {
        const hasReleaseChanges = url.includes('/compare/main...release')
        return new Response(
          JSON.stringify({
            ahead_by: hasReleaseChanges ? 1 : 0,
            behind_by: 0,
            files: hasReleaseChanges ? [{ filename: 'Dockerfile' }] : [],
          }),
          { status: 200 },
        )
      }
      if (url.includes('/pulls?')) {
        const requestUrl = new URL(url)
        expect(requestUrl.searchParams.has('head')).toBe(false)
        expect(requestUrl.searchParams.has('base')).toBe(false)
        const pulls =
          requestUrl.searchParams.get('state') === 'open'
            ? [sameBranchFromAnotherFork, promotionPull]
            : []
        return new Response(JSON.stringify(pulls), { status: 200 })
      }
      if (url.includes('/pulls/196/reviews?')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/commits/release-sha/check-runs?')) {
        return new Response(JSON.stringify({ check_runs: [] }), {
          status: 200,
        })
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
    clearRepositoryCaches(config, repository)

    const state = await getRepositoryReleaseState(config, repository)

    expect(
      state.promotionSteps.find(
        (step) => step.route === 'release-to-default',
      ),
    ).toMatchObject({
      state: 'pr_open',
      pullRequest: { number: 196 },
    })
    clearRepositoryCaches(config, repository)
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
              head_branch: 'v26.0715.1',
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
        tag: 'v26.0715.1',
        createdAt: '2026-07-15T08:59:00Z',
      },
    ])

    expect(result.buildStatus).toBe('succeeded')
    expect(result.runs).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/actions/runs?branch=v26.0715.1',
    )
    const [cached] = await getReleaseBuildStatuses(config, [
      {
        repository: 'Orange-Health/service-api',
        tag: 'v26.0715.1',
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
          tag: 'v26.0715.1',
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

describe('mergeFeaturePullRequest', () => {
  it('retargets a default-branch PR to dev before merging', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.endsWith('/repos/orange/service-api') && method === 'GET') {
        return new Response(JSON.stringify({ default_branch: 'main' }), {
          status: 200,
        })
      }
      if (url.includes('/pulls?') && method === 'GET') {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/compare/') && method === 'GET') {
        return new Response(
          JSON.stringify({ ahead_by: 0, behind_by: 0, files: [] }),
          { status: 200 },
        )
      }
      if (url.endsWith('/pulls/8') && method === 'GET') {
        return new Response(
          JSON.stringify({
            id: 8,
            number: 8,
            title: 'OH-123 Release API',
            html_url: 'https://github.test/pull/8',
            draft: false,
            merged_at: null,
            mergeable: true,
            mergeable_state: 'clean',
            base: { ref: 'main' },
            head: { ref: 'feature/OH-123', sha: 'abc123' },
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/pulls/8') && method === 'PATCH') {
        expect(JSON.parse(String(init?.body))).toEqual({ base: 'dev' })
        return new Response(
          JSON.stringify({
            id: 8,
            number: 8,
            title: 'OH-123 Release API',
            html_url: 'https://github.test/pull/8',
            draft: false,
            merged_at: null,
            mergeable: true,
            mergeable_state: 'clean',
            base: { ref: 'dev' },
            head: { ref: 'feature/OH-123', sha: 'abc123' },
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/pulls/8/reviews?per_page=100')) {
        return new Response(
          JSON.stringify([
            {
              user: { login: 'reviewer' },
              state: 'APPROVED',
              submitted_at: '2026-07-13T12:00:00Z',
            },
          ]),
          { status: 200 },
        )
      }
      if (url.endsWith('/commits/abc123/check-runs?per_page=100')) {
        return new Response(
          JSON.stringify({
            check_runs: [{ status: 'completed', conclusion: 'success' }],
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/pulls/8/merge') && method === 'PUT') {
        return new Response(
          JSON.stringify({ merged: true, message: 'Merged', sha: 'def456' }),
          { status: 200 },
        )
      }
      return new Response('unexpected request', { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const config: ConnectionConfig = {
      jiraSite: 'https://jira.test',
      jiraEmail: 'rm@test.com',
      jiraToken: 'jira',
      githubOrg: 'orange',
      githubToken: 'github',
      jenkinsUrl: 'https://jenkins.test',
      jenkinsUsername: 'rm',
      jenkinsToken: 'jenkins',
    }

    const result = await mergeFeaturePullRequest(
      config,
      'orange/service-api',
      8,
      true,
    )

    expect(result.merged).toBe(true)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(
      true,
    )
  })
})
