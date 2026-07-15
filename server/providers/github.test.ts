import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig } from '../../src/shared/types.js'
import {
  clearGitHubProviderCache,
  createStagingRelease,
  createProductionRelease,
  developmentPullRequests,
  discoverPullRequests,
  githubApi,
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
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/repos/Orange-Health/service-api/pulls/42')) {
        return new Response(
          JSON.stringify({
            id: 42,
            number: 42,
            title: 'OH-123 linked work',
            html_url: 'https://github.com/Orange-Health/service-api/pull/42',
            state: 'open',
            draft: false,
            merged: false,
            mergeable: true,
            mergeable_state: 'clean',
            updated_at: '2026-07-15T08:00:00Z',
            user: { login: 'dev', avatar_url: 'https://avatar.test/dev' },
            assignees: [],
            base: {
              ref: 'dev',
              repo: { full_name: 'Orange-Health/service-api' },
            },
            head: { ref: 'feature/OH-123', sha: 'abc123' },
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/pulls/42/reviews?per_page=100')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.endsWith('/commits/abc123/check-runs?per_page=100')) {
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

    const result = await discoverPullRequests(config, [
      {
        key: 'OH-123',
        developmentSummary:
          'https://github.com/Orange-Health/service-api/pull/42',
      },
    ])

    expect(result.byIssue.get('OH-123')?.[0].number).toBe(42)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/search/'))).toBe(false)
  })
})

describe('targeted search invalidation', () => {
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

    expect(fetchMock).toHaveBeenCalledTimes(3)
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
})

describe('production release tags', () => {
  it('uses special prefixes only for configured frontend repositories', () => {
    expect(
      productionTagPrefix('Orange-Health/sapphire-web', '2026-07-14'),
    ).toBe(
      'v-prod-26.0714.',
    )
    expect(productionTagPrefix('Orange-Health/sapphire', '2026-07-14')).toBe(
      'v-26.0714.',
    )
    expect(productionTagPrefix('Orange-Health/accounts', '2026-07-14')).toBe(
      'v-26.0714.',
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
  })

  it('creates a production release from release using generated notes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'release' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ ref: 'refs/tags/v-26.0714.1' }]),
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

    expect(result.tag).toBe('v-26.0714.2')
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      tag_name: 'v-26.0714.2',
      target_commitish: 'release',
      prerelease: false,
      generate_release_notes: true,
    })
  })

  it('returns the release from an interrupted operation without duplicating it', async () => {
    const operationId = '5ce8a585-87f7-4c58-8e4f-8a3dd49b16df'
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'release' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 101,
              tag_name: 'v-26.0714.3',
              target_commitish: 'release',
              html_url: 'https://github.test/releases/101',
              created_at: '2026-07-14T12:05:00Z',
              body: `<!-- release-desk-operation:${operationId} -->`,
            },
          ]),
          { status: 200 },
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

    expect(result.tag).toBe('v-26.0714.3')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
