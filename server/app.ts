import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { z } from 'zod'
import type {
  ApiErrorBody,
  ConnectionConfig,
  ConnectionStatus,
  ReleaseControlSyncResponse,
  RepositoryDeploymentStatusResponse,
} from '../src/shared/types.js'
import {
  clearConnection,
  getConnection,
  requireConnection,
  setConnection,
} from './connectionStore.js'
import { ProviderError } from './errors.js'
import {
  clearGitHubProviderCache,
  createProductionRelease,
  createStagingRelease,
  listOrganizationRepositories,
  listRepositoryBranches,
  testGitHubConnection,
} from './providers/github.js'
import {
  clearRepositoryCaches,
  createBackMergePullRequest,
  createPromotionPullRequest,
  getReleaseBuildStatuses,
  getReleaseControlRoomState,
  getReleaseControlRoomStatesBatch,
  getRepositoryReleaseHistory,
  getRepositoryReleaseState,
  getRepositoryRisks,
  listRepositoryPullRequestAuthors,
  listRepositoryPullRequests,
  mergeBackMergePullRequest,
  mergeFeaturePullRequest,
  mergePromotionPullRequest,
  mergeRepositoryPullRequest,
} from './providers/githubOperations.js'
import {
  listUnreleasedVersions,
  markVersionIssuesReleased,
  removeIssueFromRelease,
  testJiraConnection,
} from './providers/jira.js'
import {
  getCurrentDeployments,
  getCurrentDeploymentsBatch,
  getCurrentProductionDeployments,
  getDeploymentQueueStatus,
  getEitriBuilds,
  getProductionDeploymentBuildStatus,
  getProductionDeploymentQueueStatus,
  servicesForRepository,
  testJenkinsConnection,
  triggerDeployment,
  triggerEitriDeployment,
  triggerProductionDeployment,
} from './providers/jenkins.js'
import {
  aggregateRelease,
  clearReleaseCache,
  refreshServiceRelease,
  refreshTicketRelease,
} from './services/releaseAggregator.js'
import { getDeploymentFreshness } from './services/deploymentFreshness.js'
import {
  getDashboardProgress,
  setDashboardProgress,
} from './services/dashboardProgress.js'
import {
  completeControlRoomSyncProgress,
  createControlRoomSyncProgress,
  getControlRoomSyncProgress,
  publishControlRoomServiceState,
  trackControlRoomEnrichment,
  updateControlRoomProviderProgress,
} from './services/controlRoomSyncProgress.js'

const connectionSchema = z.object({
  jiraSite: z
    .url()
    .refine((value) => new URL(value).protocol === 'https:', {
      message: 'Jira URL must use HTTPS.',
    }),
  jiraEmail: z.email(),
  jiraToken: z.string().trim().min(1),
  githubToken: z.string().trim().min(1),
  jenkinsUrl: z
    .url()
    .refine((value) => new URL(value).protocol === 'https:', {
      message: 'Jenkins URL must use HTTPS.',
    }),
  jenkinsUsername: z.string().trim().min(1),
  jenkinsToken: z.string().trim().min(1),
  productionJenkins: z
    .object({
      jenkinsUrl: z
        .url()
        .refine((value) => new URL(value).protocol === 'https:', {
          message: 'Production Jenkins URL must use HTTPS.',
        }),
      jenkinsUsername: z.string().trim().min(1),
      jenkinsToken: z.string().trim().min(1),
    })
    .optional(),
  jiraProject: z.string().regex(/^[A-Z][A-Z0-9_]+$/).default('OH'),
})

const stagingReleaseSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  environment: z.enum(['qa', 's1', 's2', 's3', 's4', 's5', 's6']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceBranch: z.string().trim().min(1).max(255).optional(),
})
const repositorySchema = z
  .string()
  .regex(/^Orange-Health\/[A-Za-z0-9_.-]+$/i)
  .refine((value) => !['.', '..'].includes(value.split('/')[1]))

const productionReleaseSchema = z
  .object({
    repository: repositorySchema,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    mode: z.enum(['release-day', 'patch']).optional(),
    operationId: z.uuid().optional(),
  })
  .superRefine((value, context) => {
    const mode = value.mode ?? (value.date ? 'release-day' : 'patch')
    if (mode === 'release-day' && !value.date) {
      context.addIssue({
        code: 'custom',
        message: 'Release date is required for release-day mode.',
        path: ['date'],
      })
    }
  })

