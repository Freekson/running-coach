import { redirect } from 'next/navigation'
import { AccountUnavailable } from './account-unavailable'
import { verifyAppAccess } from './access'

export default async function AppPage() {
  if (!(await verifyAppAccess())) return <AccountUnavailable />
  redirect('/app/dashboard')
}
