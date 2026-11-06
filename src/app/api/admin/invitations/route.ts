import { z } from 'zod'
import { requireAdmin, requireTrustedOrigin, privateHeaders } from '@/server/auth/admin-access'
import { createInvitation, listInvitations } from '@/server/auth/invitation-management'

export const runtime = 'nodejs'

const inputSchema = z.object({ label: z.string().trim().max(120).nullable().optional() }).strict()

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  status: z.enum(['all', 'pending', 'processing', 'used', 'revoked', 'expired']).default('all'),
})

export async function GET(request: Request) {
  const denied = await requireAdmin()
  if (denied) return denied
  const url = new URL(request.url)
  const parsed = querySchema.safeParse({
    page: url.searchParams.get('page') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
  })
  if (!parsed.success) return new Response(null, { status: 400 })
  return Response.json(await listInvitations(parsed.data.page, parsed.data.status), {
    headers: privateHeaders,
  })
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
