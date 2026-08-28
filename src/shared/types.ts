export type ConnectionConfig = {
  jiraSite: string
  jiraEmail: string
  jiraToken: string
  githubOrg: string
  githubToken: string
  jenkinsUrl: string
  jenkinsUsername: string
  jenkinsToken: string
  productionJenkins?: {
    jenkinsUrl: string
    jenkinsUsername: string
    jenkinsToken: string
  }
  jiraProject?: string
}

export type ConnectionStatus = {
  connected: boolean
  jiraUser?: string
  githubUser?: string
  jenkinsUser?: string
  githubOrg?: string
  projectKey?: string
  productionEnabled?: boolean
  jiraSite?: string
  jiraEmail?: string
  jenkinsUrl?: string
  jenkinsUsername?: string
  productionJenkinsUrl?: string
  productionJenkinsUsername?: string
}

export type AuthSession = {
  authenticated: boolean
  email: string
  displayName?: string
  authDisabled: boolean
}

export type JiraVersion = {
  id: string
  name: string
  description?: string
  startDate?: string
  releaseDate?: string
  overdue: boolean
  issueCount?: number
}

export type JiraIssue = {
  key: string
  summary: string
  status: string
  assignee?: string
  url: string
  developmentSummary?: string
}

export type MarkReleaseIssuesReleasedResult = {
  versionId: string
  total: number
  transitioned: string[]
  alreadyReleased: string[]
  failed: Array<{ key: string; message: string }>
}

export type RemoveReleaseIssueResult = {
  issueKey: string
  removedFromVersionId: string
  addedToVersionId?: string
}

export type ReviewDecision =
  | 'approved'
  | 'changes_requested'
  | 'review_required'

export type CheckStatus = 'success' | 'failure' | 'pending' | 'none'

export type PullRequest = {
  id: number
  number: number
  repository: string
  title: string
  url: string
  state: 'open' | 'closed'
  draft: boolean
  merged: boolean
  baseBranch: string
  headBranch: string
  author: string
  assignees: string[]
  reviewDecision: ReviewDecision
  mergeable: boolean | null
  mergeableState: string
  checks: CheckStatus
  unresolvedReviewThreads?: number
  updatedAt: string
  participants?: Array<{
    login: string
    avatarUrl: string
    role: 'author' | 'assignee' | 'reviewer'
  }>
}

export type EligibilityReason =
  | 'NO_MATCHING_PR'
  | 'WRONG_BASE_BRANCH'
  | 'REVIEW_REQUIRED'
  | 'CHANGES_REQUESTED'
  | 'UNRESOLVED_COMMENTS'
  | 'HAS_CONFLICTS'
  | 'MERGEABILITY_PENDING'
  | 'CHECKS_PENDING'
  | 'CHECKS_FAILED'
  | 'DRAFT'
  | 'ALREADY_MERGED'

export type ReleaseItem = {
  issue: JiraIssue
  pullRequest?: PullRequest
  eligible: boolean
  blockingReasons: EligibilityReason[]
  warningReasons: EligibilityReason[]
}

export type ServiceRelease = {
  repository: string
  defaultBranch?: string
  items: ReleaseItem[]
  eligibleCount: number
  blockedCount: number
  mergedCount: number
  backMergePending: boolean
  riskCheckFailed?: boolean
}

export type OrganizationRepository = {
  repository: string
  name: string
  defaultBranch: string
  url: string
  archived: boolean
  private: boolean
}

export type RepositoryPullRequest = {
  number: number
  title: string
  url: string
  state: 'open' | 'closed'
  draft: boolean
  merged: boolean
  author: string
  headBranch: string
  baseBranch: string
  updatedAt: string
}

export type RepositoryPullRequestList = {
  repository: string
  defaultBranch: string
  items: RepositoryPullRequest[]
  page: number
  hasMore: boolean
}

export const ALL_SERVICES_ID = 'all-services'

export type ProviderWarning = {
  provider: 'jira' | 'github' | 'jenkins'
  message: string
}

export type RateLimit = {
  remaining: number
  limit: number
  resetsAt: string
}

