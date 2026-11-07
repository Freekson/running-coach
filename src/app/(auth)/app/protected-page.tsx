import type { ReactNode } from 'react'
import { AccountUnavailable } from './account-unavailable'
import { getAppUser } from './access'
import { AppShell } from './app-shell'
import { getMeasurementSystem } from '@/server/athlete/profile'

export async function renderProtectedPage(children: ReactNode) {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const measurementSystem = await getMeasurementSystem(user.id)
  return (
    <AppShell user={user} measurementSystem={measurementSystem}>
      {children}
    </AppShell>
  )
}
