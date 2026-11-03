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
    expect((await POST(signup({ email: 'a@example.test', password: 'secret' }))).status).toBe(403)
    consumeInvitation.mockResolvedValue(null)
    expect((await POST(signup({ invitationToken: 'x' }))).status).toBe(403)
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
    expect(
      (await POST(signup({ invitationToken: 'a'.repeat(64) }, 'https://other.test'))).status,
    ).toBe(403)
    expect(consumeInvitation).not.toHaveBeenCalled()
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
