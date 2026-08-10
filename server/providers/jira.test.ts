import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig } from '../../src/shared/types.js'
import { markVersionIssuesReleased, removeIssueFromRelease } from './jira.js'

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

describe('removeIssueFromRelease', () => {
  it('clears the ticket fixVersion from the release', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (
        url.includes('/rest/api/3/issue/OH-101') &&
        !init?.method &&
        url.includes('fields=fixVersions')
      ) {
        return new Response(
          JSON.stringify({
            key: 'OH-101',
            fields: { fixVersions: [{ id: '123', name: 'OH Release' }] },
          }),
        )
      }
      if (url.endsWith('/rest/api/3/issue/OH-101') && init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toEqual({
          update: {
            fixVersions: [{ remove: { id: '123' } }],
          },
        })
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected Jira request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      removeIssueFromRelease(config, '123', 'OH-101'),
    ).resolves.toEqual({
      issueKey: 'OH-101',
      removedFromVersionId: '123',
    })
  })

  it('moves the ticket to another unreleased version', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes('/rest/api/3/issue/OH-101') && url.includes('fields=')) {
        return new Response(
          JSON.stringify({
            key: 'OH-101',
            fields: { fixVersions: [{ id: '123', name: 'Current' }] },
          }),
        )
      }
      if (url.includes('/rest/api/3/project/') && url.includes('/version?')) {
        return new Response(
          JSON.stringify({
            isLast: true,
            values: [
              { id: '123', name: 'Current', overdue: false },
              { id: '456', name: 'Next', overdue: false },
            ],
          }),
        )
      }
      if (url.endsWith('/rest/api/3/issue/OH-101') && init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toEqual({
          update: {
            fixVersions: [
              { remove: { id: '123' } },
              { add: { id: '456' } },
            ],
          },
        })
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected Jira request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      removeIssueFromRelease(config, '123', 'oh-101', '456'),
    ).resolves.toEqual({
      issueKey: 'OH-101',
      removedFromVersionId: '123',
      addedToVersionId: '456',
    })
  })

  it('rejects tickets that are not on the release', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        new Response(
          JSON.stringify({
            key: 'OH-101',
            fields: { fixVersions: [{ id: '999', name: 'Other' }] },
          }),
        ),
      ),
    )

    await expect(
      removeIssueFromRelease(config, '123', 'OH-101'),
    ).rejects.toMatchObject({
      code: 'ISSUE_NOT_IN_RELEASE',
      status: 400,
    })
  })

  it('rejects moving into the same version', async () => {
    await expect(
      removeIssueFromRelease(config, '123', 'OH-101', '123'),
    ).rejects.toMatchObject({
      code: 'INVALID_TARGET_VERSION',
      status: 400,
    })
  })
})

describe('markVersionIssuesReleased', () => {
  it('transitions only the selected release tickets', async () => {
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

    const result = await markVersionIssuesReleased(config, '123', ['OH-101'])

    expect(result).toEqual({
      versionId: '123',
      total: 1,
      transitioned: ['OH-101'],
      alreadyReleased: [],
      failed: [],
    })
  })
})
