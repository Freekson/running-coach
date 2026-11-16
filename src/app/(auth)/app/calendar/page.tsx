import { ButtonLink } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/States'
import { calendarQuerySchema } from '@/lib/training-calendar'
import { getOwnerContext } from '@/server/authorization/ownership'
import { getMeasurementSystem } from '@/server/athlete/profile'
import { getTrainingCalendar } from '@/server/plans/calendar'
import { getAppUser } from '../access'
import { AccountUnavailable } from '../account-unavailable'
import { AppShell } from '../app-shell'
import { CalendarController } from './calendar-controller'
import styles from './calendar.module.scss'

export default async function CalendarPage({
  searchParams,
}: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const owner = getOwnerContext(user)
  const query = calendarQuerySchema.safeParse((await searchParams) ?? {})
  const [measurement, calendar] = await Promise.allSettled([
    getMeasurementSystem(owner),
    query.success ? getTrainingCalendar(owner, query.data) : Promise.resolve(null),
  ])
  const data = calendar.status === 'fulfilled' ? calendar.value : null
  return (
    <AppShell
      user={user}
      measurementSystem={measurement.status === 'fulfilled' ? measurement.value : 'METRIC'}
    >
      <main>
        {data ? (
          <CalendarController key={`${data.date}-${data.view}`} data={data} />
        ) : (
          <>
            <h1 className={styles.title}>Training calendar</h1>
            <Card>
              <EmptyState
                title="Calendar unavailable"
                description={
                  query.success
                    ? 'Your calendar could not be loaded. Please try again.'
                    : 'The calendar date or view is invalid. Reset the calendar and try again.'
                }
                action={
                  <ButtonLink href="/app/calendar" variant="secondary">
                    {query.success ? 'Try again' : 'Reset calendar'}
                  </ButtonLink>
                }
              />
            </Card>
          </>
        )}
      </main>
    </AppShell>
  )
}
