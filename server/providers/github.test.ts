import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig } from '../../src/shared/types.js'
import {
  createStagingRelease,
  nextStagingTag,
  stagingTagPrefix,
  titleContainsIssueKey,
} from './github.js'

afterEach(() => vi.unstubAllGlobals())

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
    expect(JSON.parse(String(releaseRequest[1]?.body))).toMatchObject({
      tag_name: 'v-qa-v26.0713.3',
      target_commitish: 'dev',
      prerelease: true,
      draft: false,
    })
  })
})