export type ReleaseDashboard = {
  version: JiraVersion
  services: ServiceRelease[]
  unmatched: ReleaseItem[]
  warnings: ProviderWarning[]
  githubRateLimit?: RateLimit
  fetchedAt: string
  cached: boolean
}

export type DashboardProgress = {
  phase: 'starting' | 'jira' | 'github-search' | 'github-details' | 'mapping'
  message: string
  current?: number
  total?: number
}

export type StagingEnvironment = 'qa' | 's1' | 's2' | 's3' | 's4' | 's5' | 's6'

export type CreateStagingReleaseInput = {
  repository: string
  environment: StagingEnvironment
  date: string
  sourceBranch?: string
}

export type StagingTagListInput = {
  repositories: string[]
  environment?: StagingEnvironment
  date: string
}

export type RepositoryStagingTags = {
  repository: string
  tags: string[]
  checkFailed: boolean
}

export type ProductionReleaseMode = 'release-day' | 'patch'

export type CreateProductionReleaseInput = {
  repository: string
  /** Required when mode is `release-day`. Ignored for `patch`. */
  date?: string
  /**
   * `release-day` builds a date-based tag (vYY.MMDD.N).
   * `patch` increments N on the latest existing production tag.
   * Defaults to `release-day` when `date` is provided, otherwise `patch`.
   */
  mode?: ProductionReleaseMode
  operationId?: string
}

export type CreatedStagingRelease = {
  id: number
  repository: string
  environment: StagingEnvironment
  tag: string
  sourceBranch: string
  url: string
  createdAt: string
}

export type CreatedProductionRelease = {
  id: number
  repository: string
  tag: string
  sourceBranch: string
  url: string
  createdAt: string
}

export type BuildStatus =
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export type WorkflowRun = {
  id: number
  name: string
  status: string
  conclusion?: string
  url: string
  startedAt: string
  updatedAt: string
}

export type ReleaseBuildStatusInput = {
  repository: string
  tag: string
  createdAt: string
}

export type ReleaseBuildStatusResult = ReleaseBuildStatusInput & {
  buildStatus: BuildStatus
  runs: WorkflowRun[]
}

export type TrackedStagingRelease = {
  id: number
  tag: string
  environment: StagingEnvironment | 'custom'
  url: string
  createdAt: string
  buildStatus: BuildStatus
  runs: WorkflowRun[]
}

export type TrackedProductionRelease = {
  id: number
  tag: string
  url: string
  createdAt: string
  description?: string
  buildStatus: BuildStatus
  runs: WorkflowRun[]
}

export type PromotionRoute =
  | 'dev-to-release'
  | 'release-to-default'
  | 'dev-to-default'

export type PromotionPullRequest = {
  number: number
  title: string
  body?: string
  url: string
  baseBranch: string
  headBranch: string
  draft: boolean
  mergeable: boolean | null
  mergeableState: string
  reviewDecision: ReviewDecision
  checks: CheckStatus
  unresolvedReviewThreads?: number
  resolution?: 'existing' | 'created'
}

export type PromotionStep = {
  route: PromotionRoute
  fromBranch: string
  toBranch: string
  commitsAhead: number
  commitsBehind: number
  filesChanged?: number
  state: 'up_to_date' | 'needs_pr' | 'pr_open'
  pullRequest?: PromotionPullRequest
  previousTemplate?: {
    title: string
    body?: string
    url: string
  }
}

export type PendingBackMerge = {
  number: number
  title: string
  url: string
  fromBranch: string
  toBranch: string
}

export type BackMergeRoute =
  | 'default-to-release'
  | 'release-to-dev'
  | 'default-to-dev'

export type BackMergeStep = {
  route: BackMergeRoute
  fromBranch: string
  toBranch: string
  commitsAhead: number
  commitsBehind: number
  filesChanged?: number
  state: 'up_to_date' | 'needs_pr' | 'pr_open'
  pullRequest?: PromotionPullRequest
}

export type LatestProductionTagDelta = {
  tag: string
  commitsAhead: number
  filesChanged: number
  hasSourceChanges: boolean
}

