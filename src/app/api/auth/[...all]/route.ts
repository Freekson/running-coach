import { toNextJsHandler } from 'better-auth/next-js'
import { z } from 'zod'
import { getAuth, getTrustedOrigins } from '@/server/auth/better-auth'
import { withInvitationClaim } from '@/server/auth/invitation/invitation-claim-context'
import {
  completeInvitation,
  consumeInvitation,
  invitationStatus,
  recoverInvitationAfterFailedSignup,
  releaseInvitation,
} from '@/server/auth/invitation/invitations'

export const runtime = 'nodejs'
export const maxDuration = 60

// Match Better Auth's configured password bounds before touching a one-time
// link. Better Auth remains the final authority on account validation.
const signupFields = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.email().max(320),
    password: z.string().min(12).max(128),
  })
  .passthrough()

function invalidInvitation(reason: string = 'invalid') {
  return new Response(null, {
    status: 403,
    headers: {
      'X-Running-Coach-Error': 'invalid-invitation',
      'X-Running-Coach-Invitation-Status': reason,
    },
  })
}

function failedSignupResponse(recovered: boolean): Response {
  return new Response(null, {
    status: 503,
    headers: recovered ? undefined : { 'X-Running-Coach-Error': 'registration-outcome-unknown' },
  })
}

function fieldErrors(error: z.ZodError) {
  const fields = new Set(error.issues.map((issue) => issue.path[0]))
  return Response.json(
    {
      errors: {
        ...(fields.has('name') && { name: 'Enter your name.' }),
        ...(fields.has('email') && { email: 'Enter a valid email address.' }),
        ...(fields.has('password') && { password: 'Use a password with 12 to 128 characters.' }),
      },
    },
    { status: 400 },
  )
}

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
      return invalidInvitation()
    if (typeof body.invitationToken !== 'string') return invalidInvitation()
    const parsed = signupFields.safeParse(body)
    if (!parsed.success) return fieldErrors(parsed.error)
    // Check the request origin before touching the token. Better Auth checks it
    // again when processing the signup itself.
    const auth = await getAuth()
    const origin = request.headers.get('origin')
    const allowed = getTrustedOrigins(process.env.BETTER_AUTH_URL ?? '')
    if (!origin || !allowed.includes(origin)) return new Response(null, { status: 403 })
    const claim = await consumeInvitation(body.invitationToken, parsed.data.email)
    if (!claim) return invalidInvitation(await invitationStatus(body.invitationToken))
    // The invitation token is never forwarded to Better Auth or stored there.
    const { invitationToken: _token, ...signupBody } = body
    void _token
    if ('invitationClaimNonce' in signupBody) delete signupBody.invitationClaimNonce
    const headers = new Headers(request.headers)
    headers.delete('content-length')
    const forwarded = new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(signupBody),
    })
    let response: Response
    try {
      response = await withInvitationClaim(claim.nonce, () => toNextJsHandler(auth).POST(forwarded))
    } catch {
      const recovered = await recoverInvitationAfterFailedSignup(claim)
      return failedSignupResponse(recovered)
    }
    if (response.status >= 500) {
      const recovered = await recoverInvitationAfterFailedSignup(claim)
      return failedSignupResponse(recovered)
    }
    if (response.status >= 400) {
      const result: unknown = await response
        .clone()
        .json()
        .catch(() => null)
      if (
        response.status === 422 &&
        result &&
        typeof result === 'object' &&
        'code' in result &&
        result.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'
      ) {
        // Better Auth checks for an existing user before creating a new one.
        await releaseInvitation(claim)
        return new Response(null, {
          status: 422,
          headers: { 'X-Running-Coach-Error': 'duplicate-email' },
        })
      }
      const recovered = await recoverInvitationAfterFailedSignup(claim)
      if (!recovered) return failedSignupResponse(false)
    }
    if (response.ok) {
      try {
        if (!(await completeInvitation(claim))) return failedSignupResponse(false)
      } catch {
        return failedSignupResponse(false)
      }
    }
    return response
  }
  return toNextJsHandler(await getAuth()).POST(request)
}
