import { describe, expect, it } from 'vitest'
import {
  deploymentSpec,
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
