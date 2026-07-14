import Jenkins from 'jenkins'
import type {
  ConnectionConfig,
  DeploymentEnvironment,
  JenkinsDeployedTag,
  JenkinsQueueStatus,
  TriggerDeploymentInput,
  TriggeredDeployment,
} from '../../src/shared/types.js'
import { ProviderError } from '../errors.js'

const serviceToRepository = {
  accounts: 'accounts',
  'asbru-web': 'asbru',
  'bifrost-web': 'bifrost',
  cdp: 'cdp-api',
  'cds-api': 'cds',
  'cds-web': 'cds-web',
  'cerebro-api': 'cerebro',
  'cerebro-go': 'cerebro-go',
  citadel: 'citadel',
  'clr-api': 'clr',
  'clr-web': 'clr',
  'cms-api': 'cms-api',
  'cms-web': 'cms-web',
  compass: 'compass-clinics',
  consent: 'consent-service',
  chronos: 'chronos',
  'cpms-web': 'cpms',
  dokumentor: 'dokumentor',
  runestone: 'runestone',
  'super-crm': 'super-crm',
  'vault-web': 'vault-ui',
  web: 'orange-health-app',
  'superlab-web': 'amethyst',
  ets: 'ets-lab',
  'feedback-api': 'feedback-api',
  'feedback-web': 'feedback',
  'geomark-api': 'geomark',
  gringotts: 'gringotts',
  'gringotts-web': 'gringotts-web',
  groot: 'groot',
  health: 'health-api',
  'hedwig-api': 'hedwig',
  'gateway-api': 'gateway-api',
  'occ-api': 'occ',
  'occ-web': 'occ-web',
  odin: 'odin-api',
  oms: 'oms',
  'oms-web': 'oms-web',
  partner: 'partner-api',
  'partner-web': 'partner-web',
  patients: 'patients-service',
  payment: 'payment-api',
  webhook: 'webhook-service',
  'sorting-hat': 'sorting-hat',
  'orange-fusion': 'orange-fusion',
  'porte-api': 'porte',
  'report-rebranding-api': 'report-rebranding',
  'nimbus-api': 'nimbus',
  's3wrapper-api': 's3wrapper',
  sapphire: 'sapphire-api',
  'sapphire-web': 'sapphire-web',
  scheduler: 'scheduler-api',
  'scheduler-web': 'scheduler',
  titan: 'titan-api',
  'vault-api': 'vault',
} as const

const stagingTeams: Record<
  Exclude<DeploymentEnvironment, 'qa'>,
  string
> = {
  s1: 'Doctors',
  s2: 'D2C CRM',
  s3: 'Logistics',
  s4: 'Lab',
  s5: 'Partnerships',
}

const teamEnvironments = new Map(
  Object.entries(stagingTeams).map(([environment, team]) => [
    team.toLowerCase(),
    environment as DeploymentEnvironment,
  ]),
)
const DEPLOYMENT_CACHE_MS = 30_000
const deploymentCache = new Map<
  string,
  { expiresAt: number; value: Promise<JenkinsDeployedTag[]> }
>()
const deploymentBuildCache = new Map<
  string,
  {
    expiresAt: number
    value: Promise<{ qa: JenkinsBuild[]; staging: JenkinsBuild[] }>
  }
>()

type JenkinsBuild = {
  number: number
  url?: string
  result?: string | null
  timestamp?: number
  actions?: Array<{
    parameters?: Array<{ name: string; value: unknown }>
  }>
}

type DeploymentSpec = {
  jobName: string
  parameters: Record<string, string | boolean>
}

function jenkinsClient(config: ConnectionConfig) {
  const url = new URL(config.jenkinsUrl)
  url.username = config.jenkinsUsername
  url.password = config.jenkinsToken
  return new Jenkins({
    baseUrl: url.toString().replace(/\/$/, ''),
    crumbIssuer: true,
  })
}

