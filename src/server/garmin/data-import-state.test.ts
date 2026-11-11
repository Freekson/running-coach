import { expect, it, vi } from 'vitest'

const { getPrismaClient, getGarminSyncState, getGarminProviderPauseUntil } = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
  getGarminSyncState: vi.fn(async () => ({
    status: 'IDLE',
    window: null,
    nextDate: null,
    nextAttemptAt: null,
    lastSuccessAt: null,
    errorCode: null,
    processed: 0,
  })),
  getGarminProviderPauseUntil: vi.fn(async () => new Date('2026-11-10T14:00:00.000Z')),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))
vi.mock('./sync', () => ({ getGarminSyncState }))
vi.mock('./import-rate-limit', () => ({ getGarminProviderPauseUntil }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { getGarminImportState, healthInitialImportReady } from './data-import'

it('keeps a completed stream complete when another stream hits provider backoff', async () => {
  const endDate = '2026-11-09'
  const base = {
    version: 1,
    generation: 1,
    startDate: '2022-11-10',
    endDate,
    failedDates: [],
    timezone: 'UTC',
    lastCheckedDate: '2022-11-10',
  }
  getPrismaClient.mockResolvedValueOnce({
    integrationConnection: {
      findUnique: vi.fn(async () => ({
        id: '00000000-0000-4000-8000-000000000010',
        externalAccountId: '123456',
        status: 'CONNECTED',
        credential: { connectionId: '00000000-0000-4000-8000-000000000010' },
      })),
    },
    syncCursor: {
      findMany: vi.fn(async () => [
        {
          dataType: 'GARMIN_IMPORT_DAILY_SUMMARY',
          cursorOrCheckpoint: { ...base, nextDate: null },
          leaseExpiresAt: null,
          nextAttemptAt: null,
          lastSyncedAt: new Date('2026-11-10T12:00:00.000Z'),
        },
        {
          dataType: 'GARMIN_IMPORT_SLEEP',
          cursorOrCheckpoint: { ...base, nextDate: '2026-11-08' },
          leaseExpiresAt: null,
          nextAttemptAt: null,
          lastSyncedAt: new Date('2026-11-10T12:00:00.000Z'),
        },
        {
          dataType: 'ACTIVITIES',
          cursorOrCheckpoint: { version: 1, mode: 'DONE', nextDate: null },
          lastSyncedAt: new Date('2026-11-10T12:00:00.000Z'),
        },
      ]),
    },
    syncRun: { findFirst: vi.fn(async () => null) },
  })
  const owner = getOwnerContext({
    id: '00000000-0000-4000-8000-000000000001',
    role: 'USER',
    email: null,
  })
  const streams = await getGarminImportState(owner, new Date('2026-11-10T13:00:00.000Z'))
  expect(streams.find((stream) => stream.streamId === 'daily_summary')).toMatchObject({
    status: 'completed',
    retryAfter: null,
  })
  expect(streams.find((stream) => stream.streamId === 'sleep')).toMatchObject({
    status: 'waiting_retry',
    nextDate: '2026-11-08',
  })
  expect(streams.find((stream) => stream.streamId === 'activities')).toMatchObject({
    status: 'not_started',
    checkedDays: 0,
    totalDays: null,
  })
})

it('returns the saved date failure cause with verified and unresolved counts', async () => {
  getPrismaClient.mockResolvedValueOnce({
    integrationConnection: {
      findUnique: vi.fn(async () => ({
        id: '00000000-0000-4000-8000-000000000010',
        externalAccountId: '123456',
        status: 'CONNECTED',
        credential: { connectionId: '00000000-0000-4000-8000-000000000010' },
      })),
    },
    syncCursor: {
      findMany: vi.fn(async () => [
        {
          dataType: 'GARMIN_IMPORT_DAILY_SUMMARY',
          cursorOrCheckpoint: {
            version: 1,
            generation: 1,
            startDate: '2023-11-10',
            endDate: '2026-11-09',
            nextDate: '2026-08-10',
            failedDates: Array.from({ length: 62 }, (_, index) =>
              new Date(Date.parse('2026-11-09T00:00:00Z') - index * 86_400_000)
                .toISOString()
                .slice(0, 10),
            ),
            timezone: 'UTC',
            lastCheckedDate: '2026-08-11',
            summaryFailureCode: 'SUMMARY_INVALID_RECORD',
          },
          leaseExpiresAt: null,
          nextAttemptAt: null,
          lastSyncedAt: new Date('2026-11-10T12:40:00.000Z'),
        },
      ]),
    },
    syncRun: {
      findFirst: vi.fn(async () => ({ status: 'SUCCEEDED', errorCode: null })),
    },
  })
  const owner = getOwnerContext({
    id: '00000000-0000-4000-8000-000000000001',
    role: 'USER',
    email: null,
  })
  const daily = (await getGarminImportState(owner, new Date('2026-11-10T13:00:00.000Z'))).find(
    (stream) => stream.streamId === 'daily_summary',
  )
  expect(daily).toMatchObject({
    checkedDays: 29,
    failedDateCount: 62,
    errorCode: 'SUMMARY_INVALID_RECORD',
  })
})

it('gates incremental Health only on owner-scoped Health checkpoints', async () => {
  const owner = getOwnerContext({
    id: '00000000-0000-4000-8000-000000000002',
    role: 'USER',
    email: null,
  })
  const checkpoint = {
    version: 1,
    generation: 1,
    startDate: '2023-11-10',
    endDate: '2026-11-09',
    nextDate: null,
    failedDates: ['2026-01-01'],
    timezone: 'UTC',
    lastCheckedDate: '2023-11-10',
  }
  const findMany = vi.fn(async () => [
    { dataType: 'GARMIN_IMPORT_DAILY_SUMMARY', cursorOrCheckpoint: checkpoint },
    { dataType: 'GARMIN_IMPORT_SLEEP', cursorOrCheckpoint: checkpoint },
  ])
  getPrismaClient.mockResolvedValueOnce({
    integrationConnection: {
      findUnique: vi.fn(async () => ({
        id: '00000000-0000-4000-8000-000000000010',
        externalAccountId: '123456',
        credential: { connectionId: '00000000-0000-4000-8000-000000000010' },
      })),
    },
    syncCursor: { findMany },
  })
  getGarminSyncState.mockClear()
  expect(await healthInitialImportReady(owner)).toBe(true)
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ userId: owner.userId }) }),
  )
  expect(getGarminSyncState).not.toHaveBeenCalled()
})
