import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  isVerifiedCurrentUser,
  getPrismaClient,
  getGarminProviderPauseUntil,
  pauseGarminProviderUntil,
} = vi.hoisted(() => ({
  isVerifiedCurrentUser: vi.fn(() => true),
  getPrismaClient: vi.fn(),
  getGarminProviderPauseUntil: vi.fn<() => Promise<Date | null>>(async () => null),
  pauseGarminProviderUntil: vi.fn<(...args: [unknown, Date, Uint8Array]) => Promise<void>>(
    async () => {},
  ),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser }))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))
vi.mock('./import-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./import-rate-limit')>()),
  getGarminProviderPauseUntil,
  pauseGarminProviderUntil,
}))
vi.mock('./provider-lease', () => ({
  claimGarminProviderLease: vi.fn(async () => 'synthetic-provider-lease'),
  releaseGarminProviderLease: vi.fn(async () => {}),
}))

import { getOwnerContext } from '@/server/authorization/ownership'
import { GarminImportError, importGarminActivityPage } from './activity-import'
import { getGarminSyncState, runGarminSync } from './sync'

const firstId = '00000000-0000-4000-8000-000000000001'
const secondId = '00000000-0000-4000-8000-000000000002'
const connectionId = '00000000-0000-4000-8000-000000000010'
const owner = getOwnerContext({ id: firstId, role: 'USER', email: null })
const anotherOwner = getOwnerContext({ id: secondId, role: 'ADMIN', email: null })

type Cursor = {
  userId: string
  connectionId: string
  dataType: string
  cursorOrCheckpoint: unknown
  leaseToken: string | null
  leaseExpiresAt: Date | null
  nextAttemptAt: Date | null
  lastSyncedAt: Date | null
  consecutiveFailures: number
}
type Run = {
  id: string
  userId: string
  connectionId: string
  jobType: string
  status: string
  startedAt: Date
  finishedAt: Date | null
  recordsWritten: number
  errorCode: string | null
}

function fixture() {
  let cursor: Cursor | null = null
  let externalAccountId: string | null = '123456'
  const runs: Run[] = []
  const db = {
    integrationConnection: {
      findUnique: vi.fn(async ({ where }: { where: { userId_provider: { userId: string } } }) =>
        where.userId_provider.userId === firstId
          ? {
              id: connectionId,
              status: 'CONNECTED',
              externalAccountId,
              credential: {
                connectionId,
                nonce: new Uint8Array([1]),
                rotatedAt: new Date('2026-11-01T00:00:00Z'),
              },
            }
          : null,
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    syncCursor: {
      upsert: vi.fn(async ({ create }: { create: Cursor }) => {
        cursor ??= {
          ...create,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          lastSyncedAt: null,
          consecutiveFailures: 0,
        }
        return cursor
      }),
      findUniqueOrThrow: vi.fn(async () => {
        if (!cursor) throw new Error('Missing cursor')
        return { ...cursor }
      }),
      findUnique: vi.fn(async () => cursor),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>
          data: Record<string, unknown>
        }) => {
          if (
            !cursor ||
            cursor.userId !== where.userId ||
            cursor.connectionId !== where.connectionId
          )
            return { count: 0 }
          if (where.leaseToken && where.leaseToken !== cursor.leaseToken) return { count: 0 }
          if (where.OR && cursor.leaseExpiresAt && cursor.leaseExpiresAt > clock)
            return { count: 0 }
          if (where.AND && cursor.nextAttemptAt && cursor.nextAttemptAt > clock) return { count: 0 }
          if (where.leaseExpiresAt && (!cursor.leaseExpiresAt || cursor.leaseExpiresAt <= clock))
            return { count: 0 }
          cursor = {
            ...cursor,
            ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
          }
          return { count: 1 }
        },
      ),
    },
    syncRun: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }: { data: Partial<Run> }) => {
        const run: Run = {
          id: `run-${runs.length}`,
          userId: firstId,
          connectionId,
          jobType: 'GARMIN_ACTIVITIES',
          status: 'RUNNING',
          startedAt: clock,
          finishedAt: null,
          recordsWritten: 0,
          errorCode: null,
          ...data,
        }
        runs.push(run)
        return run
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Run> }) => {
        const run = runs.find((item) => item.id === where.id)
        if (!run) throw new Error('Missing run')
        Object.assign(run, data)
        return run
      }),
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
        where.userId === firstId ? (runs.at(-1) ?? null) : null,
      ),
    },
  }
  getPrismaClient.mockResolvedValue(db)
  return {
    db,
    setAccountId(value: string | null) {
      externalAccountId = value
    },
    get cursor() {
      return cursor
    },
    runs,
  }
}

