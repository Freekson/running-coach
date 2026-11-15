import { ListOrdered } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { estimateWorkout, formatDuration, formatEstimate } from '@/lib/workout-estimate'
import type { WorkoutDefinition, WorkoutNode, WorkoutStep } from '@/schemas/workout-definition.v1'
import styles from './workout-builder.module.scss'

function stepDescription(step: WorkoutStep) {
  const ending = step.termination
  const target = step.target
  const duration =
    ending.type === 'time'
      ? `${formatDuration(ending.durationSeconds)} time`
      : ending.type === 'distance'
        ? `${ending.distanceMeters} m`
        : 'Until lap press'
  const intensity =
    target.type === 'free'
      ? 'Free target'
      : target.type === 'pace'
        ? `${formatDuration(target.minSecondsPerKm)}–${formatDuration(target.maxSecondsPerKm)} /km`
        : `${target.minBpm}–${target.maxBpm} bpm`
  return `${duration} · ${intensity}`
}

function PreviewSteps({ steps }: { steps: WorkoutNode[] }) {
  return (
    <ol className={styles.previewSteps}>
      {steps.map((step, index) => (
        <li key={index}>
          {step.type === 'repeat' ? (
            <>
              <strong>Repeat {step.count} times</strong>
              <PreviewSteps steps={step.steps} />
            </>
          ) : (
            <>
              <strong>{step.name ?? 'Step'}</strong>
              <span>{stepDescription(step)}</span>
            </>
          )}
        </li>
      ))}
    </ol>
  )
}

export function WorkoutPreview({ definition }: { definition: WorkoutDefinition }) {
  const estimate = estimateWorkout(definition)
  return (
    <Card as="section" className={styles.preview} aria-label="Workout preview">
      <SectionHeading icon={ListOrdered} title="Preview" />
      <dl className={styles.estimates} aria-live="polite" aria-atomic="true">
        <div>
          <dt>Estimated duration</dt>
          <dd>{formatEstimate(estimate.durationSeconds, 'time')}</dd>
        </div>
        <div>
          <dt>Estimated distance</dt>
          <dd>{formatEstimate(estimate.distanceMeters, 'distance')}</dd>
        </div>
        <div>
          <dt>Steps after repeats</dt>
          <dd>{estimate.stepCount}</dd>
        </div>
      </dl>
      <p className={styles.hint}>
        Pace targets give an estimate range. Free, HR and lap steps can leave totals unknown.
      </p>
      <p className={styles.hint}>
        Each repeat includes its entire sequence, including the final recovery.
      </p>
      <PreviewSteps steps={definition.steps} />
    </Card>
  )
}
