import { z } from 'zod'
import { requireAdmin, requireTrustedOrigin } from '@/server/auth/admin-access'
import { revokeInvitation } from '@/server/auth/invitation/invitation-management'

export const runtime = 'nodejs'

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const originDenied = requireTrustedOrigin(request)
  if (originDenied) return originDenied
  const { id } = await context.params
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 400 })
  return new Response(null, { status: (await revokeInvitation(id)) ? 204 : 409 })
}
