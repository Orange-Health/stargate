import { describe, expect, it } from 'vitest'
import {
  dashboardJenkinsServices,
  deployedTagsFromBuilds,
  deploymentSpec,
  EITRI_DEFAULT_STAGING_ENV_UPDATE_JOB,
  EITRI_JOB_NAME,
  eitriBuildsFromJobBuilds,
  eitriDeploymentSpec,
  productionDeployedTagsFromBuilds,
  productionDeploymentSpec,
  servicesForRepository,
  stagingDeployServiceName,
} from './jenkins.js'

/** SERVICE_NAME choices from Jenkins DEV/DEV Deployer. */
const jenkinsStagingServiceNames = [
  'accounts',
  'amethyst',
  'asbru',
  'bifrost',
  'cdp-api',
  'cds',
  'cds-web',
  'cerebro',
  'cerebro-go',
  'chronos',
  'citadel',
  'clr-api',
  'clr-web',
  'cms-api',
  'cms-web',
  'compass',
  'consent-service',
  'cpms',
  'dokumentor',
  'ets-lab',
  'feedback',
  'feedback-api',
  'geomark',
  'gringotts',
  'gringotts-web',
  'groot',
  'health-api',
  'health-web',
  'hedwig',
  'gateway-api',
  'nimbus-api',
  'occ',
  'occ-web',
  'odin-api',
  'oms',
  'oms-web',
  'orange-fusion',
  'partner-api',
  'partner-web',
  'patients-service',
  'payment-api',
  'porte',
  'raven',
  'report-rebranding',
  'runestone',
  's3-nginx',
  's3wrapper',
  'sapphire-api',
  'sapphire-web',
  'scheduler',
  'scheduler-api',
  'sorting-hat',
  'super-crm',
  'titan',
  'vault-api',
  'vault-web',
  'web',
  'webhook-mirror',
  'webhook-service',
] as const

describe('Jenkins service mapping', () => {
  it('maps GitHub repositories back to Jenkins service names', () => {
    expect(servicesForRepository('Orange-Health/asbru')).toEqual([
      'asbru-web',
    ])
    expect(servicesForRepository('Orange-Health/clr')).toEqual([
      'clr-api',
      'clr-web',
    ])
    expect(servicesForRepository('Orange-Health/scheduler-api')).toEqual([
      'scheduler-api',
    ])
    expect(servicesForRepository('Orange-Health/citrus')).toEqual(['citrus'])
    expect(servicesForRepository('Orange-Health/unknown')).toEqual([])
  })

  it('resolves every dashboard service to a DEV Deployer SERVICE_NAME', () => {
    const stagingNames = new Set<string>(jenkinsStagingServiceNames)
    const unresolved = dashboardJenkinsServices()
      .filter((service) => service !== 'citrus')
      .map((service) => ({
        service,
        stagingName: stagingDeployServiceName(service),
      }))
      .filter(({ stagingName }) => !stagingNames.has(stagingName))

    expect(unresolved).toEqual([])
    expect(stagingNames.has(stagingDeployServiceName('citrus'))).toBe(false)
  })
})

describe('deploymentSpec', () => {
  it('uses QA-DEPLOYMENT and QA parameter names', () => {
    expect(
      deploymentSpec({
        repository: 'Orange-Health/accounts',
        service: 'accounts',
        tag: 'v-qa-26.0713.1',
        environment: 'qa',
      }),
    ).toEqual({
      jobName: 'QA/QA-DEPLOYMENT',
      parameters: {
        TEAM: 'QA',
        SERVICE: 'accounts',
        IMAGE_TAG: 'v-qa-26.0713.1',
        IS_PROD_TAG: false,
        TRIGGER_PNS_SUITE: false,
        TRIGGER_AUTOMATION_SUITE: false,
      },
    })
  })

  it('maps S1-S5 through DEV Deployer teams', () => {
    expect(
      deploymentSpec({
        repository: 'Orange-Health/gringotts',
        service: 'gringotts',
        tag: 'v-s2-26.0713.2',
        environment: 's2',
      }),
    ).toEqual({
      jobName: 'DEV/DEV Deployer',
      parameters: {
        TEAM: 'D2C CRM',
        SERVICE_NAME: 'gringotts',
        IMAGE_TAG: 'v-s2-26.0713.2',
        IS_PROD_TAG: false,
        SKIP_MIGRATION: false,
      },
    })
  })

  it('maps dashboard web service keys to DEV Deployer SERVICE_NAME values', () => {
    expect(
      deploymentSpec({
        repository: 'Orange-Health/bifrost',
        service: 'bifrost-web',
        tag: 'v-s2-26.0731.1',
        environment: 's2',
      }),
    ).toMatchObject({
      parameters: {
        SERVICE_NAME: 'bifrost',
      },
    })
    expect(
      deploymentSpec({
        repository: 'Orange-Health/bifrost',
        service: 'bifrost-web',
        tag: 'v-s2-26.0731.1',
        environment: 'qa',
      }),
    ).toMatchObject({
      parameters: {
        SERVICE: 'bifrost-web',
      },
    })
  })

  it('rejects a service that is not mapped to the repository', () => {
    expect(() =>
      deploymentSpec({
        repository: 'Orange-Health/accounts',
        service: 'gringotts',
        tag: 'v-qa-26.0713.1',
        environment: 'qa',
      }),
    ).toThrow('is not mapped')
  })
})

