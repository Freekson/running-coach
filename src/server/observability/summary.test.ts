import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  db: vi.fn(),
  syncGroups: vi.fn(),
  publicationGroups: vi.fn(),
  syncCount: vi.fn(),
  publicationCount: vi.fn(),
}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: mocks.user,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/db/client', () => ({ getPrismaClient: mocks.db }))
import { getOperationalSummary } from './summary'
import { GET } from '@/app/api/admin/operations/route'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'))
  mocks.user.mockResolvedValue({ id: 'admin', role: 'ADMIN' })
  mocks.db.mockResolvedValue({
    syncRun: { groupBy: mocks.syncGroups, count: mocks.syncCount },
    workoutPublication: { groupBy: mocks.publicationGroups, count: mocks.publicationCount },
  })
  mocks.syncGroups.mockResolvedValue([])
  mocks.publicationGroups.mockResolvedValue([])
  mocks.syncCount.mockResolvedValue(0)
  mocks.publicationCount.mockResolvedValue(0)
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

it.each([null, { id: 'different-user', role: 'USER' }])(
  'denies non-admin access before operational queries: %j',
  async (user) => {
    mocks.user.mockResolvedValue(user)
    const response = await GET()
    expect(response.status).toBe(user ? 403 : 401)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(mocks.db).not.toHaveBeenCalled()
    expect(mocks.syncGroups).not.toHaveBeenCalled()
  },
)

it('returns only scrubbed aggregates and includes partial errors and old stalled work', async () => {
  mocks.syncGroups.mockResolvedValue([
    { errorCode: 'secret health payload', _count: { _all: 2 } },
    { errorCode: 'Authorization: synthetic-token', _count: { _all: 1 } },
    { errorCode: 'RATE_LIMITED', _count: { _all: 4 } },
    { errorCode: 'PARTIAL_IMPORT', _count: { _all: 2 } },
  ])
  mocks.publicationGroups.mockResolvedValue([
    { errorCode: 'RECOVERY_REQUIRED', _count: { _all: 1 } },
  ])
  mocks.syncCount.mockResolvedValue(2)
  const response = await GET()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    since: '2026-11-24T12:00:00.000Z',
    checkedAt: '2026-11-25T12:00:00.000Z',
    syncFailures: [
      { code: 'PARTIAL_IMPORT', count: 2 },
      { code: 'RATE_LIMITED', count: 4 },
      { code: 'UNKNOWN_ERROR', count: 3 },
    ],
    publicationFailures: [{ code: 'RECOVERY_REQUIRED', count: 1 }],
    stalledSyncs: 2,
    stalledPublications: 0,
  })
  expect(mocks.syncGroups).toHaveBeenCalledWith({
    by: ['errorCode'],
    where: {
      startedAt: { gte: new Date('2026-11-24T12:00:00Z') },
      OR: [{ status: 'FAILED' }, { errorCode: { not: null } }],
    },
    _count: { _all: true },
  })
  expect(mocks.syncCount).toHaveBeenCalledWith({
    where: { status: 'RUNNING', startedAt: { lt: new Date('2026-11-25T11:55:00Z') } },
  })
})

it('reports storage failures as unavailable, with no driver message or false healthy result', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.db.mockRejectedValue(new Error('postgresql://private-password health-record'))
  expect(await getOperationalSummary()).toBeNull()
  const response = await GET()
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'UNAVAILABLE' })
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private-password')
})
