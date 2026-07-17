import { describe, expect, it } from 'vitest'
import {
  deployedTagsFromBuilds,
  deploymentSpec,
  productionDeployedTagsFromBuilds,
  productionDeploymentSpec,
  servicesForRepository,
} from './jenkins.js'

describe('Jenkins service mapping', () => {
  it('maps GitHub repositories back to Jenkins service names', () => {
    expect(servicesForRepository('Orange-Health/asbru')).toEqual([
      'asbru-web',
    ])
    expect(servicesForRepository('Orange-Health/clr')).toEqual([
      'clr-api',
      'clr-web',
    ])
    expect(servicesForRepository('Orange-Health/unknown')).toEqual([])
  })
})

describe('deploymentSpec', () => {
  it('uses QA-DEPLOYMENT and QA parameter names', () => {
    expect(
      deploymentSpec({
        repository: 'Orange-Health/accounts',
        service: 'accounts',
        tag: 'v-qa-v26.0713.1',
        environment: 'qa',
      }),
    ).toEqual({
      jobName: 'QA/QA-DEPLOYMENT',
      parameters: {
        TEAM: 'QA',
        SERVICE: 'accounts',
        IMAGE_TAG: 'v-qa-v26.0713.1',
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
        tag: 'v-s2-v26.0713.2',
        environment: 's2',
      }),
    ).toEqual({
      jobName: 'DEV/DEV Deployer',
      parameters: {
        TEAM: 'D2C CRM',
        SERVICE_NAME: 'gringotts',
        IMAGE_TAG: 'v-s2-v26.0713.2',
        IS_PROD_TAG: false,
        SKIP_MIGRATION: false,
      },
    })
  })

  it('rejects a service that is not mapped to the repository', () => {
    expect(() =>
      deploymentSpec({
        repository: 'Orange-Health/accounts',
        service: 'gringotts',
        tag: 'v-qa-v26.0713.1',
        environment: 'qa',
      }),
    ).toThrow('is not mapped')
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
          actions: [parameterAction('accounts', 'v-qa-v26.0714.1', 'QA', true)],
        },
      ],
      [
        {
          number: 300,
          result: 'FAILURE',
          actions: [parameterAction('accounts', 'v-s1-v26.0714.2', 'Doctors')],
        },
        {
          number: 299,
          result: 'SUCCESS',
          url: 'https://jenkins.test/dev/299/',
          timestamp: Date.parse('2026-07-14T07:00:00Z'),
          actions: [parameterAction('accounts', 'v-s1-v26.0714.1', 'Doctors')],
        },
      ],
      ['accounts'],
    )

    expect(deployments).toEqual([
      expect.objectContaining({
        environment: 'qa',
        tag: 'v-qa-v26.0714.1',
        buildNumber: 2152,
      }),
      expect.objectContaining({
        environment: 's1',
        tag: 'v-s1-v26.0714.1',
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
            url: 'https://jenkins.test/job/Prod-new-cluster-deployment/2201/',
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
      jobName: 'Prod-new-cluster-deployment',
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
