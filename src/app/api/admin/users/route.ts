import { requireAdmin, privateHeaders } from '@/server/auth/admin-access'
import { listRegisteredUsers } from '@/server/auth/invitation-management'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const parsed = z.coerce
    .number()
    .int()
    .min(1)
    .safeParse(new URL(request.url).searchParams.get('page') ?? 1)
  if (!parsed.success) return new Response(null, { status: 400 })
  return Response.json(await listRegisteredUsers(parsed.data), { headers: privateHeaders })
}
import { z } from 'zod'