describe('eitriDeploymentSpec', () => {
  it('targets Stag EITRI with staging SERVICE_NAME and defaults', () => {
    expect(
      eitriDeploymentSpec({
        repository: 'Orange-Health/accounts',
        service: 'accounts',
        namespace: 's1',
      }),
    ).toEqual({
      jobName: EITRI_JOB_NAME,
      parameters: {
        SERVICE_NAME: 'accounts',
        NAMESPACE: 's1',
        STAGING_ENV_UPDATE_JOB: EITRI_DEFAULT_STAGING_ENV_UPDATE_JOB,
      },
    })
  })

  it('maps dashboard web service keys and optional branch/sha', () => {
    expect(
      eitriDeploymentSpec({
        repository: 'Orange-Health/bifrost',
        service: 'bifrost-web',
        namespace: 's3',
        branch: 'deploy/s3-hotfix',
        commitSha: 'abc1234',
        stagingEnvUpdateJob: 'DEV/DEV Deployer',
      }),
    ).toEqual({
      jobName: EITRI_JOB_NAME,
      parameters: {
        SERVICE_NAME: 'bifrost',
        NAMESPACE: 's3',
        BRANCH: 'deploy/s3-hotfix',
        COMMIT_SHA: 'abc1234',
        STAGING_ENV_UPDATE_JOB: 'DEV/DEV Deployer',
      },
    })
  })

  it('rejects unmapped services', () => {
    expect(() =>
      eitriDeploymentSpec({
        repository: 'Orange-Health/accounts',
        service: 'gringotts',
        namespace: 's1',
      }),
    ).toThrow('is not mapped')
  })
})

describe('eitriBuildsFromJobBuilds', () => {
  it('keeps recent EITRI builds for mapped repository services', () => {
    const builds = eitriBuildsFromJobBuilds(
      [
        {
          number: 12,
          result: null,
          url: 'https://jenkins.test/eitri/12/',
          timestamp: Date.parse('2026-08-12T06:00:00Z'),
          actions: [
            {
              parameters: [
                { name: 'SERVICE_NAME', value: 'bifrost' },
                { name: 'NAMESPACE', value: 's2' },
                { name: 'BRANCH', value: 'deploy/s2' },
                {
                  name: 'STAGING_ENV_UPDATE_JOB',
                  value: 'DEV/DEV Deployer',
                },
              ],
            },
          ],
        },
        {
          number: 11,
          result: 'SUCCESS',
          url: 'https://jenkins.test/eitri/11/',
          timestamp: Date.parse('2026-08-12T05:00:00Z'),
          actions: [
            {
              parameters: [
                { name: 'SERVICE_NAME', value: 'accounts' },
                { name: 'NAMESPACE', value: 's1' },
              ],
            },
          ],
        },
      ],
      ['bifrost-web'],
    )

    expect(builds).toEqual([
      {
        buildNumber: 12,
        buildUrl: 'https://jenkins.test/eitri/12/',
        service: 'bifrost-web',
        namespace: 's2',
        branch: 'deploy/s2',
        commitSha: undefined,
        stagingEnvUpdateJob: 'DEV/DEV Deployer',
        status: 'running',
        createdAt: '2026-08-12T06:00:00.000Z',
      },
    ])
  })
})

