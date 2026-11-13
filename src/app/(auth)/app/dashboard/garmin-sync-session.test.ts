import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  incrementalStreamIds,
  type IncrementalStreamId,
  type IncrementalSyncResult,
  type IncrementalSyncSnapshot,
} from '@/lib/garmin-incremental-sync'
import {
  preserveDashboardSyncFailures,
  runDashboardGarminSync,
  type DashboardSyncHistory,
} from './garmin-sync-session'

const idle = (): IncrementalSyncSnapshot => ({
  connection: 'connected',
  streams: incrementalStreamIds.map((streamId) => ({
    streamId,
    status: 'idle',
    reason: null,
    lastSuccessAt: null,
    retryAt: null,
  })),
})
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
const complete = (id: IncrementalStreamId): IncrementalSyncResult => ({
  streamId: id,
  status: 'completed',
  reason: null,
  lastSuccessAt: new Date().toISOString(),
  retryAt: null,
})
let state: IncrementalSyncSnapshot
let controller: AbortController
const onState = vi.fn()
const onProgress = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-13T10:00:00Z'))
  state = idle()
  controller = new AbortController()
  onState.mockReset()
  onProgress.mockReset()
})
afterEach(() => {
  controller.abort()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function mockServer(
  run: (
    id: IncrementalStreamId,
  ) => IncrementalSyncResult | Response | Promise<IncrementalSyncResult | Response>,
) {
  return vi.fn(async (_url: string, options?: RequestInit) => {
    if (!options?.method) return json(state)
    const { streamId } = JSON.parse(String(options.body)) as { streamId: IncrementalStreamId }
    const result = await run(streamId)
    if (result instanceof Response) return result
    state = {
      ...state,
      busy: result.status === 'syncing',
      streams: state.streams.map((stream) => (stream.streamId === streamId ? result : stream)),
    }
    return json(result)
  })
}
const start = (target?: IncrementalStreamId) =>
  runDashboardGarminSync({ signal: controller.signal, onState, onProgress, target })
const posted = (mock: ReturnType<typeof mockServer>) =>
  mock.mock.calls
    .filter((call) => call[1]?.method === 'POST')
    .map((call) => JSON.parse(String(call[1]?.body)).streamId)

it('finishes multiple bounded pages after one start without restarting completed streams', async () => {
  let passes = 0
  const fetchMock = mockServer((id) =>
    id === 'activities' && ++passes < 3
      ? {
          ...state.streams[0],
          status: 'skipped',
          reason: 'REQUEST_BUDGET',
          progressKey: `page-${passes}`,
        }
      : complete(id),
  )
  vi.stubGlobal('fetch', fetchMock)
  const result = start()
  await vi.advanceTimersByTimeAsync(0)
  expect(posted(fetchMock)).toEqual(['activities', 'daily_summary', 'sleep'])
  await vi.advanceTimersByTimeAsync(2_000)
  expect((await result).streams.every((stream) => stream.status === 'completed')).toBe(true)
  expect(posted(fetchMock)).toEqual([
    'activities',
    'daily_summary',
    'sleep',
    'activities',
    'activities',
  ])
})

it.each([false, true])(
  'preserves an unrecorded failure across status reads, allowing confirmed new recovery: %s',
  async (recovered) => {
    state.streams = state.streams.map((stream) => ({
      ...stream,
      status: 'completed',
      lastSuccessAt: new Date(Date.now() - 60_000).toISOString(),
    }))
    let dailyPasses = 0
    const fetchMock = mockServer((id) => {
      if (id === 'activities')
        return json({ ...state.streams[0], status: 'failed', reason: 'SYNC_FAILED' })
      return id === 'daily_summary' && ++dailyPasses === 1
        ? {
            ...complete(id),
            status: 'skipped',
            reason: 'REQUEST_BUDGET',
            lastSuccessAt: null,
            progressKey: 'page-1',
          }
        : complete(id)
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = start()
    await vi.advanceTimersByTimeAsync(0)
    expect(onState.mock.calls.at(-1)?.[0].streams[0].status).toBe('failed')
    if (recovered) state.streams[0] = complete('activities')
    await vi.advanceTimersByTimeAsync(1_000)
    const final = await result
    expect(final.streams.map((stream) => stream.status)).toEqual([
      recovered ? 'completed' : 'failed',
      'completed',
      'completed',
    ])
    expect(posted(fetchMock)).toEqual(['activities', 'daily_summary', 'sleep', 'daily_summary'])
    if (!recovered)
      expect(
        onState.mock.calls.slice(1).every(([snapshot]) => snapshot.streams[0].status === 'failed'),
      ).toBe(true)
  },
)

it('can be armed during backoff and rechecks a deadline extended by another page', async () => {
  state.streams = state.streams.map((stream) => ({
    ...stream,
    status: 'rate_limited',
    reason: 'BACKOFF',
    retryAt: new Date(Date.now() + 30_000).toISOString(),
  }))
  const fetchMock = mockServer(complete)
  vi.stubGlobal('fetch', fetchMock)
  const result = start()
  await vi.advanceTimersByTimeAsync(29_000)
  expect(posted(fetchMock)).toEqual([])
  state.streams = state.streams.map((stream) => ({ ...stream, retryAt: '2026-11-13T10:01:00Z' }))
  await vi.advanceTimersByTimeAsync(30_999)
  expect(posted(fetchMock)).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect((await result).streams.every((stream) => stream.status === 'completed')).toBe(true)
  expect(posted(fetchMock)).toEqual(incrementalStreamIds)
})

it('retains a longer shared Retry-After when preserving a failed attempt over old coverage', () => {
  const oldSuccess = new Date(Date.now() - 60_000).toISOString()
  const retryAt = new Date(Date.now() + 120_000).toISOString()
  state.streams[0] = {
    ...state.streams[0],
    status: 'completed',
    lastSuccessAt: oldSuccess,
    retryAt,
  }
  const failure: IncrementalSyncResult = {
    ...state.streams[0],
    status: 'failed',
    reason: 'SYNC_FAILED',
    retryAt: null,
  }
  expect(preserveDashboardSyncFailures(state, [failure], Date.now()).streams[0]).toMatchObject({
    status: 'failed',
    retryAt,
  })
})

it.each([true, false])(
  'inherits unrelated failed attempts only for the same connection: %s',
  async (sameConnection) => {
    state.connectionKey = 'current-connection'
    state.streams = state.streams.map((stream) => ({
      ...stream,
      status: 'completed',
      lastSuccessAt: new Date(Date.now() - 60_000).toISOString(),
    }))
    const failure: IncrementalSyncResult = {
      ...state.streams[0],
      status: 'failed',
      reason: 'SYNC_FAILED',
    }
    const history: DashboardSyncHistory = {
      connectionKey: sameConnection ? 'current-connection' : 'other-owner-connection',
      attempts: { activities: { startedAt: Date.now() - 1_000, result: failure } },
    }
    const fetchMock = mockServer(complete)
    const onAttempt = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await runDashboardGarminSync({
      signal: controller.signal,
      target: 'sleep',
      history,
      onState,
      onProgress,
      onAttempt,
    })
    expect(result.streams[0].status).toBe(sameConnection ? 'failed' : 'completed')
    expect(posted(fetchMock)).toEqual(['sleep'])
    expect(onAttempt).toHaveBeenCalledOnce()
    expect(onAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ streamId: 'sleep', status: 'completed' }),
      }),
      'current-connection',
    )
    expect(history.attempts.activities?.result).toBe(failure)
    expect(
      JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body))
        .connectionKey,
    ).toBe('current-connection')
  },
)

