import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GarminImportStreamState, GarminLapImportState } from '@/lib/garmin-import-state'
const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
  getState: vi.fn(),
  run: vi.fn(),
  block: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/db/client', () => ({
  getPrismaClient: async () => ({ integrationConnection: { findUnique: mocks.connection } }),
}))
vi.mock('./data-import', () => ({
  getGarminImportState: mocks.getState,
  runGarminDataImport: mocks.run,
}))
vi.mock('./import-rate-limit', () => ({ getGarminImportBlock: mocks.block }))
import { getOwnerContext } from '@/server/authorization/ownership'
import { getTrainingSyncState, runTrainingSync } from './training-sync'

const owner = getOwnerContext({
  id: '00000000-0000-4000-8000-000000000001',
  role: 'USER',
  email: null,
})
const other = getOwnerContext({
  id: '00000000-0000-4000-8000-000000000002',
  role: 'ADMIN',
  email: null,
})
const history: GarminImportStreamState = {
  streamId: 'activities',
  status: 'completed',
  summaryStatus: 'completed',
  startDate: '2023-11-12',
  endDate: '2026-11-11',
  nextDate: null,
  lastCheckedDate: '2023-11-12',
  checkedDays: 1096,
  totalDays: 1096,
  failedDateCount: 0,
  retryAfter: null,
  lastSyncAt: '2026-11-12T06:42:28Z',
  errorCode: null,
  generation: 1,
}
const recent: GarminImportStreamState = {
  ...history,
  startDate: '2026-11-05',
  endDate: '2026-11-13',
  activityCount: 3,
  lastSyncAt: '2026-11-13T05:00:00Z',
}
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-13T06:00:00Z'))
  vi.clearAllMocks()
  mocks.connection.mockImplementation(async ({ where }) =>
    where.userId_provider.userId === owner.userId
      ? { status: 'CONNECTED', externalAccountId: '123', credential: { connectionId: 'c' } }
      : null,
  )
  mocks.getState.mockResolvedValue([history])
  mocks.block.mockResolvedValue(null)
  mocks.run.mockImplementation(async () => {
    mocks.getState.mockResolvedValue([{ ...history, recentSync: recent }])
    return [{ ...history, recentSync: recent }]
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
it('uses the completed Settings history to sync recent summaries rather than the old INITIAL backfill', async () => {
  expect((await getTrainingSyncState(owner)).status).toBe('IDLE')
  const state = await runTrainingSync(owner, 'Asia/Tokyo')
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith(owner, {
    streamId: 'activities',
    stage: 'summaries',
    action: 'sync',
    browserTimezone: 'Asia/Tokyo',
  })
  expect(state).toMatchObject({
    status: 'SUCCESS',
    processed: 3,
    window: { start: '2026-11-05', end: '2026-11-13' },
    lastSuccessAt: recent.lastSyncAt,
  })
})
it('does not expose another user connection or start a provider request for an admin', async () => {
  expect((await getTrainingSyncState(other)).status).toBe('NOT_CONNECTED')
  expect((await runTrainingSync(other, 'UTC')).status).toBe('NOT_CONNECTED')
  expect(mocks.getState).not.toHaveBeenCalled()
  expect(mocks.run).not.toHaveBeenCalled()
})

it('keeps a disconnected owner from starting hosted sync', async () => {
  mocks.connection.mockResolvedValue({
    status: 'DISCONNECTED',
    externalAccountId: '123',
    credential: null,
  })
  expect((await runTrainingSync(owner, 'UTC')).status).toBe('NOT_CONNECTED')
  expect(mocks.getState).not.toHaveBeenCalled()
  expect(mocks.run).not.toHaveBeenCalled()
})

it('requires a replacement key for an invalid hosted connection', async () => {
  mocks.connection.mockResolvedValue({
    status: 'ERROR',
    externalAccountId: '123',
    credential: { connectionId: 'c' },
  })
  expect(await runTrainingSync(owner, 'UTC')).toMatchObject({
    status: 'ACTION_REQUIRED',
    errorCode: 'INVALID_KEY',
  })
  expect(mocks.getState).not.toHaveBeenCalled()
  expect(mocks.run).not.toHaveBeenCalled()
})
it('requires initial import in Settings instead of starting a second historical traversal', async () => {
  mocks.getState.mockResolvedValue([{ ...history, summaryStatus: 'paused' }])
  expect(await runTrainingSync(owner, 'UTC')).toMatchObject({
    status: 'ACTION_REQUIRED',
    errorCode: 'INITIAL_IMPORT_REQUIRED',
  })
  expect(mocks.run).not.toHaveBeenCalled()
})
it('honors active provider pauses without doing work', async () => {
  const retryAt = new Date(Date.now() + 60000)
  mocks.block.mockResolvedValue({ code: 'PROVIDER_PAUSED', retryAt })
  expect(await runTrainingSync(owner, 'UTC')).toMatchObject({
    status: 'PAUSED',
    nextAttemptAt: retryAt.toISOString(),
  })
  expect(mocks.run).not.toHaveBeenCalled()
})
it('runs bounded FIT work after a successful 20-second summary check within the route budget', async () => {
  const now = Date.now()
  let elapsed = 0
  const laps = {
    status: 'paused' as const,
    eligible: 3,
    processed: 0,
    complete: 0,
    failed: 0,
    unavailable: 0,
    pending: 3,
    retryable: 0,
    totalLaps: 0,
    retryAfter: null,
    lastSyncAt: null,
    errorCode: null,
  }
  mocks.run.mockImplementation(async (_owner, options) => {
    if (options.stage === 'summaries') elapsed = 20_100
    const value = {
      ...history,
      recentSync: recent,
      laps: options.stage === 'laps' ? { ...laps, status: 'completed' as const, pending: 0 } : laps,
    }
    mocks.getState.mockResolvedValue([value])
    return [value]
  })
  expect((await runTrainingSync(owner, 'UTC', { now: () => new Date(now + elapsed) })).status).toBe(
    'SUCCESS',
  )
  expect(mocks.run.mock.calls.map((call) => call[1].stage)).toEqual(['summaries', 'laps'])
})
it('resumes incomplete recent summaries and never starts laps before summary coverage completes', async () => {
  mocks.run.mockResolvedValue([
    { ...history, recentSync: { ...recent, status: 'paused', nextDate: '2026-11-13' } },
  ])
  mocks.getState.mockResolvedValue([
    { ...history, recentSync: { ...recent, status: 'paused', nextDate: '2026-11-13' } },
  ])
  expect((await runTrainingSync(owner, 'UTC')).status).toBe('PARTIAL')
  expect(mocks.run).toHaveBeenCalledOnce()
})

it('does not call a recent summary success a complete sync while FIT lap imports have failed', async () => {
  mocks.getState.mockResolvedValue([
    {
      ...history,
      recentSync: recent,
      laps: {
        status: 'completed_with_warnings',
        eligible: 3,
        processed: 3,
        complete: 2,
        failed: 1,
        unavailable: 0,
        pending: 0,
        retryable: 0,
        totalLaps: 5,
        retryAfter: null,
        lastSyncAt: null,
        errorCode: null,
      },
    },
  ])
  expect(await getTrainingSyncState(owner)).toMatchObject({
    status: 'PARTIAL_FAILURE',
    lastSuccessAt: recent.lastSyncAt,
  })
})

const failedLaps: GarminLapImportState = {
  status: 'paused',
  eligible: 3,
  processed: 3,
  complete: 2,
  failed: 1,
  unavailable: 0,
  pending: 0,
  retryable: 1,
  totalLaps: 5,
  retryAfter: null,
  lastSyncAt: null,
  errorCode: null,
}

it('retries failed FIT downloads after cooldown when no new downloads remain', async () => {
  const waiting = { ...history, recentSync: recent, laps: failedLaps }
  mocks.getState.mockResolvedValue([waiting])
  mocks.run.mockImplementation(async (_owner, options) => {
    const value =
      options.stage === 'laps'
        ? {
            ...waiting,
            laps: {
              ...failedLaps,
              status: 'completed' as const,
              complete: 3,
              failed: 0,
              retryable: 0,
            },
          }
        : waiting
    mocks.getState.mockResolvedValue([value])
    return [value]
  })

  expect((await runTrainingSync(owner, 'Asia/Tokyo')).status).toBe('SUCCESS')
  expect(mocks.run.mock.calls.map((call) => call[1])).toEqual([
    { streamId: 'activities', stage: 'summaries', action: 'sync', browserTimezone: 'Asia/Tokyo' },
    { streamId: 'activities', stage: 'laps', action: 'retry', browserTimezone: 'Asia/Tokyo' },
  ])
})

it('does not retry failed downloads that are not eligible yet', async () => {
  const waiting = { ...history, recentSync: recent, laps: { ...failedLaps, retryable: 0 } }
  mocks.getState.mockResolvedValue([waiting])
  mocks.run.mockResolvedValue([waiting])

  expect((await runTrainingSync(owner, 'UTC')).status).toBe('PARTIAL_FAILURE')
  expect(mocks.run).toHaveBeenCalledOnce()
})

it('prioritizes pending downloads and keeps FIT work to one bounded batch', async () => {
  const waiting = {
    ...history,
    recentSync: recent,
    laps: { ...failedLaps, eligible: 4, pending: 1 },
  }
  mocks.getState.mockResolvedValue([waiting])
  mocks.run.mockResolvedValue([waiting])

  await runTrainingSync(owner, 'UTC')
  expect(mocks.run).toHaveBeenCalledTimes(2)
  expect(mocks.run).toHaveBeenLastCalledWith(owner, {
    streamId: 'activities',
    stage: 'laps',
    action: 'sync',
    browserTimezone: 'UTC',
  })
})

it('honors a FIT cooldown established while summaries were being imported', async () => {
  const now = new Date('2026-11-13T05:00:00Z')
  mocks.run.mockResolvedValue([
    {
      ...history,
      recentSync: recent,
      laps: { ...failedLaps, retryAfter: new Date(now.getTime() + 60_000).toISOString() },
    },
  ])

  await runTrainingSync(owner, 'UTC', { now: () => now })
  expect(mocks.run).toHaveBeenCalledOnce()
})

it('does not start a FIT retry after the summary stage consumes the run budget', async () => {
  const now = new Date('2026-11-13T05:00:00Z')
  let elapsed = 0
  const waiting = { ...history, recentSync: recent, laps: failedLaps }
  mocks.getState.mockResolvedValue([history])
  mocks.run.mockImplementation(async () => {
    elapsed = 30_000
    mocks.getState.mockResolvedValue([waiting])
    return [waiting]
  })

  await runTrainingSync(owner, 'UTC', { now: () => new Date(now.getTime() + elapsed) })
  expect(mocks.run).toHaveBeenCalledOnce()
})

it.each(['sync', 'retry'] as const)(
  'continues deferred FIT %s work on the next request after slow summaries',
  async (action) => {
    const now = Date.parse('2026-11-13T06:00:00Z')
    let elapsed = 0
    mocks.run.mockImplementation(async (_owner, options) => {
      if (options.stage === 'summaries') elapsed += 30_100
      const value = {
        ...history,
        recentSync: { ...recent, lastSyncAt: new Date(now + elapsed).toISOString() },
        laps:
          options.stage === 'laps'
            ? { ...failedLaps, status: 'completed' as const, complete: 3, failed: 0, retryable: 0 }
            : action === 'retry'
              ? failedLaps
              : { ...failedLaps, processed: 2, pending: 1, failed: 0, retryable: 0 },
      }
      mocks.getState.mockResolvedValue([value])
      return [value]
    })
    const dependencies = { now: () => new Date(now + elapsed) }
    expect((await runTrainingSync(owner, 'UTC', dependencies)).status).toBe(
      action === 'retry' ? 'PARTIAL_FAILURE' : 'PARTIAL',
    )
    expect(mocks.run).toHaveBeenCalledOnce()
    expect((await runTrainingSync(owner, 'UTC', dependencies)).status).toBe('SUCCESS')
    expect(mocks.run.mock.calls.map((call) => call[1].stage)).toEqual(['summaries', 'laps'])
    expect(mocks.run).toHaveBeenLastCalledWith(owner, {
      streamId: 'activities',
      stage: 'laps',
      action,
      browserTimezone: 'UTC',
    })
  },
)

it('refreshes stale summary coverage before continuing a FIT backlog', async () => {
  const stale = { ...history, recentSync: recent, laps: failedLaps }
  mocks.getState.mockResolvedValue([stale])
  mocks.run.mockResolvedValue([stale])
  await runTrainingSync(owner, 'UTC')
  expect(mocks.run.mock.calls.map((call) => call[1].stage)).toEqual(['summaries', 'laps'])
})

it('does not continue deferred FIT work during a provider pause', async () => {
  mocks.getState.mockResolvedValue([
    {
      ...history,
      recentSync: { ...recent, lastSyncAt: new Date().toISOString() },
      laps: failedLaps,
    },
  ])
  mocks.block.mockResolvedValue({ code: 'PROVIDER_PAUSED', retryAt: new Date(Date.now() + 60_000) })
  expect((await runTrainingSync(owner, 'UTC')).status).toBe('PAUSED')
  expect(mocks.run).not.toHaveBeenCalled()
})