export type RepositoryReleaseState = {
  repository: string
  defaultBranch: string
  stagingReleases: TrackedStagingRelease[]
  productionReleases: TrackedProductionRelease[]
  latestProductionTagDelta?: LatestProductionTagDelta
  deployedTags: JenkinsDeployedTag[]
  deploymentLookupFailed: boolean
  productionReady: boolean
  promotionSteps: PromotionStep[]
  backMergeSteps: BackMergeStep[]
  pendingBackMerges: PendingBackMerge[]
  jenkinsServices: string[]
  fetchedAt: string
}

export type ReleaseControlRoomState = Pick<
  RepositoryReleaseState,
  | 'repository'
  | 'defaultBranch'
  | 'productionReleases'
  | 'latestProductionTagDelta'
  | 'deployedTags'
  | 'deploymentLookupFailed'
  | 'productionReady'
  | 'promotionSteps'
  | 'jenkinsServices'
  | 'fetchedAt'
> & {
  /** True while workflow runs / tag-delta enrichment is still pending. */
  partial?: boolean
}

export type ReleaseControlSyncError = {
  code: string
  message: string
  provider?: 'jira' | 'github' | 'jenkins'
  retryable: boolean
}

export type ReleaseControlSyncResult = {
  repository: string
  state?: ReleaseControlRoomState
  error?: ReleaseControlSyncError
}

export type ReleaseControlSyncStats = {
  durationMs: number
  cacheHits: number
  graphqlRequests: number
  restRequests: number
  fallbackCount: number
}

export type ReleaseControlSyncResponse = {
  results: ReleaseControlSyncResult[]
  fetchedAt: string
  stats: ReleaseControlSyncStats
  githubRateLimit?: RateLimit
}

export type ReleaseControlProviderSyncStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'

export type ReleaseControlSyncStep =
  | 'queued'
  | 'github-metadata'
  | 'github-branches'
  | 'github-fallback'
  | 'github-ready'
  | 'github-failed'
  | 'jenkins-loading'
  | 'jenkins-ready'
  | 'jenkins-failed'
  | 'complete'

export type ReleaseControlServiceSyncProgress = {
  repository: string
  status: 'queued' | 'syncing' | 'synced' | 'failed'
  stage: 'queued' | 'github' | 'jenkins' | 'complete'
  step: ReleaseControlSyncStep
  githubStep: ReleaseControlSyncStep
  jenkinsStep: ReleaseControlSyncStep
  message: string
  /** Fractional completion for this service, from 0 to 1. */
  weight: number
  github: ReleaseControlProviderSyncStatus
  jenkins: ReleaseControlProviderSyncStatus
  /** Latest known control-room state for progressive UI unlock. */
  state?: ReleaseControlRoomState
  updatedAt: string
}

export type ReleaseControlSyncProgress = {
  progressId: string
  status: 'running' | 'completed'
  total: number
  completed: number
  /** Aggregate 0–100 progress across weighted service steps. */
  percent: number
  services: ReleaseControlServiceSyncProgress[]
  updatedAt: string
}

export type RepositoryReleaseHistory = {
  repository: string
  stagingReleases: TrackedStagingRelease[]
  productionReleases: TrackedProductionRelease[]
  hasMoreStaging: boolean
  hasMoreProduction: boolean
}

export type RepositoryReleaseData = RepositoryReleaseHistory &
  RepositoryDeploymentStatus & {
    jenkinsServices: string[]
    fetchedAt: string
  }

export type ServiceRefreshResult = {
  service: ServiceRelease
  repositoryState?: RepositoryReleaseState
}

export type TicketRefreshResult = {
  items: ReleaseItem[]
}

export type RepositoryRisk = {
  repository: string
  backMergePending: boolean
  backMergeOutdated: boolean
  checkFailed: boolean
}

export type DeploymentFreshness = {
  repository: string
  latestBuiltQaTag?: string
  liveQaTags: string[]
  jenkinsServices: string[]
  outdated: boolean
  checkFailed: boolean
}

export type CreatePromotionPullRequestInput = {
  repository: string
  route: PromotionRoute
}

