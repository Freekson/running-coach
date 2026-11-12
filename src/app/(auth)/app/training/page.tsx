import { ButtonLink } from '@/components/ui/Button'
import { cookies } from 'next/headers'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/States'
import { getMeasurementSystem } from '@/server/athlete/profile'
import { getOwnerContext } from '@/server/authorization/ownership'
import { getGarminSyncState } from '@/server/garmin/sync'
import { getActivityHistory } from '@/server/activity/history'
import {
  activityHistoryQuerySchema,
  defaultActivityHistoryQuery,
  activityTimezoneCookie,
} from '@/lib/activity-history'
import type { GarminSyncState } from '@/lib/garmin-sync-state'
import { AccountUnavailable } from '../account-unavailable'
import { getAppUser } from '../access'
import { AppShell } from '../app-shell'
import { ActivitySyncPanel } from './activity-sync-panel'
import { ActivityHistory } from './activity-history'
import styles from './training.module.scss'

const unavailable: GarminSyncState = {
  status: 'UNAVAILABLE',
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextAttemptAt: null,
  window: null,
  nextDate: null,
  processed: 0,
  errorCode: null,
}

export default async function TrainingPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
} = {}) {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const owner = getOwnerContext(user)
  const parsed = activityHistoryQuerySchema.safeParse((await searchParams) ?? {})
  const query = parsed.success ? parsed.data : defaultActivityHistoryQuery
  const timezone = (await cookies()).get(activityTimezoneCookie)?.value
  const [measurement, sync, history] = await Promise.allSettled([
    getMeasurementSystem(owner),
    getGarminSyncState(owner),
    parsed.success ? getActivityHistory(owner, query, { timezone }) : Promise.resolve(null),
  ])
  const data = history.status === 'fulfilled' ? history.value : null
  const error = !parsed.success
    ? 'The activity filters are invalid. Reset them and try again.'
    : history.status === 'rejected' || measurement.status === 'rejected'
      ? 'Your saved activities could not be loaded. Please try again.'
      : null
  return (
    <AppShell
      user={user}
      measurementSystem={measurement.status === 'fulfilled' ? measurement.value : 'METRIC'}
    >
      <main className={styles.page}>
        <header className={styles.header}>
          <div>
            <h1>Activity History</h1>
            <p>Browse and filter your imported workouts.</p>
          </div>
          <ActivitySyncPanel
            initial={sync.status === 'fulfilled' ? sync.value : unavailable}
            savedAt={data?.savedAt}
          />
        </header>
        {error || !data ? (
          <Card>
            <EmptyState
              title="Activities unavailable"
              description={error ?? 'Please try again.'}
              action={
                <ButtonLink variant="secondary" href="/app/training">
                  {parsed.success ? 'Try again' : 'Reset filters'}
                </ButtonLink>
              }
            />
          </Card>
        ) : (
          <ActivityHistory key={JSON.stringify(query)} data={data} query={query} />
        )}
      </main>
    </AppShell>
  )
}
