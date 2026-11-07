import type { ReactNode } from 'react'
import { AccountUnavailable } from './account-unavailable'
import { getAppUser } from './access'
import { AppShell } from './app-shell'
import { getMeasurementSystem } from '@/server/athlete/profile'
import { getOwnerContext } from '@/server/authorization/ownership'

export async function renderProtectedPage(children: ReactNode) {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  const owner = getOwnerContext(user)
  const measurementSystem = await getMeasurementSystem(owner)
  return (
    <AppShell user={user} measurementSystem={measurementSystem}>
      {children}
    </AppShell>
  )
}
