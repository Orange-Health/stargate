import { isClosedWithoutMerge } from './pullRequests.js'
import type {
  ReleaseDashboard,
  ReleaseItem,
  ServiceRelease,
} from './types.js'

function isClearedMergeItem(item: ReleaseItem) {
  return (
    Boolean(item.pullRequest?.merged) &&
    (item.pullRequest?.baseBranch === 'dev' ||
      item.pullRequest?.baseBranch === 'main')
  )
}

function recountService(
  service: ServiceRelease,
  items: ReleaseItem[],
): ServiceRelease {
  return {
    ...service,
    items: [...items].toSorted((left, right) =>
      left.issue.key.localeCompare(right.issue.key),
    ),
    eligibleCount: items.filter((item) => item.eligible).length,
    blockedCount: items.filter(
      (item) => !item.eligible && !item.pullRequest?.merged,
    ).length,
    mergedCount: items.filter(isClearedMergeItem).length,
  }
}

/** Replace one Jira issue's linked PR rows on the in-memory release dashboard. */
export function replaceIssueItemsInDashboard(
  dashboard: ReleaseDashboard,
  issueKey: string,
  items: ReleaseItem[],
): ReleaseDashboard {
  const key = issueKey.toUpperCase()
  const servicesWithoutIssue = dashboard.services
    .map((service) => {
      const remaining = service.items.filter(
        (item) => item.issue.key.toUpperCase() !== key,
      )
      if (remaining.length === service.items.length) return service
      return recountService(service, remaining)
    })
    .filter((service) => service.items.length > 0)

  const unmatched = dashboard.unmatched.filter(
    (item) => item.issue.key.toUpperCase() !== key,
  )

  const withPulls = items.filter(
    (item) => item.pullRequest && !isClosedWithoutMerge(item.pullRequest),
  )
  if (withPulls.length === 0) {
    const unmatchedItem = items[0]
    return {
      ...dashboard,
      services: servicesWithoutIssue,
      unmatched: unmatchedItem
        ? [...unmatched, { ...unmatchedItem, pullRequest: undefined }].toSorted(
            (left, right) => left.issue.key.localeCompare(right.issue.key),
          )
        : unmatched,
      cached: false,
    }
  }

  const extrasByRepository = new Map<
    string,
    { repository: string; items: ReleaseItem[] }
  >()
  for (const item of withPulls) {
    const repository = item.pullRequest!.repository
    const lookup = repository.toLowerCase()
    const current = extrasByRepository.get(lookup)
    if (current) current.items.push(item)
    else extrasByRepository.set(lookup, { repository, items: [item] })
  }

  const services = servicesWithoutIssue.map((service) => {
    const extra = extrasByRepository.get(service.repository.toLowerCase())
    if (!extra) return service
    extrasByRepository.delete(service.repository.toLowerCase())
    return recountService(service, [...service.items, ...extra.items])
  })

  for (const extra of extrasByRepository.values()) {
    services.push(
      recountService(
        {
          repository: extra.repository,
          items: [],
          eligibleCount: 0,
          blockedCount: 0,
          mergedCount: 0,
          backMergePending: false,
        },
        extra.items,
      ),
    )
  }

  return {
    ...dashboard,
    services: services.toSorted((left, right) =>
      left.repository.localeCompare(right.repository),
    ),
    unmatched,
    cached: false,
  }
}
