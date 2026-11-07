import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invitationStatus, allowInvitationStatusCheck, invitationStatusClientIp } = vi.hoisted(
  () => ({
    invitationStatus: vi.fn(),
    allowInvitationStatusCheck: vi.fn(),
    invitationStatusClientIp: vi.fn(),
  }),
)
vi.mock('@/server/auth/better-auth', () => ({
  getTrustedOrigins: () => ['http://localhost:3000'],
}))
vi.mock('@/server/auth/invitation/invitations', () => ({ invitationStatus }))
vi.mock('@/server/auth/invitation/invitation-status-rate-limit', () => ({
  allowInvitationStatusCheck,
  invitationStatusClientIp,
}))

import { POST } from './route'

function request(token: string, origin = 'http://localhost:3000') {
  return new Request('http://localhost:3000/api/invitations/status', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.BETTER_AUTH_URL = 'http://localhost:3000'
  allowInvitationStatusCheck.mockResolvedValue(true)
  invitationStatusClientIp.mockReturnValue('192.0.2.1')
})

describe('public invitation status', () => {
  it('rejects other origins before reading invitation state', async () => {
    expect((await POST(request('a'.repeat(64), 'https://other.test'))).status).toBe(403)
    expect(invitationStatus).not.toHaveBeenCalled()
  })

  it('returns only a safe status and disables caching', async () => {
    invitationStatus.mockResolvedValue('revoked')
    const response = await POST(request('a'.repeat(64)))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ status: 'revoked' })
    expect(invitationStatus).toHaveBeenCalledOnce()
  })

  it('rejects malformed tokens before the database limit and returns 429 when limited', async () => {
    expect((await POST(request('bad'))).status).toBe(400)
    expect(allowInvitationStatusCheck).not.toHaveBeenCalled()
    allowInvitationStatusCheck.mockResolvedValueOnce(false)
    const limited = await POST(request('a'.repeat(64)))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(invitationStatus).not.toHaveBeenCalled()
  })
})
