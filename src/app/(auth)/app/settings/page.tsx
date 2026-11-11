import { AccountUnavailable } from '../account-unavailable'
import { getAppUser } from '../access'
import { AppShell } from '../app-shell'
import { getAthleteProfile } from '@/server/athlete/profile'
import { getOwnerContext } from '@/server/authorization/ownership'
import { getProviderConnectionStatus } from '@/server/provider/vault'
import { getGarminImportState } from '@/server/garmin/data-import'
import { AthleteSettingsRoute } from './athlete-settings'

export default async function SettingsPage() {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const owner = getOwnerContext(user)
  const [profile, garminConnection, garminImports] = await Promise.all([
    getAthleteProfile(owner),
    getProviderConnectionStatus(owner, 'GARMIN'),
    getGarminImportState(owner),
  ])
  return (
    <AppShell user={user} measurementSystem={profile.measurementSystem}>
      <AthleteSettingsRoute
        key={user.id}
        initial={{ profile }}
        registrationName={user.name ?? null}
        garminConnection={garminConnection}
        garminImports={garminImports}
      />
    </AppShell>
  )
}
