import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlerPost,
  getAuth,
  consumeInvitation,
  completeInvitation,
  invitationStatus,
  recoverInvitationAfterFailedSignup,
  releaseInvitation,
  withInvitationClaim,
} = vi.hoisted(() => ({
  handlerPost: vi.fn(async (_request: Request) => {
    void _request
    return new Response(null, { status: 200 })
  }),
  getAuth: vi.fn(async () => ({})),
  consumeInvitation: vi.fn(),
  completeInvitation: vi.fn(),
  invitationStatus: vi.fn(),
  recoverInvitationAfterFailedSignup: vi.fn(),
  releaseInvitation: vi.fn(),
  withInvitationClaim: vi.fn((_nonce: string, callback: () => Promise<Response>) => callback()),
}))
vi.mock('better-auth/next-js', () => ({ toNextJsHandler: () => ({ POST: handlerPost }) }))
vi.mock('@/server/auth/better-auth', () => ({
  getAuth,
  getTrustedOrigins: () => ['http://localhost:3000'],
}))
vi.mock('@/server/auth/invitations', () => ({
  consumeInvitation,
  completeInvitation,
  invitationStatus,
  recoverInvitationAfterFailedSignup,
  releaseInvitation,
}))
vi.mock('@/server/auth/invitation-claim-context', () => ({ withInvitationClaim }))

import { POST } from './route'

function signup(body: object, origin = 'http://localhost:3000') {
  return new Request('http://localhost:3000/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Test Athlete',
      email: 'a@example.test',
      password: 'a-long-password',
      ...body,
    }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.BETTER_AUTH_URL = 'http://localhost:3000'
  consumeInvitation.mockResolvedValue({
    tokenHash: 'h',
    claimedAt: new Date(),
    email: 'a@example.test',
    nonce: '00000000-0000-4000-8000-000000000001',
  })
  completeInvitation.mockResolvedValue(true)
  invitationStatus.mockResolvedValue('invalid')
  recoverInvitationAfterFailedSignup.mockResolvedValue(false)
})

