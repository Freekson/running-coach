import { SignOutButton } from '../../sign-out-button'
import { AccountUnavailable } from '../account-unavailable'
import { verifyAppAccess } from '../access'
import { EmptyState } from '@/components/ui/States'

export default async function DashboardPage() {
  if (!(await verifyAppAccess())) return <AccountUnavailable />
  return (
    <section className="auth-page">
      <h1>Dashboard</h1>
      <EmptyState
        title="Your training space is ready"
        description="Training insights will appear here later."
      />
      <SignOutButton />
    </section>
  )
}
