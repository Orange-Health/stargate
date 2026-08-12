import type { JenkinsDeployedTag } from '../../shared/types'

export function liveProductionTags(
  deployedTags: JenkinsDeployedTag[],
  service?: string,
) {
  const serviceKey = service?.toLowerCase()
  const tags = deployedTags
    .filter(
      (deployment) =>
        deployment.environment === 'production' &&
        (deployment.status === undefined || deployment.status === 'succeeded') &&
        (!serviceKey || deployment.service.toLowerCase() === serviceKey),
    )
    .map((deployment) => deployment.tag)
  return [...new Set(tags)]
}
