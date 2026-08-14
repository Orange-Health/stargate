import type {
  CreatedProductionRelease,
  DeploymentFreshness,
  PromotionRoute,
  ReleaseControlRoomState,
  ServiceRelease,
} from '../../shared/types'
import { releaseCreatedOnDate } from './releaseNotes'
import type { ReleaseTicket } from './releaseTickets'

export const RELEASE_PROGRESS_STORAGE_PREFIX = 'release-desk-progress:'

export type ProgressCount = {
  current: number
  total: number
}

export type PendingProgressRepositories = {
  prsMerged: string[]
  tagsCreated: string[]
  deployedOnQa: string[]
}

export type ReleaseProgressSnapshot = {
  versionId: string
  ticketsFinalised: ProgressCount
  prsMerged: ProgressCount
  tagsCreated: ProgressCount
  deployedOnQa: ProgressCount
  pendingRepositories: PendingProgressRepositories
  updatedAt: string
  deployedLabel?: string
}

export type ReleaseProgressStepId =
  | 'tickets-finalised'
  | 'prs-merged'
  | 'tags-created'
  | 'deployed-qa'

export type ReleaseProgressStep = {
  id: ReleaseProgressStepId
  label: string
  current: number
  total: number
  pendingRepositories: string[]
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function releaseProgressDate(releaseDate?: string, now = new Date()) {
  if (releaseDate && DATE_PATTERN.test(releaseDate)) return releaseDate
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function isCompatibleTicket(ticket: ReleaseTicket) {
  return ticket.readiness !== 'unmatched'
}

export function progressRatio(count: ProgressCount) {
  if (count.total <= 0) return 0
  return Math.min(1, count.current / count.total)
}

export function isStepComplete(count: ProgressCount) {
  return count.total > 0 && count.current >= count.total
}

export function completedProgressStepIds(
  snapshot: ReleaseProgressSnapshot,
): ReleaseProgressStepId[] {
  return releaseProgressSteps(snapshot)
    .filter((step) => isStepComplete(step))
    .map((step) => step.id)
}

export function newlyCompletedProgressStepIds(
  previous: Iterable<ReleaseProgressStepId> | null,
  next: Iterable<ReleaseProgressStepId>,
): ReleaseProgressStepId[] {
  if (previous == null) return []
  const seen = new Set(previous)
  return [...next].filter((id) => !seen.has(id))
}

export function repositoryShortName(repository: string) {
  return repository.split('/').at(-1) ?? repository
}

export function serviceHasUnmergedPullRequests(service: ServiceRelease) {
  return service.items.some(
    (item) => item.pullRequest && !item.pullRequest.merged,
  )
}

export function serviceHasCreatedTag(
  repository: string,
  stagingTags: Record<string, string[]>,
) {
  return (stagingTags[repository] ?? []).length > 0
}

export function serviceTagIsDeployed(
  repository: string,
  stagingTags: Record<string, string[]>,
  freshness: Record<string, DeploymentFreshness>,
) {
  const created = stagingTags[repository] ?? []
  if (created.length === 0) return false
  const info = freshness[repository]
  const live = new Set(info?.liveQaTags ?? [])
  if (created.some((tag) => live.has(tag))) return true
  return Boolean(
    info?.latestBuiltQaTag &&
      created.includes(info.latestBuiltQaTag) &&
      !info.outdated,
  )
}

export function computeReleaseProgress(input: {
  versionId: string
  tickets: ReleaseTicket[]
  mergedIssueCount: number
  issueCount: number
  services: ServiceRelease[]
  stagingTags: Record<string, string[]>
  freshness: Record<string, DeploymentFreshness>
  now?: string
}): ReleaseProgressSnapshot {
  const repositories = input.services.map((service) => service.repository)
  const taggedRepositories = repositories.filter((repository) =>
    serviceHasCreatedTag(repository, input.stagingTags),
  )
  const undeployedRepositories = taggedRepositories.filter(
    (repository) =>
      !serviceTagIsDeployed(repository, input.stagingTags, input.freshness),
  )
  return {
    versionId: input.versionId,
    ticketsFinalised: {
      current: input.tickets.filter(isCompatibleTicket).length,
      total: input.tickets.length,
    },
    prsMerged: {
      current: input.mergedIssueCount,
      total: input.issueCount,
    },
    tagsCreated: {
      current: taggedRepositories.length,
      total: repositories.length,
    },
    deployedOnQa: {
      current: taggedRepositories.length - undeployedRepositories.length,
      total: taggedRepositories.length,
    },
    pendingRepositories: {
      prsMerged: input.services
        .filter(serviceHasUnmergedPullRequests)
        .map((service) => service.repository),
      tagsCreated: repositories.filter(
        (repository) => !serviceHasCreatedTag(repository, input.stagingTags),
      ),
      deployedOnQa: undeployedRepositories,
    },
    updatedAt: input.now ?? new Date().toISOString(),
  }
}

export function lastHopPromotionMerged(
  state: ReleaseControlRoomState | undefined,
  lastHop: PromotionRoute,
) {
  return (
    state?.promotionSteps.find((step) => step.route === lastHop)?.state ===
    'up_to_date'
  )
}

export function productionTagCreatedForDate(
  productionRelease: Pick<CreatedProductionRelease, 'tag' | 'createdAt'> | undefined,
  state: ReleaseControlRoomState | undefined,
  releaseDate: string,
) {
  if (
    !productionRelease ||
    !releaseCreatedOnDate(productionRelease.createdAt, releaseDate)
  ) {
    return false
  }
  return (
    state?.productionReleases.find((item) => item.tag === productionRelease.tag)
      ?.buildStatus !== 'canceled'
  )
}

export function productionTagDeployedToProd(
  tag: string | undefined,
  state: ReleaseControlRoomState | undefined,
) {
  if (!tag || !state?.jenkinsServices.length) return false
  const productionDeployments = state.deployedTags.filter(
    (deployment) => deployment.environment === 'production',
  )
  return state.jenkinsServices.every((jenkinsService) =>
    productionDeployments.some(
      (deployment) =>
        deployment.service === jenkinsService &&
        deployment.tag === tag &&
        (deployment.status === undefined || deployment.status === 'succeeded'),
    ),
  )
}

export function computeControlRoomProgress(input: {
  versionId: string
  tickets: ReleaseTicket[]
  selectedRepositories: string[]
  lastHop: PromotionRoute
  states: Record<string, ReleaseControlRoomState | undefined>
  productionReleases: Record<
    string,
    Pick<CreatedProductionRelease, 'tag' | 'createdAt'> | undefined
  >
  releaseDate: string
  now?: string
}): ReleaseProgressSnapshot {
  const repositories = input.selectedRepositories
  const mergedRepositories = repositories.filter((repository) =>
    lastHopPromotionMerged(input.states[repository], input.lastHop),
  )
  const taggedRepositories = repositories.filter((repository) =>
    productionTagCreatedForDate(
      input.productionReleases[repository],
      input.states[repository],
      input.releaseDate,
    ),
  )
  const undeployedRepositories = taggedRepositories.filter(
    (repository) =>
      !productionTagDeployedToProd(
        input.productionReleases[repository]?.tag,
        input.states[repository],
      ),
  )
  return {
    versionId: input.versionId,
    ticketsFinalised: {
      current: input.tickets.filter(isCompatibleTicket).length,
      total: input.tickets.length,
    },
    prsMerged: {
      current: mergedRepositories.length,
      total: repositories.length,
    },
    tagsCreated: {
      current: taggedRepositories.length,
      total: repositories.length,
    },
    deployedOnQa: {
      current: taggedRepositories.length - undeployedRepositories.length,
      total: taggedRepositories.length,
    },
    pendingRepositories: {
      prsMerged: repositories.filter(
        (repository) =>
          !lastHopPromotionMerged(input.states[repository], input.lastHop),
      ),
      tagsCreated: repositories.filter(
        (repository) =>
          !productionTagCreatedForDate(
            input.productionReleases[repository],
            input.states[repository],
            input.releaseDate,
          ),
      ),
      deployedOnQa: undeployedRepositories,
    },
    updatedAt: input.now ?? new Date().toISOString(),
    deployedLabel: 'Deployed to prod',
  }
}

export function emptyPendingRepositories(): PendingProgressRepositories {
  return {
    prsMerged: [],
    tagsCreated: [],
    deployedOnQa: [],
  }
}

export function releaseProgressSteps(
  snapshot: ReleaseProgressSnapshot,
): ReleaseProgressStep[] {
  const pending = snapshot.pendingRepositories ?? emptyPendingRepositories()
  return [
    {
      id: 'tickets-finalised',
      label: 'Tickets finalised',
      pendingRepositories: [],
      ...snapshot.ticketsFinalised,
    },
    {
      id: 'prs-merged',
      label: "PR's merged",
      pendingRepositories: pending.prsMerged,
      ...snapshot.prsMerged,
    },
    {
      id: 'tags-created',
      label: 'Tags created',
      pendingRepositories: pending.tagsCreated,
      ...snapshot.tagsCreated,
    },
    {
      id: 'deployed-qa',
      label: snapshot.deployedLabel ?? 'Deployed on QA',
      pendingRepositories: pending.deployedOnQa,
      ...snapshot.deployedOnQa,
    },
  ]
}

export function storageKeyForProgress(versionId: string) {
  return `${RELEASE_PROGRESS_STORAGE_PREFIX}${versionId}`
}

export function readStoredReleaseProgress(
  versionId: string,
  storage: Pick<Storage, 'getItem'> | null | undefined = globalThis.localStorage,
): ReleaseProgressSnapshot | undefined {
  if (!versionId || !storage) return undefined
  try {
    const raw = storage.getItem(storageKeyForProgress(versionId))
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Partial<ReleaseProgressSnapshot>
    if (
      parsed.versionId !== versionId ||
      !isProgressCount(parsed.ticketsFinalised) ||
      !isProgressCount(parsed.prsMerged) ||
      !isProgressCount(parsed.tagsCreated) ||
      !isProgressCount(parsed.deployedOnQa)
    ) {
      return undefined
    }
    return {
      versionId,
      ticketsFinalised: parsed.ticketsFinalised,
      prsMerged: parsed.prsMerged,
      tagsCreated: parsed.tagsCreated,
      deployedOnQa: parsed.deployedOnQa,
      pendingRepositories: isPendingRepositories(parsed.pendingRepositories)
        ? parsed.pendingRepositories
        : emptyPendingRepositories(),
      updatedAt:
        typeof parsed.updatedAt === 'string'
          ? parsed.updatedAt
          : new Date().toISOString(),
    }
  } catch {
    return undefined
  }
}

export function writeStoredReleaseProgress(
  snapshot: ReleaseProgressSnapshot,
  storage:
    | Pick<Storage, 'setItem'>
    | null
    | undefined = globalThis.localStorage,
) {
  if (!snapshot.versionId || !storage) return
  try {
    storage.setItem(
      storageKeyForProgress(snapshot.versionId),
      JSON.stringify(snapshot),
    )
  } catch {
    // Ignore quota / private-mode failures; the live bar still updates.
  }
}

function isProgressCount(value: unknown): value is ProgressCount {
  if (!value || typeof value !== 'object') return false
  const count = value as ProgressCount
  return (
    Number.isFinite(count.current) &&
    Number.isFinite(count.total) &&
    count.current >= 0 &&
    count.total >= 0
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isPendingRepositories(
  value: unknown,
): value is PendingProgressRepositories {
  if (!value || typeof value !== 'object') return false
  const pending = value as PendingProgressRepositories
  return (
    isStringArray(pending.prsMerged) &&
    isStringArray(pending.tagsCreated) &&
    isStringArray(pending.deployedOnQa)
  )
}
