'use client'

import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DateField } from '@/components/ui/DateField'
import { SectionHeading } from '@/components/ui/SectionHeading'
import type {
  ActivityMatchingData,
  MatchActivityInput,
  UnlinkActivityInput,
  MatchingResult,
  MatchCandidate,
} from '@/lib/activity-matching'
import { formatEstimate } from '@/lib/workout-estimate'
import styles from './activity-matching.module.scss'

function value(number: number | null, unit: string) {
  return number === null ? 'Unavailable' : `${Number(number.toFixed(2))} ${unit}`
}
function range(range: { min: number; max: number } | null, unit: string) {
  return range
    ? range.min === range.max
      ? value(range.min, unit)
      : `${value(range.min, unit)} – ${value(range.max, unit)}`
    : 'Unavailable'
}
function plannedRange(estimate: { min: number; max: number; incomplete: boolean }, unit: string) {
  if (estimate.incomplete && estimate.max === 0) return 'Unavailable'
  return `${range(estimate, unit)}${estimate.incomplete ? ' + unspecified steps' : ''}`
}
const paceSources = {
  'timer-distance': 'Timer and distance',
  'recorded-speed': 'Recorded average speed',
  unavailable: 'Unavailable',
} as const
function Comparison({ data, planned }: { data: ActivityMatchingData; planned: MatchCandidate }) {
  const compatible = planned.sport === data.sport && planned.sport !== 'OTHER'
  return (
    <Card as="section" className={styles.panel}>
      <SectionHeading icon={Link2} title="Planned vs actual" />
      <p>
        {planned.name} · {planned.sport.toLowerCase()} · {planned.date} ({planned.timezone})
      </p>
      <details className={styles.muted}>
        <summary>Comparison source</summary>
        <p>
          Approved revision: {planned.revisionId}. Planned ranges come from the saved workout steps
          and explicit pace targets.
        </p>
      </details>
      <p className={styles.muted}>
        Scroll the table horizontally on smaller screens to see every value.
      </p>
      {!compatible ? (
        <p role="alert">These sports are incompatible. Correct the link to compare metrics.</p>
      ) : (
        <div
          className={styles.scroll}
          tabIndex={0}
          role="region"
          aria-label="Planned and actual metrics, scroll for all columns"
        >
          <table>
            <caption>Saved metrics</caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Planned</th>
                <th scope="col">Actual</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Distance</th>
                <td>{plannedRange(planned.estimate.distanceMeters, 'm')}</td>
                <td>{value(data.actual.distanceMeters, 'm')}</td>
              </tr>
              <tr>
                <th scope="row">Duration</th>
                <td>{plannedRange(planned.estimate.durationSeconds, 's')}</td>
                <td>{value(data.actual.durationSeconds, 's')} (timer)</td>
              </tr>
              <tr>
                <th scope="row">Pace targets</th>
                <td>{range(planned.paceSecondsPerKm, 's/km')}</td>
                <td>
                  {value(data.actual.paceSecondsPerKm, 's/km')} (
                  {paceSources[data.actual.paceBasis]})
                </td>
              </tr>
              <tr>
                <th scope="row">Heart rate targets / average</th>
                <td>{range(planned.heartRateTargetBpm, 'bpm')}</td>
                <td>{value(data.actual.avgHrBpm, 'bpm')}</td>
              </tr>
              <tr>
                <th scope="row">Maximum heart rate</th>
                <td>Unavailable</td>
                <td>{value(data.actual.maxHrBpm, 'bpm')}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.muted}>
        Pace uses saved timer time and distance, or recorded average speed when those are missing.
        Step target ranges are not whole-session averages. Laps are shown as recorded; they are not
        assumed to align with planned steps.
      </p>
    </Card>
  )
}

export type ActivityMatchingProps = {
  data: ActivityMatchingData
  refreshing?: boolean
  onLink: (input: MatchActivityInput) => Promise<MatchingResult>
  onUnlink: (input: UnlinkActivityInput) => Promise<MatchingResult>
  onReload: () => void
  onSearch: (date: string) => void
}
export function ActivityMatching({
  data,
  refreshing = false,
  onLink,
  onUnlink,
  onReload,
  onSearch,
}: ActivityMatchingProps) {
  const [selected, setSelected] = useState(data.suggestionWorkoutId ?? '')
  const [date, setDate] = useState(data.searchDate)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const candidate = data.candidates.find((c) => c.workoutId === selected)
  async function save(unlink: boolean, duplicate?: UnlinkActivityInput) {
    if (pending || refreshing) return
    setPending(true)
    setError('')
    setNotice('')
    try {
      const unlinkInput =
        duplicate ??
        (data.linked
          ? {
              activityId: data.activityId,
              expectedWorkoutId: data.linked.workoutId,
            }
          : null)
      const result = unlink
        ? unlinkInput
          ? await onUnlink(unlinkInput)
          : null
        : candidate
          ? await onLink({
              activityId: data.activityId,
              expectedWorkoutId: data.linked?.workoutId ?? null,
              planId: candidate.planId,
              expectedRevisionId: candidate.revisionId,
              workoutId: candidate.workoutId,
            })
          : null
      if (result?.success) {
        setNotice(unlink ? 'Activity unlinked.' : 'Activity linked.')
        onReload()
      } else if (result) setError(result.error)
    } catch {
      setError('The link could not be saved. Reload and try again.')
    } finally {
      setPending(false)
    }
  }
  return (
    <main className={styles.page} aria-busy={pending || refreshing || undefined}>
      <header>
        <ButtonLink href={`/app/training/${data.activityId}`} variant="secondary">
          Back to activity
        </ButtonLink>
        <h1>Match completed activity</h1>
        <p>
          {data.title} · {data.sport.toLowerCase()}
        </p>
      </header>
      <Card as="section" className={styles.panel}>
        <SectionHeading icon={Link2} title="Saved Garmin activity" />
        <p>
          <time dateTime={data.startedAt}>{data.startedAt}</time> · Athlete-local date:{' '}
          {data.localDate} ({data.timezone})
        </p>
        <p className={styles.muted}>
          Garmin · {data.sourceRecordType} · Activity ID: {data.externalActivityId ?? 'Unavailable'}{' '}
          · Imported: {data.importedAt}
        </p>
        <p>
          Distance: {value(data.actual.distanceMeters, 'm')} · Timer:{' '}
          {value(data.actual.durationSeconds, 's')} · Pace:{' '}
          {value(data.actual.paceSecondsPerKm, 's/km')} ({paceSources[data.actual.paceBasis]})
        </p>
        <p className={styles.muted}>
          Uses saved Garmin activities. Use Sync now to import new activities; publish planned
          workouts separately.
        </p>
      </Card>
      {data.linked?.comparison && <Comparison data={data} planned={data.linked.comparison} />}
      {data.linked && !data.linked.comparison && (
        <p>
          Linked session has no saved comparison revision. Unlink and select a session to establish
          comparison provenance.
        </p>
      )}
      <Card as="section" className={styles.panel}>
        <SectionHeading
          icon={Link2}
          title={data.linked ? 'Correct activity link' : 'Choose a planned session'}
        />
        {data.ambiguous && (
          <p role="status">
            Multiple sessions are plausible. Select and confirm the correct session.
          </p>
        )}
        {data.suggestionWorkoutId && (
          <p role="status">
            One session matches the local date, sport and available metrics. Confirm the suggestion
            below.
          </p>
        )}
        {data.duplicateCount > 0 && (
          <p role="status">
            {data.duplicateCount} flagged duplicate activity record(s). Suggestions are disabled;
            confirm only one record for this completed session.
          </p>
        )}
        {data.duplicateLinked && (
          <p role="alert">
            A flagged duplicate is already linked. Unlink that record before linking this one.
          </p>
        )}
        {data.linkedDuplicates.map((duplicate) => (
          <div key={duplicate.workoutId}>
            <p>
              {duplicate.title} ·{' '}
              {duplicate.provider === 'INTERVALS' ? 'Intervals.icu' : duplicate.provider}
            </p>
            <Button
              variant="secondary"
              disabled={pending || refreshing}
              aria-label={`Unlink duplicate ${duplicate.title}`}
              onClick={() =>
                void save(true, {
                  activityId: duplicate.activityId,
                  expectedWorkoutId: duplicate.workoutId,
                })
              }
            >
              Unlink duplicate activity
            </Button>
          </div>
        ))}
        <div className={styles.search}>
          <DateField
            id="matching-date"
            label="Find sessions near date"
            value={date}
            onChange={setDate}
            disabled={pending || refreshing}
            min="1900-01-01"
            max="9998-12-31"
          />
          <Button
            variant="secondary"
            disabled={!date || pending || refreshing}
            onClick={() => onSearch(date)}
          >
            Find sessions
          </Button>
        </div>
        <p className={styles.muted}>
          Showing compatible, unlinked sessions within 7 days of {data.searchDate}. Change the date
          to find another session.
        </p>
        {data.candidates.length ? (
          <fieldset
            className={styles.choices}
            disabled={pending || refreshing || data.duplicateLinked}
          >
            <legend>Planned sessions</legend>
            {data.candidates.map((c) => (
              <label key={c.workoutId} className={styles.choice}>
                <input
                  type="radio"
                  name="planned-session"
                  value={c.workoutId}
                  checked={selected === c.workoutId}
                  onChange={() => setSelected(c.workoutId)}
                />
                <span>
                  <strong>{c.name}</strong>
                  <span>
                    {c.date} · {c.timezone} · {c.sport.toLowerCase()}
                  </span>
                  <span>
                    {formatEstimate(c.estimate.distanceMeters, 'distance')} ·{' '}
                    {formatEstimate(c.estimate.durationSeconds, 'time')}
                  </span>
                  {c.workoutId === data.suggestionWorkoutId && <span>Suggested match</span>}
                </span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p>No compatible unlinked sessions found. Try another date or approve a plan.</p>
        )}
        <p role="status">{refreshing ? 'Updating matches…' : notice}</p>
        {error && <p role="alert">{error}</p>}
        <div className={styles.actions}>
          <Button
            disabled={!candidate || pending || refreshing || data.duplicateLinked}
            loading={pending}
            onClick={() => void save(false)}
          >
            {data.linked ? 'Confirm relink' : 'Confirm link'}
          </Button>
          {data.linked && (
            <Button
              variant="secondary"
              disabled={pending || refreshing}
              onClick={() => void save(true)}
            >
              Unlink activity
            </Button>
          )}
          <Button variant="secondary" disabled={pending || refreshing} onClick={onReload}>
            Reload matches
          </Button>
        </div>
        <p className={styles.muted}>
          Unlinking or relinking preserves completed history and its permanent schedule locks.
        </p>
      </Card>
      <Card as="section" className={styles.panel}>
        <SectionHeading icon={Link2} title="Saved laps" />
        {data.laps.length ? (
          <div
            className={styles.scroll}
            tabIndex={0}
            role="region"
            aria-label="Saved lap metrics, scroll for all columns"
          >
            <table>
              <caption>Garmin lap metrics, with recorded provenance</caption>
              <thead>
                <tr>
                  {[
                    'Lap',
                    'Source',
                    'Distance (m)',
                    'Timer (s)',
                    'Pace (s/km)',
                    'Pace source',
                    'Avg HR (bpm)',
                    'Max HR (bpm)',
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.laps.map((lap) => (
                  <tr key={lap.index}>
                    <th scope="row">{lap.index + 1}</th>
                    <td>{lap.sourceRecordType}</td>
                    <td>{value(lap.distanceMeters, 'm')}</td>
                    <td>{value(lap.durationSeconds, 's')}</td>
                    <td>{value(lap.paceSecondsPerKm, 's/km')}</td>
                    <td>{paceSources[lap.paceBasis]}</td>
                    <td>{value(lap.avgHrBpm, 'bpm')}</td>
                    <td>{value(lap.maxHrBpm, 'bpm')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No saved lap metrics available.</p>
        )}
      </Card>
    </main>
  )
}
