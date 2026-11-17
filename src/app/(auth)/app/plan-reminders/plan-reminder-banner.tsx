'use client'

import { useId, useState, useTransition } from 'react'
import { CalendarClock } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { useToast } from '@/components/ui/Toast'
import type { PlanReminder, PlanReminderCommand, PlanReminderResult } from '@/lib/plan-reminders'
import styles from './plan-reminders.module.scss'
import { PlanReminderLink } from './plan-reminder-link'

export function PlanReminderBanner({
  reminder,
  onRespond,
}: {
  reminder: PlanReminder
  onRespond: (command: PlanReminderCommand) => Promise<PlanReminderResult>
}) {
  const titleId = useId()
  const notify = useToast()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState(false)
  const actionByDate =
    reminder.refreshByDate < reminder.detailEndDate
      ? reminder.refreshByDate
      : reminder.detailEndDate

  function respond(action: PlanReminderCommand['action']) {
    setError(null)
    startTransition(async () => {
      try {
        const result = await onRespond({
          planId: reminder.planId,
          fingerprint: reminder.fingerprint,
          action,
        })
        if (!result.success) {
          setError(result.error)
          return
        }
        setCompleted(true)
        // The server-filtered banner can unmount before this action resolves.
        // Both the toast and main landmark belong to the stable root layout.
        notify(
          'success',
          action === 'dismiss'
            ? 'Reminder dismissed for this approved revision.'
            : 'Reminder snoozed for 24 hours.',
          `plan-reminder:${reminder.fingerprint}`,
        )
        document.getElementById('main-content')?.focus({ preventScroll: true })
      } catch {
        setError('The reminder could not be saved. Please try again.')
      }
    })
  }

  if (completed) return null

  return (
    <Card
      as="section"
      className={styles.banner}
      aria-labelledby={titleId}
      aria-busy={pending || undefined}
    >
      <SectionHeading
        id={titleId}
        icon={CalendarClock}
        title={
          reminder.nextAction === 'refresh'
            ? 'Plan your next training window'
            : 'Review your remaining training days'
        }
      />
      <p>
        {reminder.goalName}: your approved detail {reminder.exhausted ? 'ended' : 'ends'} on{' '}
        <time dateTime={reminder.detailEndDate}>{reminder.detailEndDate}</time> ({reminder.timezone}
        ).{' '}
        {reminder.nextAction === 'refresh' ? (
          <>
            {reminder.exhausted ? (
              'Refresh now'
            ) : (
              <>
                Refresh by <time dateTime={actionByDate}>{actionByDate}</time>
              </>
            )}{' '}
            to review the next 2–4 weeks.
          </>
        ) : (
          <>
            Some days before this plan ends still lack approved detail. A 14-day future refresh no
            longer fits. Review the plan and goal before deciding how to cover the remaining days.
          </>
        )}
      </p>
      <div className={styles.actions}>
        <PlanReminderLink
          href={
            reminder.nextAction === 'refresh'
              ? `/app/training/plan/refresh?planId=${reminder.planId}`
              : `/app/training/plan/${reminder.planId}`
          }
          disabled={pending}
        >
          {reminder.nextAction === 'refresh' ? 'Refresh plan' : 'Review plan'}
        </PlanReminderLink>
        <Button
          variant="secondary"
          size="compact"
          disabled={pending}
          onClick={() => respond('snooze')}
        >
          Snooze 24 hours
        </Button>
        <Button
          variant="secondary"
          size="compact"
          disabled={pending}
          onClick={() => respond('dismiss')}
        >
          Dismiss reminder
        </Button>
      </div>
      {pending && <p role="status">Saving reminder preference…</p>}
      {error && <p role="alert">{error}</p>}
    </Card>
  )
}
