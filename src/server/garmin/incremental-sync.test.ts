import { beforeEach, expect, it, vi } from 'vitest'
import type { GarminImportStreamState } from '@/lib/garmin-import-state'
import type { GarminSyncState } from '@/lib/garmin-sync-state'

const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
  lease: vi.fn(),
  history: vi.fn(),
  health: vi.fn(),
  run: vi.fn(),
  block: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/db/client', () => ({
  getPrismaClient: async () => ({
    integrationConnection: { findUnique: mocks.connection },
    syncCursor: { findFirst: mocks.lease },
  }),
}))
vi.mock('./data-import', () => ({
  getGarminImportState: mocks.history,
  runGarminDataImport: mocks.run,
}))
vi.mock('./health-sync', () => ({
  getGarminHealthSyncState: mocks.health,
  GarminHealthSyncUnavailableError: class extends Error {},
}))
vi.mock('./import-rate-limit', () => ({ getGarminImportBlock: mocks.block }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { GarminDataImportError } from './data-import-error'
import { getGarminIncrementalSyncState, runGarminIncrementalSync } from './incremental-sync'

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
const now = new Date('2026-11-13T06:00:00Z')
const imported: GarminImportStreamState = {
  streamId: 'activities',
  status: 'completed',
  summaryStatus: 'completed',
  startDate: '2023-11-12',
  endDate: '2026-11-12',
  nextDate: null,
  lastCheckedDate: '2023-11-12',
  checkedDays: 1000,
  totalDays: 1000,
  failedDateCount: 0,
  retryAfter: null,
  lastSyncAt: null,
  errorCode: null,
  generation: 1,
}
const idle: GarminSyncState = {
  status: 'IDLE',
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextAttemptAt: null,
  window: null,
  nextDate: null,
  processed: 0,
  errorCode: null,
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.connection.mockImplementation(async ({ where }) =>
    where.userId_provider.userId === owner.userId
      ? {
          id: 'c',
          credential: { connectionId: 'c' },
          status: 'CONNECTED',
          externalAccountId: '123',
        }
      : null,
  )
  mocks.history.mockResolvedValue([
    imported,
    { ...imported, streamId: 'daily_summary' },
    { ...imported, streamId: 'sleep' },
  ])
  mocks.health.mockResolvedValue(idle)
  mocks.lease.mockResolvedValue(null)
  mocks.block.mockResolvedValue(null)
  mocks.run.mockResolvedValue([])
})

it('only reads persisted state on open, scoped to the verified owner; another admin cannot read it', async () => {
  expect((await getGarminIncrementalSyncState(owner, now)).streams.map((s) => s.status)).toEqual([
    'idle',
    'idle',
    'idle',
  ])
  expect(mocks.run).not.toHaveBeenCalled()
  expect(mocks.lease).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { userId: owner.userId, connectionId: 'c', dataType: 'GARMIN_REQUESTS' },
    }),
  )
  mocks.history.mockClear()
  mocks.health.mockClear()
  expect(await getGarminIncrementalSyncState(other, now)).toMatchObject({
    connection: 'disconnected',
    streams: expect.arrayContaining([expect.objectContaining({ reason: 'NOT_CONNECTED' })]),
  })
  expect(mocks.history).not.toHaveBeenCalled()
  expect(mocks.health).not.toHaveBeenCalled()
})

it('dispatches only incremental summary work through the existing coordinator for every stream', async () => {
  for (const streamId of ['activities', 'daily_summary', 'sleep'] as const) {
    await runGarminIncrementalSync(owner, streamId, 'Asia/Tokyo')
    expect(mocks.run).toHaveBeenLastCalledWith(owner, {
      streamId,
      stage: 'summaries',
      action: 'sync',
      browserTimezone: 'Asia/Tokyo',
    })
  }
  expect(mocks.run).toHaveBeenCalledTimes(3)
})

it('skips each unfinished initial stream without importing or changing its state', async () => {
  mocks.history.mockResolvedValue([
    { ...imported, summaryStatus: 'paused' },
    { ...imported, streamId: 'daily_summary', nextDate: '2026-10-01' },
  ])
  for (const streamId of ['activities', 'daily_summary', 'sleep'] as const) {
    expect(await runGarminIncrementalSync(owner, streamId, 'UTC')).toMatchObject({
      status: 'skipped',
      reason: 'INITIAL_IMPORT_REQUIRED',
    })
  }
  expect(mocks.run).not.toHaveBeenCalled()
})

