import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig } from '../../src/shared/types.js'
import {
  clearGitHubProviderCache,
  createStagingRelease,
  createProductionRelease,
  developmentPullRequests,
  discoverPullRequests,
  buildIssueSearchQuery,
  countSearchBooleanOperators,
  githubApi,
  listOrganizationRepositories,
  listRepositoryBranches,
  nextProductionTag,
  nextStagingTag,
  stagingTagPrefix,
  productionTagPrefix,
  titleContainsIssueKey,
} from './github.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clearGitHubProviderCache()
})

describe('organization repositories', () => {
  it('lists and maps repositories from the connected organization', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            archived: false,
            default_branch: 'main',
            full_name: 'orange/service-api',
            html_url: 'https://github.com/orange/service-api',
            name: 'service-api',
            private: true,
          },
        ]),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const repositories = await listOrganizationRepositories({
      jiraSite: 'https://jira.test',
      jiraEmail: 'rm@test.com',
      jiraToken: 'jira',
      githubOrg: 'orange',
      githubToken: 'github',
      jenkinsUrl: 'https://jenkins.test',
      jenkinsUsername: 'rm',
      jenkinsToken: 'jenkins',
    })

    expect(repositories).toEqual([
      {
        archived: false,
        defaultBranch: 'main',
        name: 'service-api',
        private: true,
        repository: 'orange/service-api',
        url: 'https://github.com/orange/service-api',
      },
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/orgs/orange/repos?type=all&sort=full_name&direction=asc&per_page=100&page=1',
      expect.any(Object),
    )
  })

  it('lists repository branches for source selection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify([
            { name: 'feature/OH-42' },
            { name: 'dev' },
            { name: 'main' },
          ]),
        ),
      ),
    )

    const branches = await listRepositoryBranches(
      {
        jiraSite: 'https://jira.test',
        jiraEmail: 'rm@test.com',
        jiraToken: 'jira',
        githubOrg: 'orange',
        githubToken: 'github',
        jenkinsUrl: 'https://jenkins.test',
        jenkinsUsername: 'rm',
        jenkinsToken: 'jenkins',
      },
      'orange/service-api',
    )

    expect(branches).toEqual(['dev', 'feature/OH-42', 'main'])
  })
})

describe('conditional GitHub requests', () => {
  it('reuses the cached body when GitHub returns 304', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'main' }), {
          status: 200,
          headers: { etag: '"repo-v1"' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
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

    const first = await githubApi<{ default_branch: string }>(
      config,
      '/repos/orange/service-api',
    )
    const second = await githubApi<{ default_branch: string }>(
      config,
      '/repos/orange/service-api',
    )

    expect(second).toBe(first)
    const secondHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers)
    expect(secondHeaders.get('if-none-match')).toBe('"repo-v1"')
  })

  it('removes repository validators when its cache is invalidated', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'main' }), {
          status: 200,
          headers: { etag: '"repo-v1"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'master' }), {
          status: 200,
          headers: { etag: '"repo-v2"' },
        }),
      )
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

    await githubApi(config, '/repos/orange/service-api')
    clearGitHubProviderCache('orange/service-api')
    const refreshed = await githubApi<{ default_branch: string }>(
      config,
      '/repos/orange/service-api',
    )

    expect(refreshed.default_branch).toBe('master')
    const secondHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers)
    expect(secondHeaders.has('if-none-match')).toBe(false)
  })

  it('does not add conditional headers to mutations', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ merged: true }), {
        status: 200,
        headers: { etag: '"mutation"' },
      }),
    )
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

    await githubApi(config, '/repos/orange/service-api/pulls/1/merge', {
      method: 'PUT',
      body: JSON.stringify({ merge_method: 'merge' }),
    })

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.has('if-none-match')).toBe(false)
  })
})

