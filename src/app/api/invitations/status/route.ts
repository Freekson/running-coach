import { z } from 'zod'
import { getTrustedOrigins } from '@/server/auth/better-auth'
import { invitationStatus } from '@/server/auth/invitation/invitations'
import {
  allowInvitationStatusCheck,
  invitationStatusClientIp,
} from '@/server/auth/invitation/invitation-status-rate-limit'

export const runtime = 'nodejs'

const requestBody = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) })

export async function POST(request: Request) {
  const origin = request.headers.get('origin')
  const baseURL = process.env.BETTER_AUTH_URL
  if (!baseURL || !origin || !getTrustedOrigins(baseURL).includes(origin)) {
    return new Response(null, { status: 403 })
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return new Response(null, { status: 415 })
  }
  const body: unknown = await request.json().catch(() => null)
  const parsed = requestBody.safeParse(body)
  if (!parsed.success) return new Response(null, { status: 400 })
  if (!(await allowInvitationStatusCheck(invitationStatusClientIp(request)))) {
    return new Response(null, { status: 429, headers: { 'Retry-After': '60' } })
  }
  return Response.json(
    { status: await invitationStatus(parsed.data.token) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
