import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlerPost, getAuth, consumeInvitation, releaseInvitation } = vi.hoisted(() => ({
  handlerPost: vi.fn(async (_request: Request) => {
    void _request
    return new Response(null, { status: 200 })
  }),
  getAuth: vi.fn(async () => ({})),
  consumeInvitation: vi.fn(),
  releaseInvitation: vi.fn(),
}))
vi.mock('better-auth/next-js', () => ({ toNextJsHandler: () => ({ POST: handlerPost }) }))
vi.mock('@/server/auth/better-auth', () => ({
  getAuth,
  getTrustedOrigins: () => ['http://localhost:3000'],
}))
vi.mock('@/server/auth/invitations', () => ({ consumeInvitation, releaseInvitation }))

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
  consumeInvitation.mockResolvedValue({ tokenHash: 'h', claimedAt: new Date() })
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
    handlerPost.mockResolvedValueOnce(new Response(null, { status: 403 }))
    const blocked = await POST(signup({ invitationToken: 'a'.repeat(64) }))
    expect(blocked.status).toBe(403)
    expect(blocked.headers.get('x-running-coach-error')).toBeNull()
    expect(releaseInvitation).toHaveBeenCalledOnce()
  })

  it('forwards only a claimed signup and removes the token', async () => {
    const token = 'a'.repeat(64)
    expect((await POST(signup({ email: 'a@example.test', invitationToken: token }))).status).toBe(
      200,
    )
    expect(consumeInvitation).toHaveBeenCalledWith(token)
    const forwarded = handlerPost.mock.calls[0][0]
    expect(await forwarded.json()).toEqual({
      name: 'Test Athlete',
      email: 'a@example.test',
      password: 'a-long-password',
    })
  })

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

    handlerPost.mockResolvedValueOnce(new Response(null, { status: 422 }))
    expect((await POST(signup({ invitationToken: token }))).status).toBe(422)
    expect(releaseInvitation).toHaveBeenCalledOnce()
  })

  it('keeps unknown server failures fail-closed', async () => {
    handlerPost.mockResolvedValueOnce(new Response(null, { status: 500 }))
    expect((await POST(signup({ invitationToken: 'a'.repeat(64) }))).status).toBe(500)
    expect(releaseInvitation).not.toHaveBeenCalled()
  })
})
