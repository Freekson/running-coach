import { cookies } from 'next/headers'
import { AppShell } from '../app-shell'
import { AccountUnavailable } from '../account-unavailable'
import { getAppUser } from '../access'
import { getAthleteSettings } from '@/server/athlete/profile'
import { getOwnerContext } from '@/server/authorization/ownership'
import { getHealthPreferredTimezone, getHealthTrendRows } from '@/server/health/history'
import { getGarminHealthSyncState } from '@/server/garmin/health-sync'
import { healthInitialImportReady } from '@/server/garmin/data-import'
import { addHealthDays } from '@/lib/health-history'
import { HealthSyncPanel } from '@/components/health/HealthSyncPanel'
import { HealthHistoryPanel } from '@/components/health/HealthHistoryPanel'
import { chartPeriodCookie, chartPeriods } from '../settings/weight-history'
import { WeightHistorySection } from './weight-history-section'
import styles from './health-page.module.scss'

export default async function HealthPage() {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const owner = getOwnerContext(user)
  const now = new Date()
  const utcToday = now.toISOString().slice(0, 10)
  const savedPeriod = (await cookies()).get(chartPeriodCookie)?.value
  const period = chartPeriods.find((option) => option === savedPeriod) ?? '7D'
  // Include the next UTC date for athletes whose local day is ahead of UTC.
  const [settings, syncState, rows, profileTimezone, initialImportReady] = await Promise.all([
    getAthleteSettings(owner, period),
    getGarminHealthSyncState(owner),
    getHealthTrendRows(owner, null, addHealthDays(utcToday, 1)),
    getHealthPreferredTimezone(owner),
    healthInitialImportReady(owner),
  ])
  let preferredTimezone = profileTimezone
  try {
    if (preferredTimezone) new Intl.DateTimeFormat('en-US', { timeZone: preferredTimezone })
  } catch {
    preferredTimezone = null
  }
  return (
    <AppShell user={user} measurementSystem={settings.profile.measurementSystem}>
      <main className={`app-page ${styles.page}`}>
        <header className={styles.header}>
          <div>
            <h1>Health &amp; Recovery</h1>
            <p>Your recovery trends and Garmin health data.</p>
          </div>
          <HealthSyncPanel initial={syncState} initialImportReady={initialImportReady} />
        </header>
        <HealthHistoryPanel
          rows={rows}
          asOfInstant={now.toISOString()}
          preferredTimezone={preferredTimezone}
        />
        <WeightHistorySection
          initialPeriod={period}
          initialWeights={settings.weights}
          initialChartWeights={settings.chartWeights}
        />
      </main>
    </AppShell>
  )
}
