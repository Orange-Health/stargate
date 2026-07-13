import type {
  ApiErrorBody,
  ConnectionConfig,
  ConnectionStatus,
  CreatePromotionPullRequestInput,
  CreatedStagingRelease,
  CreateStagingReleaseInput,
  JiraVersion,
  JenkinsQueueStatus,
  MergePromotionPullRequestInput,
  MergePromotionPullRequestResult,
  PromotionPullRequest,
  ReleaseDashboard,
  RepositoryReleaseState,
  TriggerDeploymentInput,
  TriggeredDeployment,
} from './types.js'

export class ApiError extends Error {
  readonly code: string
  readonly provider?: string
  readonly retryable: boolean

  constructor(
    message: string,
    code: string,
    provider?: string,
    retryable = false,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.provider = provider
    this.retryable = retryable
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      | ApiErrorBody
      | undefined
    throw new ApiError(
      body?.error.message ?? `Request failed with status ${response.status}.`,
      body?.error.code ?? 'REQUEST_FAILED',
      body?.error.provider,
      body?.error.retryable,
    )
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const api = {
  connection: () => request<ConnectionStatus>('/api/connection'),
  connect: (config: ConnectionConfig) =>
    request<ConnectionStatus>('/api/connection', {
      method: 'POST',
      body: JSON.stringify(config),
    }),
  disconnect: () =>
    request<void>('/api/connection', {
      method: 'DELETE',
    }),
  releases: () => request<JiraVersion[]>('/api/releases'),
  dashboard: (versionId: string, refresh = false) =>
    request<ReleaseDashboard>(
      `/api/releases/${encodeURIComponent(versionId)}/dashboard${refresh ? '?refresh=true' : ''}`,
    ),
  createStagingRelease: (input: CreateStagingReleaseInput) =>
    request<CreatedStagingRelease>('/api/github/staging-releases', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  repositoryState: (repository: string) =>
    request<RepositoryReleaseState>(
      `/api/github/repository-state?repository=${encodeURIComponent(repository)}`,
    ),
  createPromotionPullRequest: (input: CreatePromotionPullRequestInput) =>
    request<PromotionPullRequest>('/api/github/promotion-pull-requests', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  mergePromotionPullRequest: (input: MergePromotionPullRequestInput) =>
    request<MergePromotionPullRequestResult>(
      '/api/github/promotion-pull-requests/merge',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
  triggerDeployment: (input: TriggerDeploymentInput) =>
    request<TriggeredDeployment>('/api/jenkins/deployments', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  jenkinsQueueStatus: (queueId: number) =>
    request<JenkinsQueueStatus>(`/api/jenkins/queue/${queueId}`),
}
