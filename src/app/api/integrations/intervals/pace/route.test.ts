import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  preflight: vi.fn(),
  getStatus: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: mocks.getCurrentUser,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/intervals/pace-preflight', () => ({ preflightIntervalsPace: mocks.preflight }))
vi.mock('@/server/intervals/pace-state', () => ({ getIntervalsPaceStatus: mocks.getStatus }))
import { GET, POST } from './route'
import { IntervalsPaceError } from '@/server/intervals/pace-policy'

const summary = {
  status: 'READY',
  source: 'technical-delivery-reference',
  verifiedAt: '2026-11-15T00:00:00.000Z',
}
const url = 'https://coach.example.test/api/integrations/intervals/pace'
function request(body = '{}', origin = 'https://coach.example.test') {
  return new Request(url, { method: 'POST', headers: { Origin: origin }, body })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.getCurrentUser.mockResolvedValue({ id: 'owner-a', role: 'USER', email: null })
  mocks.preflight.mockResolvedValue({
    summary,
    credentialNonce: 'private-nonce',
    connectionId: 'private-connection',
  })
  mocks.getStatus.mockResolvedValue(summary)
})

it.each(['owner-a', 'owner-b'])(
  'binds settings preparation and status to verified owner %s',
  async (id) => {
    mocks.getCurrentUser.mockResolvedValue({
      id,
      role: id === 'owner-b' ? 'ADMIN' : 'USER',
      email: null,
    })
    const response = await POST(request())
    expect(await response.json()).toEqual(summary)
    expect(mocks.preflight).toHaveBeenCalledWith({ userId: id })
    const viewed = await GET()
    expect(await viewed.json()).toEqual(summary)
    expect(mocks.getStatus).toHaveBeenCalledWith({ userId: id })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  },
)

it('rejects unauthenticated reads and writes before any provider access', async () => {
  mocks.getCurrentUser.mockResolvedValue(null)
  expect((await GET()).status).toBe(401)
  expect((await POST(request())).status).toBe(401)
  expect(mocks.preflight).not.toHaveBeenCalled()
  expect(mocks.getStatus).not.toHaveBeenCalled()
})

it.each(['https://evil.test', '', 'null'])('rejects origin %s', async (origin) => {
  expect((await POST(request('{}', origin))).status).toBe(403)
  expect(mocks.preflight).not.toHaveBeenCalled()
})

it.each([
  '{"userId":"owner-b"}',
  '{"athleteId":"another"}',
  '{"reference":4}',
  '{',
  '[]',
  'null',
  'x'.repeat(513),
])('rejects client routing, reference overrides and malformed bodies: %#', async (body) => {
  expect((await POST(request(body))).status).toBe(400)
  expect(mocks.preflight).not.toHaveBeenCalled()
})

it.each([
  ['PERMISSION_REQUIRED', 403],
  ['INVALID_KEY', 422],
  ['RATE_LIMITED', 429],
  ['PROVIDER_UNAVAILABLE', 503],
  ['READBACK_FAILED', 409],
  ['BUSY', 409],
] as const)('returns a safe recovery error for %s', async (code, status) => {
  mocks.preflight.mockRejectedValue(new IntervalsPaceError(code))
  const response = await POST(request())
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ code, message: expect.any(String) })
})

it('never exposes raw errors or credential bindings', async () => {
  mocks.preflight.mockRejectedValue(new Error('private-key private-provider-body'))
  const response = await POST(request())
  expect(await response.json()).toEqual({ code: 'PROVIDER_UNAVAILABLE' })
})
