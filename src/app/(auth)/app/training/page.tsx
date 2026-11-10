import { EmptyState } from '@/components/ui/States'
import { getMeasurementSystem } from '@/server/athlete/profile'
import { getOwnerContext } from '@/server/authorization/ownership'
import { getGarminSyncState } from '@/server/garmin/sync'
import { AccountUnavailable } from '../account-unavailable'
import { getAppUser } from '../access'
import { AppShell } from '../app-shell'
import { ActivitySyncPanel } from './activity-sync-panel'

export default async function TrainingPage() {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const owner = getOwnerContext(user)
  const [measurementSystem, syncState] = await Promise.all([
    getMeasurementSystem(owner),
    getGarminSyncState(owner),
  ])
  return (
    <AppShell user={user} measurementSystem={measurementSystem}>
      <section className="app-page">
        <h1>Training</h1>
        <ActivitySyncPanel initial={syncState} />
        <EmptyState
          title="Training plans are coming soon"
          description="Training plans will appear here later."
        />
      </section>
    </AppShell>
  )
}