it('honors HTTP Retry-After and backs off repeated limits without another click', async () => {
  let passes = 0
  const fetchMock = mockServer((id) =>
    ++passes < 3
      ? new Response(null, { status: 429, headers: { 'Retry-After': passes === 1 ? '90' : '30' } })
      : complete(id),
  )
  vi.stubGlobal('fetch', fetchMock)
  const result = start('activities')
  await vi.advanceTimersByTimeAsync(89_999)
  expect(posted(fetchMock)).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(posted(fetchMock)).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(119_999)
  expect(posted(fetchMock)).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(1)
  expect((await result).streams[0].status).toBe('completed')
  expect(posted(fetchMock)).toEqual(['activities', 'activities', 'activities'])
})

it('observes an external lease without duplicate work, then finishes only remaining streams', async () => {
  state.busy = true
  state.streams[0] = { ...state.streams[0], status: 'syncing', reason: null }
  const fetchMock = mockServer(complete)
  vi.stubGlobal('fetch', fetchMock)
  const result = start()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(posted(fetchMock)).toEqual([])
  state = {
    ...state,
    busy: false,
    streams: state.streams.map((stream) =>
      stream.streamId === 'activities' ? complete('activities') : stream,
    ),
  }
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await result).streams.every((stream) => stream.status === 'completed')).toBe(true)
  expect(posted(fetchMock)).toEqual(['daily_summary', 'sleep'])
})

