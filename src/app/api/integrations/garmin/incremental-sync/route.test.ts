import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: vi.fn(), state: vi.fn(), run: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: mocks.user,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/garmin/incremental-sync', () => ({
  getGarminIncrementalSyncState: mocks.state,
  runGarminIncrementalSync: mocks.run,
}))
import { GET, POST } from './route'
import { AccountUnavailableError } from '@/server/auth/current-user'
const user = { id: '00000000-0000-4000-8000-000000000001', role: 'USER', email: null }
const admin = { ...user, id: '00000000-0000-4000-8000-000000000002', role: 'ADMIN' }
function request(
  body: unknown = { streamId: 'activities', browserTimezone: 'UTC' },
  origin = 'https://running.example',
  type = 'application/json',
) {
  return new Request('https://running.example/api/integrations/garmin/incremental-sync', {
    method: 'POST',
    headers: { origin, 'content-type': type },
    body: JSON.stringify(body),
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.user.mockResolvedValue(user)
  mocks.state.mockResolvedValue({ streams: [] })
  mocks.run.mockResolvedValue({ status: 'completed' })
})
it('rejects unauthenticated, disabled-account and cross-origin requests before sync', async () => {
  mocks.user.mockResolvedValueOnce(null)
  expect((await GET()).status).toBe(401)
  mocks.user.mockResolvedValueOnce(null)
  expect((await POST(request())).status).toBe(401)
  mocks.user.mockRejectedValueOnce(new AccountUnavailableError())
  expect((await POST(request())).status).toBe(403)
  expect((await POST(request(undefined, 'https://attacker.example'))).status).toBe(403)
  expect(mocks.run).not.toHaveBeenCalled()
})
it('derives ownership from each session, including admin, without accepting an owner or historical action', async () => {
  mocks.user.mockResolvedValueOnce(admin)
  const response = await POST(request({ streamId: 'sleep', browserTimezone: 'Asia/Tokyo' }))
  expect(response.status).toBe(200)
  expect(mocks.run).toHaveBeenCalledWith(
    expect.objectContaining({ userId: admin.id }),
    'sleep',
    'Asia/Tokyo',
  )
  await GET()
  expect(mocks.state).toHaveBeenCalledWith(expect.objectContaining({ userId: user.id }))
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  for (const extra of [{ userId: admin.id }, { action: 'reimport' }, { extendDays: 28 }])
    expect(
      (await POST(request({ streamId: 'activities', browserTimezone: 'UTC', ...extra }))).status,
    ).toBe(400)
  expect(mocks.run).toHaveBeenCalledOnce()
})
it('bounds and validates untrusted requests', async () => {
  expect((await POST(request({}, undefined, 'text/plain'))).status).toBe(415)
  expect((await POST(request({ streamId: 'laps', browserTimezone: 'UTC' }))).status).toBe(400)
  expect((await POST(request({ streamId: 'sleep', browserTimezone: 'invalid' }))).status).toBe(400)
  expect((await POST(request({ padding: 'x'.repeat(300) }))).status).toBe(413)
  expect(
    (
      await POST(
        new Request('https://running.example/api/integrations/garmin/incremental-sync', {
          method: 'POST',
          headers: { origin: 'https://running.example', 'content-type': 'application/json' },
          body: '{',
        }),
      )
    ).status,
  ).toBe(400)
  expect(mocks.run).not.toHaveBeenCalled()
})
it('returns safe failure responses for unavailable persistence', async () => {
  mocks.state.mockRejectedValueOnce(new Error('private database information'))
  const response = await GET()
  expect(response.status).toBe(503)
  expect(await response.text()).toBe('')
})

it('forwards a continuation connection precondition while deriving its owner from the session', async () => {
  const response = await POST(
    request({
      streamId: 'activities',
      browserTimezone: 'UTC',
      connectionKey: 'original-connection',
    }),
  )
  expect(response.status).toBe(200)
  expect(mocks.run).toHaveBeenCalledWith(
    expect.objectContaining({ userId: user.id }),
    'activities',
    'UTC',
    'original-connection',
  )
})
