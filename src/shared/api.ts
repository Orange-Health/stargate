import type {
  ApiErrorBody,
  ConnectionConfig,
  ConnectionStatus,
  CreateBackMergePullRequestInput,
  CreatedProductionRelease,
  CreatePromotionPullRequestInput,
  CreatedStagingRelease,
  CreateStagingReleaseInput,
  CreateProductionReleaseInput,
  DashboardProgress,
  DeploymentFreshness,
  JiraVersion,
  JenkinsQueueStatus,
  MergeFeaturePullRequestInput,
  MergePromotionPullRequestInput,
  MergePromotionPullRequestResult,
  OrganizationRepository,
  PromotionPullRequest,
  ReleaseBuildStatusInput,
  ReleaseBuildStatusResult,
  ReleaseControlRoomState,
  ReleaseDashboard,
  RepositoryDeploymentStatus,
  RepositoryReleaseData,
  RepositoryReleaseHistory,
  RepositoryReleaseState,
  RepositoryPullRequestList,
  RepositoryRisk,
  ServiceRefreshResult,
  TriggerDeploymentInput,
  TriggerProductionDeploymentInput,
  TriggeredDeployment,
  TriggeredProductionDeployment,
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
  repositories: () =>
    request<OrganizationRepository[]>('/api/github/repositories'),
  repositoryBranches: (repository: string) =>
    request<string[]>(
      `/api/github/repository-branches?repository=${encodeURIComponent(repository)}`,
    ),
  repositoryPullRequests: (
    repository: string,
    options: {
      state?: 'open' | 'closed' | 'all'
      base?: string
      author?: string
      page?: number
    } = {},
  ) => {
    const query = new URLSearchParams({
      repository,
      state: options.state ?? 'open',
      page: String(options.page ?? 1),
    })
    if (options.base) query.set('base', options.base)
    if (options.author) query.set('author', options.author)
    return request<RepositoryPullRequestList>(
      `/api/github/repository-pull-requests?${query}`,
    )
  },
  repositoryPullRequestAuthors: (repository: string) =>
    request<string[]>(
      `/api/github/repository-pull-request-authors?repository=${encodeURIComponent(repository)}`,
    ),
  dashboard: (
    versionId: string,
    refresh = false,
    progressId?: string,
  ) => {
    const query = new URLSearchParams()
    if (refresh) query.set('refresh', 'true')
    if (progressId) query.set('progressId', progressId)
    const suffix = query.size > 0 ? `?${query}` : ''
    return request<ReleaseDashboard>(
      `/api/releases/${encodeURIComponent(versionId)}/dashboard${suffix}`,
    )
  },
  dashboardProgress: (progressId: string) =>
    request<DashboardProgress>(
      `/api/releases/dashboard-progress/${encodeURIComponent(progressId)}`,
    ),
  createStagingRelease: (input: CreateStagingReleaseInput) =>
    request<CreatedStagingRelease>('/api/github/staging-releases', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  createProductionRelease: (input: CreateProductionReleaseInput) =>
    request<CreatedProductionRelease>('/api/github/production-releases', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  repositoryState: (repository: string, includeAllVReleases = false) =>
    request<RepositoryReleaseState>(
      `/api/github/repository-state?repository=${encodeURIComponent(repository)}${includeAllVReleases ? '&includeAllVReleases=true' : ''}`,
    ),
  releaseControlState: (repository: string) =>
    request<ReleaseControlRoomState>(
      `/api/github/release-control-state?repository=${encodeURIComponent(repository)}`,
    ),
  releaseHistory: (repository: string, includeAllVReleases = false) =>
    request<RepositoryReleaseHistory>(
      `/api/github/release-history?repository=${encodeURIComponent(repository)}${includeAllVReleases ? '&includeAllVReleases=true' : ''}`,
    ),
  repositoryReleaseData: (repository: string, includeAllVReleases = false) =>
    request<RepositoryReleaseData>(
      `/api/github/release-history?repository=${encodeURIComponent(repository)}${includeAllVReleases ? '&includeAllVReleases=true' : ''}`,
    ),
  releaseBuildStatuses: (
    releases: ReleaseBuildStatusInput[],
    forceRefresh = false,
  ) =>
    request<ReleaseBuildStatusResult[]>(
      '/api/github/release-build-statuses',
      {
        method: 'POST',
        body: JSON.stringify({ releases, forceRefresh }),
      },
    ),
  repositoryDeploymentStatus: (repository: string, forceRefresh = false) =>
    request<RepositoryDeploymentStatus>(
      `/api/jenkins/deployment-status?repository=${encodeURIComponent(repository)}${forceRefresh ? '&forceRefresh=true' : ''}`,
    ),
  repositoryRisks: (repositories: string[]) =>
    request<RepositoryRisk[]>('/api/github/repository-risks', {
      method: 'POST',
      body: JSON.stringify({ repositories }),
    }),
  deploymentFreshness: (repositories: string[]) =>
    request<DeploymentFreshness[]>('/api/deployment-freshness', {
      method: 'POST',
      body: JSON.stringify({ repositories }),
    }),
  refreshRepository: (repository: string) =>
    request<void>('/api/github/repository-refresh', {
      method: 'POST',
      body: JSON.stringify({ repository }),
    }),
  refreshService: (
    versionId: string,
    repository: string,
    issueKeys: string[],
    includeRepositoryState = true,
  ) =>
    request<ServiceRefreshResult>(
      `/api/releases/${encodeURIComponent(versionId)}/service-refresh`,
      {
        method: 'POST',
        body: JSON.stringify({
          repository,
          issueKeys,
          includeRepositoryState,
        }),
      },
    ),
  createPromotionPullRequest: (input: CreatePromotionPullRequestInput) =>
    request<PromotionPullRequest>('/api/github/promotion-pull-requests', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  createBackMergePullRequest: (input: CreateBackMergePullRequestInput) =>
    request<PromotionPullRequest>('/api/github/back-merge-pull-requests', {
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
  mergeBackMergePullRequest: (input: MergePromotionPullRequestInput) =>
    request<MergePromotionPullRequestResult>(
      '/api/github/back-merge-pull-requests/merge',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
  mergeFeaturePullRequest: (input: MergeFeaturePullRequestInput) =>
    request<MergePromotionPullRequestResult>(
      '/api/github/feature-pull-requests/merge',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
  mergeRepositoryPullRequest: (input: MergePromotionPullRequestInput) =>
    request<MergePromotionPullRequestResult>(
      '/api/github/repository-pull-requests/merge',
      {
        method: 'POST',
        body: JSON.stringify({
          repository: input.repository,
          pullNumber: input.pullNumber,
        }),
      },
    ),
  triggerDeployment: (input: TriggerDeploymentInput) =>
    request<TriggeredDeployment>('/api/jenkins/deployments', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  jenkinsQueueStatus: (queueId: number) =>
    request<JenkinsQueueStatus>(`/api/jenkins/queue/${queueId}`),
  triggerProductionDeployment: (input: TriggerProductionDeploymentInput) =>
    request<TriggeredProductionDeployment>(
      '/api/jenkins/production-deployments',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
  productionJenkinsQueueStatus: (queueId: number) =>
    request<JenkinsQueueStatus>(
      `/api/jenkins/production-queue/${queueId}`,
    ),
}
