import type {
  DeploymentFreshness,
  ServiceRelease,
} from '../../shared/types'

export type DeployTarget = {
  repository: string
  tag: string
  jenkinsServices: string[]
}

export function isMergedToDev(service: ServiceRelease) {
  const withPulls = service.items.filter((item) => item.pullRequest)
  if (withPulls.length === 0) return false
  return withPulls.every(
    (item) =>
      Boolean(item.pullRequest?.merged) &&
      item.pullRequest?.baseBranch === 'dev',
  )
}

export function deployableQaTargets(
  services: ServiceRelease[],
  freshness: Record<string, DeploymentFreshness>,
): DeployTarget[] {
  // Only repositories present on the selected Jira release dashboard.
  return services.flatMap((service) => {
    if (!isMergedToDev(service)) return []
    const info = freshness[service.repository]
    if (!info?.latestBuiltQaTag || info.jenkinsServices.length === 0) return []
    return [
      {
        repository: service.repository,
        tag: info.latestBuiltQaTag,
        jenkinsServices: info.jenkinsServices,
      },
    ]
  })
}
