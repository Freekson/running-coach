import type { GoalStatus } from '@/lib/goal-progress'
import type { GoalView } from './goal-view'
import styles from './goals.module.scss'

export const statusLabels: Record<GoalStatus, string> = {
  ACTIVE: 'Active',
  ACHIEVED: 'Achieved',
  OVERDUE: 'Overdue',
  ARCHIVED: 'Archived',
}

export function goalStatus(goal: GoalView): GoalStatus {
  return goal.archived ? 'ARCHIVED' : (goal.progress?.status ?? 'ACTIVE')
}

export function dateLabel(value: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`))
}

function duration(seconds: number) {
  const rounded = Math.ceil(seconds)
  const minutes = Math.floor(rounded / 60)
  return `${minutes >= 60 ? `${Math.floor(minutes / 60)}:` : ''}${String(minutes % 60).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`
}

export function deadlineLabel(days: number) {
  if (days === 0) return 'Due today'
  const count = Math.abs(days)
  return `${count} ${count === 1 ? 'day' : 'days'} ${days < 0 ? 'overdue' : 'left'}`
}

export function GoalProgressContent({ goal }: { goal: GoalView }) {
  const progress = goal.progress
  if (!progress) return <p className={styles.progressNote}>Progress unavailable</p>
  const cumulative = goal.type === 'VOLUME' || goal.type === 'CONSISTENCY'
  const targetSeconds = goal.targetTime
    ? goal.targetTime.split(':').reduce((total, part) => total * 60 + Number(part), 0)
    : null
  return (
    <div className={styles.progressContent}>
      {cumulative ? (
        <>
          <div className={styles.progressHeading}>
            <p className={styles.metric}>
              <strong>
                {goal.type === 'VOLUME'
                  ? new Intl.NumberFormat('en', { maximumFractionDigits: 3 }).format(
                      progress.distanceMeters / 1000,
                    )
                  : progress.runCount}
              </strong>
              <span>
                /{' '}
                {goal.type === 'VOLUME' ? `${goal.distanceKm} km` : `${goal.sessionsPerWeek} runs`}
              </span>
            </p>
            <strong className={styles.percent}>{progress.percent}%</strong>
          </div>
          <progress
            className={styles.progressBar}
            max={100}
            value={progress.percent ?? 0}
            aria-label={`${goal.name} progress`}
          />
          <p className={styles.progressNote}>
            {goal.type === 'VOLUME' ? 'Distance' : 'Runs'} completed in goal window
          </p>
          {goal.type === 'VOLUME' && goal.elevationGainM && (
            <p className={styles.progressNote}>
              {progress.elevationGainM} / {goal.elevationGainM} m elevation gain
            </p>
          )}
        </>
      ) : goal.type === 'PERFORMANCE' ? (
        <>
          <div className={styles.performanceMetric}>
            <div>
              <p className={styles.progressNote}>Best recorded</p>
              <p className={styles.metric}>
                <strong>
                  {progress.bestTimeSeconds === null
                    ? 'No result'
                    : duration(progress.bestTimeSeconds)}
                </strong>
              </p>
            </div>
            <div className={styles.targetMetric}>
              <p className={styles.progressNote}>Target</p>
              <strong>{targetSeconds === null ? 'No time set' : duration(targetSeconds)}</strong>
            </div>
          </div>
          <p className={styles.progressNote}>
            {progress.bestTimeSeconds === null
              ? 'Awaiting a qualifying run'
              : targetSeconds === null
                ? 'Set a target time to measure achievement'
                : progress.achieved
                  ? 'Target time achieved'
                  : `${duration(progress.bestTimeSeconds - targetSeconds)} to improve`}
          </p>
        </>
      ) : (
        <>
          <p className={styles.metric}>
            <strong>{progress.achieved ? 'Completed' : 'Not completed'}</strong>
          </p>
          <p className={styles.progressNote}>
            {progress.achieved ? 'Qualifying run recorded' : 'Awaiting a qualifying run'}
          </p>
        </>
      )}
      <p className={styles.window}>
        {progress.from ? dateLabel(progress.from) : 'All recorded history'} –{' '}
        {dateLabel(progress.through)} · {progress.timezone}
      </p>
      {progress.surfaceUnknownRunCount > 0 && (
        <p className={styles.progressNote}>
          {progress.surfaceUnknownRunCount}{' '}
          {progress.surfaceUnknownRunCount === 1 ? 'run excluded' : 'runs excluded'}: surface
          unknown.
        </p>
      )}
    </div>
  )
}