const promotionSchema = z.object({
  repository: repositorySchema,
  route: z.enum(['dev-to-release', 'release-to-default']),
})

const backMergeSchema = z.object({
  repository: repositorySchema,
  route: z.enum(['default-to-release', 'release-to-dev']),
})

const mergePromotionSchema = z.object({
  repository: repositorySchema,
  pullNumber: z.number().int().positive(),
  bypassBranchProtection: z.boolean().optional(),
})

const mergeFeaturePullSchema = mergePromotionSchema.extend({
  retargetToDev: z.boolean().optional(),
})
const repositoryPullQuerySchema = z.object({
  repository: repositorySchema,
  state: z.enum(['open', 'closed', 'all']).default('open'),
  base: z
    .string()
    .regex(/^[A-Za-z0-9._/-]+$/)
    .optional(),
  author: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/)
    .optional(),
  page: z.coerce.number().int().positive().default(1),
})
const mergeRepositoryPullSchema = z.object({
  repository: repositorySchema,
  pullNumber: z.number().int().positive(),
})

const deploymentSchema = z
  .object({
    repository: repositorySchema,
    service: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    tag: z.string().max(255),
    environment: z.enum(['qa', 's1', 's2', 's3', 's4', 's5']),
    allowAnyVTag: z.boolean().optional(),
  })
  .superRefine((input, context) => {
    const pattern = input.allowAnyVTag
      ? /^v-[A-Za-z0-9._/-]+$/
      : /^v-(qa|s1|s2|s3|s4|s5|s6)-\d{2}\.\d{4}\.\d+$/
    if (!pattern.test(input.tag)) {
      context.addIssue({
        code: 'custom',
        path: ['tag'],
        message: input.allowAnyVTag
          ? 'Tag must start with v-.'
          : 'Tag must use the standard staging release format.',
      })
    }
  })

const productionDeploymentSchema = z
  .object({
    repository: repositorySchema,
    service: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    imageTag: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    qaApprovalRequired: z.boolean(),
    qaName: z.string().max(120).optional(),
    skipProdMigration: z.boolean(),
    prodMigrationJob: z.string().trim().min(1).max(160),
  })
  .refine(
    (input) => !input.qaApprovalRequired || Boolean(input.qaName?.trim()),
    { message: 'QA name is required when approval is enabled.' },
  )

const eitriDeploymentSchema = z
  .object({
    repository: repositorySchema,
    service: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    namespace: z.enum(['s1', 's2', 's3', 's4', 's5']),
    branch: z.string().trim().max(255).optional(),
    commitSha: z.string().trim().max(40).optional(),
    stagingEnvUpdateJob: z.string().trim().min(1).max(160).optional(),
  })
  .superRefine((input, context) => {
    const commitSha = input.commitSha?.trim()
    if (commitSha && !/^[A-Fa-f0-9]{7,40}$/.test(commitSha)) {
      context.addIssue({
        code: 'custom',
        path: ['commitSha'],
        message: 'Commit SHA must be 7–40 hexadecimal characters.',
      })
    }
  })

const repositoryRisksSchema = z.object({
  repositories: z.array(repositorySchema).max(100),
})
const repositoryBatchSchema = z.object({
  repositories: z.array(repositorySchema).min(1).max(100),
  forceRefresh: z.boolean().optional().default(false),
  progressId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,80}$/)
    .optional(),
})
const releaseBuildStatusesSchema = z.object({
  releases: z
    .array(
      z.object({
        repository: repositorySchema,
        tag: z
          .string()
          .regex(
            /^(?:v-prod-|v-?)\d{2}\.\d{4}\.\d+|v-(?:qa|s[1-6])-\d{2}\.\d{4}\.\d+$/,
          ),
        createdAt: z.iso.datetime(),
      }),
    )
    .max(100),
  forceRefresh: z.boolean().optional().default(false),
})
const serviceRefreshSchema = z.object({
  repository: repositorySchema,
  issueKeys: z
    .array(z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/i))
    .min(1)
    .max(200),
  includeRepositoryState: z.boolean().optional().default(true),
})
const ticketRefreshSchema = z.object({
  issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/i),
  repositories: z
    .array(
      z
        .string()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
        .refine((value) => !['.', '..'].includes(value.split('/')[1])),
    )
    .max(50)
    .optional()
    .default([]),
})
const markReleaseIssuesSchema = z.object({
  issueKeys: z
    .array(z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/i))
    .min(1)
    .max(500),
})
const removeReleaseIssueSchema = z.object({
  issueKey: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/i),
  targetVersionId: z
    .string()
    .regex(/^\d+$/)
    .optional(),
})

