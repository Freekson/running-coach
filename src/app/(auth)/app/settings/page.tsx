import { cookies } from 'next/headers'
import { AccountUnavailable } from '../account-unavailable'
import { getAppUser } from '../access'
import { AppShell } from '../app-shell'
import { getAthleteSettings } from '@/server/athlete/profile'
import { getOwnerContext } from '@/server/authorization/ownership'
import { getProviderConnectionStatus } from '@/server/provider/vault'
import { AthleteSettingsRoute } from './athlete-settings'
import { chartPeriodCookie, chartPeriods } from './weight-history'

export default async function SettingsPage() {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const owner = getOwnerContext(user)
  const cookieStore = await cookies()
  const savedPeriod = cookieStore.get(chartPeriodCookie)?.value
  const period = chartPeriods.find((option) => option === savedPeriod) ?? '7D'
  const [settings, garminConnection, openaiConnection] = await Promise.all([
    getAthleteSettings(owner, period),
    getProviderConnectionStatus(owner, 'GARMIN'),
    getProviderConnectionStatus(owner, 'OPENAI'),
  ])
  return (
    <AppShell user={user} measurementSystem={settings.profile.measurementSystem}>
      <AthleteSettingsRoute
        key={user.id}
        initial={settings}
        initialChartPeriod={period}
        registrationName={user.name ?? null}
        garminConnection={garminConnection}
        openaiConnection={openaiConnection}
      />
    </AppShell>
  )
}
