import { SignOutButton } from '../../sign-out-button'
import { AccountUnavailable } from '../account-unavailable'
import { verifyAppAccess } from '../access'

export default async function DashboardPage() {
  if (!(await verifyAppAccess())) return <AccountUnavailable />
  return (
    <section className="auth-page">
      <h1>Dashboard</h1>
      <p>Your account is ready. Training insights will appear here later.</p>
      <SignOutButton />
    </section>
  )
}
