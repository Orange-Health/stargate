import type {
  ConnectionConfig,
  DeploymentFreshness,
} from '../../src/shared/types.js'
import { getLatestSuccessfulQaTag } from '../providers/githubOperations.js'
import {
  getCurrentDeployments,
  servicesForRepository,
} from '../providers/jenkins.js'

export async function getDeploymentFreshness(
  config: ConnectionConfig,
  repositories: string[],
): Promise<DeploymentFreshness[]> {
  const results: DeploymentFreshness[] = new Array(repositories.length)
  let cursor = 0

  async function worker() {
    while (cursor < repositories.length) {
      const index = cursor++
      const repository = repositories[index]
      try {
        const [latestBuiltQaTag, deployments] = await Promise.all([
          getLatestSuccessfulQaTag(config, repository),
          getCurrentDeployments(config, repository),
        ])
        const services = servicesForRepository(repository)
        const liveQaDeployments = deployments.filter(
          (deployment) => deployment.environment === 'qa',
        )
        const liveQaTags = [
          ...new Set(liveQaDeployments.map((deployment) => deployment.tag)),
        ]
        const outdated =
          Boolean(latestBuiltQaTag) &&
          services.length > 0 &&
          services.some(
            (service) =>
              !liveQaDeployments.some(
                (deployment) =>
                  deployment.service === service &&
                  deployment.tag === latestBuiltQaTag,
              ),
          )
        results[index] = {
          repository,
          latestBuiltQaTag,
          liveQaTags,
          outdated,
          checkFailed: false,
        }
      } catch {
        results[index] = {
          repository,
          liveQaTags: [],
          outdated: false,
          checkFailed: true,
        }
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(5, repositories.length) },
      () => worker(),
    ),
  )
  return results
}