let clock = new Date('2026-11-08T12:00:00.000Z')
beforeEach(() => {
  vi.clearAllMocks()
  getGarminProviderPauseUntil.mockResolvedValue(null)
  clock = new Date('2026-11-08T12:00:00.000Z')
  delete process.env.VERCEL_ENV
  delete process.env.GARMIN_SHARED_SYNC_APPROVED
  delete process.env.GARMIN_SYNC_MAX_PAGES
  delete process.env.GARMIN_SYNC_PAGE_SIZE
  delete process.env.GARMIN_SYNC_TIMEOUT_MS
  delete process.env.GARMIN_SYNC_PACING_MS
})

describe('Garmin sync checkpoints', () => {
  it('requires account verification before an existing key can import activities', async () => {
    const state = fixture()
    state.setAccountId(null)
    expect(await getGarminSyncState(owner)).toMatchObject({
      status: 'ACTION_REQUIRED',
      errorCode: 'ACCOUNT_VERIFICATION_REQUIRED',
    })
    await expect(runGarminSync(owner)).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
    expect(state.db.syncCursor.upsert).not.toHaveBeenCalled()
    process.env.VERCEL_ENV = 'production'
    expect((await getGarminSyncState(owner)).status).toBe('UNAVAILABLE')
  })

  it('commits a page only after import and resumes its next offset', async () => {
    const state = fixture()
    const importPage = vi.fn(async () => {
      clock = new Date(clock.getTime() + 21_000)
      return {
        imported: [{ id: 'activity', lapImportStatus: 'IMPORTED' as const }],
        providerIds: ['123'],
        hasMore: true,
        nextStart: 3,
      }
    })
    await runGarminSync(owner, {}, { now: () => clock, importPage })
    expect(importPage).toHaveBeenCalledWith(
      owner,
      {
        startDate: '2026-08-17',
        endDate: '2026-08-17',
        start: 0,
        pageSize: 1,
        refreshLaps: false,
      },
      {
        requestTimeoutMs: 7000,
        pacingMs: 1000,
        deadlineAt: Date.parse('2026-11-08T12:00:20Z'),
        identitySession: {},
      },
    )
    expect(state.cursor?.cursorOrCheckpoint).toMatchObject({ nextDate: '2026-08-17', offset: 3 })
    const secondPage = vi.fn(async () => {
      clock = new Date(clock.getTime() + 21_000)
      return { imported: [], providerIds: [], hasMore: false, nextStart: null }
    })
    await runGarminSync(owner, {}, { now: () => clock, importPage: secondPage })
    expect(secondPage).toHaveBeenCalledWith(
      owner,
      {
        startDate: '2026-08-17',
        endDate: '2026-08-17',
        start: 3,
        pageSize: 1,
        refreshLaps: false,
      },
      {
        requestTimeoutMs: 7000,
        pacingMs: 1000,
        deadlineAt: clock.getTime() - 1_000,
        identitySession: {},
      },
    )
    expect(state.cursor?.cursorOrCheckpoint).toMatchObject({
      nextDate: '2026-08-17',
      offset: 0,
      verifyingDay: true,
    })
    const verify = vi.fn<typeof importGarminActivityPage>(async () => {
      clock = new Date(clock.getTime() + 21_000)
      return { imported: [], providerIds: ['123'], hasMore: false, nextStart: null }
    })
    await runGarminSync(owner, {}, { now: () => clock, importPage: verify })
    expect(verify.mock.calls[0][1]).toMatchObject({ startDate: '2026-08-17', start: 0 })
    expect(state.cursor?.cursorOrCheckpoint).toMatchObject({ nextDate: '2026-08-18', offset: 0 })
  })

  it('rescans a paginated historical day when Garmin inserts ahead of the saved offset', async () => {
    const state = fixture()
    const pages = [
      { providerIds: ['2', '1'], hasMore: true, nextStart: 2 },
      { providerIds: ['1', '0'], hasMore: false, nextStart: null },
      { providerIds: ['3', '2'], hasMore: true, nextStart: 2 },
      { providerIds: ['1', '0'], hasMore: false, nextStart: null },
      { providerIds: ['3', '2'], hasMore: true, nextStart: 2 },
      { providerIds: ['1', '0'], hasMore: false, nextStart: null },
    ]
    const importPage = vi.fn<typeof importGarminActivityPage>(async () => {
      clock = new Date(clock.getTime() + 21_000)
      const next = pages.shift()
      if (!next) throw new Error('Unexpected page')
      return { imported: [], ...next }
    })
    for (let attempt = 0; attempt < 6; attempt++)
      await runGarminSync(owner, {}, { now: () => clock, importPage })
    expect(importPage.mock.calls.map((call) => call[1].start)).toEqual([0, 2, 0, 2, 0, 2])
    expect(state.cursor?.cursorOrCheckpoint).toMatchObject({
      nextDate: '2026-08-18',
      seenIds: [],
      verifyingDay: false,
    })
  })

  it('keeps the full provider Retry-After when it exceeds seven days', async () => {
    const state = fixture()
    const importPage = vi.fn(async () => {
      throw new GarminImportError('RATE_LIMITED', 10 * 86_400_000)
    })
    await runGarminSync(owner, {}, { now: () => clock, importPage })
    expect(state.cursor?.nextAttemptAt?.getTime()).toBe(clock.getTime() + 10 * 86_400_000)
  })

  it('caps an extreme provider Retry-After at 30 days', async () => {
    const state = fixture()
    const importPage = vi.fn(async () => {
      throw new GarminImportError('RATE_LIMITED', 1e20)
    })
    await runGarminSync(owner, {}, { now: () => clock, importPage })
    expect(state.cursor?.nextAttemptAt?.getTime()).toBe(clock.getTime() + 30 * 86_400_000)
    expect(pauseGarminProviderUntil.mock.calls[0][1]).toEqual(state.cursor?.nextAttemptAt)
  })

  it('holds one owner lease across concurrent triggers', async () => {
    fixture()
    let release!: (value: {
      imported: []
      providerIds: []
      hasMore: false
      nextStart: null
    }) => void
    const importPage = vi.fn(
      () =>
        new Promise<{ imported: []; providerIds: []; hasMore: false; nextStart: null }>(
          (resolve) => {
            release = resolve
          },
        ),
    )
    const running = runGarminSync(owner, {}, { now: () => clock, importPage })
    await vi.waitFor(() => expect(importPage).toHaveBeenCalledOnce())
    await expect(runGarminSync(owner, {}, { now: () => clock, importPage })).rejects.toMatchObject({
      code: 'BUSY',
    })
    clock = new Date(clock.getTime() + 21_000)
    release({ imported: [], providerIds: [], hasMore: false, nextStart: null })
    await running
    expect(importPage).toHaveBeenCalledOnce()
  })

  it('retains the checkpoint on a provider rate limit and pauses retries', async () => {
    const state = fixture()
    const importPage = vi.fn(async () => {
      throw new GarminImportError('RATE_LIMITED', 300_000)
    })
    const result = await runGarminSync(owner, {}, { now: () => clock, importPage })
    expect(result.status).toBe('PAUSED')
    expect(state.cursor?.cursorOrCheckpoint).toMatchObject({ nextDate: '2026-08-17', offset: 0 })
    expect(state.cursor?.nextAttemptAt?.getTime()).toBeGreaterThanOrEqual(clock.getTime() + 300_000)
    expect(pauseGarminProviderUntil).toHaveBeenCalledWith(
      owner,
      expect.any(Date),
      new Uint8Array([1]),
    )
    await expect(runGarminSync(owner, {}, { now: () => clock, importPage })).rejects.toMatchObject({
      code: 'PAUSED',
    })
    expect(importPage).toHaveBeenCalledOnce()
  })

  it('keeps the historical checkpoint after a FIT timeout with JSON already persisted', async () => {
    const state = fixture()
    const importPage = vi.fn(async () => {
      throw new GarminImportError('TIMEOUT', undefined, 1)
    })
    const result = await runGarminSync(owner, {}, { now: () => clock, importPage })
    expect(result.status).toBe('PAUSED')
    expect(state.cursor?.cursorOrCheckpoint).toMatchObject({ nextDate: '2026-08-17', offset: 0 })
    expect(state.runs[0]).toMatchObject({
      status: 'FAILED',
      recordsWritten: 1,
      errorCode: 'TIMEOUT',
    })
    expect(importPage).toHaveBeenCalledOnce()
    expect(pauseGarminProviderUntil).not.toHaveBeenCalled()
  })

  it('keeps invalid-response backoff local to activities and permits retry after it expires', async () => {
    const state = fixture()
    const failed = await runGarminSync(
      owner,
      {},
      {
        now: () => clock,
        importPage: async () => {
          throw new GarminImportError('INVALID_RESPONSE')
        },
      },
    )
    expect(failed).toMatchObject({ status: 'PAUSED', errorCode: 'INVALID_RESPONSE' })
    expect(pauseGarminProviderUntil).not.toHaveBeenCalled()
    clock = new Date(Date.parse(failed.nextAttemptAt!) + 1)
    expect(await getGarminSyncState(owner, clock)).toMatchObject({
      status: 'ERROR',
      nextAttemptAt: null,
      errorCode: 'INVALID_RESPONSE',
    })
    const result = await runGarminSync(
      owner,
      {},
      {
        now: () => clock,
        importPage: async () => ({
          imported: [],
          providerIds: [],
          hasMore: false,
          nextStart: null,
        }),
      },
    )
    expect(result.status).toBe('PARTIAL')
    expect(state.cursor?.nextAttemptAt).toBeNull()
  })

  it('does not start a job while another Garmin import holds the provider pause', async () => {
    fixture()
    const until = new Date(clock.getTime() + 300_000)
    getGarminProviderPauseUntil.mockResolvedValue(until)
    expect((await getGarminSyncState(owner, clock)).status).toBe('PAUSED')
    await expect(runGarminSync(owner, {}, { now: () => clock })).rejects.toMatchObject({
      code: 'PAUSED',
    })
  })

  it('does not expose another athlete’s connection to an admin', async () => {
    fixture()
    expect((await getGarminSyncState(anotherOwner)).status).toBe('NOT_CONNECTED')
    await expect(runGarminSync(anotherOwner)).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
  })

  it('keeps hosted sync gated until Garmin approval is recorded', async () => {
    fixture()
    process.env.VERCEL_ENV = 'production'
    expect((await getGarminSyncState(owner)).status).toBe('UNAVAILABLE')
    await expect(runGarminSync(owner)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
  })

  it('stops after four empty pages and resumes the bounded initial window', async () => {
    const state = fixture()
    const importPage = vi.fn(async () => ({
      imported: [],
      providerIds: [],
      hasMore: false,
      nextStart: null,
    }))
    await runGarminSync(owner, {}, { now: () => clock, importPage })
    expect(importPage).toHaveBeenCalledTimes(4)
    expect(state.cursor?.cursorOrCheckpoint).toMatchObject({ nextDate: '2026-08-21', offset: 0 })
  })

  it('honors bounded page, request, and pacing configuration', async () => {
    fixture()
    process.env.GARMIN_SYNC_MAX_PAGES = '2'
    process.env.GARMIN_SYNC_PAGE_SIZE = '2'
    process.env.GARMIN_SYNC_TIMEOUT_MS = '3000'
    process.env.GARMIN_SYNC_PACING_MS = '2000'
    const importPage = vi.fn(async () => ({
      imported: [],
      providerIds: [],
      hasMore: false,
      nextStart: null,
    }))
    await runGarminSync(owner, {}, { now: () => clock, importPage })
    expect(importPage).toHaveBeenCalledTimes(2)
    expect(importPage.mock.calls[0]).toEqual([
      owner,
      {
        startDate: '2026-08-17',
        endDate: '2026-08-17',
        start: 0,
        pageSize: 2,
        refreshLaps: false,
      },
      {
        requestTimeoutMs: 3000,
        pacingMs: 2000,
        deadlineAt: clock.getTime() + 20_000,
        identitySession: {},
      },
    ])
  })

  it('uses a seven-day overlap and only an explicit bounded older extension', async () => {
    const state = fixture()
    const finishPage = vi.fn(async () => {
      clock = new Date(clock.getTime() + 21_000)
      return { imported: [], providerIds: [], hasMore: false, nextStart: null }
    })
    await runGarminSync(owner, {}, { now: () => clock, importPage: finishPage })
    if (!state.cursor) throw new Error('Cursor missing')
    state.cursor.cursorOrCheckpoint = {
      version: 1,
      mode: 'DONE',
      oldestIncludedDate: '2026-08-17',
      windowStart: '2026-08-17',
      windowEnd: '2026-11-08',
      nextDate: null,
      offset: 0,
    }
    const overlap = vi.fn(async () => {
      clock = new Date(clock.getTime() + 21_000)
      return { imported: [], providerIds: [], hasMore: false, nextStart: null }
    })
    await runGarminSync(owner, {}, { now: () => clock, importPage: overlap })
    expect(overlap.mock.calls).toHaveLength(1)
    expect(state.cursor.cursorOrCheckpoint).toMatchObject({ windowStart: '2026-11-02' })
    state.cursor.cursorOrCheckpoint = {
      version: 1,
      mode: 'DONE',
      oldestIncludedDate: '2026-08-17',
      windowStart: '2026-08-17',
      windowEnd: '2026-11-08',
      nextDate: null,
      offset: 0,
    }
    const extension = vi.fn(async () => {
      clock = new Date(clock.getTime() + 21_000)
      return { imported: [], providerIds: [], hasMore: false, nextStart: null }
    })
    await runGarminSync(owner, { extendDays: 7 }, { now: () => clock, importPage: extension })
    expect(state.cursor.cursorOrCheckpoint).toMatchObject({
      mode: 'EXTENSION',
      windowStart: '2026-08-10',
      windowEnd: '2026-08-16',
    })
  })

  it('catches up missing days after a delayed backfill before resuming the recent overlap', async () => {
    const state = fixture()
    const page = vi.fn<typeof importGarminActivityPage>(async () => ({
      imported: [],
      providerIds: [],
      hasMore: false,
      nextStart: null,
    }))
    await runGarminSync(owner, {}, { now: () => clock, importPage: page })
    if (!state.cursor) throw new Error('Cursor missing')
    // A checkpoint written before latestRecentDate existed remains readable.
    state.cursor.cursorOrCheckpoint = {
      version: 1,
      mode: 'DONE',
      oldestIncludedDate: '2026-08-17',
      windowStart: '2026-08-17',
      windowEnd: '2026-11-08',
      nextDate: null,
      offset: 0,
    }
    clock = new Date('2026-11-18T12:00:00.000Z')
    page.mockClear()
    await runGarminSync(owner, {}, { now: () => clock, importPage: page })
    expect(page.mock.calls[0][1]).toMatchObject({ startDate: '2026-11-09', refreshLaps: true })
    expect(state.cursor.cursorOrCheckpoint).toMatchObject({
      windowStart: '2026-11-09',
      windowEnd: '2026-11-15',
      nextDate: '2026-11-13',
    })
    await runGarminSync(owner, {}, { now: () => clock, importPage: page })
    expect(state.cursor.cursorOrCheckpoint).toMatchObject({
      latestRecentDate: '2026-11-15',
      nextDate: null,
    })
    page.mockClear()
    await runGarminSync(owner, {}, { now: () => clock, importPage: page })
    expect(page.mock.calls[0][1]).toMatchObject({ startDate: '2026-11-12' })
    expect(state.cursor.cursorOrCheckpoint).toMatchObject({ windowEnd: '2026-11-18' })
  })

  it('preserves the latest recent date across an older extension', async () => {
    const state = fixture()
    const page = vi.fn<typeof importGarminActivityPage>(async () => ({
      imported: [],
      providerIds: [],
      hasMore: false,
      nextStart: null,
    }))
    await runGarminSync(owner, {}, { now: () => clock, importPage: page })
    if (!state.cursor) throw new Error('Cursor missing')
    state.cursor.cursorOrCheckpoint = {
      version: 1,
      mode: 'DONE',
      oldestIncludedDate: '2026-08-17',
      latestRecentDate: '2026-11-08',
      windowStart: '2026-08-17',
      windowEnd: '2026-11-08',
      nextDate: null,
      offset: 0,
    }
    clock = new Date('2026-11-18T12:00:00.000Z')
    await runGarminSync(owner, { extendDays: 7 }, { now: () => clock, importPage: page })
    await runGarminSync(owner, {}, { now: () => clock, importPage: page })
    expect(state.cursor.cursorOrCheckpoint).toMatchObject({
      latestRecentDate: '2026-11-08',
      nextDate: null,
    })
    page.mockClear()
    await runGarminSync(owner, {}, { now: () => clock, importPage: page })
    expect(page.mock.calls[0][1]).toMatchObject({ startDate: '2026-11-09' })
  })

  it('resumes an extension after its first page times out without another extendDays request', async () => {
    const state = fixture()
    await runGarminSync(
      owner,
      {},
      {
        now: () => clock,
        importPage: vi.fn(async () => ({
          imported: [],
          providerIds: [],
          hasMore: false,
          nextStart: null,
        })),
      },
    )
    if (!state.cursor) throw new Error('Cursor missing')
    state.cursor.cursorOrCheckpoint = {
      version: 1,
      mode: 'DONE',
      oldestIncludedDate: '2026-08-17',
      latestRecentDate: '2026-11-08',
      windowStart: '2026-08-17',
      windowEnd: '2026-11-08',
      nextDate: null,
      offset: 0,
    }
    const failedPage = vi.fn(async () => {
      throw new GarminImportError('TIMEOUT')
    })
    expect(
      (await runGarminSync(owner, { extendDays: 7 }, { now: () => clock, importPage: failedPage }))
        .status,
    ).toBe('PAUSED')
    expect(state.cursor.cursorOrCheckpoint).toMatchObject({
      mode: 'EXTENSION',
      windowStart: '2026-08-10',
      windowEnd: '2026-08-16',
      nextDate: '2026-08-10',
    })
    state.cursor.nextAttemptAt = null
    const resumedPage = vi.fn<typeof importGarminActivityPage>(async () => ({
      imported: [],
      providerIds: [],
      hasMore: false,
      nextStart: null,
    }))
    await runGarminSync(owner, {}, { now: () => clock, importPage: resumedPage })
    expect(resumedPage.mock.calls[0][1]).toMatchObject({ startDate: '2026-08-10' })
  })

  it('requires a replacement key after an invalid-key response', async () => {
    const state = fixture()
    const importPage = vi.fn(async () => {
      throw new GarminImportError('INVALID_KEY')
    })
    const result = await runGarminSync(owner, {}, { now: () => clock, importPage })
    expect(result.status).toBe('ACTION_REQUIRED')
    expect(state.cursor?.cursorOrCheckpoint).toMatchObject({ actionRequired: true, offset: 0 })
    await expect(runGarminSync(owner, {}, { now: () => clock, importPage })).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    })
    expect(importPage).toHaveBeenCalledOnce()
  })

  it('pauses a rejected access token without invalidating the saved key', async () => {
    const state = fixture()
    const importPage = vi.fn(async () => {
      throw new GarminImportError('TOKEN_REJECTED')
    })
    expect((await runGarminSync(owner, {}, { now: () => clock, importPage })).status).toBe('PAUSED')
    expect(state.db.integrationConnection.updateMany).not.toHaveBeenCalled()
    expect(state.cursor?.cursorOrCheckpoint).toMatchObject({ actionRequired: false })
  })

  it('reports denied activity access separately from an invalid key', async () => {
    const state = fixture()
    const importPage = vi.fn(async () => {
      throw new GarminImportError('ACCESS_DENIED')
    })
    const result = await runGarminSync(owner, {}, { now: () => clock, importPage })
    expect(result.status).toBe('ACTION_REQUIRED')
    expect(result.errorCode).toBe('ACCESS_DENIED')
    expect(state.db.integrationConnection.updateMany).not.toHaveBeenCalled()
  })

  it('reports a partial failure without advancing the failed page', async () => {
    const state = fixture()
    const importPage = vi
      .fn()
      .mockResolvedValueOnce({
        imported: [{ id: 'synthetic', lapImportStatus: 'IMPORTED' }],
        providerIds: ['123'],
        hasMore: true,
        nextStart: 1,
      })
      .mockRejectedValueOnce(new GarminImportError('UNAVAILABLE'))
    await runGarminSync(owner, {}, { now: () => clock, importPage })
    expect(state.cursor?.cursorOrCheckpoint).toMatchObject({ offset: 1 })
    expect(state.runs[0].recordsWritten).toBe(1)
    if (!state.cursor) throw new Error('Cursor missing')
    state.cursor.nextAttemptAt = null
    expect((await getGarminSyncState(owner)).status).toBe('PARTIAL_FAILURE')
  })
})
