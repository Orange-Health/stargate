import type {
  ReleaseControlProviderSyncStatus,
  ReleaseControlRoomState,
  ReleaseControlServiceSyncProgress,
  ReleaseControlSyncProgress,
  ReleaseControlSyncStep,
} from '../../src/shared/types.js'
import { progressScopeKey } from '../auth/context.js'

const PROGRESS_TTL_MS = 5 * 60_000
const progress = new Map<string, ReleaseControlSyncProgress>()
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const enrichmentWaiters = new Map<string, Promise<void>>()

function scoped(progressId: string) {
  return progressScopeKey(progressId)
}

/** GitHub work is ~70% of a service; Jenkins is the remaining ~30%. */
const GITHUB_WEIGHT: Partial<Record<ReleaseControlSyncStep, number>> = {
  queued: 0,
  'github-metadata': 0.22,
  'github-branches': 0.48,
  'github-fallback': 0.48,
  'github-ready': 0.7,
  'github-failed': 0.7,
  complete: 0.7,
}

const JENKINS_WEIGHT: Partial<Record<ReleaseControlSyncStep, number>> = {
  queued: 0,
  'jenkins-loading': 0.12,
  'jenkins-ready': 0.3,
  'jenkins-failed': 0.3,
  complete: 0.3,
}

function scheduleExpiry(progressId: string) {
  const key = scoped(progressId)
  const currentTimer = expiryTimers.get(key)
  if (currentTimer) clearTimeout(currentTimer)
  const timer = setTimeout(() => {
    progress.delete(key)
    expiryTimers.delete(key)
    enrichmentWaiters.delete(key)
  }, PROGRESS_TTL_MS)
  timer.unref()
  expiryTimers.set(key, timer)
}

function providerTerminal(status: ReleaseControlProviderSyncStatus) {
  return status === 'succeeded' || status === 'failed'
}

function githubStepFromUpdate(
  status: ReleaseControlProviderSyncStatus,
  step?: ReleaseControlSyncStep,
): ReleaseControlSyncStep {
  if (status === 'failed') return 'github-failed'
  if (status === 'succeeded') return 'github-ready'
  if (
    step === 'github-metadata' ||
    step === 'github-branches' ||
    step === 'github-fallback'
  ) {
    return step
  }
  return 'github-metadata'
}

function jenkinsStepFromUpdate(
  status: ReleaseControlProviderSyncStatus,
): ReleaseControlSyncStep {
  if (status === 'failed') return 'jenkins-failed'
  if (status === 'succeeded') return 'jenkins-ready'
  return 'jenkins-loading'
}

function serviceWeight(
  githubStep: ReleaseControlSyncStep,
  jenkinsStep: ReleaseControlSyncStep,
  status: ReleaseControlServiceSyncProgress['status'],
) {
  if (status === 'synced' || status === 'failed') return 1
  return Math.min(
    1,
    (GITHUB_WEIGHT[githubStep] ?? 0) + (JENKINS_WEIGHT[jenkinsStep] ?? 0),
  )
}

function stageFromStep(
  step: ReleaseControlSyncStep,
  status: ReleaseControlServiceSyncProgress['status'],
): ReleaseControlServiceSyncProgress['stage'] {
  if (status === 'synced' || status === 'failed' || step === 'complete') {
    return 'complete'
  }
  if (step.startsWith('jenkins')) return 'jenkins'
  if (step.startsWith('github')) return 'github'
  return 'queued'
}

function deriveServiceProgress(
  current: ReleaseControlServiceSyncProgress,
  provider: 'github' | 'jenkins',
  providerStatus: ReleaseControlProviderSyncStatus,
  message: string,
  step?: ReleaseControlSyncStep,
  state?: ReleaseControlRoomState,
): ReleaseControlServiceSyncProgress {
  const github =
    provider === 'github' ? providerStatus : current.github
  const jenkins =
    provider === 'jenkins' ? providerStatus : current.jenkins
  const githubStep =
    provider === 'github'
      ? githubStepFromUpdate(providerStatus, step)
      : current.githubStep
  const jenkinsStep =
    provider === 'jenkins'
      ? jenkinsStepFromUpdate(providerStatus)
      : current.jenkinsStep
  const githubDone = providerTerminal(github)
  const jenkinsDone = providerTerminal(jenkins)
  const status =
    github === 'failed'
      ? 'failed'
      : githubDone && jenkinsDone
        ? 'synced'
        : github === 'running' ||
            jenkins === 'running' ||
            githubDone ||
            jenkinsDone
          ? 'syncing'
          : 'queued'
  const resolvedStep =
    status === 'synced' || status === 'failed'
      ? 'complete'
      : provider === 'github'
        ? githubStep
        : jenkinsStep
  const finalMessage =
    status === 'synced' && jenkins === 'failed'
      ? 'Repository synced; Jenkins deployment status is unavailable.'
      : message
  return {
    ...current,
    github,
    jenkins,
    githubStep,
    jenkinsStep,
    status,
    stage: stageFromStep(resolvedStep, status),
    step: resolvedStep,
    weight: serviceWeight(githubStep, jenkinsStep, status),
    message: finalMessage,
    ...(state ? { state } : {}),
    updatedAt: new Date().toISOString(),
  }
}

