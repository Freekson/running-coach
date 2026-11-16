import { CalendarDays, Layers, TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { addHealthDays } from '@/lib/health-history'
import type { PlanImportResult, RefreshDiff } from '@/lib/plan-import'
import { formatDuration, formatEstimate } from '@/lib/workout-estimate'
import type { WorkoutNode } from '@/schemas/workout-definition.v1'
import styles from './plan-wizard.module.scss'

type Preview = Extract<PlanImportResult, { valid: true }>['preview']
export function PlanReview({
  preview,
  timezone,
  acknowledged,
  onAcknowledge,
  disabled,
}: {
  preview: Preview
  timezone: string
  acknowledged: string[]
  onAcknowledge: (id: string, checked: boolean) => void
  disabled: boolean
}) {
  const response = preview.response
  if (response.mode === 'refresh' && !preview.refresh)
    return (
      <Card>
        <p role="alert">
          Reload and validate this refresh against the saved revision to inspect its changes.
        </p>
      </Card>
    )
  const macro = preview.refresh?.macroPlan ?? response.macroPlan
  const schedule =
    response.mode === 'initial'
      ? response.workouts
      : preview.refresh!.schedule.filter((w) => !w.cancelled)
  const dates: string[] = []
  for (
    let date = response.detailWindow.startDate;
    date <= response.detailWindow.endDate && dates.length < 28;
    date = addHealthDays(date, 1)
  )
    dates.push(date)
  return (
    <>
      <Card className={styles.stack}>
        <SectionHeading icon={Layers} title="Full-goal strategy and macro phases" />
        <p>
          {macro.startDate} – {macro.endDate}
        </p>
        <p>{macro.strategy}</p>
        {preview.refresh && (
          <p>The approved macro strategy is preserved. Refresh changes near-term workouts only.</p>
        )}
        <ol>
          {macro.phases.map((phase, index) => (
            <li key={index}>
              <h3>{phase.label}</h3>
              <p>
                {phase.startDate} – {phase.endDate}
              </p>
              <p>{phase.notes}</p>
            </li>
          ))}
        </ol>
      </Card>
      {preview.refresh && (
        <Card className={styles.stack}>
          <SectionHeading icon={Layers} title="Changes from the approved revision" />
          <p>
            {preview.refresh.retainedOutsideWindow} workouts outside this window are retained.
            Omitted workouts keep their saved definitions and dates.
          </p>
          <RefreshChanges changes={preview.refresh.changes} />
        </Card>
      )}
      <Card className={styles.stack}>
        <SectionHeading icon={CalendarDays} title="Detailed training calendar" />
        <p>
          {response.detailWindow.startDate} – {response.detailWindow.endDate} · Local dates in{' '}
          {timezone}. Blank days below are proposed rest days. Estimates include unknown portions
          where the workout leaves time or distance open.
        </p>
        <div className={styles.calendar}>
          {dates.map((date) => {
            const workouts = schedule.filter((workout) => workout.scheduledDate === date)
            return (
              <section key={date} className={styles.day}>
                <h3>
                  <time dateTime={date}>{date}</time>
                </h3>
                {!workouts.length && <p>Rest day</p>}
                {workouts.map((workout) => {
                  const estimate = preview.sessions.find(
                    (session) => session.workoutId === workout.workoutId,
                  )?.estimate
                  return (
                    <article key={workout.workoutId}>
                      <h4>{workout.definition.name}</h4>
                      {'timezone' in workout && typeof workout.timezone === 'string' && (
                        <p>{workout.timezone}</p>
                      )}
                      <Badge>{workout.definition.sport.toLowerCase()}</Badge>
                      {estimate && (
                        <p>
                          {formatEstimate(estimate.durationSeconds, 'time')} ·{' '}
                          {formatEstimate(estimate.distanceMeters, 'distance')}
                        </p>
                      )}
                      <WorkoutSteps nodes={workout.definition.steps} />
                    </article>
                  )
                })}
              </section>
            )
          })}
        </div>
        <div className={styles.tableWrap}>
          <table>
            <caption>Proposed weekly load · {preview.methodVersion}</caption>
            <thead>
              <tr>
                <th scope="col">Week</th>
                <th scope="col">Sessions</th>
                <th scope="col">Duration</th>
                <th scope="col">Distance</th>
              </tr>
            </thead>
            <tbody>
              {preview.weeks.map((week) => (
                <tr key={week.startDate}>
                  <th scope="row">
                    {week.startDate} – {week.endDate}
                  </th>
                  <td>{week.sessions}</td>
                  <td>
                    {formatDuration(week.durationSeconds)}
                    {week.durationIncomplete ? ' + unknown' : ''}
                  </td>
                  <td>
                    {(week.distanceMeters / 1000).toFixed(1)} km
                    {week.distanceIncomplete ? ' + unknown' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card className={styles.stack}>
        <SectionHeading icon={TriangleAlert} title="Load warnings and review" />
        <p>
          These checks describe recorded evidence and uncertainty. They do not establish that a plan
          is safe for you. Acknowledge every warning before local approval.
        </p>
        {!!response.warnings?.length && (
          <>
            <h3>Notes from the imported response</h3>
            <ul>
              {response.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </>
        )}
        {!preview.warnings.length && (
          <p>No load warnings were raised. Explicit plan approval is still required.</p>
        )}
        {preview.warnings.map((warning) => (
          <section key={warning.id} className={styles.day}>
            <Badge tone="warning">Review required · {warning.confidence} confidence</Badge>
            <p>{warning.message}</p>
            <p>
              Proposed: {warning.evidence.proposed ?? 'Unknown'} · Observed:{' '}
              {warning.evidence.observed ?? 'Unknown'} {warning.evidence.unit ?? ''}
              {warning.evidence.window
                ? ` · ${warning.evidence.window.startDate} – ${warning.evidence.window.endDate}`
                : ''}
            </p>
            <label className={styles.choice}>
              <input
                type="checkbox"
                checked={acknowledged.includes(warning.id)}
                disabled={disabled}
                onChange={(event) => onAcknowledge(warning.id, event.target.checked)}
              />
              I reviewed this warning: {warning.code.replaceAll('_', ' ')}
            </label>
          </section>
        ))}
      </Card>
    </>
  )
}

export function RefreshChanges({ changes }: { changes: RefreshDiff[] }) {
  return (
    <>
      <p>
        {(['created', 'changed', 'canceled', 'unchanged'] as const)
          .map((kind) => `${changes.filter((change) => change.kind === kind).length} ${kind}`)
          .join(' · ')}
      </p>
      {changes.map((change) => (
        <details key={change.workoutId} className={styles.day}>
          <summary>
            {change.kind}: {change.after.definition.name} · {change.after.scheduledDate}
          </summary>
          {change.before && (
            <section>
              <h3>Before</h3>
              <p>
                {change.before.definition.name} · {change.before.scheduledDate} ·{' '}
                {change.before.timezone} · {change.before.cancelled ? 'Canceled' : 'Scheduled'}
              </p>
              <Badge>{change.before.definition.sport.toLowerCase()}</Badge>
              <WorkoutSteps nodes={change.before.definition.steps} />
            </section>
          )}
          <section>
            <h3>After</h3>
            <p>
              {change.after.definition.name} · {change.after.scheduledDate} ·{' '}
              {change.after.timezone} · {change.after.cancelled ? 'Canceled' : 'Scheduled'}
            </p>
            <Badge>{change.after.definition.sport.toLowerCase()}</Badge>
            <WorkoutSteps nodes={change.after.definition.steps} />
          </section>
        </details>
      ))}
    </>
  )
}

export function WorkoutSteps({ nodes }: { nodes: WorkoutNode[] }) {
  return (
    <ol>
      {nodes.map((node, index) => (
        <li key={index}>
          {node.type === 'repeat' ? (
            <>
              <strong>Repeat {node.count} times</strong>
              <WorkoutSteps nodes={node.steps} />
            </>
          ) : (
            <>
              {node.name && `${node.name}: `}
              {node.termination.type === 'time'
                ? formatDuration(node.termination.durationSeconds)
                : node.termination.type === 'distance'
                  ? `${node.termination.distanceMeters} m`
                  : 'Until lap press'}
              {' · '}
              {node.target.type === 'free'
                ? 'Free effort'
                : node.target.type === 'heartRate'
                  ? `${node.target.minBpm}–${node.target.maxBpm} bpm`
                  : `${formatDuration(node.target.minSecondsPerKm)}–${formatDuration(node.target.maxSecondsPerKm)} /km`}
            </>
          )}
        </li>
      ))}
    </ol>
  )
}