it('preserves partial success and independent retry times', async () => {
  const retryAt = new Date(Date.now() + 60_000).toISOString()
  mocks.history.mockResolvedValue([
    { ...imported, recentSync: { ...imported, lastSyncAt: now.toISOString() } },
    { ...imported, streamId: 'daily_summary' },
    { ...imported, streamId: 'sleep' },
  ])
  mocks.health.mockImplementation(async (_owner, _at, id) =>
    id === 'daily_summary'
      ? { ...idle, status: 'SUCCESS', lastSuccessAt: now.toISOString() }
      : { ...idle, status: 'PAUSED', errorCode: 'SLEEP_TIMEOUT', nextAttemptAt: retryAt },
  )
  expect((await getGarminIncrementalSyncState(owner)).streams.map((s) => s.status)).toEqual([
    'completed',
    'completed',
    'failed',
  ])
  expect(await runGarminIncrementalSync(owner, 'sleep', 'UTC')).toMatchObject({
    status: 'failed',
    retryAt,
  })
  expect(mocks.run).not.toHaveBeenCalled()
  await runGarminIncrementalSync(owner, 'daily_summary', 'UTC')
  expect(mocks.run).toHaveBeenCalledOnce()
})

it('keeps unfinished recent activity coverage resumable when a bounded pass has no error', async () => {
  mocks.history.mockResolvedValue([
    {
      ...imported,
      recentSync: {
        ...imported,
        status: 'paused',
        nextDate: '2026-11-10',
        errorCode: null,
        lastSyncAt: null,
      },
    },
    { ...imported, streamId: 'daily_summary' },
    { ...imported, streamId: 'sleep' },
  ])
  expect(await runGarminIncrementalSync(owner, 'activities', 'UTC')).toMatchObject({
    status: 'skipped',
    reason: 'REQUEST_BUDGET',
    retryAt: null,
  })
  expect(mocks.run).toHaveBeenCalledOnce()
  expect(mocks.run).toHaveBeenCalledWith(owner, {
    streamId: 'activities',
    action: 'sync',
    stage: 'summaries',
    browserTimezone: 'UTC',
  })
})

it('blocks all eligible streams while another page owns the shared provider lease', async () => {
  mocks.lease.mockResolvedValue({ leaseExpiresAt: new Date(Date.now() + 100_000) })
  for (const streamId of ['activities', 'daily_summary', 'sleep'] as const)
    expect(await runGarminIncrementalSync(owner, streamId, 'UTC')).toMatchObject({
      status: 'syncing',
      reason: 'BUSY',
    })
  expect(mocks.run).not.toHaveBeenCalled()
})

it('does not retry a shared provider pause and returns its retry time', async () => {
  const retryAt = new Date(Date.now() + 60_000)
  mocks.block.mockResolvedValue({ code: 'PROVIDER_PAUSED', retryAt })
  expect(await runGarminIncrementalSync(owner, 'activities', 'UTC')).toMatchObject({
    status: 'rate_limited',
    retryAt: retryAt.toISOString(),
  })
  expect(mocks.run).not.toHaveBeenCalled()
})

it('reports a lease race and masks unexpected provider errors without claiming success', async () => {
  mocks.run.mockRejectedValueOnce(new GarminDataImportError('BUSY'))
  expect(await runGarminIncrementalSync(owner, 'activities', 'UTC')).toMatchObject({
    status: 'syncing',
    reason: 'BUSY',
  })
  mocks.run.mockRejectedValueOnce(new Error('secret provider payload'))
  const result = await runGarminIncrementalSync(owner, 'sleep', 'UTC')
  expect(result).toMatchObject({ status: 'failed', reason: 'SYNC_FAILED' })
  expect(JSON.stringify(result)).not.toContain('secret')
})

it('preserves completed streams and distinguishes an active stream from the provider lease', async () => {
  mocks.history.mockResolvedValue([
    { ...imported, recentSync: { ...imported, lastSyncAt: now.toISOString() } },
    { ...imported, streamId: 'daily_summary' },
    { ...imported, streamId: 'sleep' },
  ])
  mocks.health.mockImplementation(async (_owner, _at, id) => ({
    ...idle,
    status: id === 'daily_summary' ? 'SYNCING' : 'SUCCESS',
    lastSuccessAt: now.toISOString(),
  }))
  mocks.lease.mockResolvedValue({ leaseExpiresAt: new Date(Date.now() + 100_000) })
  const state = await getGarminIncrementalSyncState(owner)
  expect(state.busy).toBe(true)
  expect(state.streams.map((stream) => [stream.status, stream.reason])).toEqual([
    ['completed', null],
    ['syncing', null],
    ['completed', null],
  ])
  expect(await runGarminIncrementalSync(owner, 'activities', 'UTC')).toMatchObject({
    status: 'syncing',
    reason: 'BUSY',
  })
  expect(mocks.run).not.toHaveBeenCalled()
  mocks.health.mockImplementation(async (_owner, _at, id) => ({
    ...idle,
    status: id === 'daily_summary' ? 'SYNCING' : 'ERROR',
  }))
  expect((await getGarminIncrementalSyncState(owner)).streams[2]).toMatchObject({
    status: 'failed',
    reason: 'SYNC_FAILED',
  })
})