describe('direct signup API protection', () => {
  it('rejects missing and invalid invitation tokens without calling Better Auth', async () => {
    const missing = await POST(signup({ email: 'a@example.test', password: 'secret' }))
    expect(missing.status).toBe(403)
    expect(missing.headers.get('x-running-coach-error')).toBe('invalid-invitation')
    consumeInvitation.mockResolvedValue(null)
    const invalid = await POST(signup({ invitationToken: 'x' }))
    expect(invalid.status).toBe(403)
    expect(invalid.headers.get('x-running-coach-error')).toBe('invalid-invitation')
    expect(handlerPost).not.toHaveBeenCalled()
  })

  it('rejects noncanonical signup route variants before touching a token', async () => {
    const request = new Request('http://localhost:3000/api/auth/sign-up/email/', {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ invitationToken: 'a'.repeat(64) }),
    })
    expect((await POST(request)).status).toBe(404)
    expect(consumeInvitation).not.toHaveBeenCalled()
  })

  it('does not consume a token from an untrusted origin', async () => {
    const blocked = await POST(signup({ invitationToken: 'a'.repeat(64) }, 'https://other.test'))
    expect(blocked.status).toBe(403)
    expect(blocked.headers.get('x-running-coach-error')).toBeNull()
    expect(consumeInvitation).not.toHaveBeenCalled()
  })

  it('does not mark a Better Auth 403 as an invalid invitation', async () => {
    recoverInvitationAfterFailedSignup.mockResolvedValueOnce(true)
    handlerPost.mockResolvedValueOnce(new Response(null, { status: 403 }))
    const blocked = await POST(signup({ invitationToken: 'a'.repeat(64) }))
    expect(blocked.status).toBe(403)
    expect(blocked.headers.get('x-running-coach-error')).toBeNull()
    expect(recoverInvitationAfterFailedSignup).toHaveBeenCalledOnce()
    expect(releaseInvitation).not.toHaveBeenCalled()
  })

  it('forwards only a claimed signup and removes the token', async () => {
    const token = 'a'.repeat(64)
    expect((await POST(signup({ email: 'a@example.test', invitationToken: token }))).status).toBe(
      200,
    )
    expect(consumeInvitation).toHaveBeenCalledWith(token, 'a@example.test')
    expect(completeInvitation).toHaveBeenCalledOnce()
    expect(withInvitationClaim).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      expect.any(Function),
    )
    const forwarded = handlerPost.mock.calls[0][0]
    expect(await forwarded.json()).toEqual({
      name: 'Test Athlete',
      email: 'a@example.test',
      password: 'a-long-password',
    })
  })

  it('does not forward a client-supplied claim nonce', async () => {
    await POST(signup({ invitationToken: 'a'.repeat(64), invitationClaimNonce: 'forged' }))
    expect(await handlerPost.mock.calls[0][0].json()).not.toHaveProperty('invitationClaimNonce')
  })

  it.each(['false', 'error'] as const)(
    'reports an uncertain outcome when finalizing a successful signup returns %s',
    async (failure) => {
      if (failure === 'false') completeInvitation.mockResolvedValueOnce(false)
      else completeInvitation.mockRejectedValueOnce(new Error('database unavailable'))
      const response = await POST(signup({ invitationToken: 'a'.repeat(64) }))
      expect(response.status).toBe(503)
      expect(response.headers.get('x-running-coach-error')).toBe('registration-outcome-unknown')
    },
  )

  it('constructs the forwarded request from its URL for the Vercel runtime', async () => {
    const incoming = signup({ invitationToken: 'a'.repeat(64) })
    incoming.headers.set('content-length', '999')
    const NativeRequest = Request
    vi.stubGlobal(
      'Request',
      class UrlOnlyRequest extends NativeRequest {
        constructor(input: RequestInfo | URL, init?: RequestInit) {
          if (typeof input !== 'string' && !(input instanceof URL)) {
            throw new TypeError('Request input must be a URL')
          }
          super(input, init)
        }
      },
    )

    try {
      expect((await POST(incoming)).status).toBe(200)
      const forwarded = handlerPost.mock.calls[0][0]
      expect(forwarded.url).toBe(incoming.url)
      expect(forwarded.headers.get('origin')).toBe('http://localhost:3000')
      expect(forwarded.headers.get('content-length')).toBeNull()
      expect(await forwarded.json()).not.toHaveProperty('invitationToken')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the link available for invalid fields and a Better Auth 4xx response', async () => {
    const token = 'a'.repeat(64)
    expect((await POST(signup({ invitationToken: token, password: 'short' }))).status).toBe(400)
    expect(consumeInvitation).not.toHaveBeenCalled()

    recoverInvitationAfterFailedSignup.mockResolvedValueOnce(true)
    handlerPost.mockResolvedValueOnce(new Response(null, { status: 422 }))
    expect((await POST(signup({ invitationToken: token }))).status).toBe(422)
    expect(recoverInvitationAfterFailedSignup).toHaveBeenCalledOnce()
    expect(releaseInvitation).not.toHaveBeenCalled()
  })

  it('returns stable field errors before claiming an invite', async () => {
    const response = await POST(
      signup({ invitationToken: 'a'.repeat(64), email: 'bad', password: 'short' }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      errors: {
        email: 'Enter a valid email address.',
        password: 'Use a password with 12 to 128 characters.',
      },
    })
    expect(consumeInvitation).not.toHaveBeenCalled()
  })

  it('maps only the structured Better Auth duplicate code after a valid claim', async () => {
    handlerPost.mockResolvedValueOnce(
      Response.json({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' }, { status: 422 }),
    )
    const duplicate = await POST(signup({ invitationToken: 'a'.repeat(64) }))
    expect(duplicate.headers.get('x-running-coach-error')).toBe('duplicate-email')
    expect(releaseInvitation).toHaveBeenCalledOnce()
    handlerPost.mockResolvedValueOnce(
      Response.json({ message: 'User already exists' }, { status: 422 }),
    )
    const other = await POST(signup({ invitationToken: 'a'.repeat(64) }))
    expect(other.headers.get('x-running-coach-error')).toBe('registration-outcome-unknown')
    expect(releaseInvitation).toHaveBeenCalledOnce()
  })

  it('does not release a 400 after Better Auth created the user but failed to create a session', async () => {
    handlerPost.mockResolvedValueOnce(
      Response.json({ code: 'FAILED_TO_CREATE_SESSION' }, { status: 400 }),
    )
    const response = await POST(signup({ invitationToken: 'a'.repeat(64) }))
    expect(response.status).toBe(503)
    expect(response.headers.get('x-running-coach-error')).toBe('registration-outcome-unknown')
    expect(recoverInvitationAfterFailedSignup).toHaveBeenCalledOnce()
    expect(releaseInvitation).not.toHaveBeenCalled()
  })

  it('reports a safe reason for an unclaimable invite', async () => {
    consumeInvitation.mockResolvedValue(null)
    invitationStatus.mockResolvedValue('expired')
    const response = await POST(signup({ invitationToken: 'a'.repeat(64) }))
    expect(response.headers.get('x-running-coach-invitation-status')).toBe('expired')
    expect(handlerPost).not.toHaveBeenCalled()
  })

  it('releases a failed signup when the account check proves no account exists', async () => {
    recoverInvitationAfterFailedSignup.mockResolvedValue(true)
    handlerPost.mockResolvedValueOnce(new Response(null, { status: 500 }))
    expect((await POST(signup({ invitationToken: 'a'.repeat(64) }))).status).toBe(503)
    expect(recoverInvitationAfterFailedSignup).toHaveBeenCalledOnce()
  })

  it('keeps an uncertain 5xx claim and returns actionable status', async () => {
    handlerPost.mockResolvedValueOnce(new Response(null, { status: 500 }))
    const response = await POST(signup({ invitationToken: 'a'.repeat(64) }))
    expect(response.status).toBe(503)
    expect(response.headers.get('x-running-coach-error')).toBe('registration-outcome-unknown')
    expect(releaseInvitation).not.toHaveBeenCalled()
  })

  it('also recovers a thrown signup failure when no account was created', async () => {
    recoverInvitationAfterFailedSignup.mockResolvedValue(true)
    handlerPost.mockRejectedValueOnce(new Error('upstream failed'))
    const response = await POST(signup({ invitationToken: 'a'.repeat(64) }))
    expect(response.status).toBe(503)
    expect(response.headers.get('x-running-coach-error')).toBeNull()
    expect(recoverInvitationAfterFailedSignup).toHaveBeenCalledOnce()
  })
})
