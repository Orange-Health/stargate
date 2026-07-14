import express from 'express'
import { z } from 'zod'
import type {
  ApiErrorBody,
  ConnectionConfig,
  ConnectionStatus,
} from '../src/shared/types.js'
import {
  clearConnection,
  getConnection,
  requireConnection,
  setConnection,
} from './connectionStore.js'
import { ProviderError } from './errors.js'
import {
  createStagingRelease,
  testGitHubConnection,
} from './providers/github.js'
import {
  createPromotionPullRequest,
  getRepositoryReleaseState,
  mergePromotionPullRequest,
} from './providers/githubOperations.js'
import {
  listUnreleasedVersions,
  testJiraConnection,
} from './providers/jira.js'
import {
  getDeploymentQueueStatus,
  testJenkinsConnection,
  triggerDeployment,
} from './providers/jenkins.js'
import {
  aggregateRelease,
  clearReleaseCache,
} from './services/releaseAggregator.js'

const connectionSchema = z.object({
  jiraSite: z
    .url()
    .refine((value) => new URL(value).protocol === 'https:', {
      message: 'Jira URL must use HTTPS.',
    }),
  jiraEmail: z.email(),
  jiraToken: z.string().min(1),
  githubToken: z.string().min(1),
  jenkinsUrl: z
    .url()
    .refine((value) => new URL(value).protocol === 'https:', {
      message: 'Jenkins URL must use HTTPS.',
    }),
  jenkinsUsername: z.string().min(1),
  jenkinsToken: z.string().min(1),
  productionJenkins: z
    .object({
      jenkinsUrl: z
        .url()
        .refine((value) => new URL(value).protocol === 'https:', {
          message: 'Production Jenkins URL must use HTTPS.',
        }),
      jenkinsUsername: z.string().min(1),
      jenkinsToken: z.string().min(1),
    })
    .optional(),
  jiraProject: z.string().regex(/^[A-Z][A-Z0-9_]+$/).default('OH'),
})

const stagingReleaseSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  environment: z.enum(['qa', 's1', 's2', 's3', 's4', 's5', 's6']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

const repositorySchema = z
  .string()
  .regex(/^Orange-Health\/[A-Za-z0-9_.-]+$/i)
  .refine((value) => !['.', '..'].includes(value.split('/')[1]))

const promotionSchema = z.object({
  repository: repositorySchema,
  route: z.enum(['dev-to-release', 'release-to-default']),
})

const mergePromotionSchema = z.object({
  repository: repositorySchema,
  pullNumber: z.number().int().positive(),
})

const deploymentSchema = z.object({
  repository: repositorySchema,
  service: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  tag: z
    .string()
    .regex(/^v-(qa|s1|s2|s3|s4|s5|s6)-v\d{2}\.\d{4}\.\d+$/),
  environment: z.enum(['qa', 's1', 's2', 's3', 's4', 's5']),
})

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
      testJenkinsConnection(config),
      ...(config.productionJenkins
        ? [
            testJenkinsConnection({
              ...config,
              jenkinsUrl: config.productionJenkins.jenkinsUrl,
              jenkinsUsername: config.productionJenkins.jenkinsUsername,
              jenkinsToken: config.productionJenkins.jenkinsToken,
            }),
          ]
        : []),
    ])
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
    clearConnection()
    clearReleaseCache()
    response.status(204).end()
  })

  app.get('/api/releases', async (_request, response) => {
    response.json(await listUnreleasedVersions(requireConnection()))
  })

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
    response.json(
      await aggregateRelease(
        requireConnection(),
        versionId,
        request.query.refresh === 'true',
      ),
    )
  })

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
    response.status(201).json(
      await createStagingRelease(
        requireConnection(),
        parsed.data.repository,
        parsed.data.environment,
        parsed.data.date,
      ),
    )
  })

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
    response.json(
      await getRepositoryReleaseState(requireConnection(), parsed.data),
    )
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