export function servicesForRepository(repository: string) {
  const name = repository.split('/').at(-1)?.toLowerCase()
  if (!name) return []
  return Object.entries(serviceToRepository)
    .filter(([, repositoryName]) => repositoryName === name)
    .map(([service]) => service)
}

function buildParameters(build: JenkinsBuild) {
  return Object.fromEntries(
    (build.actions ?? [])
      .flatMap((action) => action.parameters ?? [])
      .map((parameter) => [parameter.name, String(parameter.value)]),
  )
}

export function deployedTagsFromBuilds(
  qaBuilds: JenkinsBuild[],
  stagingBuilds: JenkinsBuild[],
  services: string[],
): JenkinsDeployedTag[] {
  const serviceSet = new Set(services.map((service) => service.toLowerCase()))
  const deployments = new Map<string, JenkinsDeployedTag>()

  function collect(builds: JenkinsBuild[], qa: boolean) {
    for (const build of [...builds].sort((a, b) => b.number - a.number)) {
      if (build.result !== 'SUCCESS') continue
      const parameters = buildParameters(build)
      const service = (parameters.SERVICE ?? parameters.SERVICE_NAME)?.toLowerCase()
      const tag = parameters.IMAGE_TAG
      const environment = qa
        ? 'qa'
        : teamEnvironments.get((parameters.TEAM ?? '').toLowerCase())
      if (!service || !serviceSet.has(service) || !tag || !environment) continue
      const key = `${service}:${environment}`
      if (deployments.has(key)) continue
      deployments.set(key, {
        service,
        tag,
        environment,
        buildNumber: build.number,
        buildUrl: build.url ?? '',
        deployedAt: new Date(build.timestamp ?? 0).toISOString(),
      })
    }
  }

  collect(qaBuilds, true)
  collect(stagingBuilds, false)
  return [...deployments.values()]
}

async function recentJobBuilds(
  client: Jenkins,
  jobName: string,
): Promise<JenkinsBuild[]> {
  const getJob = client.job.get as unknown as (
    name: string,
    options: { tree: string },
  ) => Promise<{ builds?: JenkinsBuild[] }>
  const job = await getJob.call(client.job, jobName, {
    tree:
      'builds[number,url,result,timestamp,actions[parameters[name,value]]]{0,200}',
  })
  return job.builds ?? []
}

async function recentDeploymentBuilds(config: ConnectionConfig) {
  const cacheKey = config.jenkinsUrl.toLowerCase()
  const cached = deploymentBuildCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const value = (async () => {
    const client = jenkinsClient(config)
    const [qa, staging] = await Promise.all([
      recentJobBuilds(client, 'QA/QA-DEPLOYMENT'),
      recentJobBuilds(client, 'DEV/DEV Deployer'),
    ])
    return { qa, staging }
  })()
  deploymentBuildCache.set(cacheKey, {
    expiresAt: Date.now() + DEPLOYMENT_CACHE_MS,
    value,
  })
  value.catch(() => deploymentBuildCache.delete(cacheKey))
  return value
}

export async function getCurrentDeployments(
  config: ConnectionConfig,
  repository: string,
): Promise<JenkinsDeployedTag[]> {
  const services = servicesForRepository(repository)
  if (services.length === 0) return []
  const cacheKey = repository.toLowerCase()
  const cached = deploymentCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const value = (async () => {
    try {
      const builds = await recentDeploymentBuilds(config)
      return deployedTagsFromBuilds(builds.qa, builds.staging, services)
    } catch (error) {
      throw new ProviderError(
        error instanceof Error
          ? `Could not read current Jenkins deployments: ${error.message}`
          : 'Could not read current Jenkins deployments.',
        'JENKINS_DEPLOYMENT_LOOKUP_FAILED',
        'jenkins',
        502,
        true,
      )
    }
  })()
  deploymentCache.set(cacheKey, {
    expiresAt: Date.now() + DEPLOYMENT_CACHE_MS,
    value,
  })
  value.catch(() => deploymentCache.delete(cacheKey))
  return value
}

