import {
  isStepComplete,
  progressRatio,
  releaseProgressSteps,
  repositoryShortName,
  type ReleaseProgressSnapshot,
  type ReleaseProgressStep,
} from './releaseProgress'

type Props = {
  progress: ReleaseProgressSnapshot
}

const PENDING_STEP_HINT: Partial<Record<ReleaseProgressStep['id'], string>> = {
  'tickets-finalised': 'Yet to create',
  'prs-merged': 'Yet to merge',
  'tags-created': 'Yet to tag',
  'deployed-qa': 'Yet to deploy',
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
      <path
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  )
}

function pendingLabel(step: ReleaseProgressStep) {
  const names = step.pendingRepositories.map(repositoryShortName)
  if (names.length === 0) return undefined
  const hint = PENDING_STEP_HINT[step.id]
  if (!hint) return undefined
  return `${hint}: ${names.join(', ')}`
}

export function ReleaseProgressBar({ progress }: Props) {
  const steps = releaseProgressSteps(progress)
  const firstIncomplete = steps.findIndex((step) => !isStepComplete(step))

  return (
    <div
      className="release-progress"
      role="list"
      aria-label="Release progress"
    >
      {steps.map((step, index) => {
        const complete = isStepComplete(step)
        const current =
          !complete && (firstIncomplete === -1 || index === firstIncomplete)
        const fill = progressRatio(step) * 100
        const state = complete ? 'complete' : current ? 'current' : 'pending'
        const remaining = complete ? [] : step.pendingRepositories
        const hoverLabel = remaining.length > 0 ? pendingLabel(step) : undefined
        const alignEnd = index >= steps.length - 2
        return (
          <div
            className={`release-progress-step ${state}${hoverLabel ? ' has-pending' : ''}${alignEnd ? ' tooltip-end' : ''}`}
            role="listitem"
            aria-current={current ? 'step' : undefined}
            aria-label={
              hoverLabel
                ? `${step.label}, ${step.current} of ${step.total}. ${hoverLabel}`
                : `${step.label}, ${step.current} of ${step.total}`
            }
            data-tooltip={hoverLabel}
            key={step.id}
          >
            <span className="release-progress-node">
              {complete ? <CheckIcon /> : index + 1}
            </span>
            {index < steps.length - 1 && (
              <div className="release-progress-track" aria-hidden="true">
                <span style={{ width: `${fill}%` }} />
              </div>
            )}
            <span className="release-progress-copy">
              <strong>{step.label}</strong>
              <small>
                {step.total === 0
                  ? '0 of 0'
                  : `${step.current} of ${step.total}`}
              </small>
            </span>
          </div>
        )
      })}
    </div>
  )
}