describe('deployedTagsFromBuilds', () => {
  it('finds the latest successful tag for each Jenkins environment', () => {
    const parameterAction = (
      serviceName: string,
      tag: string,
      team: string,
      qa = false,
    ) => ({
      parameters: [
        { name: qa ? 'SERVICE' : 'SERVICE_NAME', value: serviceName },
        { name: 'IMAGE_TAG', value: tag },
        { name: 'TEAM', value: team },
      ],
    })

    const deployments = deployedTagsFromBuilds(
      [
        {
          number: 2152,
          result: 'SUCCESS',
          url: 'https://jenkins.test/qa/2152/',
          timestamp: Date.parse('2026-07-14T08:00:00Z'),
          actions: [parameterAction('accounts', 'v-qa-26.0714.1', 'QA', true)],
        },
      ],
      [
        {
          number: 300,
          result: 'FAILURE',
          actions: [parameterAction('accounts', 'v-s1-26.0714.2', 'Doctors')],
        },
        {
          number: 299,
          result: 'SUCCESS',
          url: 'https://jenkins.test/dev/299/',
          timestamp: Date.parse('2026-07-14T07:00:00Z'),
          actions: [parameterAction('accounts', 'v-s1-26.0714.1', 'Doctors')],
        },
      ],
      ['accounts'],
    )

    expect(deployments).toEqual([
      expect.objectContaining({
        environment: 'qa',
        tag: 'v-qa-26.0714.1',
        buildNumber: 2152,
      }),
      expect.objectContaining({
        environment: 's1',
        tag: 'v-s1-26.0714.1',
        buildNumber: 299,
      }),
    ])
  })

  it('finds the latest successful production tag for each service', () => {
    const parameters = (service: string, tag: string) => ({
      parameters: [
        { name: 'SERVICE', value: service },
        { name: 'IMAGE_TAG', value: tag },
      ],
    })
    expect(
      productionDeployedTagsFromBuilds(
        [
          {
            number: 2201,
            result: 'SUCCESS',
            url: 'https://jenkins.test/job/Prod%20Deployments/job/Prod-cluster-deployment/2201/',
            timestamp: 1_721_141_200_000,
            actions: [parameters('sapphire-web', 'v-prod-26.0716.6')],
          },
          {
            number: 2200,
            result: 'SUCCESS',
            actions: [parameters('sapphire-web', 'v-prod-26.0716.3')],
          },
        ],
        ['sapphire-web'],
      ),
    ).toEqual([
      expect.objectContaining({
        service: 'sapphire-web',
        tag: 'v-prod-26.0716.6',
        environment: 'production',
        buildNumber: 2201,
      }),
    ])
  })

  it('reports the latest external production deployment status', () => {
    const parameters = (service: string, tag: string) => ({
      parameters: [
        { name: 'SERVICE', value: service },
        { name: 'IMAGE_TAG', value: tag },
      ],
    })

    expect(
      productionDeployedTagsFromBuilds(
        [
          {
            number: 2202,
            result: null,
            actions: [parameters('chronos', 'v26.0730.1')],
          },
          {
            number: 2201,
            result: 'SUCCESS',
            actions: [parameters('chronos', 'v26.0729.1')],
          },
        ],
        ['chronos'],
      ),
    ).toEqual([
      expect.objectContaining({
        service: 'chronos',
        tag: 'v26.0730.1',
        status: 'running',
        buildNumber: 2202,
      }),
      expect.objectContaining({
        service: 'chronos',
        tag: 'v26.0729.1',
        status: 'succeeded',
        buildNumber: 2201,
      }),
    ])
  })
})

describe('productionDeploymentSpec', () => {
  it('maps the production Jenkins parameters exactly', () => {
    expect(
      productionDeploymentSpec({
        repository: 'Orange-Health/accounts',
        service: 'accounts',
        imageTag: 'v26.0714.1',
        qaApprovalRequired: true,
        qaName: 'QA Owner',
        skipProdMigration: false,
        prodMigrationJob: 'Prod-new-cluster-migration',
      }),
    ).toEqual({
      jobName: 'Prod Deployments/Prod-cluster-deployment',
      parameters: {
        SERVICE: 'accounts',
        IMAGE_TAG: 'v26.0714.1',
        QA_APPROVAL_REQUIRED: true,
        QA_NAME: 'QA Owner',
        SKIP_PROD_MIGRATION: false,
        PROD_MIGRATION_JOB: 'Prod-new-cluster-migration',
      },
    })
  })

  it('requires a QA name when approval is enabled', () => {
    expect(() =>
      productionDeploymentSpec({
        repository: 'Orange-Health/accounts',
        service: 'accounts',
        imageTag: 'v26.0714.1',
        qaApprovalRequired: true,
        qaName: '',
        skipProdMigration: false,
        prodMigrationJob: 'Prod-new-cluster-migration',
      }),
    ).toThrow('QA name is required')
  })
})