function summarize(services: ReleaseControlServiceSyncProgress[]) {
  const completed = services.filter(
    (service) => service.status === 'synced' || service.status === 'failed',
  ).length
  const totalWeight = services.reduce((sum, service) => sum + service.weight, 0)
  const percent =
    services.length === 0
      ? 0
      : Math.min(100, Math.round((totalWeight / services.length) * 100))
  return {
    completed,
    percent,
    status: (completed === services.length ? 'completed' : 'running') as
      | 'running'
      | 'completed',
  }
}

export function createControlRoomSyncProgress(
  progressId: string,
  repositories: string[],
) {
  const updatedAt = new Date().toISOString()
  progress.set(scoped(progressId), {
    progressId,
    status: 'running',
    total: repositories.length,
    completed: 0,
    percent: 0,
    services: repositories.map((repository) => ({
      repository,
      status: 'queued',
      stage: 'queued',
      step: 'queued',
      githubStep: 'queued',
      jenkinsStep: 'queued',
      message: 'Queued for synchronization.',
      weight: 0,
      github: 'queued',
      jenkins: 'queued',
      updatedAt,
    })),
    updatedAt,
  })
  scheduleExpiry(progressId)
}

export function updateControlRoomProviderProgress(
  progressId: string,
  repository: string,
  provider: 'github' | 'jenkins',
  providerStatus: ReleaseControlProviderSyncStatus,
  message: string,
  step?: ReleaseControlSyncStep,
  state?: ReleaseControlRoomState,
) {
  const current = progress.get(scoped(progressId))
  if (!current) return
  const services = current.services.map((service) => {
    if (service.repository !== repository) return service
    return deriveServiceProgress(
      service,
      provider,
      providerStatus,
      message,
      step,
      state,
    )
  })
  const summary = summarize(services)
  // Keep overall status running while enrichment may still be in flight.
  const enrichmentPending = enrichmentWaiters.has(scoped(progressId))
  progress.set(scoped(progressId), {
    ...current,
    ...summary,
    status: enrichmentPending ? 'running' : summary.status,
    services,
    updatedAt: new Date().toISOString(),
  })
  scheduleExpiry(progressId)
}

/** Publish or merge an enriched control-room state onto a service entry. */
export function publishControlRoomServiceState(
  progressId: string,
  repository: string,
  state: ReleaseControlRoomState,
  message?: string,
) {
  const current = progress.get(scoped(progressId))
  if (!current) return
  const services = current.services.map((service) => {
    if (service.repository !== repository) return service
    return {
      ...service,
      state,
      message: message ?? service.message,
      updatedAt: new Date().toISOString(),
    }
  })
  progress.set(scoped(progressId), {
    ...current,
    services,
    updatedAt: new Date().toISOString(),
  })
  scheduleExpiry(progressId)
}

/** Track deferred enrichment so progress stays running until it finishes. */
export function trackControlRoomEnrichment(
  progressId: string,
  enrichment: Promise<void>,
) {
  const tracked = enrichment
    .catch(() => undefined)
    .finally(() => {
      if (enrichmentWaiters.get(scoped(progressId)) === tracked) {
        enrichmentWaiters.delete(scoped(progressId))
      }
      completeControlRoomSyncProgress(progressId)
    })
  enrichmentWaiters.set(scoped(progressId), tracked)
  const current = progress.get(scoped(progressId))
  if (current) {
    progress.set(scoped(progressId), {
      ...current,
      status: 'running',
      updatedAt: new Date().toISOString(),
    })
  }
  scheduleExpiry(progressId)
}

export function getControlRoomSyncProgress(progressId: string) {
  return progress.get(scoped(progressId))
}

export function completeControlRoomSyncProgress(progressId: string) {
  const current = progress.get(scoped(progressId))
  if (!current) return
  if (enrichmentWaiters.has(scoped(progressId))) {
    progress.set(scoped(progressId), {
      ...current,
      status: 'running',
      updatedAt: new Date().toISOString(),
    })
    scheduleExpiry(progressId)
    return
  }
  const services = current.services.map((service) => {
    if (service.status === 'synced' || service.status === 'failed') {
      return {
        ...service,
        weight: 1,
        step: 'complete' as const,
        stage: 'complete' as const,
        githubStep: service.github === 'failed' ? 'github-failed' as const : 'github-ready' as const,
        jenkinsStep:
          service.jenkins === 'failed'
            ? 'jenkins-failed' as const
            : 'jenkins-ready' as const,
      }
    }
    const github =
      service.github === 'failed' || service.github === 'succeeded'
        ? service.github
        : ('succeeded' as const)
    const jenkins =
      service.jenkins === 'failed' || service.jenkins === 'succeeded'
        ? service.jenkins
        : ('succeeded' as const)
    return deriveServiceProgress(
      {
        ...service,
        github,
        jenkins,
        githubStep:
          github === 'failed' ? 'github-failed' : 'github-ready',
        jenkinsStep:
          jenkins === 'failed' ? 'jenkins-failed' : 'jenkins-ready',
      },
      'github',
      github,
      service.github === 'failed'
        ? service.message
        : 'Synchronization finished.',
      github === 'failed' ? 'github-failed' : 'github-ready',
    )
  })
  progress.set(scoped(progressId), {
    ...current,
    status: 'completed',
    completed: services.length,
    percent: 100,
    services,
    updatedAt: new Date().toISOString(),
  })
  scheduleExpiry(progressId)
}
