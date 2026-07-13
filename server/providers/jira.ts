import type {
  ConnectionConfig,
  JiraIssue,
  JiraVersion,
} from '../../src/shared/types.js'
import { providerResponseError } from '../errors.js'

type JiraVersionResponse = {
  isLast: boolean
  nextPage?: string
  values: Array<{
    id: string
    name: string
    description?: string
    startDate?: string
    releaseDate?: string
    overdue?: boolean
    issuesStatusForFixVersion?: Record<string, number>
  }>
}

type JiraSearchResponse = {
  issues: Array<{
    key: string
    fields: {
      summary: string
      status?: { name?: string }
      assignee?: { displayName?: string }
      customfield_10000?: string
    }
  }>
  nextPageToken?: string
  isLast?: boolean
}

function jiraHeaders(config: ConnectionConfig) {
  const auth = Buffer.from(`${config.jiraEmail}:${config.jiraToken}`).toString(
    'base64',
  )
  return {
    Accept: 'application/json',
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/json',
  }
}

function jiraUrl(config: ConnectionConfig, path: string) {
  return `${config.jiraSite.replace(/\/+$/, '')}${path}`
}

async function jiraFetch<T>(
  config: ConnectionConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(jiraUrl(config, path), {
    ...init,
    headers: {
      ...jiraHeaders(config),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(20_000),
  })

  if (!response.ok) {
    throw await providerResponseError(response, 'jira')
  }

  return (await response.json()) as T
}

export async function testJiraConnection(config: ConnectionConfig) {
  return jiraFetch<{ displayName: string }>(config, '/rest/api/3/myself')
}

export async function listUnreleasedVersions(
  config: ConnectionConfig,
): Promise<JiraVersion[]> {
  const project = encodeURIComponent(config.jiraProject ?? 'OH')
  let startAt = 0
  const versions: JiraVersion[] = []

  while (true) {
    const query = new URLSearchParams({
      status: 'unreleased',
      orderBy: '-releaseDate',
      startAt: String(startAt),
      maxResults: '50',
      expand: 'issuesstatus',
    })
    const page = await jiraFetch<JiraVersionResponse>(
      config,
      `/rest/api/3/project/${project}/version?${query}`,
    )
    versions.push(
      ...page.values.map((version) => ({
        id: version.id,
        name: version.name,
        description: version.description,
        startDate: version.startDate,
        releaseDate: version.releaseDate,
        overdue: Boolean(version.overdue),
        issueCount: version.issuesStatusForFixVersion
          ? Object.values(version.issuesStatusForFixVersion).reduce(
              (sum, count) => sum + count,
              0,
            )
          : undefined,
      })),
    )

    if (page.isLast || page.values.length === 0) break
    startAt += page.values.length
  }

  return versions.sort((a, b) => {
    const left = a.releaseDate ?? a.startDate ?? ''
    const right = b.releaseDate ?? b.startDate ?? ''
    return right.localeCompare(left)
  })
}

export async function getVersion(
  config: ConnectionConfig,
  versionId: string,
): Promise<JiraVersion> {
  const version = await jiraFetch<{
    id: string
    name: string
    description?: string
    startDate?: string
    releaseDate?: string
    overdue?: boolean
  }>(config, `/rest/api/3/version/${encodeURIComponent(versionId)}`)

  return {
    ...version,
    overdue: Boolean(version.overdue),
  }
}

export async function listVersionIssues(
  config: ConnectionConfig,
  versionId: string,
): Promise<JiraIssue[]> {
  let nextPageToken: string | undefined
  const issues: JiraIssue[] = []

  do {
    const body = {
      jql: `project = "${(config.jiraProject ?? 'OH').replaceAll('"', '\\"')}" AND fixVersion = ${Number(versionId)}`,
      fields: [
        'summary',
        'status',
        'assignee',
        'customfield_10000',
      ],
      maxResults: 100,
      ...(nextPageToken ? { nextPageToken } : {}),
    }
    const page = await jiraFetch<JiraSearchResponse>(
      config,
      '/rest/api/3/search/jql',
      { method: 'POST', body: JSON.stringify(body) },
    )
    issues.push(
      ...page.issues.map((issue) => ({
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status?.name ?? 'Unknown',
        assignee: issue.fields.assignee?.displayName,
        url: `${config.jiraSite.replace(/\/+$/, '')}/browse/${issue.key}`,
        developmentSummary: issue.fields.customfield_10000,
      })),
    )
    nextPageToken = page.isLast ? undefined : page.nextPageToken
  } while (nextPageToken)

  return issues
}
