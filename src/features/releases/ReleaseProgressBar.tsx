import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  completedProgressStepIds,
  isStepComplete,
  newlyCompletedProgressStepIds,
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
  'prs-merged': 'Yet to merge',
  'tags-created': 'Yet to tag',
  'deployed-qa': 'Yet to deploy',
}

export const STEP_CELEBRATION_MS = 5_000
const CONFETTI_COUNT = 56
const CONFETTI_COLORS = [
  '#34d399',
  '#7db9ff',
  '#ffd27a',
  '#d3c2ff',
  '#ffaaa4',
  '#ffffff',
]

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

function confettiPieces() {
  return Array.from({ length: CONFETTI_COUNT }, (_, index) => ({
    id: index,
    left: `${(index * 17 + 11) % 100}%`,
    delay: `${(index % 12) * 0.08}s`,
    duration: `${3.4 + (index % 8) * 0.2}s`,
    color: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
    rotate: `${(index * 47) % 360}deg`,
    width: `${6 + (index % 5)}px`,
  }))
}

function StepCelebration() {
  const pieces = confettiPieces()

  return createPortal(
    <div className="rm-celebration" role="status" aria-live="polite">
      <div className="rm-celebration-confetti" aria-hidden="true">
        {pieces.map((piece) => (
          <span
            className="rm-confetti-piece"
            key={piece.id}
            style={{
              background: piece.color,
              left: piece.left,
              width: piece.width,
              animationDelay: piece.delay,
              animationDuration: piece.duration,
              transform: `rotate(${piece.rotate})`,
            }}
          />
        ))}
      </div>
      <p className="rm-celebration-banner">You are the best RM</p>
    </div>,
    document.body,
  )
}

export function ReleaseProgressBar({ progress }: Props) {
  const steps = releaseProgressSteps(progress)
  const firstIncomplete = steps.findIndex((step) => !isStepComplete(step))
  const completeIds = completedProgressStepIds(progress)
  const completeKey = completeIds.join('|')
  const previousVersionId = useRef(progress.versionId)
  const previousComplete = useRef<Set<(typeof completeIds)[number]> | null>(
    null,
  )
  const [celebrationId, setCelebrationId] = useState(0)

  useEffect(() => {
    const ids = completeKey
      ? (completeKey.split('|') as typeof completeIds)
      : []
    if (
      previousComplete.current === null ||
      previousVersionId.current !== progress.versionId
    ) {
      previousVersionId.current = progress.versionId
      previousComplete.current = new Set(ids)
      return
    }
    const newly = newlyCompletedProgressStepIds(previousComplete.current, ids)
    previousComplete.current = new Set(ids)
    if (newly.length === 0) return
    setCelebrationId((current) => current + 1)
  }, [completeKey, progress.versionId])

  useEffect(() => {
    if (celebrationId === 0) return
    const timer = window.setTimeout(
      () => setCelebrationId(0),
      STEP_CELEBRATION_MS,
    )
    return () => window.clearTimeout(timer)
  }, [celebrationId])

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
      {celebrationId > 0 && <StepCelebration key={celebrationId} />}
    </div>
  )
}
