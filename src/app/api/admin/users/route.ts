import { requireAdmin, privateHeaders } from '@/server/auth/admin-access'
import { listRegisteredUsers } from '@/server/auth/invitation-management'

export const runtime = 'nodejs'

export async function GET() {
  const denied = await requireAdmin()
  if (denied) return denied
  return Response.json({ users: await listRegisteredUsers() }, { headers: privateHeaders })
}
