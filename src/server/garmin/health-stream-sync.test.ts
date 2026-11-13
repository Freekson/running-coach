import { beforeEach, expect, it, vi } from 'vitest'
import type { GarminHealthImportErrorCode } from './health-import'

const mocks = vi.hoisted(() => ({ db: vi.fn(), allow: vi.fn(), claim: vi.fn(), release: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/db/client', () => ({ getPrismaClient: mocks.db }))
vi.mock('./import-rate-limit', () => ({
  allowGarminImport: mocks.allow,
  getGarminProviderPauseUntil: async () => null,
}))
vi.mock('./provider-lease', () => ({
  claimGarminProviderLease: mocks.claim,
  releaseGarminProviderLease: mocks.release,
}))
vi.mock('./health-import', () => ({
  importGarminHealthDate: vi.fn(),
  GarminHealthImportError: class extends Error {
    constructor(readonly code: GarminHealthImportErrorCode) {
      super(code)
    }
  },
}))
import { getOwnerContext } from '@/server/authorization/ownership'
import { GarminHealthImportError, type importGarminHealthDate } from './health-import'
import {
  GarminHealthSyncUnavailableError,
  getGarminHealthSyncState,
  runGarminHealthSync,
} from './health-sync'

const owner = getOwnerContext({
  id: '00000000-0000-4000-8000-000000000001',
  role: 'USER',
  email: null,
})
const now = new Date('2026-11-13T06:00:00Z')
type Cursor = {
  cursorOrCheckpoint: unknown
  lastSyncedAt: Date | null
  nextAttemptAt: Date | null
  leaseExpiresAt: Date | null
  consecutiveFailures: number
}
const cursors = new Map<string, Cursor>()
const runs = new Map<
  string,
  { id: string; startedAt: Date; status: string; recordsWritten: number; errorCode: string | null }
>()
let initialComplete = true
const findMany = vi.fn()
const upsert = vi.fn()

beforeEach(() => {
  vi.resetAllMocks()
  cursors.clear()
  runs.clear()
  initialComplete = true
  successful.mockImplementation(async (_owner, date, zone, options) => ({
    status: options?.sources === 'SUMMARY_ONLY' ? 'SUMMARY_ONLY' : 'SUCCEEDED',
    date,
    sourceTimezone: zone,
  }))
  mocks.allow.mockResolvedValue(true)
  mocks.claim.mockResolvedValue('provider-token')
  mocks.release.mockResolvedValue(undefined)
  findMany.mockImplementation(async () => [
    {
      cursorOrCheckpoint: {
        endDate: '2026-11-12',
        nextDate: initialComplete ? null : '2026-10-01',
      },
    },
  ])
  upsert.mockImplementation(
    async ({ create }: { create: { dataType: string; cursorOrCheckpoint: unknown } }) => {
      if (!cursors.has(create.dataType))
        cursors.set(create.dataType, {
          cursorOrCheckpoint: create.cursorOrCheckpoint,
          lastSyncedAt: null,
          nextAttemptAt: null,
          leaseExpiresAt: null,
          consecutiveFailures: 0,
        })
    },
  )
  mocks.db.mockResolvedValue({
    integrationConnection: {
      findUnique: async () => ({
        id: 'c',
        externalAccountId: '123',
        status: 'CONNECTED',
        credential: { connectionId: 'c', rotatedAt: new Date('2026-11-01T00:00:00Z') },
      }),
    },
    athleteProfile: { findUnique: async () => ({ preferredTimezone: 'UTC' }) },
    syncCursor: {
      findMany,
      upsert,
      findUnique: async ({ where }: { where: { connectionId_dataType: { dataType: string } } }) =>
        cursors.get(where.connectionId_dataType.dataType) ?? null,
      findUniqueOrThrow: async ({
        where,
      }: {
        where: { connectionId_dataType: { dataType: string } }
      }) => cursors.get(where.connectionId_dataType.dataType),
      updateMany: async ({ where, data }: { where: { dataType: string }; data: object }) => {
        Object.assign(cursors.get(where.dataType) ?? {}, data)
        return { count: 1 }
      },
    },
    syncRun: {
      findFirst: async ({ where }: { where: { jobType: string } }) =>
        runs.get(where.jobType) ?? null,
      updateMany: async () => ({ count: 0 }),
      create: async ({ data }: { data: { jobType: string; status: string } }) => {
        const run = {
          id: data.jobType,
          startedAt: now,
          status: data.status,
          recordsWritten: 0,
          errorCode: null,
        }
        runs.set(data.jobType, run)
        return run
      },
      update: async ({ where, data }: { where: { id: string }; data: object }) =>
        Object.assign(runs.get(where.id) ?? {}, data),
    },
  })
})
const successful = vi.fn<typeof importGarminHealthDate>(async (_owner, date, zone, options) => ({
  status: options?.sources === 'SUMMARY_ONLY' ? 'SUMMARY_ONLY' : 'SUCCEEDED',
  date,
  sourceTimezone: zone,
}))
const dependencies = () => ({
  now: () => now,
  importDay: successful,
  zoneForDay: async () => ({ summary: 'UTC', sleep: 'UTC' }),
})

it('reuses the worker with independent cursors and source selection, preserving completed daily data after sleep fails', async () => {
  expect((await runGarminHealthSync(owner, 'UTC', dependencies(), 'daily_summary')).status).toBe(
    'SUCCESS',
  )
  expect(successful.mock.calls).toHaveLength(7)
  expect(successful.mock.calls.every((call) => call[3]?.sources === 'SUMMARY_ONLY')).toBe(true)
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        userId: owner.userId,
        connectionId: 'c',
        dataType: { in: ['GARMIN_IMPORT_DAILY_SUMMARY'] },
      },
    }),
  )
  const daily = structuredClone(cursors.get('GARMIN_HEALTH_RECENT_DAILY_SUMMARY'))
  const failing = vi.fn<typeof importGarminHealthDate>(async () => {
    throw new GarminHealthImportError('SLEEP_TIMEOUT')
  })
  expect(
    (await runGarminHealthSync(owner, 'UTC', { ...dependencies(), importDay: failing }, 'sleep'))
      .status,
  ).toBe('PAUSED')
  expect(failing.mock.calls[0][3]).toMatchObject({
    sources: 'SLEEP_ONLY',
    recheckFetchedSleep: true,
  })
  expect(cursors.get('GARMIN_HEALTH_RECENT_DAILY_SUMMARY')).toEqual(daily)
  expect(cursors.get('GARMIN_HEALTH_RECENT_SLEEP')?.nextAttemptAt).toEqual(
    new Date(now.getTime() + 60_000),
  )
  expect((await getGarminHealthSyncState(owner, now, 'daily_summary')).status).toBe('SUCCESS')
  expect(cursors.has('HEALTH')).toBe(false)
  expect(mocks.allow).toHaveBeenCalledTimes(2)
  expect(mocks.release).toHaveBeenCalledTimes(2)
})