it('allows a single-stream retry after its recorded backoff expires', async () => {
  mocks.health.mockResolvedValue({
    ...idle,
    status: 'PAUSED',
    errorCode: 'RATE_LIMITED',
    nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
  })
  await runGarminIncrementalSync(owner, 'sleep', 'UTC')
  expect(mocks.run).toHaveBeenCalledOnce()
  expect(mocks.run).toHaveBeenCalledWith(owner, {
    streamId: 'sleep',
    action: 'sync',
    stage: 'summaries',
    browserTimezone: 'UTC',
  })
})

it('a different owner cannot run an existing user’s successful or failed streams', async () => {
  expect(await runGarminIncrementalSync(other, 'sleep', 'UTC')).toMatchObject({
    status: 'skipped',
    reason: 'NOT_CONNECTED',
  })
  expect(mocks.run).not.toHaveBeenCalled()
})

it('does not acknowledge old completed coverage as a newly successful sync during backoff', async () => {
  const retryAt = new Date(Date.now() + 60_000)
  mocks.history.mockResolvedValue([
    { ...imported, recentSync: { ...imported, lastSyncAt: now.toISOString() } },
    { ...imported, streamId: 'daily_summary' },
    { ...imported, streamId: 'sleep' },
  ])
  mocks.block.mockResolvedValue({ code: 'PROVIDER_PAUSED', retryAt })
  expect((await getGarminIncrementalSyncState(owner)).streams[0]).toMatchObject({
    status: 'completed',
    retryAt: retryAt.toISOString(),
  })
  expect(await runGarminIncrementalSync(owner, 'activities', 'UTC')).toMatchObject({
    status: 'rate_limited',
    reason: 'BACKOFF',
    retryAt: retryAt.toISOString(),
  })
  expect(mocks.run).not.toHaveBeenCalled()
})

it('preserves confirmed health coverage during a shared pause and exposes checkpoint progress', async () => {
  mocks.health.mockResolvedValue({
    ...idle,
    status: 'PAUSED',
    lastSuccessAt: now.toISOString(),
    window: { start: '2026-11-07', end: '2026-11-13' },
    nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const state = await getGarminIncrementalSyncState(owner)
  expect(state.streams[1]).toMatchObject({
    status: 'completed',
    lastSuccessAt: now.toISOString(),
    progressKey: expect.any(String),
  })
  mocks.health.mockResolvedValue({
    ...idle,
    status: 'PARTIAL',
    nextDate: '2026-11-10',
    processed: 3,
  })
  const previous = (await getGarminIncrementalSyncState(owner)).streams[1].progressKey
  mocks.health.mockResolvedValue({
    ...idle,
    status: 'PARTIAL',
    nextDate: '2026-11-11',
    processed: 3,
  })
  expect((await getGarminIncrementalSyncState(owner)).streams[1].progressKey).not.toBe(previous)
})

it('does not automatically retry invalid credentials or checkpoints under a shared pause', async () => {
  const retryAt = new Date(Date.now() + 60_000)
  mocks.history.mockResolvedValue([
    {
      ...imported,
      recentSync: {
        ...imported,
        status: 'paused',
        errorCode: 'INVALID_CHECKPOINT',
        retryAfter: retryAt.toISOString(),
      },
    },
    { ...imported, streamId: 'daily_summary' },
    { ...imported, streamId: 'sleep' },
  ])
  mocks.health.mockResolvedValue({
    ...idle,
    status: 'PAUSED',
    errorCode: 'SLEEP_HTTP_403',
    nextAttemptAt: retryAt.toISOString(),
  })
  mocks.block.mockResolvedValue({ code: 'PROVIDER_PAUSED', retryAt })
  for (const streamId of ['activities', 'daily_summary', 'sleep'] as const)
    expect(await runGarminIncrementalSync(owner, streamId, 'UTC')).toMatchObject({
      status: 'failed',
      reason: 'CONNECTION_ERROR',
    })
  expect(mocks.run).not.toHaveBeenCalled()
})

it('binds automatic continuations to the original connection even if another account signs in', async () => {
  const key = (await getGarminIncrementalSyncState(owner)).connectionKey!
  mocks.connection.mockResolvedValue({
    id: 'different-connection',
    credential: { connectionId: 'different-connection' },
    status: 'CONNECTED',
    externalAccountId: '456',
  })
  expect(await runGarminIncrementalSync(other, 'sleep', 'UTC', key)).toMatchObject({
    status: 'skipped',
    reason: 'CONNECTION_ERROR',
    lastSuccessAt: null,
  })
  expect(mocks.run).not.toHaveBeenCalled()
})
