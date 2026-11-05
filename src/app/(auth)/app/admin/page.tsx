import { notFound } from 'next/navigation'
import { AccountUnavailable } from '../account-unavailable'
import { getAppUser } from '../access'
import { AppShell } from '../app-shell'
import { listInvitations, listRegisteredUsers } from '@/server/auth/invitation-management'
import { AdminManagement } from './admin-management'

export default async function AdminPage() {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  if (user.role !== 'ADMIN') notFound()
  const [invitations, users] = await Promise.all([listInvitations(), listRegisteredUsers()])
  return (
    <AppShell user={user}>
      <AdminManagement
        invitations={invitations.map((invitation) => ({
          ...invitation,
          createdAt: invitation.createdAt.toISOString(),
          expiresAt: invitation.expiresAt.toISOString(),
        }))}
        users={users.map((registered) => ({
          ...registered,
          createdAt: registered.createdAt.toISOString(),
        }))}
      />
    </AppShell>
  )
}
