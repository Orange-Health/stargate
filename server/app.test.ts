import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { clearConnection } from './connectionStore.js'

describe('local API', () => {
  beforeEach(() => clearConnection())

  it('reports health without exposing server details', async () => {
    const response = await request(createApp()).get('/api/health')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
    expect(response.headers['x-powered-by']).toBeUndefined()
  })

  it('rejects malformed connection details before provider calls', async () => {
    const response = await request(createApp()).post('/api/connection').send({
      jiraSite: 'http://insecure.example.com',
      jiraEmail: 'not-an-email',
      jiraToken: '',
      githubOrg: 'invalid org',
      githubToken: '',
      jiraProject: 'oh',
    })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_CONNECTION')
  })

  it('requires a connection before loading releases', async () => {
    const response = await request(createApp()).get('/api/releases')
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('NOT_CONNECTED')
  })

  it('rejects production and malformed staging release requests', async () => {
    const response = await request(createApp())
      .post('/api/github/staging-releases')
      .send({
        repository: 'orange/service-api',
        environment: 'prod',
        date: '2026-07-13',
      })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_STAGING_RELEASE')
  })

  it('validates production release requests', async () => {
    const response = await request(createApp())
      .post('/api/github/production-releases')
      .send({
        repository: '../outside',
        date: '2026-07-14',
      })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_PRODUCTION_RELEASE')
  })

  it('validates repository-state and promotion mutation inputs', async () => {
    const app = createApp()
    const stateResponse = await request(app)
      .get('/api/github/repository-state')
      .query({ repository: '../outside' })
    const historyResponse = await request(app)
      .get('/api/github/release-history')
      .query({ repository: '../outside' })
    const createResponse = await request(app)
      .post('/api/github/promotion-pull-requests')
      .send({
        repository: 'Orange-Health/service-api',
        route: 'production',
      })
    const mergeResponse = await request(app)
      .post('/api/github/promotion-pull-requests/merge')
      .send({
        repository: 'Orange-Health/service-api',
        pullNumber: -1,
      })

    expect(stateResponse.body.error.code).toBe('INVALID_REPOSITORY')
    expect(historyResponse.body.error.code).toBe('INVALID_REPOSITORY')
    expect(createResponse.body.error.code).toBe('INVALID_PROMOTION')
    expect(mergeResponse.body.error.code).toBe('INVALID_PROMOTION_MERGE')
  })

  it('rejects unsupported Jenkins deployment environments', async () => {
    const response = await request(createApp())
      .post('/api/jenkins/deployments')
      .send({
        repository: 'Orange-Health/accounts',
        service: 'accounts',
        tag: 'v-s6-v26.0713.1',
        environment: 's6',
      })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_DEPLOYMENT')
  })

  it('validates Jenkins queue item identifiers', async () => {
    const response = await request(createApp()).get(
      '/api/jenkins/queue/not-a-number',
    )
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_QUEUE_ITEM')
  })

  it('validates feature PR merge inputs', async () => {
    const response = await request(createApp())
      .post('/api/github/feature-pull-requests/merge')
      .send({ repository: 'Orange-Health/accounts', pullNumber: 0 })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_FEATURE_PR_MERGE')
  })

  it('validates asynchronous repository risk requests', async () => {
    const response = await request(createApp())
      .post('/api/github/repository-risks')
      .send({ repositories: ['../outside'] })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_REPOSITORIES')
  })

  it('validates lightweight release build status requests', async () => {
    const response = await request(createApp())
      .post('/api/github/release-build-statuses')
      .send({
        releases: [
          {
            repository: 'Orange-Health/accounts',
            tag: 'not-a-release-tag',
            createdAt: 'yesterday',
          },
        ],
      })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe(
      'INVALID_RELEASE_BUILD_STATUSES',
    )
  })

  it('validates deployment freshness requests', async () => {
    const response = await request(createApp())
      .post('/api/deployment-freshness')
      .send({ repositories: ['../outside'] })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_REPOSITORIES')
  })

  it('validates service-level refresh requests', async () => {
    const response = await request(createApp())
      .post('/api/github/repository-refresh')
      .send({ repository: '../outside' })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_REPOSITORY')
  })

  it('validates focused service data refresh requests', async () => {
    const response = await request(createApp())
      .post('/api/releases/10351/service-refresh')
      .send({
        repository: 'Orange-Health/accounts',
        issueKeys: ['not-a-ticket'],
      })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('INVALID_SERVICE_REFRESH')
  })

  it('validates production deployment inputs before triggering Jenkins', async () => {
    const response = await request(createApp())
      .post('/api/jenkins/production-deployments')
      .send({
        repository: 'Orange-Health/accounts',
        service: 'accounts',
        imageTag: 'invalid tag',
        qaApprovalRequired: false,
        skipProdMigration: false,
        prodMigrationJob: 'Prod-new-cluster-migration',
      })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe(
      'INVALID_PRODUCTION_DEPLOYMENT',
    )
  })

  it('returns supplemental dashboard loading progress', async () => {
    const response = await request(createApp()).get(
      '/api/releases/dashboard-progress/dashboard-test-123',
    )
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      phase: 'starting',
      message: 'Preparing release data…',
    })
  })
})