describe('GitHub request scheduler', () => {
  it('serializes mutations with a one-second pause', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ merged: true }), { status: 200 }),
      )
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

    const first = githubApi(config, '/repos/orange/service-api/pulls/1/merge', {
      method: 'PUT',
      body: JSON.stringify({ merge_method: 'merge' }),
    })
    const second = githubApi(config, '/repos/orange/service-api/pulls/2/merge', {
      method: 'PUT',
      body: JSON.stringify({ merge_method: 'merge' }),
    })
    await first

    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await second
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('honors Retry-After before retrying a rate-limited read', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'rate limited' }), {
          status: 429,
          headers: { 'retry-after': '2' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'main' }), {
          status: 200,
        }),
      )
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

    const pending = githubApi<{ default_branch: string }>(
      config,
      '/repos/orange/service-api',
    )
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(pending).resolves.toEqual({ default_branch: 'main' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry ambiguous mutation server errors', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: 'temporary failure' }), {
          status: 500,
        }),
      )
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

    await expect(
      githubApi(config, '/repos/orange/service-api/releases', {
        method: 'POST',
        body: JSON.stringify({ tag_name: 'v-26.0715.1' }),
      }),
    ).rejects.toMatchObject({ status: 500 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('titleContainsIssueKey', () => {
  it.each([
    ['OH-123 add dashboard', true],
    ['feat: [OH-123] add dashboard', true],
    ['Fix oh-123: add dashboard', true],
    ['OH-1234 is a different ticket', false],
    ['prefixOH-123 should not match', false],
    ['No ticket in this title', false],
  ])('matches exact ticket boundaries in %s', (title, expected) => {
    expect(titleContainsIssueKey(title, 'OH-123')).toBe(expected)
  })
})

describe('Jira development links', () => {
  it('extracts and de-duplicates GitHub pull request links', () => {
    expect(
      developmentPullRequests(
        '{"url":"https:\\/\\/github.com\\/Orange-Health\\/service-api\\/pull\\/42","api":"https://api.github.com/repos/Orange-Health/service-api/pulls/42"}',
      ),
    ).toEqual([
      { repository: 'Orange-Health/service-api', number: 42 },
    ])
  })

  it('loads Jira-linked PRs without using GitHub Search', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url === 'https://api.github.com/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          variables: Record<string, string | number>
        }
        const data: Record<string, unknown> = {}
        for (const key of Object.keys(body.variables)) {
          const match = /^number(\d+)$/.exec(key)
          if (!match) continue
          const index = match[1]
          const pullNumber = Number(body.variables[key])
          data[`p${index}`] = {
            pullRequest: {
              databaseId: pullNumber,
              number: pullNumber,
              title: 'OH-123 linked work',
              url: `https://github.com/Orange-Health/service-api/pull/${pullNumber}`,
              state: pullNumber === 43 ? 'CLOSED' : 'OPEN',
              isDraft: false,
              merged: false,
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
              baseRefName: 'dev',
              headRefName: 'feature/OH-123',
              updatedAt: '2026-07-15T08:00:00Z',
              reviewDecision: 'APPROVED',
              author: { login: 'dev', avatarUrl: 'https://avatar.test/dev' },
              assignees: { nodes: [] },
              latestReviews: { nodes: [] },
              commits: {
                nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }],
              },
            },
          }
        }
        return new Response(JSON.stringify({ data }), { status: 200 })
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

    const result = await discoverPullRequests(config, [
      {
        key: 'OH-123',
        developmentSummary:
          'https://github.com/Orange-Health/service-api/pull/42 https://github.com/Orange-Health/service-api/pull/43',
      },
    ])

    expect(result.byIssue.get('OH-123')?.[0].number).toBe(42)
    expect(result.byIssue.get('OH-123')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.github.com/graphql',
    )
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('/search/')),
    ).toBe(false)
  })

  it('keeps the last known GitHub rate limit when provider caches satisfy a refresh', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url === 'https://api.github.com/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          variables: Record<string, string | number>
        }
        const data: Record<string, unknown> = {}
        for (const key of Object.keys(body.variables)) {
          const match = /^number(\d+)$/.exec(key)
          if (!match) continue
          const index = match[1]
          const pullNumber = Number(body.variables[key])
          data[`p${index}`] = {
            pullRequest: {
              databaseId: pullNumber,
              number: pullNumber,
              title: 'OH-999 linked work',
              url: `https://github.com/Orange-Health/service-api/pull/${pullNumber}`,
              state: 'OPEN',
              isDraft: false,
              merged: false,
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
              baseRefName: 'dev',
              headRefName: 'feature/OH-999',
              updatedAt: '2026-07-15T08:00:00Z',
              reviewDecision: 'APPROVED',
              author: { login: 'dev', avatarUrl: 'https://avatar.test/dev' },
              assignees: { nodes: [] },
              latestReviews: { nodes: [] },
              commits: { nodes: [] },
            },
          }
        }
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: {
            'x-ratelimit-remaining': '4321',
            'x-ratelimit-limit': '5000',
            'x-ratelimit-reset': '1893456000',
          },
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
    const issues = [
      {
        key: 'OH-999',
        developmentSummary:
          'https://github.com/Orange-Health/service-api/pull/99',
      },
    ]

    const first = await discoverPullRequests(config, issues)
    expect(first.rateLimit?.remaining).toBe(4321)

    const second = await discoverPullRequests(config, issues)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(second.rateLimit?.remaining).toBe(4321)
  })

  it('batches unique pull request details in a single GraphQL request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url === 'https://api.github.com/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          query: string
          variables: Record<string, string | number>
        }
        expect(body.query).toContain('p0:')
        expect(body.query).toContain('p1:')
        return new Response(
          JSON.stringify({
            data: {
              p0: {
                pullRequest: {
                  databaseId: 10,
                  number: 10,
                  title: 'OH-1',
                  url: 'https://github.com/Orange-Health/a/pull/10',
                  state: 'OPEN',
                  isDraft: false,
                  merged: false,
                  mergeable: 'MERGEABLE',
                  mergeStateStatus: 'CLEAN',
                  baseRefName: 'dev',
                  headRefName: 'feature/OH-1',
                  updatedAt: '2026-07-15T08:00:00Z',
                  reviewDecision: 'APPROVED',
                  author: { login: 'dev', avatarUrl: '' },
                  assignees: { nodes: [] },
                  latestReviews: { nodes: [] },
                  commits: { nodes: [] },
                },
              },
              p1: {
                pullRequest: {
                  databaseId: 20,
                  number: 20,
                  title: 'OH-2',
                  url: 'https://github.com/Orange-Health/b/pull/20',
                  state: 'OPEN',
                  isDraft: false,
                  merged: false,
                  mergeable: 'CONFLICTING',
                  mergeStateStatus: 'DIRTY',
                  baseRefName: 'dev',
                  headRefName: 'feature/OH-2',
                  updatedAt: '2026-07-15T08:00:00Z',
                  reviewDecision: 'CHANGES_REQUESTED',
                  author: { login: 'dev', avatarUrl: '' },
                  assignees: { nodes: [] },
                  latestReviews: {
                    nodes: [
                      {
                        author: { login: 'reviewer', avatarUrl: '' },
                        state: 'CHANGES_REQUESTED',
                      },
                    ],
                  },
                  commits: {
                    nodes: [
                      { commit: { statusCheckRollup: { state: 'FAILURE' } } },
                    ],
                  },
                },
              },
            },
          }),
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

    const result = await discoverPullRequests(config, [
      {
        key: 'OH-1',
        developmentSummary:
          'https://github.com/Orange-Health/a/pull/10',
      },
      {
        key: 'OH-2',
        developmentSummary:
          'https://github.com/Orange-Health/b/pull/20',
      },
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.byIssue.get('OH-1')?.[0]).toMatchObject({
      number: 10,
      mergeable: true,
      mergeableState: 'clean',
      checks: 'none',
      reviewDecision: 'approved',
    })
    expect(result.byIssue.get('OH-2')?.[0]).toMatchObject({
      number: 20,
      mergeable: false,
      mergeableState: 'dirty',
      checks: 'failure',
      reviewDecision: 'changes_requested',
    })
  })
})

