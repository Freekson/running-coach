import { z } from 'zod'
import { requireAdmin, requireTrustedOrigin, privateHeaders } from '@/server/auth/admin-access'
import { createInvitation, listInvitations } from '@/server/auth/invitation-management'

export const runtime = 'nodejs'

const inputSchema = z.object({ label: z.string().trim().max(120).nullable().optional() }).strict()

export async function GET() {
  const denied = await requireAdmin()
  if (denied) return denied
  return Response.json({ invitations: await listInvitations() }, { headers: privateHeaders })
}

export async function POST(request: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const originDenied = requireTrustedOrigin(request)
  if (originDenied) return originDenied
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response(null, { status: 400 })
  }
  const parsed = inputSchema.safeParse(body)
  if (!parsed.success) return new Response(null, { status: 400 })
  const invitation = await createInvitation(parsed.data.label || null)
  return Response.json(invitation, { status: 201, headers: privateHeaders })
}
