import { AppShell } from '../app-shell'
import { AccountUnavailable } from '../account-unavailable'
import { getAppUser } from '../access'
import { getOwnerContext } from '@/server/authorization/ownership'
import { getGarminIncrementalSyncState } from '@/server/garmin/incremental-sync'
import { getMeasurementSystem } from '@/server/athlete/profile'
import { cookies } from 'next/headers'
import { getHealthPreferredTimezone, getHealthSnapshot } from '@/server/health/history'
import {
  getDashboardActivityOverview,
  getDashboardRecentActivities,
} from '@/server/activity/history'
import { activityTimezoneCookie, activityTimezoneSchema } from '@/lib/activity-history'
import { DashboardContent } from './dashboard-content'

export default async function DashboardPage() {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const owner = getOwnerContext(user)
  const now = new Date()
  const preferredTimezone = await getHealthPreferredTimezone(owner).catch(() => null)
  const browserTimezone = (await cookies()).get(activityTimezoneCookie)?.value
  const timezone =
    activityTimezoneSchema.safeParse(preferredTimezone).data ??
    activityTimezoneSchema.safeParse(browserTimezone).data ??
    'UTC'
  const [measurement, sync, overview, recent, health] = await Promise.allSettled([
    getMeasurementSystem(owner),
    getGarminIncrementalSyncState(owner),
    getDashboardActivityOverview(owner, timezone, now),
    getDashboardRecentActivities(owner, now),
    getHealthSnapshot(owner),
  ])
  const measurementSystem = measurement.status === 'fulfilled' ? measurement.value : 'METRIC'
  return (
    <AppShell user={user} measurementSystem={measurementSystem}>
      <DashboardContent
        asOfInstant={now.toISOString()}
        timezone={timezone}
        name={user.displayName ?? user.name}
        system={measurementSystem}
        overview={overview.status === 'fulfilled' ? overview.value : null}
        recent={recent.status === 'fulfilled' ? recent.value : null}
        health={health.status === 'fulfilled' ? health.value : null}
        sync={sync.status === 'fulfilled' ? sync.value : null}
      />
    </AppShell>
  )
}
