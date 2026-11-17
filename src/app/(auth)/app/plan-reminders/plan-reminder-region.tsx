import type { CurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import { getPlanReminders } from '@/server/plans/reminders'
import { PlanReminderBanner } from './plan-reminder-banner'
import { respondToPlanReminderAction } from './actions'
import styles from './plan-reminders.module.scss'
import { PlanReminderLink } from './plan-reminder-link'

export async function PlanReminderRegion({ user }: { user: CurrentUser }) {
  try {
    const reminders = await getPlanReminders(getOwnerContext(user))
    return reminders.map((reminder) => (
      <PlanReminderBanner
        key={reminder.fingerprint}
        reminder={reminder}
        onRespond={respondToPlanReminderAction}
      />
    ))
  } catch {
    return (
      <p className={styles.unavailable} role="status">
        Plan reminders are temporarily unavailable.{' '}
        <PlanReminderLink href="/app/training/plan/refresh">Review approved plans</PlanReminderLink>
      </p>
    )
  }
}