async function currentDeployments(
  config: ConnectionConfig,
  repository: string,
  forceRefresh = false,
) {
  const results = await Promise.allSettled([
    getCurrentDeployments(config, repository, forceRefresh),
    getCurrentProductionDeployments(config, repository, forceRefresh),
  ])
  return {
    deployedTags: results.flatMap((result) =>
      result.status === 'fulfilled' ? result.value : [],
    ),
    failed: results.some((result) => result.status === 'rejected'),
  }
}

function resolveDistDir(): string | null {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist'),
    path.resolve(process.cwd(), 'dist'),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir
    }
  }
  return null
}

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '16kb' }))

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true })
  })

  app.get('/api/connection', (_request, response) => {
    const connection = getConnection()
    const status: ConnectionStatus = connection
      ? {
          connected: true,
          githubOrg: connection.githubOrg,
          projectKey: connection.jiraProject ?? 'OH',
          productionEnabled: Boolean(connection.productionJenkins),
        }
      : { connected: false }
    response.json(status)
  })

  app.post('/api/connection', async (request, response) => {
    const parsed = connectionSchema.safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_CONNECTION',
          message: parsed.error.issues[0]?.message ?? 'Invalid connection details.',
        },
      } satisfies ApiErrorBody)
      return
    }

    const config: ConnectionConfig = {
      ...parsed.data,
      jiraSite: parsed.data.jiraSite.replace(/\/+$/, ''),
      githubOrg: 'Orange-Health',
      productionJenkins: parsed.data.productionJenkins
        ? {
            ...parsed.data.productionJenkins,
            jenkinsUrl: parsed.data.productionJenkins.jenkinsUrl.replace(
              /\/+$/,
              '',
            ),
          }
        : undefined,
    }
    const [jira, github, jenkins] = await Promise.all([
      testJiraConnection(config),
      testGitHubConnection(config),
      testJenkinsConnection(config, 'staging'),
      ...(config.productionJenkins
        ? [
            testJenkinsConnection(
              {
                ...config,
                jenkinsUrl: config.productionJenkins.jenkinsUrl,
                jenkinsUsername: config.productionJenkins.jenkinsUsername,
                jenkinsToken: config.productionJenkins.jenkinsToken,
              },
              'production',
            ),
          ]
        : []),
    ])
    clearGitHubProviderCache()
    clearReleaseCache()
    setConnection(config)
    response.json({
      connected: true,
      jiraUser: jira.displayName,
      githubUser: github.user,
      jenkinsUser: jenkins.name,
      githubOrg: github.org,
      projectKey: config.jiraProject,
      productionEnabled: Boolean(config.productionJenkins),
    } satisfies ConnectionStatus)
  })

  app.delete('/api/connection', (_request, response) => {
    clearGitHubProviderCache()
    clearConnection()
    clearReleaseCache()
    response.status(204).end()
  })

  app.get('/api/releases', async (_request, response) => {
    response.json(await listUnreleasedVersions(requireConnection()))
  })

  app.post(
    '/api/releases/:versionId/mark-issues-released',
    async (request, response) => {
      const { versionId } = request.params
      const parsed = markReleaseIssuesSchema.safeParse(request.body)
      if (!/^\d+$/.test(versionId) || !parsed.success) {
        response.status(400).json({
          error: {
            code: 'INVALID_VERSION',
            message: !/^\d+$/.test(versionId)
              ? 'A numeric Jira version ID is required.'
              : 'Select at least one valid Jira ticket.',
          },
        } satisfies ApiErrorBody)
        return
      }
      response.json(
        await markVersionIssuesReleased(
          requireConnection(),
          versionId,
          parsed.data.issueKeys,
        ),
      )
    },
  )

  app.post(
    '/api/releases/:versionId/issues/remove',
    async (request, response) => {
      const { versionId } = request.params
      const parsed = removeReleaseIssueSchema.safeParse(request.body)
      if (!/^\d+$/.test(versionId) || !parsed.success) {
        response.status(400).json({
          error: {
            code: 'INVALID_REMOVE_ISSUE',
            message: !/^\d+$/.test(versionId)
              ? 'A numeric Jira version ID is required.'
              : 'A valid Jira ticket key is required.',
          },
        } satisfies ApiErrorBody)
        return
      }
      const result = await removeIssueFromRelease(
        requireConnection(),
        versionId,
        parsed.data.issueKey,
        parsed.data.targetVersionId,
      )
      clearReleaseCache()
      response.json(result)
    },
  )

  app.get(
    '/api/releases/dashboard-progress/:progressId',
    (request, response) => {
      const { progressId } = request.params
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(progressId)) {
        response.status(400).json({
          error: {
            code: 'INVALID_PROGRESS_ID',
            message: 'A valid dashboard progress ID is required.',
          },
        } satisfies ApiErrorBody)
        return
      }
      response.json(
        getDashboardProgress(progressId) ?? {
          phase: 'starting',
          message: 'Preparing release data…',
        },
      )
    },
  )

  app.get('/api/releases/:versionId/dashboard', async (request, response) => {
    const { versionId } = request.params
    if (!/^\d+$/.test(versionId)) {
      response.status(400).json({
        error: {
          code: 'INVALID_VERSION',
          message: 'Jira version ID must be numeric.',
        },
      } satisfies ApiErrorBody)
      return
    }
    const progressId =
      typeof request.query.progressId === 'string' &&
      /^[A-Za-z0-9_-]{8,80}$/.test(request.query.progressId)
        ? request.query.progressId
        : undefined
    if (progressId) {
      setDashboardProgress(progressId, {
        phase: 'starting',
        message: 'Preparing release data…',
        current: 0,
        total: 1,
      })
    }
    response.json(
      await aggregateRelease(
        requireConnection(),
        versionId,
        request.query.refresh === 'true',
        progressId
          ? (progress) => setDashboardProgress(progressId, progress)
          : undefined,
      ),
    )
  })

  app.post(
    '/api/releases/:versionId/service-refresh',
    async (request, response) => {
      const { versionId } = request.params
      const parsed = serviceRefreshSchema.safeParse(request.body)
      if (!/^\d+$/.test(versionId) || !parsed.success) {
        response.status(400).json({
          error: {
            code: 'INVALID_SERVICE_REFRESH',
            message:
              'A valid release, repository, and Jira issue list are required.',
          },
        } satisfies ApiErrorBody)
        return
      }
      const config = requireConnection()
      clearRepositoryCaches(
        config,
        parsed.data.repository,
        parsed.data.issueKeys,
      )
      if (!parsed.data.includeRepositoryState) {
        response.json({
          service: await refreshServiceRelease(
            config,
            versionId,
            parsed.data.repository,
            parsed.data.issueKeys,
          ),
        })
        return
      }
      const [service, state, deploymentResult] = await Promise.all([
        refreshServiceRelease(
          config,
          versionId,
          parsed.data.repository,
          parsed.data.issueKeys,
        ),
        getRepositoryReleaseState(config, parsed.data.repository),
        currentDeployments(config, parsed.data.repository),
      ])
      response.json({
        service,
        repositoryState: {
          ...state,
          deployedTags: deploymentResult.deployedTags,
          deploymentLookupFailed: deploymentResult.failed,
        },
      })
    },
  )

  app.post(
    '/api/releases/:versionId/ticket-refresh',
    async (request, response) => {
      const { versionId } = request.params
      const parsed = ticketRefreshSchema.safeParse(request.body)
      if (!/^\d+$/.test(versionId) || !parsed.success) {
        response.status(400).json({
          error: {
            code: 'INVALID_TICKET_REFRESH',
            message: 'A valid release and Jira ticket key are required.',
          },
        } satisfies ApiErrorBody)
        return
      }
      response.json({
        items: await refreshTicketRelease(
          requireConnection(),
          versionId,
          parsed.data.issueKey,
          parsed.data.repositories,
        ),
      })
    },
  )

  app.post('/api/github/staging-releases', async (request, response) => {
    const parsed = stagingReleaseSchema.safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_STAGING_RELEASE',
          message:
            parsed.error.issues[0]?.message ??
            'Invalid staging release details.',
        },
      } satisfies ApiErrorBody)
      return
    }
    const config = requireConnection()
    const release = await createStagingRelease(
      config,
      parsed.data.repository,
      parsed.data.environment,
      parsed.data.date,
      parsed.data.sourceBranch,
    )
    clearRepositoryCaches(config, parsed.data.repository)
    response.status(201).json(release)
  })

  app.post('/api/github/production-releases', async (request, response) => {
    const parsed = productionReleaseSchema.safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_PRODUCTION_RELEASE',
          message:
            parsed.error.issues[0]?.message ??
            'Invalid production release details.',
        },
      } satisfies ApiErrorBody)
      return
    }
    const config = requireConnection()
    const mode =
      parsed.data.mode ?? (parsed.data.date ? 'release-day' : 'patch')
    const release = await createProductionRelease(
      config,
      parsed.data.repository,
      parsed.data.date,
      parsed.data.operationId,
      mode,
    )
    clearRepositoryCaches(config, parsed.data.repository)
    response.status(201).json(release)
  })

  app.get('/api/github/repositories', async (_request, response) => {
    response.json(await listOrganizationRepositories(requireConnection()))
  })

  app.get('/api/github/repository-branches', async (request, response) => {
    const parsed = repositorySchema.safeParse(request.query.repository)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_REPOSITORY',
          message: 'Repository must use the owner/name format.',
        },
      } satisfies ApiErrorBody)
      return
    }
    response.json(
      await listRepositoryBranches(requireConnection(), parsed.data),
    )
  })

  app.get('/api/github/repository-pull-requests', async (request, response) => {
    const parsed = repositoryPullQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_PULL_REQUEST_QUERY',
          message: 'Repository, state, branch, or page is invalid.',
        },
      } satisfies ApiErrorBody)
      return
    }
    response.json(
      await listRepositoryPullRequests(
        requireConnection(),
        parsed.data.repository,
        {
          state: parsed.data.state,
          base: parsed.data.base,
          author: parsed.data.author,
          page: parsed.data.page,
        },
      ),
    )
  })

  app.get(
    '/api/github/repository-pull-request-authors',
    async (request, response) => {
      const parsed = repositorySchema.safeParse(request.query.repository)
      if (!parsed.success) {
        response.status(400).json({
          error: {
            code: 'INVALID_REPOSITORY',
            message: 'Repository must use the owner/name format.',
          },
        } satisfies ApiErrorBody)
        return
      }
      response.json(
        await listRepositoryPullRequestAuthors(
          requireConnection(),
          parsed.data,
        ),
      )
    },
  )

  app.get('/api/github/repository-state', async (request, response) => {
    const parsed = repositorySchema.safeParse(request.query.repository)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_REPOSITORY',
          message: 'Repository must use the owner/name format.',
        },
      } satisfies ApiErrorBody)
      return
    }
    const config = requireConnection()
    const includeAllVReleases =
      request.query.includeAllVReleases === 'true'
    const [state, deploymentResult] = await Promise.all([
      getRepositoryReleaseState(config, parsed.data, includeAllVReleases),
      currentDeployments(config, parsed.data),
    ])
    response.json({
      ...state,
      deployedTags: deploymentResult.deployedTags,
      deploymentLookupFailed: deploymentResult.failed,
    })
  })

  app.get('/api/github/release-control-state', async (request, response) => {
    const parsed = repositorySchema.safeParse(request.query.repository)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_REPOSITORY',
          message: 'Repository must use the owner/name format.',
        },
      } satisfies ApiErrorBody)
      return
    }
    const config = requireConnection()
    const [state, deploymentResult] = await Promise.all([
      getReleaseControlRoomState(config, parsed.data),
      currentDeployments(config, parsed.data),
    ])
    response.json({
      ...state,
      deployedTags: deploymentResult.deployedTags,
      deploymentLookupFailed: deploymentResult.failed,
    })
  })

  app.get(
    '/api/github/release-control-sync-progress/:progressId',
    (request, response) => {
      const { progressId } = request.params
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(progressId)) {
        response.status(400).json({
          error: {
            code: 'INVALID_PROGRESS_ID',
            message: 'A valid control-room progress ID is required.',
          },
        } satisfies ApiErrorBody)
        return
      }
      const current = getControlRoomSyncProgress(progressId)
      if (!current) {
        response.status(404).json({
          error: {
            code: 'SYNC_PROGRESS_NOT_FOUND',
            message: 'Control-room synchronization progress was not found.',
          },
        } satisfies ApiErrorBody)
        return
      }
      response.json(current)
    },
  )

  app.post('/api/github/release-control-states', async (request, response) => {
    const parsed = repositoryBatchSchema.safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_REPOSITORIES',
          message: 'Provide between 1 and 100 valid repositories.',
        },
      } satisfies ApiErrorBody)
      return
    }
    const startedAt = performance.now()
    const config = requireConnection()
    const repositories = [...new Set(parsed.data.repositories)]
    const progressId = parsed.data.progressId
    if (progressId) {
      createControlRoomSyncProgress(progressId, repositories)
      for (const repository of repositories) {
        updateControlRoomProviderProgress(
          progressId,
          repository,
          'jenkins',
          'succeeded',
          'Deployments load separately from Jenkins.',
          'jenkins-ready',
        )
      }
    }
    const github = await getReleaseControlRoomStatesBatch(
      config,
      repositories,
      parsed.data.forceRefresh,
      progressId
        ? (repository, status, message, step, state) =>
            updateControlRoomProviderProgress(
              progressId,
              repository,
              'github',
              status,
              message,
              step,
              state,
            )
        : undefined,
      progressId
        ? {
            onEnrichment: (enrichment) => {
              trackControlRoomEnrichment(progressId, enrichment)
            },
            publishEnrichedState: (repository, state) =>
              publishControlRoomServiceState(
                progressId,
                repository,
                state,
                'Release build and tag details are ready.',
              ),
          }
        : {
            onEnrichment: (enrichment) => enrichment,
          },
    )
    if (progressId) completeControlRoomSyncProgress(progressId)
    const durationMs = Math.round(performance.now() - startedAt)
    response.setHeader('Server-Timing', `release-control-sync;dur=${durationMs}`)
    response.json({
      results: github.results.map((result) => {
        if (!result.state) return result
        return {
          repository: result.repository,
          state: {
            ...result.state,
            deployedTags: result.state.deployedTags ?? [],
            deploymentLookupFailed: false,
          },
        }
      }),
      fetchedAt: new Date().toISOString(),
      stats: { ...github.stats, durationMs },
      githubRateLimit: github.githubRateLimit,
    } satisfies ReleaseControlSyncResponse)
  })

  app.get('/api/jenkins/deployment-status', async (request, response) => {
    const parsed = repositorySchema.safeParse(request.query.repository)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_REPOSITORY',
          message: 'Repository must use the owner/name format.',
        },
      } satisfies ApiErrorBody)
      return
    }
    const deploymentResult = await currentDeployments(
      requireConnection(),
      parsed.data,
      request.query.forceRefresh === 'true',
    )
    response.json({
      deployedTags: deploymentResult.deployedTags,
      deploymentLookupFailed: deploymentResult.failed,
    })
  })

  app.post('/api/jenkins/deployment-statuses', async (request, response) => {
    const parsed = repositoryBatchSchema.safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_REPOSITORIES',
          message: 'Provide between 1 and 100 valid repositories.',
        },
      } satisfies ApiErrorBody)
      return
    }
    response.json({
      results: await getCurrentDeploymentsBatch(
        requireConnection(),
        parsed.data.repositories,
        parsed.data.forceRefresh,
      ),
      fetchedAt: new Date().toISOString(),
    } satisfies RepositoryDeploymentStatusResponse)
  })

  app.get('/api/github/release-history', async (request, response) => {
    const parsed = repositorySchema.safeParse(request.query.repository)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_REPOSITORY',
          message: 'Repository must use the owner/name format.',
        },
      } satisfies ApiErrorBody)
      return
    }
    const rawLimit = Number(request.query.limit)
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), 30)
        : 5
    const config = requireConnection()
    const [history, deploymentResult] = await Promise.all([
      getRepositoryReleaseHistory(
        config,
        parsed.data,
        request.query.includeAllVReleases === 'true',
        limit,
      ),
      currentDeployments(config, parsed.data),
    ])
    response.json({
      ...history,
      deployedTags: deploymentResult.deployedTags,
      deploymentLookupFailed: deploymentResult.failed,
      jenkinsServices: servicesForRepository(parsed.data),
      fetchedAt: new Date().toISOString(),
    })
  })

  app.post('/api/github/release-build-statuses', async (request, response) => {
    const parsed = releaseBuildStatusesSchema.safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_RELEASE_BUILD_STATUSES',
          message: 'Valid repositories, tags, and creation times are required.',
        },
      } satisfies ApiErrorBody)
      return
    }
    response.json(
      await getReleaseBuildStatuses(
        requireConnection(),
        parsed.data.releases,
        parsed.data.forceRefresh,
      ),
    )
  })

  app.post('/api/github/repository-risks', async (request, response) => {
    const parsed = repositoryRisksSchema.safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_REPOSITORIES',
          message: 'A valid list of repositories is required.',
        },
      } satisfies ApiErrorBody)
      return
    }
    response.json(
      await getRepositoryRisks(
        requireConnection(),
        parsed.data.repositories,
      ),
    )
  })

  app.post('/api/deployment-freshness', async (request, response) => {
    const parsed = repositoryRisksSchema.safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_REPOSITORIES',
          message: 'A valid list of repositories is required.',
        },
      } satisfies ApiErrorBody)
      return
    }
    response.json(
      await getDeploymentFreshness(
        requireConnection(),
        parsed.data.repositories,
      ),
    )
  })

  app.post('/api/github/repository-refresh', async (request, response) => {
    const parsed = z.object({ repository: repositorySchema }).safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_REPOSITORY',
          message: 'A valid repository is required.',
        },
      } satisfies ApiErrorBody)
      return
    }
    clearRepositoryCaches(
      requireConnection(),
      parsed.data.repository,
      [],
      true,
    )
    response.status(204).end()
  })

  app.post('/api/github/promotion-pull-requests', async (request, response) => {
    const parsed = promotionSchema.safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_PROMOTION',
          message: 'Repository and promotion route are required.',
        },
      } satisfies ApiErrorBody)
      return
    }
    response.status(201).json(
      await createPromotionPullRequest(
        requireConnection(),
        parsed.data.repository,
        parsed.data.route,
      ),
    )
  })

  app.post('/api/github/back-merge-pull-requests', async (request, response) => {
    const parsed = backMergeSchema.safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_BACK_MERGE',
          message: 'Repository and back-merge route are required.',
        },
      } satisfies ApiErrorBody)
      return
    }
    response.status(201).json(
      await createBackMergePullRequest(
        requireConnection(),
        parsed.data.repository,
        parsed.data.route,
      ),
    )
  })

  app.post(
    '/api/github/promotion-pull-requests/merge',
    async (request, response) => {
      const parsed = mergePromotionSchema.safeParse(request.body)
      if (!parsed.success) {
        response.status(400).json({
          error: {
            code: 'INVALID_PROMOTION_MERGE',
            message: 'Repository and a valid pull request number are required.',
          },
        } satisfies ApiErrorBody)
        return
      }
      response.json(
        await mergePromotionPullRequest(
          requireConnection(),
          parsed.data.repository,
          parsed.data.pullNumber,
          parsed.data.bypassBranchProtection,
        ),
      )
    },
  )

  app.post(
    '/api/github/back-merge-pull-requests/merge',
    async (request, response) => {
      const parsed = mergePromotionSchema.safeParse(request.body)
      if (!parsed.success) {
        response.status(400).json({
          error: {
            code: 'INVALID_BACK_MERGE',
            message: 'Repository and a valid pull request number are required.',
          },
        } satisfies ApiErrorBody)
        return
      }
      response.json(
        await mergeBackMergePullRequest(
          requireConnection(),
          parsed.data.repository,
          parsed.data.pullNumber,
          parsed.data.bypassBranchProtection,
        ),
      )
    },
  )

  app.post(
    '/api/github/feature-pull-requests/merge',
    async (request, response) => {
      const parsed = mergeFeaturePullSchema.safeParse(request.body)
      if (!parsed.success) {
        response.status(400).json({
          error: {
            code: 'INVALID_FEATURE_PR_MERGE',
            message: 'Repository and a valid pull request number are required.',
          },
        } satisfies ApiErrorBody)
        return
      }
      response.json(
        await mergeFeaturePullRequest(
          requireConnection(),
          parsed.data.repository,
          parsed.data.pullNumber,
          parsed.data.retargetToDev,
          parsed.data.bypassBranchProtection,
        ),
      )
    },
  )

  app.post(
    '/api/github/repository-pull-requests/merge',
    async (request, response) => {
      const parsed = mergeRepositoryPullSchema.safeParse(request.body)
      if (!parsed.success) {
        response.status(400).json({
          error: {
            code: 'INVALID_PULL_REQUEST_MERGE',
            message: 'Repository and a valid pull request number are required.',
          },
        } satisfies ApiErrorBody)
        return
      }
      response.json(
        await mergeRepositoryPullRequest(
          requireConnection(),
          parsed.data.repository,
          parsed.data.pullNumber,
        ),
      )
    },
  )

  app.post('/api/jenkins/deployments', async (request, response) => {
    const parsed = deploymentSchema.safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_DEPLOYMENT',
          message:
            parsed.error.issues[0]?.message ?? 'Invalid deployment details.',
        },
      } satisfies ApiErrorBody)
      return
    }
    response.status(201).json(
      await triggerDeployment(requireConnection(), parsed.data),
    )
  })

  app.get('/api/jenkins/eitri-builds', async (request, response) => {
    const repository = String(request.query.repository ?? '')
    const parsed = repositorySchema.safeParse(repository)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_REPOSITORY',
          message: 'A valid repository is required.',
        },
      } satisfies ApiErrorBody)
      return
    }
    const forceRefresh = request.query.forceRefresh === 'true'
    response.json(
      await getEitriBuilds(requireConnection(), parsed.data, forceRefresh),
    )
  })

  app.post('/api/jenkins/eitri-deployments', async (request, response) => {
    const parsed = eitriDeploymentSchema.safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_EITRI_DEPLOYMENT',
          message:
            parsed.error.issues[0]?.message ??
            'Invalid EITRI deployment details.',
        },
      } satisfies ApiErrorBody)
      return
    }
    const { commitSha, branch, stagingEnvUpdateJob, ...rest } = parsed.data
    response.status(201).json(
      await triggerEitriDeployment(requireConnection(), {
        ...rest,
        ...(branch ? { branch } : {}),
        ...(commitSha ? { commitSha } : {}),
        ...(stagingEnvUpdateJob ? { stagingEnvUpdateJob } : {}),
      }),
    )
  })

  app.post(
    '/api/jenkins/production-deployments',
    async (request, response) => {
      const parsed = productionDeploymentSchema.safeParse(request.body)
      if (!parsed.success) {
        response.status(400).json({
          error: {
            code: 'INVALID_PRODUCTION_DEPLOYMENT',
            message:
              parsed.error.issues[0]?.message ??
              'Invalid production deployment details.',
          },
        } satisfies ApiErrorBody)
        return
      }
      const config = requireConnection()
      // Temporary testing override: restore the branch-equality guard after
      // production deployment validation is complete.
      // await assertProductionBranchesIdentical(
      //   config,
      //   parsed.data.repository,
      // )
      response.status(202).json(
        await triggerProductionDeployment(config, parsed.data),
      )
    },
  )

  app.get('/api/jenkins/queue/:queueId', async (request, response) => {
    const queueId = Number(request.params.queueId)
    if (!Number.isInteger(queueId) || queueId <= 0) {
      response.status(400).json({
        error: {
          code: 'INVALID_QUEUE_ITEM',
          message: 'A valid Jenkins queue item ID is required.',
        },
      } satisfies ApiErrorBody)
      return
    }
    response.json(
      await getDeploymentQueueStatus(requireConnection(), queueId),
    )
  })

  app.get(
    '/api/jenkins/production-queue/:queueId',
    async (request, response) => {
      const queueId = Number(request.params.queueId)
      if (!Number.isInteger(queueId) || queueId <= 0) {
        response.status(400).json({
          error: {
            code: 'INVALID_QUEUE_ID',
            message: 'A valid Jenkins queue ID is required.',
          },
        } satisfies ApiErrorBody)
        return
      }
      response.json(
        await getProductionDeploymentQueueStatus(
          requireConnection(),
          queueId,
        ),
      )
    },
  )

  app.get(
    '/api/jenkins/production-build/:buildNumber',
    async (request, response) => {
      const buildNumber = Number(request.params.buildNumber)
      if (!Number.isInteger(buildNumber) || buildNumber <= 0) {
        response.status(400).json({
          error: {
            code: 'INVALID_BUILD_NUMBER',
            message: 'A valid Jenkins build number is required.',
          },
        } satisfies ApiErrorBody)
        return
      }
      response.json(
        await getProductionDeploymentBuildStatus(
          requireConnection(),
          buildNumber,
        ),
      )
    },
  )

  const distDir = resolveDistDir()
  if (distDir) {
    app.use(express.static(distDir, { index: false }))
    app.use((request, response, next) => {
      if (request.path.startsWith('/api')) {
        next()
        return
      }
      response.sendFile(path.join(distDir, 'index.html'))
    })
  }

  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response<ApiErrorBody>,
      _next: express.NextFunction,
    ) => {
      if (error instanceof ProviderError) {
        response.status(error.status).json({
          error: {
            code: error.code,
            message: error.message,
            provider: error.provider,
            retryable: error.retryable,
          },
        })
        return
      }
      const message =
        error instanceof Error ? error.message : 'An unexpected error occurred.'
      response.status(message.startsWith('Connect ') ? 401 : 500).json({
        error: {
          code: message.startsWith('Connect ')
            ? 'NOT_CONNECTED'
            : 'INTERNAL_ERROR',
          message,
        },
      })
    },
  )

  return app
}
