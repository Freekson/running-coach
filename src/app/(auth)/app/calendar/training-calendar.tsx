'use client'

import Link from 'next/link'
import { useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { DateField } from '@/components/ui/DateField'
import { FormField } from '@/components/ui/FormField'
import { Dialog } from '@/components/ui/Dialog'
import { EmptyState } from '@/components/ui/States'
import {
  adjacentCalendarDate,
  type CalendarWorkout,
  type RescheduleResult,
  type TrainingCalendarData,
} from '@/lib/training-calendar'
import styles from './calendar.module.scss'

const statusLabels = {
  planned: 'Planned',
  completed: 'Completed',
  missed: 'Missed',
  cancelled: 'Canceled',
} as const
function dateLabel(date: string) {
  return new Intl.DateTimeFormat('en', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${date}T00:00:00Z`))
}
function href(date: string, view: TrainingCalendarData['view']) {
  return `/app/calendar?date=${date}&view=${view}`
}

type MoveInput = {
  planId: string
  expectedRevisionId: string
  workoutId: string
  scheduledDate: string
  timezone: string
}
export type TrainingCalendarProps = {
  data: TrainingCalendarData
  refreshing?: boolean
  onReschedule?: (input: MoveInput) => Promise<RescheduleResult>
  onReload?: () => void
}

export function TrainingCalendar({
  data,
  refreshing = false,
  onReschedule,
  onReload,
}: TrainingCalendarProps) {
  const [editing, setEditing] = useState<CalendarWorkout | null>(null)
  const [date, setDate] = useState('')
  const [timezone, setTimezone] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<RescheduleResult | null>(null)
  const [notice, setNotice] = useState('')
  async function save() {
    if (!editing || !onReschedule || pending || refreshing) return
    setPending(true)
    setResult(null)
    try {
      const next = await onReschedule({
        planId: editing.planId,
        expectedRevisionId: editing.revisionId,
        workoutId: editing.id,
        scheduledDate: date,
        timezone,
      })
      setResult(next)
      if (next.success) {
        setEditing(null)
        setNotice('Session moved.')
      }
    } catch {
      setResult({
        success: false,
        code: 'unavailable',
        error: 'The session could not be moved. Please try again.',
      })
    } finally {
      setPending(false)
    }
  }
  return (
    <div className={styles.calendar} aria-busy={refreshing || undefined}>
      <header className={styles.header}>
        <div>
          <h1>Training calendar</h1>
          <p>Plan your training, one local day at a time.</p>
        </div>
        <nav aria-label="Calendar view" className={styles.controls}>
          <ButtonLink
            variant="secondary"
            href={href(data.date, 'week')}
            aria-current={data.view === 'week' ? 'page' : undefined}
          >
            Week
          </ButtonLink>
          <ButtonLink
            variant="secondary"
            href={href(data.date, 'month')}
            aria-current={data.view === 'month' ? 'page' : undefined}
          >
            Month
          </ButtonLink>
        </nav>
      </header>
      <div className={styles.toolbar}>
        <nav aria-label="Calendar dates" className={styles.controls}>
          <ButtonLink
            variant="secondary"
            href={href(adjacentCalendarDate(data.date, data.view, -1), data.view)}
            aria-label={`Previous ${data.view}`}
          >
            <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
          </ButtonLink>
          <ButtonLink variant="secondary" href={href(data.today, data.view)}>
            Today
          </ButtonLink>
          <ButtonLink
            variant="secondary"
            href={href(adjacentCalendarDate(data.date, data.view, 1), data.view)}
            aria-label={`Next ${data.view}`}
          >
            <ChevronRight size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
          </ButtonLink>
        </nav>
        <h2>
          {data.view === 'month'
            ? new Intl.DateTimeFormat('en', {
                timeZone: 'UTC',
                month: 'long',
                year: 'numeric',
              }).format(new Date(`${data.date}T00:00:00Z`))
            : `${dateLabel(data.days[0].date)} – ${dateLabel(data.days[data.days.length - 1].date)}, ${data.date.slice(0, 4)}`}
        </h2>
      </div>
      <p className={styles.caption}>
        Calendar timezone: {data.timezone}. Sessions keep their scheduled local date and timezone.
        Activities use their recorded timezone when available.
      </p>
      {!data.hasPlan && (
        <Card>
          <EmptyState
            title="No approved plan yet"
            description="Your saved activities still appear below. Approve a training plan to see scheduled sessions and rest days."
            action={
              <ButtonLink href="/app/goals" variant="secondary">
                View goals
              </ButtonLink>
            }
          />
        </Card>
      )}
      <p role="status" className={styles.caption}>
        {refreshing ? 'Updating calendar…' : notice}
      </p>
      <div
        className={styles.days}
        aria-label={`${data.view === 'week' ? 'Weekly' : 'Monthly'} training calendar`}
      >
        {data.days.map((day) => (
          <section
            key={day.date}
            className={styles.day}
            data-today={day.date === data.today || undefined}
            aria-label={dateLabel(day.date)}
          >
            <h3>
              <time dateTime={day.date}>{dateLabel(day.date)}</time>
              {day.date === data.today && <span className={styles.caption}>Today</span>}
            </h3>
            {day.workouts.map((workout) => (
              <article
                className={styles.session}
                key={workout.id}
                aria-label={`${workout.name}: ${statusLabels[workout.status]}`}
              >
                <Badge
                  tone={
                    workout.status === 'completed'
                      ? 'success'
                      : workout.status === 'missed'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {statusLabels[workout.status]}
                </Badge>
                <h4>{workout.name}</h4>
                <p className={styles.caption}>
                  {workout.sport.toLowerCase()} · {workout.timezone}
                </p>
                {workout.movedFrom && (
                  <p className={styles.caption}>Moved from {workout.movedFrom}</p>
                )}
                {workout.locked && <p className={styles.caption}>Locked</p>}
                {workout.activity && (
                  <Link href={`/app/training/${workout.activity.id}`}>
                    Activity: {workout.activity.title}
                  </Link>
                )}
                {workout.editable && onReschedule && (
                  <Button
                    size="compact"
                    variant="secondary"
                    disabled={refreshing || pending}
                    aria-label={`Move ${workout.name}`}
                    onClick={() => {
                      setEditing(workout)
                      setDate(workout.date)
                      setTimezone(workout.timezone)
                      setResult(null)
                      setNotice('')
                    }}
                  >
                    Move session
                  </Button>
                )}
              </article>
            ))}
            {day.activities.map((activity) => (
              <article key={activity.id} className={styles.session}>
                <Badge tone={activity.linkedWorkoutId ? 'success' : 'info'}>
                  {activity.linkedWorkoutId ? 'Linked activity' : 'Unlinked activity'}
                </Badge>
                <h4>
                  <Link href={`/app/training/${activity.id}`}>{activity.title}</Link>
                </h4>
                <p className={styles.caption}>{activity.timezone}</p>
              </article>
            ))}
            {day.rest ? (
              <p className={styles.caption}>Rest / recovery day</p>
            ) : !day.workouts.length && !day.activities.length ? (
              <p className={styles.caption}>No sessions scheduled</p>
            ) : null}
          </section>
        ))}
      </div>
      <Dialog
        open={!!editing}
        title="Move session"
        description={editing?.name}
        pending={pending || refreshing}
        icon={<CalendarDays size={20} strokeWidth={2} aria-hidden="true" focusable="false" />}
        onClose={() => setEditing(null)}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={pending || refreshing}
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                !date ||
                !timezone.trim() ||
                refreshing ||
                (result !== null && !result.success && result.code === 'conflict')
              }
              loading={pending}
              onClick={save}
            >
              Approve date change
            </Button>
          </>
        }
      >
        {editing && (
          <div className={styles.form}>
            <DateField
              id="session-date"
              label="Scheduled date"
              value={date}
              onChange={setDate}
              min={editing.minDate}
              max={editing.maxDate}
              disabled={pending || refreshing}
            />
            <FormField
              label="Session timezone"
              id="session-timezone"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              disabled={pending || refreshing}
              placeholder="Europe/London"
            />
            <p className={styles.caption}>
              Choose a future date within {editing.minDate} – {editing.maxDate}. Approving saves a
              new plan revision.
            </p>
            {result && !result.success && (
              <div role="alert">
                <p>{result.error}</p>
                {result.code === 'conflict' && onReload && (
                  <Button
                    variant="secondary"
                    disabled={refreshing}
                    onClick={() => {
                      setEditing(null)
                      onReload()
                    }}
                  >
                    Reload calendar
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  )
}
