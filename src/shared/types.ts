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
  items: ReleaseItem[]
  eligibleCount: number
  blockedCount: number
  mergedCount: number
  backMergePending: boolean
  riskCheckFailed?: boolean
}

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
}

export type CreateProductionReleaseInput = {
  repository: string
  date: string
  operationId?: string
}

export type CreatedStagingRelease = {
  id: number
  repository: string
  environment: StagingEnvironment
  tag: string
  sourceBranch: 'dev'
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
  environment: StagingEnvironment
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
  buildStatus: BuildStatus
  runs: WorkflowRun[]
}

export type PromotionRoute = 'dev-to-release' | 'release-to-default'

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

export type BackMergeRoute = 'default-to-release' | 'release-to-dev'

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

export type RepositoryReleaseState = {
  repository: string
  defaultBranch: string
  stagingReleases: TrackedStagingRelease[]
  productionReleases: TrackedProductionRelease[]
  deployedTags: JenkinsDeployedTag[]
  deploymentLookupFailed: boolean
  productionReady: boolean
  promotionSteps: PromotionStep[]
  backMergeSteps: BackMergeStep[]
  pendingBackMerges: PendingBackMerge[]
  jenkinsServices: string[]
  fetchedAt: string
}

export type RepositoryReleaseHistory = {
  repository: string
  stagingReleases: TrackedStagingRelease[]
  productionReleases: TrackedProductionRelease[]
}

export type ServiceRefreshResult = {
  service: ServiceRelease
  repositoryState?: RepositoryReleaseState
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
}

export type MergePromotionPullRequestResult = {
  merged: boolean
  message: string
  sha?: string
}

export type MergeFeaturePullRequestInput = {
  repository: string
  pullNumber: number
}

export type DeploymentEnvironment = 'qa' | 's1' | 's2' | 's3' | 's4' | 's5'
export type JenkinsDeploymentEnvironment =
  | DeploymentEnvironment
  | 'production'

export type JenkinsDeployedTag = {
  service: string
  tag: string
  environment: JenkinsDeploymentEnvironment
  buildNumber: number
  buildUrl: string
  deployedAt: string
}

export type TriggerDeploymentInput = {
  repository: string
  service: string
  tag: string
  environment: DeploymentEnvironment
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
  jobName: string
  service: string
  imageTag: string
}

export type ApiErrorBody = {
  error: {
    code: string
    message: string
    provider?: 'jira' | 'github' | 'jenkins'
    retryable?: boolean
  }
}
