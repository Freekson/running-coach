import { notFound } from 'next/navigation'
import { AccountUnavailable } from '../account-unavailable'
import { getAppUser } from '../access'
import { AppShell } from '../app-shell'
import {
  listInvitations,
  listRegisteredUsers,
} from '@/server/auth/invitation/invitation-management'
import { AdminManagement } from './admin-management'

export default async function AdminPage() {
  const user = await getAppUser()
  if (!user) return <AccountUnavailable />
  if (user.role !== 'ADMIN') notFound()
  const [invitations, users] = await Promise.all([listInvitations(1), listRegisteredUsers(1)])
  return (
    <AppShell user={user}>
      <AdminManagement
        invitations={invitations.invitations.map((invitation) => ({
          ...invitation,
          createdAt: invitation.createdAt.toISOString(),
          expiresAt: invitation.expiresAt.toISOString(),
        }))}
        invitationPage={invitations.page}
        invitationTotal={invitations.total}
        invitationCounts={invitations.counts}
        users={users.users.map((registered) => ({
          ...registered,
          createdAt: registered.createdAt.toISOString(),
        }))}
        userPage={users.page}
        userTotal={users.total}
      />
    </AppShell>
  )
}