describe('targeted search invalidation', () => {
  it('keeps OR batches within GitHub boolean operator limits', () => {
    const keys = ['OH-1', 'OH-2', 'OH-3', 'OH-4', 'OH-5', 'OH-6']
    const query = buildIssueSearchQuery('Orange-Health', keys)
    expect(countSearchBooleanOperators(query)).toBe(5)
    expect(countSearchBooleanOperators(query)).toBeLessThanOrEqual(5)
    expect(() =>
      buildIssueSearchQuery('Orange-Health', [...keys, 'OH-7']),
    ).toThrow(/OR operators/)
  })

  it('keeps unrelated issue searches cached during service refresh', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes('/search/issues')) {
        return new Response(
          JSON.stringify({ items: [], incomplete_results: false }),
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
    const issues = [{ key: 'OH-123' }, { key: 'OH-456' }]

    await discoverPullRequests(config, issues)
    clearGitHubProviderCache('Orange-Health/service-api', ['OH-123'])
    await discoverPullRequests(config, issues)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        decodeURIComponent(String(input)).includes('OH-123'),
      ),
    ).toHaveLength(2)
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        decodeURIComponent(String(input)).includes('OH-456'),
      ),
    ).toHaveLength(1)
  })

  it('batches multiple issue keys into one OR search query', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = decodeURIComponent(String(input))
      if (url.includes('/search/issues')) {
        expect(url).toContain('"OH-123" OR "OH-456"')
        expect(url).toContain('is:pr (')
        expect(url).not.toContain('in:title')
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 1,
                number: 10,
                title: 'OH-123 fix',
                repository_url:
                  'https://api.github.com/repos/Orange-Health/service-api',
                state: 'open',
                pull_request: {},
              },
              {
                id: 2,
                number: 20,
                title: 'OH-456 feature',
                repository_url:
                  'https://api.github.com/repos/Orange-Health/service-api',
                state: 'open',
                pull_request: {},
              },
            ],
            incomplete_results: false,
          }),
          { status: 200 },
        )
      }
      if (url === 'https://api.github.com/graphql') {
        return new Response(
          JSON.stringify({
            data: {
              p0: {
                pullRequest: {
                  databaseId: 10,
                  number: 10,
                  title: 'OH-123 fix',
                  url: 'https://github.com/Orange-Health/service-api/pull/10',
                  state: 'OPEN',
                  isDraft: false,
                  merged: false,
                  mergeable: 'MERGEABLE',
                  mergeStateStatus: 'CLEAN',
                  baseRefName: 'dev',
                  headRefName: 'feature/OH-123',
                  updatedAt: '2026-07-15T08:00:00Z',
                  reviewDecision: 'APPROVED',
                  author: { login: 'dev', avatarUrl: '' },
                  assignees: { nodes: [] },
                  latestReviews: { nodes: [] },
                  commits: { nodes: [] },
                },
              },
              p1: {
                pullRequest: {
                  databaseId: 20,
                  number: 20,
                  title: 'OH-456 feature',
                  url: 'https://github.com/Orange-Health/service-api/pull/20',
                  state: 'OPEN',
                  isDraft: false,
                  merged: false,
                  mergeable: 'MERGEABLE',
                  mergeStateStatus: 'CLEAN',
                  baseRefName: 'dev',
                  headRefName: 'feature/OH-456',
                  updatedAt: '2026-07-15T08:00:00Z',
                  reviewDecision: 'APPROVED',
                  author: { login: 'dev', avatarUrl: '' },
                  assignees: { nodes: [] },
                  latestReviews: { nodes: [] },
                  commits: { nodes: [] },
                },
              },
            },
          }),
          { status: 200 },
        )
      }
      throw new Error(`Unexpected GitHub request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await discoverPullRequests(
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
      [{ key: 'OH-123' }, { key: 'OH-456' }],
    )

    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/search/'),
      ),
    ).toHaveLength(1)
    expect(result.byIssue.get('OH-123')?.[0].number).toBe(10)
    expect(result.byIssue.get('OH-456')?.[0].number).toBe(20)
  })

  it('falls back to per-ticket search when an OR batch fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let searchCalls = 0
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = decodeURIComponent(String(input))
      if (url.includes('/search/issues')) {
        searchCalls += 1
        if (url.includes('OR')) {
          return new Response(
            JSON.stringify({ message: 'Validation Failed', errors: [] }),
            { status: 422 },
          )
        }
        const issueKey = url.includes('OH-123') ? 'OH-123' : 'OH-456'
        return new Response(
          JSON.stringify({
            items: [
              {
                id: issueKey === 'OH-123' ? 1 : 2,
                number: issueKey === 'OH-123' ? 10 : 20,
                title: `${issueKey} fix`,
                repository_url:
                  'https://api.github.com/repos/Orange-Health/service-api',
                state: 'open',
                pull_request: {},
              },
            ],
            incomplete_results: false,
          }),
          { status: 200 },
        )
      }
      if (url === 'https://api.github.com/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          variables: Record<string, string | number>
        }
        const data: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(body.variables)) {
          const match = /^number(\d+)$/.exec(key)
          if (!match) continue
          const index = match[1]
          const pullNumber = Number(value)
          data[`p${index}`] = {
            pullRequest: {
              databaseId: pullNumber,
              number: pullNumber,
              title: `PR ${pullNumber}`,
              url: `https://github.com/Orange-Health/service-api/pull/${pullNumber}`,
              state: 'OPEN',
              isDraft: false,
              merged: false,
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
              baseRefName: 'dev',
              headRefName: `feature/${pullNumber}`,
              updatedAt: '2026-07-15T08:00:00Z',
              reviewDecision: 'APPROVED',
              author: { login: 'dev', avatarUrl: '' },
              assignees: { nodes: [] },
              latestReviews: { nodes: [] },
              commits: { nodes: [] },
            },
          }
        }
        return new Response(JSON.stringify({ data }), { status: 200 })
      }
      throw new Error(`Unexpected GitHub request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await discoverPullRequests(
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
      [{ key: 'OH-123' }, { key: 'OH-456' }],
    )

    expect(searchCalls).toBeGreaterThanOrEqual(3)
    expect(result.warnings).toEqual([])
    expect(result.byIssue.get('OH-123')?.[0].number).toBe(10)
    expect(result.byIssue.get('OH-456')?.[0].number).toBe(20)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('logs search failures and keeps UI warnings short', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await discoverPullRequests(
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
      [{ key: 'OH-4009' }],
    )

    expect(result.warnings).toEqual(['Could not search GitHub for OH-4009.'])
    expect(errorSpy).toHaveBeenCalled()
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain('OH-4009')
    expect(String(errorSpy.mock.calls.at(-1)?.[1])).toMatch(
      /rate limit|403|Authentication/i,
    )
    errorSpy.mockRestore()
  })
})

describe('staging release tags', () => {
  it('formats dates as v-{env}-vYY.MMDD.N', () => {
    expect(stagingTagPrefix('qa', '2026-07-13')).toBe('v-qa-v26.0713.')
  })

  it('increments only valid matching numeric tag suffixes', () => {
    expect(
      nextStagingTag('s2', '2026-07-13', [
        'v-s2-v26.0713.1',
        'v-s2-v26.0713.4',
        'v-s2-v26.0713.beta',
        'v-qa-v26.0713.9',
      ]),
    ).toBe('v-s2-v26.0713.5')
  })

  it('rejects impossible calendar dates', () => {
    expect(() => stagingTagPrefix('qa', '2026-02-31')).toThrow(
      'Release date is invalid.',
    )
  })

  it('creates a prerelease from dev using the next repository tag', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'dev' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { ref: 'refs/tags/v-qa-v26.0713.1' },
            { ref: 'refs/tags/v-qa-v26.0713.2' },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 99,
            html_url: 'https://github.test/releases/99',
            created_at: '2026-07-13T12:00:00Z',
          }),
          { status: 201 },
        ),
      )
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

    const result = await createStagingRelease(
      config,
      'orange/service-api',
      'qa',
      '2026-07-13',
    )

    expect(result.tag).toBe('v-qa-v26.0713.3')
    const releaseRequest = fetchMock.mock.calls[2]
    expect(releaseRequest[0]).toBe(
      'https://api.github.com/repos/orange/service-api/releases',
    )
    const releaseBody = JSON.parse(String(releaseRequest[1]?.body))
    expect(releaseBody).toMatchObject({
      tag_name: 'v-qa-v26.0713.3',
      target_commitish: 'dev',
      prerelease: true,
      draft: false,
      generate_release_notes: true,
    })
    expect(releaseBody).not.toHaveProperty('body')
  })

  it('creates a prerelease from a selected branch', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'feature/OH-42' })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([])))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 100,
            html_url: 'https://github.test/releases/100',
            created_at: '2026-07-13T12:00:00Z',
          }),
          { status: 201 },
        ),
      )
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

    const result = await createStagingRelease(
      config,
      'orange/service-api',
      's2',
      '2026-07-13',
      'feature/OH-42',
    )

    expect(result.sourceBranch).toBe('feature/OH-42')
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/branches/feature%2FOH-42',
    )
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      target_commitish: 'feature/OH-42',
    })
  })
})

describe('production release tags', () => {
  it('uses special prefixes only for configured frontend repositories', () => {
    expect(
      productionTagPrefix('Orange-Health/sapphire-web', '2026-07-14'),
    ).toBe(
      'v-prod-26.0714.',
    )
    expect(productionTagPrefix('Orange-Health/sapphire', '2026-07-14')).toBe(
      'v26.0714.',
    )
    expect(productionTagPrefix('Orange-Health/accounts', '2026-07-14')).toBe(
      'v26.0714.',
    )
  })

  it('increments existing production tag versions', () => {
    expect(
      nextProductionTag('Orange-Health/bifrost', '2026-07-14', [
        'v-prod-26.0714.1',
        'v-prod-26.0714.3',
        'v-26.0714.9',
      ]),
    ).toBe('v-prod-26.0714.4')
    expect(
      nextProductionTag('Orange-Health/accounts', '2026-07-14', [
        'v-26.0714.1',
        'v26.0714.3',
      ]),
    ).toBe('v26.0714.4')
  })

  it('creates a production release from the default branch using generated notes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ ref: 'refs/tags/v26.0714.1' }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 100,
            html_url: 'https://github.test/releases/100',
            created_at: '2026-07-14T12:00:00Z',
          }),
          { status: 201 },
        ),
      )
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

    const result = await createProductionRelease(
      config,
      'orange/service-api',
      '2026-07-14',
    )

    expect(result.tag).toBe('v26.0714.2')
    expect(result.sourceBranch).toBe('main')
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      tag_name: 'v26.0714.2',
      target_commitish: 'main',
      prerelease: false,
      generate_release_notes: true,
    })
  })

  it('returns the release from an interrupted operation without duplicating it', async () => {
    const operationId = '5ce8a585-87f7-4c58-8e4f-8a3dd49b16df'
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'master' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 101,
              tag_name: 'v-26.0714.3',
              target_commitish: 'master',
              html_url: 'https://github.test/releases/101',
              created_at: '2026-07-14T12:05:00Z',
              body: `<!-- release-desk-operation:${operationId} -->`,
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workflow_runs: [] }), {
          status: 200,
        }),
      )
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

    const result = await createProductionRelease(
      config,
      'orange/service-api',
      '2026-07-14',
      operationId,
    )

    expect(result.tag).toBe('v-26.0714.3')
    expect(result.sourceBranch).toBe('master')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not reuse an interrupted production release from a non-default branch', async () => {
    const operationId = '5ce8a585-87f7-4c58-8e4f-8a3dd49b16df'
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'main' })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 101,
              tag_name: 'v26.0714.1',
              target_commitish: 'release',
              html_url: 'https://github.test/releases/101',
              created_at: '2026-07-14T12:05:00Z',
              body: `<!-- release-desk-operation:${operationId} -->`,
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([])))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 102,
            html_url: 'https://github.test/releases/102',
            created_at: '2026-07-14T12:06:00Z',
          }),
          { status: 201 },
        ),
      )
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

    const result = await createProductionRelease(
      config,
      'orange/service-api',
      '2026-07-14',
      operationId,
    )

    expect(result.sourceBranch).toBe('main')
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toMatchObject({
      target_commitish: 'main',
    })
  })

  it('does not reuse an interrupted operation release from another date', async () => {
    const operationId = '5ce8a585-87f7-4c58-8e4f-8a3dd49b16df'
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'master' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 101,
              tag_name: 'v-26.0716.1',
              target_commitish: 'master',
              html_url: 'https://github.test/releases/101',
              created_at: '2026-07-16T12:05:00Z',
              body: `<!-- release-desk-operation:${operationId} -->`,
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 102,
            html_url: 'https://github.test/releases/102',
            created_at: '2026-06-23T12:10:00Z',
          }),
          { status: 201 },
        ),
      )
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

    const result = await createProductionRelease(
      config,
      'orange/service-api',
      '2026-06-23',
      operationId,
    )

    expect(result.tag).toBe('v-26.0623.1')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(String(fetchMock.mock.calls[2][0])).toContain(
      '/git/matching-refs/tags/v-26.0623.',
    )
  })

  it('creates a new release when the interrupted operation build was canceled', async () => {
    const operationId = '5ce8a585-87f7-4c58-8e4f-8a3dd49b16df'
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'master' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 101,
              tag_name: 'v-26.0714.3',
              target_commitish: 'master',
              html_url: 'https://github.test/releases/101',
              created_at: '2026-07-14T12:05:00Z',
              body: `<!-- release-desk-operation:${operationId} -->`,
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflow_runs: [
              {
                head_branch: 'v-26.0714.3',
                conclusion: 'cancelled',
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ ref: 'refs/tags/v-26.0714.3' }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 102,
            html_url: 'https://github.test/releases/102',
            created_at: '2026-07-14T12:10:00Z',
          }),
          { status: 201 },
        ),
      )
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

    const result = await createProductionRelease(
      config,
      'orange/service-api',
      '2026-07-14',
      operationId,
    )

    expect(result.tag).toBe('v-26.0714.4')
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })
})
