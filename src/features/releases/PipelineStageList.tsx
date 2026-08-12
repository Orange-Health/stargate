import type { JenkinsPipelineStage } from '../../shared/types'

function formatStageDuration(durationMillis?: number) {
  if (durationMillis == null || durationMillis < 0) return undefined
  const seconds = Math.round(durationMillis / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
}

export function PipelineStageList({
  stages,
  currentStage,
}: {
  stages?: JenkinsPipelineStage[]
  currentStage?: string
}) {
  if (!stages?.length && !currentStage) return null

  return (
    <div className="pipeline-stage-block">
      {currentStage && !stages?.length && (
        <span className="pipeline-current-stage">
          <span className="spinner" aria-hidden="true" />
          {currentStage}
        </span>
      )}
      {stages && stages.length > 0 && (
        <div className="pipeline-stage-list" aria-label="Pipeline stages">
          {stages.map((stage) => {
            const duration = formatStageDuration(stage.durationMillis)
            return (
              <span
                className={`pipeline-stage ${stage.status}`}
                title={duration ? `${stage.name} · ${duration}` : stage.name}
                key={stage.id}
              >
                <span aria-hidden="true">●</span>
                {stage.name}
                {duration && stage.status !== 'pending' && <em>{duration}</em>}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
