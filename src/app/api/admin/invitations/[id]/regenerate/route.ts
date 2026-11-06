import { z } from 'zod'
import { requireAdmin, requireTrustedOrigin, privateHeaders } from '@/server/auth/admin-access'
import { regenerateInvitation } from '@/server/auth/invitation-management'

export const runtime = 'nodejs'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const originDenied = requireTrustedOrigin(request)
  if (originDenied) return originDenied
  const { id } = await context.params
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 400 })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response(null, { status: 400 })
  }
  const parsed = z
    .object({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .safeParse(body)
  if (!parsed.success) return new Response(null, { status: 400 })
  const regenerated = await regenerateInvitation(id, parsed.data.revision)
  if (!regenerated) return new Response(null, { status: 409, headers: privateHeaders })
  return Response.json(regenerated, { headers: privateHeaders })
}
