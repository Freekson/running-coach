import type { ReactNode } from 'react'
import { AccountUnavailable } from './account-unavailable'
import { getAppUser } from './access'
import { AppShell } from './app-shell'

export async function renderProtectedPage(children: ReactNode) {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  return <AppShell user={user}>{children}</AppShell>
}
