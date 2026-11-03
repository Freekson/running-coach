import { toNextJsHandler } from 'better-auth/next-js'
import { z } from 'zod'
import { getAuth, getTrustedOrigins } from '@/server/auth/better-auth'
import { consumeInvitation, releaseInvitation } from '@/server/auth/invitations'

export const runtime = 'nodejs'

// Match Better Auth's configured password bounds before touching a one-time
// link. Better Auth remains the final authority on account validation.
const signupFields = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.email().max(320),
    password: z.string().min(12).max(128),
  })
  .passthrough()

export async function GET(request: Request) {
  return toNextJsHandler(await getAuth()).GET(request)
}

export async function POST(request: Request) {
  let path: string
  try {
    path = decodeURIComponent(new URL(request.url).pathname).toLowerCase()
  } catch {
    return new Response(null, { status: 400 })
  }
  if (path.startsWith('/api/auth/sign-up') && path !== '/api/auth/sign-up/email')
    return new Response(null, { status: 404 })
  if (path === '/api/auth/sign-up/email') {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
      return new Response(null, { status: 415 })
    let body: unknown
    try {
      body = await request.clone().json()
    } catch {
      return new Response(null, { status: 400 })
    }
    if (!body || typeof body !== 'object' || !('invitationToken' in body))
      return new Response(null, { status: 403 })
    if (typeof body.invitationToken !== 'string') return new Response(null, { status: 403 })
    const parsed = signupFields.safeParse(body)
    if (!parsed.success) return new Response(null, { status: 400 })
    // Check the request origin before touching the token. Better Auth checks it
    // again when processing the signup itself.
    const auth = await getAuth()
    const origin = request.headers.get('origin')
    const allowed = getTrustedOrigins(process.env.BETTER_AUTH_URL ?? '')
    if (!origin || !allowed.includes(origin)) return new Response(null, { status: 403 })
    const claim = await consumeInvitation(body.invitationToken)
    if (!claim) return new Response(null, { status: 403 })
    // The invitation token is never forwarded to Better Auth or stored there.
    const { invitationToken: _token, ...signupBody } = body
    void _token
    const forwarded = new Request(request, { body: JSON.stringify(signupBody) })
    const response = await toNextJsHandler(auth).POST(forwarded)
    if (response.status >= 400 && response.status < 500) await releaseInvitation(claim)
    return response
  }
  return toNextJsHandler(await getAuth()).POST(request)
}
