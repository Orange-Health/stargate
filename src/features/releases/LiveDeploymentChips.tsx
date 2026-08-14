import type { JenkinsDeployedTag } from '../../shared/types'
import { PipelineStageList } from './PipelineStageList'

function deploymentLabel(deployment: JenkinsDeployedTag) {
  const environment = deployment.environment.toUpperCase()
  switch (deployment.status) {
    case 'running':
      return `Running in ${environment}`
    case 'failed':
      return `Failed in ${environment}`
    case 'canceled':
      return `Canceled in ${environment}`
    default:
      return `Live in ${environment}`
  }
}

export function LiveDeploymentChips({
  deployments,
}: {
  deployments: JenkinsDeployedTag[]
}) {
  if (deployments.length === 0) return null

  return (
    <div className="live-deployments">
      {deployments.map((deployment) => (
        <div
          className="live-deployment-item"
          key={`${deployment.service}-${deployment.environment}-${deployment.buildNumber}`}
        >
          <a
            className={`live-deployment ${deployment.status ?? 'succeeded'}`}
            href={deployment.buildUrl || undefined}
            target="_blank"
            rel="noreferrer"
            title={`${deployment.service} · Jenkins build #${deployment.buildNumber}${
              deployment.currentStage ? ` · ${deployment.currentStage}` : ''
            }`}
          >
            <span aria-hidden="true">●</span> {deploymentLabel(deployment)}
          </a>
          <PipelineStageList
            stages={deployment.stages}
            currentStage={
              deployment.status === 'running'
                ? deployment.currentStage
                : undefined
            }
          />
        </div>
      ))}
    </div>
  )
}