export function deploymentSpec(
  input: TriggerDeploymentInput,
): DeploymentSpec {
  const validServices = servicesForRepository(input.repository)
  if (!validServices.includes(input.service)) {
    throw new ProviderError(
      `Jenkins service "${input.service}" is not mapped to ${input.repository}.`,
      'JENKINS_SERVICE_NOT_MAPPED',
      'jenkins',
      400,
    )
  }

  if (input.environment === 'qa') {
    return {
      jobName: 'QA/QA-DEPLOYMENT',
      parameters: {
        TEAM: 'QA',
        SERVICE: input.service,
        IMAGE_TAG: input.tag,
        IS_PROD_TAG: false,
        TRIGGER_PNS_SUITE: false,
        TRIGGER_AUTOMATION_SUITE: false,
      },
    }
  }

  return {
    jobName: 'DEV/DEV Deployer',
    parameters: {
      TEAM: stagingTeams[input.environment],
      SERVICE_NAME: input.service,
      IMAGE_TAG: input.tag,
      IS_PROD_TAG: false,
      SKIP_MIGRATION: false,
    },
  }
}

export async function testJenkinsConnection(config: ConnectionConfig) {
  try {
    const info = (await jenkinsClient(config).info()) as {
      nodeName?: string
      mode?: string
    }
    return { name: info.nodeName || info.mode || 'Jenkins' }
  } catch (error) {
    throw new ProviderError(
      error instanceof Error
        ? `Jenkins connection failed: ${error.message}`
        : 'Jenkins connection failed.',
      'JENKINS_CONNECTION_FAILED',
      'jenkins',
      502,
    )
  }
}

export async function triggerDeployment(
  config: ConnectionConfig,
  input: TriggerDeploymentInput,
): Promise<TriggeredDeployment> {
  const spec = deploymentSpec(input)
  try {
    const client = jenkinsClient(config)
    const queueId = Number(
      await client.job.build({
        name: spec.jobName,
        parameters: spec.parameters,
      }),
    )
    if (!Number.isInteger(queueId) || queueId <= 0) {
      throw new Error('Jenkins did not return a valid queue item.')
    }
    let buildUrl: string | undefined
    try {
      const queueItem = (await client.queue.item(queueId)) as {
        executable?: { url?: string }
      }
      buildUrl = queueItem.executable?.url
    } catch {
      // It is normal for the queue item to take a moment to become available.
    }
    return {
      queueId,
      queueUrl: `${config.jenkinsUrl.replace(/\/+$/, '')}/queue/item/${queueId}/`,
      buildUrl,
      jobName: spec.jobName,
      service: input.service,
      tag: input.tag,
      environment: input.environment,
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError(
      error instanceof Error
        ? `Jenkins deployment trigger failed: ${error.message}`
        : 'Jenkins deployment trigger failed.',
      'JENKINS_TRIGGER_FAILED',
      'jenkins',
      502,
    )
  }
}

export async function getDeploymentQueueStatus(
  config: ConnectionConfig,
  queueId: number,
): Promise<JenkinsQueueStatus> {
  try {
    const item = (await jenkinsClient(config).queue.item(queueId)) as {
      cancelled?: boolean
      why?: string
      executable?: { number?: number; url?: string }
    }
    if (item.cancelled) {
      return {
        queueId,
        status: 'canceled',
        message: 'The Jenkins queue item was canceled.',
      }
    }
    if (item.executable?.url) {
      return {
        queueId,
        status: 'started',
        buildUrl: item.executable.url,
        buildNumber: item.executable.number,
      }
    }
    return {
      queueId,
      status: 'queued',
      message: item.why || 'Waiting for a Jenkins executor.',
    }
  } catch (error) {
    throw new ProviderError(
      error instanceof Error
        ? `Could not resolve Jenkins queue item: ${error.message}`
        : 'Could not resolve Jenkins queue item.',
      'JENKINS_QUEUE_LOOKUP_FAILED',
      'jenkins',
      502,
      true,
    )
  }
}
