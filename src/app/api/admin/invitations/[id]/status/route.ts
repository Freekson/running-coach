import { z } from 'zod'
import { requireAdmin, requireTrustedOrigin, privateHeaders } from '@/server/auth/admin-access'
import { checkInvitationStatus } from '@/server/auth/invitation/invitation-management'

export const runtime = 'nodejs'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const originDenied = requireTrustedOrigin(request)
  if (originDenied) return originDenied
  const { id } = await context.params
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 400 })
  const status = await checkInvitationStatus(id)
  if (!status) return new Response(null, { status: 404, headers: privateHeaders })
  return Response.json({ status }, { headers: privateHeaders })
}
