import { notFound } from 'next/navigation'
import { AccountUnavailable } from '../account-unavailable'
import { getAppUser } from '../access'
import { AppShell } from '../app-shell'
import { PendingSection } from '../pending-section'

export default async function AdminPage() {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  if (user.role !== 'ADMIN') notFound()
  return (
    <AppShell user={user}>
      <PendingSection
        title="Admin"
        description="Administration tools will be available here later."
      />
    </AppShell>
  )
}
