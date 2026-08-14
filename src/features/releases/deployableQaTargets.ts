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

const QA_TAG_PATTERN = /^v-qa-(\d{2})\.(\d{4})\.(\d+)$/

export function compareQaTags(left: string, right: string) {
  const parse = (tag: string) => {
    const match = QA_TAG_PATTERN.exec(tag)
    if (!match) return null
    return [Number(match[1]), Number(match[2]), Number(match[3])] as const
  }
  const leftParts = parse(left)
  const rightParts = parse(right)
  if (!leftParts || !rightParts) return left === right ? 0 : left.localeCompare(right)
  return (
    leftParts[0] - rightParts[0] ||
    leftParts[1] - rightParts[1] ||
    leftParts[2] - rightParts[2]
  )
}

export function newestQaTag(tags: Iterable<string | undefined>) {
  let newest: string | undefined
  for (const tag of tags) {
    if (!tag) continue
    if (!newest || compareQaTags(tag, newest) > 0) newest = tag
  }
  return newest
}

export function effectiveLatestQaTag(
  latestBuiltQaTag: string | undefined,
  githubTags: string[] | undefined,
  liveTags: string[],
) {
  return newestQaTag([latestBuiltQaTag, githubTags?.at(-1), ...liveTags])
}

export function qaDeployments(deployedTags: JenkinsDeployedTag[]) {
  return deployedTags.filter((deployment) => deployment.environment === 'qa')
}

export function runningQaDeployments(deployedTags: JenkinsDeployedTag[]) {
  return qaDeployments(deployedTags).filter(
    (deployment) => deployment.status === 'running',
  )
}

function succeededQaDeployments(deployedTags: JenkinsDeployedTag[]) {
  return qaDeployments(deployedTags).filter(
    (deployment) =>
      deployment.status === undefined || deployment.status === 'succeeded',
  )
}

export function liveQaIsAtLeast(tag: string, liveTags: string[]) {
  if (!tag || liveTags.length === 0) return false
  return liveTags.some((liveTag) => compareQaTags(liveTag, tag) >= 0)
}

export function latestQaTagAlreadyDeployed(
  tag: string,
  jenkinsServices: string[],
  deployedTags: JenkinsDeployedTag[],
) {
  if (!tag || jenkinsServices.length === 0) return false
  const live = succeededQaDeployments(deployedTags)
  return jenkinsServices.every((jenkinsService) =>
    live.some(
      (deployment) =>
        deployment.service === jenkinsService &&
        compareQaTags(deployment.tag, tag) >= 0,
    ),
  )
}

export function latestQaTagDeployInProgress(
  tag: string,
  deployedTags: JenkinsDeployedTag[],
) {
  return runningQaDeployments(deployedTags).some(
    (deployment) =>
      deployment.tag === tag || compareQaTags(deployment.tag, tag) >= 0,
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
    if (liveQaIsAtLeast(target.tag, info.liveQaTags)) return false
    return info.outdated
  })
}