it('never seeds initial import or consumes quota for an unfinished stream', async () => {
  initialComplete = false
  await expect(runGarminHealthSync(owner, 'UTC', dependencies(), 'sleep')).rejects.toMatchObject({
    code: 'NOT_READY',
  })
  expect(upsert).not.toHaveBeenCalled()
  expect(mocks.allow).not.toHaveBeenCalled()
  expect(successful).not.toHaveBeenCalled()
})

it('obeys the shared limiter and refuses provider work when another page holds the lease', async () => {
  mocks.allow.mockResolvedValueOnce(false)
  await expect(runGarminHealthSync(owner, 'UTC', dependencies(), 'sleep')).rejects.toBeInstanceOf(
    GarminHealthSyncUnavailableError,
  )
  expect(successful).not.toHaveBeenCalled()
  mocks.claim.mockResolvedValueOnce(null)
  await expect(runGarminHealthSync(owner, 'UTC', dependencies(), 'sleep')).rejects.toMatchObject({
    code: 'BUSY',
  })
  expect(successful).not.toHaveBeenCalled()
  expect(cursors.get('GARMIN_HEALTH_RECENT_SLEEP')?.leaseExpiresAt).toBeNull()
})

it('reuses the source cooldown without another provider request', async () => {
  await runGarminHealthSync(owner, 'UTC', dependencies(), 'sleep')
  const calls = successful.mock.calls.length
  await runGarminHealthSync(owner, 'UTC', dependencies(), 'sleep')
  expect(successful).toHaveBeenCalledTimes(calls)
  expect(mocks.allow).toHaveBeenCalledOnce()
})
