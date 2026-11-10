import { AccountUnavailable } from '../account-unavailable'
import { getAppUser } from '../access'
import { AppShell } from '../app-shell'
import { getAthleteProfile } from '@/server/athlete/profile'
import { getOwnerContext } from '@/server/authorization/ownership'
import { getProviderConnectionStatus } from '@/server/provider/vault'
import { AthleteSettingsRoute } from './athlete-settings'

export default async function SettingsPage() {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const owner = getOwnerContext(user)
  const [profile, garminConnection, openaiConnection] = await Promise.all([
    getAthleteProfile(owner),
    getProviderConnectionStatus(owner, 'GARMIN'),
    getProviderConnectionStatus(owner, 'OPENAI'),
  ])
  return (
    <AppShell user={user} measurementSystem={profile.measurementSystem}>
      <AthleteSettingsRoute
        key={user.id}
        initial={{ profile }}
        registrationName={user.name ?? null}
        garminConnection={garminConnection}
        openaiConnection={openaiConnection}
      />
    </AppShell>
  )
}