it('stops repeated unchanged checkpoints while preserving other successful streams', async () => {
  const fetchMock = mockServer((id) =>
    id === 'activities'
      ? {
          ...state.streams[0],
          status: 'skipped',
          reason: 'REQUEST_BUDGET',
          progressKey: 'unchanged',
        }
      : complete(id),
  )
  vi.stubGlobal('fetch', fetchMock)
  const result = start()
  await vi.advanceTimersByTimeAsync(3_000)
  expect((await result).streams.map((stream) => stream.status)).toEqual([
    'skipped',
    'completed',
    'completed',
  ])
  expect(posted(fetchMock).filter((id) => id === 'activities')).toHaveLength(4)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(posted(fetchMock)).toHaveLength(6)
})

it('aborts timers on navigation without starting later requests', async () => {
  state.streams[0] = {
    ...state.streams[0],
    status: 'rate_limited',
    reason: 'BACKOFF',
    retryAt: '2026-11-13T12:00:00Z',
  }
  const fetchMock = mockServer(complete)
  vi.stubGlobal('fetch', fetchMock)
  const result = start('activities')
  const rejection = expect(result).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(1_000)
  controller.abort()
  await rejection
  await vi.advanceTimersByTimeAsync(7_200_000)
  expect(posted(fetchMock)).toEqual([])
})

it('stops on authorization failures before any different-session retry', async () => {
  const fetchMock = mockServer(() => new Response(null, { status: 403 }))
  vi.stubGlobal('fetch', fetchMock)
  await expect(start()).rejects.toThrow('Garmin request unavailable')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(posted(fetchMock)).toEqual(['activities'])
})

it('reconciles a lost POST response with persisted success instead of replaying the stream', async () => {
  let passes = 0
  const fetchMock = mockServer(async (id) => {
    if (++passes === 1) {
      state.streams[0] = { ...complete('activities'), lastSuccessAt: '2026-11-13T10:00:00.001Z' }
      throw new Error('Connection interrupted')
    }
    return complete(id)
  })
  vi.stubGlobal('fetch', fetchMock)
  const result = start('activities')
  await vi.advanceTimersByTimeAsync(1_000)
  expect((await result).streams[0].status).toBe('completed')
  expect(posted(fetchMock)).toEqual(['activities'])
})

it('skips initial imports and never submits historical actions or owner input', async () => {
  state.streams[0] = { ...state.streams[0], status: 'skipped', reason: 'INITIAL_IMPORT_REQUIRED' }
  const fetchMock = mockServer(complete)
  vi.stubGlobal('fetch', fetchMock)
  const result = await start()
  expect(result.streams[0].reason).toBe('INITIAL_IMPORT_REQUIRED')
  expect(posted(fetchMock)).toEqual(['daily_summary', 'sleep'])
  for (const call of fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST'))
    expect(Object.keys(JSON.parse(String(call[1]?.body))).sort()).toEqual([
      'browserTimezone',
      'streamId',
    ])
})

it('does not continue under a different connection/session after waiting', async () => {
  state.connectionKey = 'original-connection'
  state.streams[0] = {
    ...state.streams[0],
    status: 'rate_limited',
    reason: 'BACKOFF',
    retryAt: '2026-11-13T10:01:00Z',
  }
  const fetchMock = mockServer(complete)
  vi.stubGlobal('fetch', fetchMock)
  const result = start('activities')
  const rejection = expect(result).rejects.toThrow('Garmin request unavailable')
  await vi.advanceTimersByTimeAsync(0)
  state.connectionKey = 'another-connection'
  await vi.advanceTimersByTimeAsync(60_000)
  await rejection
  expect(posted(fetchMock)).toEqual([])
})

it('shows a disconnected state and stops if the connection is removed during a pause', async () => {
  state.connectionKey = 'original-connection'
  state.streams[0] = {
    ...state.streams[0],
    status: 'rate_limited',
    reason: 'BACKOFF',
    retryAt: '2026-11-13T10:01:00Z',
  }
  const fetchMock = mockServer(complete)
  vi.stubGlobal('fetch', fetchMock)
  const result = start('activities')
  await vi.advanceTimersByTimeAsync(0)
  state = {
    connection: 'disconnected',
    streams: state.streams.map((stream) => ({
      ...stream,
      status: 'skipped',
      reason: 'NOT_CONNECTED',
    })),
  }
  await vi.advanceTimersByTimeAsync(60_000)
  expect((await result).connection).toBe('disconnected')
  expect(posted(fetchMock)).toEqual([])
})