export type CreateBackMergePullRequestInput = {
  repository: string
  route: BackMergeRoute
}

export type MergePromotionPullRequestInput = {
  repository: string
  pullNumber: number
  bypassBranchProtection?: boolean
}

export type MergePromotionPullRequestResult = {
  merged: boolean
  message: string
  sha?: string
}

export type MergeFeaturePullRequestInput = {
  repository: string
  pullNumber: number
  retargetToDev?: boolean
  bypassBranchProtection?: boolean
}

export type DeploymentEnvironment = 'qa' | 's1' | 's2' | 's3' | 's4' | 's5'
export type JenkinsDeploymentEnvironment =
  | DeploymentEnvironment
  | 'production'

export type JenkinsPipelineStageStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export type JenkinsPipelineStage = {
  id: string
  name: string
  status: JenkinsPipelineStageStatus
  durationMillis?: number
}

export type JenkinsDeployedTag = {
  service: string
  tag: string
  environment: JenkinsDeploymentEnvironment
  status?: 'running' | 'succeeded' | 'failed' | 'canceled'
  buildNumber: number
  buildUrl: string
  deployedAt: string
  jobName?: string
  stages?: JenkinsPipelineStage[]
  currentStage?: string
}

export type RepositoryDeploymentStatus = {
  deployedTags: JenkinsDeployedTag[]
  deploymentLookupFailed: boolean
}

export type RepositoryDeploymentStatusResult = RepositoryDeploymentStatus & {
  repository: string
}

export type RepositoryDeploymentStatusResponse = {
  results: RepositoryDeploymentStatusResult[]
  fetchedAt: string
}

export type TriggerDeploymentInput = {
  repository: string
  service: string
  tag: string
  environment: DeploymentEnvironment
  allowAnyVTag?: boolean
}

export type TriggeredDeployment = {
  queueId: number
  queueUrl: string
  buildUrl?: string
  jobName: string
  service: string
  tag: string
  environment: DeploymentEnvironment
}

export type JenkinsQueueStatus = {
  queueId: number
  status: 'queued' | 'started' | 'canceled'
  buildUrl?: string
  buildNumber?: number
  message?: string
}

export type JenkinsBuildStatus = {
  buildNumber: number
  status: 'running' | 'succeeded' | 'failed' | 'canceled'
  buildUrl?: string
}

export type TriggerProductionDeploymentInput = {
  repository: string
  service: string
  imageTag: string
  qaApprovalRequired: boolean
  qaName?: string
  skipProdMigration: boolean
  prodMigrationJob: string
}

export type TriggeredProductionDeployment = {
  queueId: number
  queueUrl: string
  buildUrl?: string
  buildNumber?: number
  jobName: string
  service: string
  imageTag: string
}

export type EitriNamespace = Exclude<DeploymentEnvironment, 'qa'>

export type TriggerEitriDeploymentInput = {
  repository: string
  service: string
  namespace: EitriNamespace
  branch?: string
  commitSha?: string
  stagingEnvUpdateJob?: string
}

export type TriggeredEitriDeployment = {
  queueId: number
  queueUrl: string
  buildUrl?: string
  buildNumber?: number
  jobName: string
  service: string
  namespace: EitriNamespace
  branch?: string
  commitSha?: string
  stagingEnvUpdateJob: string
}

export type EitriStageStatus = JenkinsPipelineStageStatus
export type EitriBuildStage = JenkinsPipelineStage

export type EitriBuild = {
  buildNumber: number
  buildUrl: string
  service: string
  namespace: EitriNamespace
  branch?: string
  commitSha?: string
  stagingEnvUpdateJob?: string
  status: 'running' | 'succeeded' | 'failed' | 'canceled'
  createdAt: string
  stages?: JenkinsPipelineStage[]
  currentStage?: string
}

export type EitriBuildsResult = {
  repository: string
  jenkinsServices: string[]
  builds: EitriBuild[]
  lookupFailed: boolean
  fetchedAt: string
}

export type ApiErrorBody = {
  error: {
    code: string
    message: string
    provider?: 'jira' | 'github' | 'jenkins'
    retryable?: boolean
  }
}
