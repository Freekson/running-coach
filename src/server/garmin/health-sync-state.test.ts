import { beforeEach, expect, it, vi } from 'vitest'

const { connectionFindUnique, cursorFindUnique, runFindFirst, runFindMany, metricFindUnique } =
  vi.hoisted(() => ({
    connectionFindUnique: vi.fn(),
    cursorFindUnique: vi.fn(),
    runFindFirst: vi.fn(),
    runFindMany: vi.fn(),
    metricFindUnique: vi.fn(),
  }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/db/client', () => ({
  getPrismaClient: async () => ({
    integrationConnection: { findUnique: connectionFindUnique },
    syncCursor: { findUnique: cursorFindUnique },
    syncRun: { findFirst: runFindFirst, findMany: runFindMany },
    dailyHealthMetric: { findUnique: metricFindUnique },
  }),
}))
vi.mock('./import-rate-limit', () => ({ getGarminProviderPauseUntil: async () => null }))
vi.mock('./sync-policy', () => ({ isGarminImportAllowed: () => true }))
vi.mock('./health-import', () => ({
  GarminHealthImportError: class extends Error {},
  importGarminHealthDate: vi.fn(),
}))

import { getOwnerContext } from '@/server/authorization/ownership'
import { getGarminHealthSyncState } from './health-sync'

const ownerId = '00000000-0000-4000-8000-000000000001'
const otherId = '00000000-0000-4000-8000-000000000002'
const owner = getOwnerContext({ id: ownerId, role: 'USER', email: null })
const other = getOwnerContext({ id: otherId, role: 'ADMIN', email: null })
const startedAt = new Date('2026-11-09T07:59:04Z')

beforeEach(() => {
  vi.clearAllMocks()
  connectionFindUnique.mockImplementation(
    async ({ where }: { where: { userId_provider: { userId: string } } }) =>
      where.userId_provider.userId === ownerId
        ? {
            id: 'connection-a',
            status: 'CONNECTED',
            externalAccountId: '123456',
            credential: {
              connectionId: 'connection-a',
              nonce: new Uint8Array([1]),
              rotatedAt: new Date('2026-11-01T00:00:00Z'),
            },
          }
        : null,
  )
  cursorFindUnique.mockResolvedValue({
    cursorOrCheckpoint: {
      version: 1,
      mode: 'RECENT',
      windowStart: '2026-11-03',
      windowEnd: '2026-11-09',
      nextDate: '2026-11-07',
      fallbackTimezone: 'Asia/Tokyo',
    },
    nextAttemptAt: new Date('2026-11-09T08:15:08Z'),
    leaseExpiresAt: null,
    lastSyncedAt: null,
  })
  runFindFirst.mockResolvedValue({
    status: 'FAILED',
    errorCode: 'UNAVAILABLE',
    startedAt,
    recordsWritten: 0,
  })
  metricFindUnique.mockResolvedValue({
    summaryFetchedAt: new Date('2026-11-09T07:59:06Z'),
    sleepFetchedAt: null,
  })
})

it('identifies the failed sleep date from a legacy run without disclosing another owner', async () => {
  const state = await getGarminHealthSyncState(owner, new Date('2026-11-09T08:00:00Z'))
  expect(state).toMatchObject({
    status: 'PAUSED',
    nextDate: '2026-11-07',
    sleepRetryDates: ['2026-11-07'],
    sleepFailedDates: ['2026-11-07'],
    errorCode: 'UNAVAILABLE',
  })
  expect(metricFindUnique.mock.calls[0][0].where).toMatchObject({
    userId_sourceProvider_localDate_garminAccountId: { userId: ownerId, garminAccountId: '123456' },
  })
  expect(await getGarminHealthSyncState(other, new Date('2026-11-09T08:00:00Z'))).toMatchObject({
    status: 'NOT_CONNECTED',
    sleepRetryDates: [],
    sleepFailedDates: [],
  })
  expect(metricFindUnique).toHaveBeenCalledOnce()
  expect(runFindMany).not.toHaveBeenCalled()
})

it('marks only the attempted sleep date failed while later deferred dates remain unchecked', async () => {
  cursorFindUnique.mockResolvedValueOnce({
    cursorOrCheckpoint: {
      version: 1,
      mode: 'RECENT',
      windowStart: '2026-11-03',
      windowEnd: '2026-11-09',
      nextDate: '2026-11-09',
      sleepRetryDates: ['2026-11-07', '2026-11-08'],
      sleepFailedDates: ['2026-11-07'],
      fallbackTimezone: 'Asia/Tokyo',
    },
    nextAttemptAt: new Date('2026-11-09T08:15:08Z'),
    leaseExpiresAt: null,
    lastSyncedAt: null,
  })
  runFindFirst.mockResolvedValueOnce({
    status: 'FAILED',
    errorCode: 'SLEEP_TIMEOUT',
    startedAt,
    recordsWritten: 2,
  })
  const state = await getGarminHealthSyncState(owner, new Date('2026-11-09T08:00:00Z'))
  expect(state.sleepRetryDates).toEqual(['2026-11-07', '2026-11-08'])
  expect(state.sleepFailedDates).toEqual(['2026-11-07'])
  expect(metricFindUnique).not.toHaveBeenCalled()
})

it('does not expose unexpected provider text in the current sync state', async () => {
  runFindFirst.mockResolvedValueOnce({
    status: 'FAILED',
    errorCode: 'secret or raw provider response',
    startedAt,
    recordsWritten: 0,
  })
  const state = await getGarminHealthSyncState(owner)
  expect(state.errorCode).toBe('UNKNOWN_ERROR')
  expect(JSON.stringify(state)).not.toContain('secret or raw provider response')
})

it('keeps a partial sleep error visible when the bounded run completed', async () => {
  runFindFirst.mockResolvedValueOnce({
    status: 'SUCCEEDED',
    errorCode: 'SLEEP_INVALID_RESPONSE',
    startedAt,
    recordsWritten: 9,
  })
  const state = await getGarminHealthSyncState(owner)
  expect(state.errorCode).toBe('SLEEP_INVALID_RESPONSE')
})

it('distinguishes a saved legacy key without account identity from a disconnected owner', async () => {
  connectionFindUnique.mockResolvedValueOnce({
    id: 'connection-a',
    status: 'CONNECTED',
    externalAccountId: null,
    credential: { connectionId: 'connection-a', rotatedAt: startedAt },
  })
  expect(await getGarminHealthSyncState(owner)).toMatchObject({
    status: 'ACTION_REQUIRED',
    errorCode: 'ACCOUNT_VERIFICATION_REQUIRED',
  })
  expect(cursorFindUnique).not.toHaveBeenCalled()
  expect(await getGarminHealthSyncState(other)).toMatchObject({ status: 'NOT_CONNECTED' })
})
