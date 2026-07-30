import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig } from '../../src/shared/types.js'
import { markVersionIssuesReleased } from './jira.js'

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

afterEach(() => vi.unstubAllGlobals())

describe('markVersionIssuesReleased', () => {
  it('transitions eligible tickets and skips tickets already released', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/rest/api/3/search/jql')) {
        return new Response(
          JSON.stringify({
            isLast: true,
            issues: [
              {
                key: 'OH-101',
                fields: {
                  summary: 'Ready ticket',
                  status: { name: 'Ready for Release' },
                },
              },
              {
                key: 'OH-102',
                fields: {
                  summary: 'Released ticket',
                  status: { name: 'Released' },
                },
              },
            ],
          }),
        )
      }
      if (
        url.endsWith('/rest/api/3/issue/OH-101/transitions') &&
        init?.method === 'POST'
      ) {
        expect(JSON.parse(String(init.body))).toEqual({
          transition: { id: '51' },
        })
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/rest/api/3/issue/OH-101/transitions')) {
        return new Response(
          JSON.stringify({
            transitions: [
              { id: '51', name: 'Release', to: { name: 'Released' } },
            ],
          }),
        )
      }
      throw new Error(`Unexpected Jira request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await markVersionIssuesReleased(config, '123')

    expect(result).toEqual({
      versionId: '123',
      total: 2,
      transitioned: ['OH-101'],
      alreadyReleased: ['OH-102'],
      failed: [],
    })
  })
})
