import type { EligibilityReason, ReleaseItem, ServiceRelease } from '../../shared/types'

export type FeatureMergeAction = {
  repository: string
  pullNumber: number
  retargetToDev?: boolean
  bypassBranchProtection?: boolean
}

const FORCE_HARD_BLOCKERS: EligibilityReason[] = [
  'NO_MATCHING_PR',
  'HAS_CONFLICTS',
  'MERGEABILITY_PENDING',
  'DRAFT',
  'ALREADY_MERGED',
]

export function canRetargetToDev(item: ReleaseItem, service: ServiceRelease) {
  const pull = item.pullRequest
  if (!pull || pull.merged || pull.draft) return false
  if (!service.defaultBranch || pull.baseBranch !== service.defaultBranch) {
    return false
  }
  const otherBlockers = item.blockingReasons.filter(
    (reason) => reason !== 'WRONG_BASE_BRANCH',
  )
  return (
    otherBlockers.length === 0 &&
    !item.warningReasons.includes('CHECKS_PENDING')
  )
}

export function isFeatureMergeReady(
  item: ReleaseItem,
  service: ServiceRelease,
  skipped: Set<number> = new Set(),
) {
  const pull = item.pullRequest
  if (!pull || pull.merged || skipped.has(pull.number)) return false
  if (service.backMergePending) return false
  return item.eligible && !item.warningReasons.includes('CHECKS_PENDING')
}

export function isFeatureRetargetReady(
  item: ReleaseItem,
  service: ServiceRelease,
  skipped: Set<number> = new Set(),
) {
  const pull = item.pullRequest
  if (!pull || skipped.has(pull.number)) return false
  if (service.backMergePending) return false
  return canRetargetToDev(item, service)
}

function hasForceHardBlocker(item: ReleaseItem) {
  return FORCE_HARD_BLOCKERS.some((reason) =>
    item.blockingReasons.includes(reason),
  )
}

/** Open PR that can be force-merged into `dev` (retarget from default if needed). */
export function isFeatureForceMergeReady(
  item: ReleaseItem,
  service: ServiceRelease,
  skipped: Set<number> = new Set(),
) {
  const pull = item.pullRequest
  if (!pull || pull.merged || pull.draft || skipped.has(pull.number)) {
    return false
  }
  if (service.backMergePending) return false
  if (hasForceHardBlocker(item)) return false
  if (pull.baseBranch === 'dev') return true
  return Boolean(
    service.defaultBranch && pull.baseBranch === service.defaultBranch,
  )
}

export function featureMergeActions(
  service: ServiceRelease,
  skipped: Set<number> = new Set(),
): FeatureMergeAction[] {
  return service.items.flatMap((item) => {
    const pull = item.pullRequest
    if (!pull) return []
    if (isFeatureMergeReady(item, service, skipped)) {
      return [{ repository: service.repository, pullNumber: pull.number }]
    }
    if (isFeatureRetargetReady(item, service, skipped)) {
      return [
        {
          repository: service.repository,
          pullNumber: pull.number,
          retargetToDev: true,
        },
      ]
    }
    return []
  })
}

export function featureForceMergeActions(
  service: ServiceRelease,
  skipped: Set<number> = new Set(),
): FeatureMergeAction[] {
  return service.items.flatMap((item) => {
    const pull = item.pullRequest
    if (!pull || !isFeatureForceMergeReady(item, service, skipped)) return []
    return [
      {
        repository: service.repository,
        pullNumber: pull.number,
        retargetToDev: pull.baseBranch !== 'dev',
        bypassBranchProtection: true,
      },
    ]
  })
}
