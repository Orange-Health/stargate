import type {
  DeploymentFreshness,
  JenkinsDeployedTag,
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

export function servicesWithQaBuilds(
  services: ServiceRelease[],
  freshness: Record<string, DeploymentFreshness>,
) {
  return services.filter(
    (service) => Boolean(freshness[service.repository]?.latestBuiltQaTag),
  )
}

export function servicesWithoutQaBuilds(
  services: ServiceRelease[],
  freshness: Record<string, DeploymentFreshness>,
) {
  return services.filter(
    (service) => !freshness[service.repository]?.latestBuiltQaTag,
  )
}

export function qaDeployments(deployedTags: JenkinsDeployedTag[]) {
  return deployedTags.filter((deployment) => deployment.environment === 'qa')
}

export function runningQaDeployments(deployedTags: JenkinsDeployedTag[]) {
  return qaDeployments(deployedTags).filter(
    (deployment) => deployment.status === 'running',
  )
}

export function latestQaTagAlreadyDeployed(
  tag: string,
  jenkinsServices: string[],
  deployedTags: JenkinsDeployedTag[],
) {
  if (!tag || jenkinsServices.length === 0) return false
  return jenkinsServices.every((jenkinsService) =>
    deployedTags.some(
      (deployment) =>
        deployment.environment === 'qa' &&
        deployment.service === jenkinsService &&
        deployment.tag === tag &&
        (deployment.status === undefined || deployment.status === 'succeeded'),
    ),
  )
}

export function latestQaTagDeployInProgress(
  tag: string,
  deployedTags: JenkinsDeployedTag[],
) {
  return runningQaDeployments(deployedTags).some(
    (deployment) => deployment.tag === tag,
  )
}

export function pendingQaDeployTargets(
  targets: DeployTarget[],
  freshness: Record<string, DeploymentFreshness>,
  deploymentsByRepository: Record<string, JenkinsDeployedTag[]>,
) {
  return targets.filter((target) => {
    const deployedTags = deploymentsByRepository[target.repository]
    if (deployedTags) {
      if (
        latestQaTagAlreadyDeployed(
          target.tag,
          target.jenkinsServices,
          deployedTags,
        )
      ) {
        return false
      }
      return !latestQaTagDeployInProgress(target.tag, deployedTags)
    }
    const info = freshness[target.repository]
    if (!info) return true
    if (info.checkFailed) return true
    return info.outdated
  })
}
