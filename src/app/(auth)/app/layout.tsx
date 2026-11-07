import type { ReactNode } from 'react'
import { AccountUnavailable } from './account-unavailable'
import { verifyAppAccess } from './access'

export const dynamic = 'force-dynamic'

export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  if (!(await verifyAppAccess())) return <AccountUnavailable />
  return children
}
