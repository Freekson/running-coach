// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  incrementalStreamIds,
  type IncrementalSyncResult,
  type IncrementalSyncSnapshot,
} from '@/lib/garmin-incremental-sync'
import { GarminSyncPanel } from './garmin-sync-panel'
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const initial: IncrementalSyncSnapshot = {
  connection: 'connected',
  streams: incrementalStreamIds.map((streamId) => ({
    streamId,
    status: 'idle',
    reason: null,
    lastSuccessAt: null,
    retryAt: null,
  })),
}
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  refresh.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})
const json = (body: unknown) => ({ ok: true, json: async () => body })

function completedSnapshot(): IncrementalSyncSnapshot {
  return {
    ...initial,
    streams: initial.streams.map((stream) => ({
      ...stream,
      status: 'completed',
      lastSuccessAt: new Date().toISOString(),
    })),
  }
}

it('keeps all three successful streams visible, without fabricated progress or cancel controls', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={completedSnapshot()} />))
  expect(host.querySelectorAll('li')).toHaveLength(3)
  expect(host.textContent?.match(/Up to date/g)).toHaveLength(3)
  expect(host.textContent).toContain('Last sync:')
  expect(host.querySelector('.badge')?.textContent).toBe('Connected')
  expect(host.querySelector('progress, [role="progressbar"]')).toBeNull()
  expect(host.textContent).not.toContain('Cancel')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('does not infer recent coverage from historical import completion or an old success', async () => {
  const snapshot = completedSnapshot()
  snapshot.streams[0].lastSuccessAt = null
  snapshot.streams[1].lastSuccessAt = new Date(Date.now() - 86_400_001).toISOString()
  snapshot.streams[2] = initial.streams[2]
  await act(async () => root.render(<GarminSyncPanel initial={snapshot} />))
  expect(host.textContent).not.toContain('Up to date')
  expect(host.textContent).toContain('Outdated')
  expect(host.textContent).toContain('Not synced')
})

it.each([1, 2])(
  'shows %i failed streams with compact, closed error details and independent retries',
  async (count) => {
    const snapshot = completedSnapshot()
    snapshot.streams = snapshot.streams.map((stream, index) =>
      index < count ? { ...stream, status: 'failed', reason: 'SYNC_FAILED' } : stream,
    )
    await act(async () => root.render(<GarminSyncPanel initial={snapshot} />))
    expect(host.querySelector('.badge')?.textContent).toBe('Sync issue')
    expect(host.textContent).toContain(
      `${count} ${count === 1 ? 'stream failed' : 'streams failed'}`,
    )
    expect(host.querySelectorAll('button[aria-label^="Retry"]')).toHaveLength(count)
    expect(host.querySelectorAll('details')).toHaveLength(count)
    expect(host.querySelector('details[open]')).toBeNull()
    expect(host.textContent?.match(/Up to date/g)).toHaveLength(3 - count)
  },
)

it('retries only the selected failed stream and preserves successful streams while retrying', async () => {
  const snapshot = completedSnapshot()
  snapshot.streams[1] = { ...snapshot.streams[1], status: 'failed', reason: 'SYNC_FAILED' }
  let resolve: (value: ReturnType<typeof json>) => void = () => {}
  const waiting = new Promise<ReturnType<typeof json>>((done) => {
    resolve = done
  })
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) =>
    options?.method === 'POST' ? waiting : json(snapshot),
  )
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={snapshot} />))
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-label="Retry Daily summary"]')!.click()
    host.querySelector<HTMLButtonElement>('button[aria-label="Retry Daily summary"]')?.click()
  })
  expect(host.querySelector('.badge')?.textContent).toBe('Retrying…')
  expect(host.textContent?.match(/Up to date/g)).toHaveLength(2)
  expect(host.querySelector('button')?.disabled).toBe(true)
  expect(host.querySelector('.button__spinner')).toBeNull()
  expect(
    fetchMock.mock.calls
      .filter((call) => call[1]?.method === 'POST')
      .map((call) => JSON.parse(String(call[1]?.body)).streamId),
  ).toEqual(['daily_summary'])
  await act(async () =>
    resolve(
      json({
        ...snapshot.streams[1],
        status: 'completed',
        reason: null,
        lastSuccessAt: new Date().toISOString(),
      }),
    ),
  )
  expect(host.textContent?.match(/Up to date/g)).toHaveLength(3)
  expect(host.querySelector('.badge')?.textContent).toBe('Connected')
  expect(refresh).toHaveBeenCalledOnce()
})

it('keeps completed streams intact while observing one active external stream', async () => {
  const snapshot = completedSnapshot()
  snapshot.busy = true
  snapshot.streams[1] = { ...snapshot.streams[1], status: 'syncing', reason: null }
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={snapshot} />))
  expect(host.textContent?.match(/Up to date/g)).toHaveLength(2)
  expect(host.querySelector('.badge')?.textContent).toBe('Syncing…')
  expect(host.querySelector('button')?.disabled).toBe(true)
  expect(host.querySelector('li:nth-child(2) svg[class*="spinning"]')).not.toBeNull()
  expect(fetchMock).not.toHaveBeenCalled()
})

it('unlocks a rate-limited retry only after Retry-After, without scheduling requests', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-13T06:00:00Z'))
  const snapshot = completedSnapshot()
  snapshot.streams[1] = {
    ...snapshot.streams[1],
    status: 'rate_limited',
    reason: 'BACKOFF',
    retryAt: '2026-11-13T06:00:10Z',
  }
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={snapshot} />))
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="Retry Daily summary"]')?.disabled,
  ).toBe(true)
  expect(host.querySelector('details summary')?.textContent).toBe('Waiting')
  expect(host.textContent).toContain('Retry after')
  expect(host.querySelector('button')?.disabled).toBe(false)
  await act(async () => vi.advanceTimersByTimeAsync(10_000))
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="Retry Daily summary"]')?.disabled,
  ).toBe(false)
  expect(host.querySelector('details summary')?.textContent).toBe('Retry available')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('links a disconnected account to settings and never offers provider actions', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  await act(async () =>
    root.render(
      <GarminSyncPanel
        initial={{
          connection: 'disconnected',
          streams: initial.streams.map((stream) => ({
            ...stream,
            status: 'skipped',
            reason: 'NOT_CONNECTED',
          })),
        }}
      />,
    ),
  )
  expect(host.querySelector('.badge')?.textContent).toBe('Not connected')
  expect(host.querySelector('button')).toBeNull()
  expect(host.querySelector('a')?.textContent).toBe('Connect Garmin')
  expect(host.querySelector('a')?.getAttribute('href')).toBe(
    '/app/settings#garmin-data-import-heading',
  )
  expect(fetchMock).not.toHaveBeenCalled()
})

it('rechecks external concurrency before any POST, even when old completed states remain', async () => {
  const snapshot = completedSnapshot()
  const fetchMock = vi.fn(async () => json({ ...snapshot, busy: true }))
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={snapshot} />))
  await act(async () => host.querySelector('button')!.click())
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(host.querySelector('button')?.disabled).toBe(true)
  expect(host.querySelector('.badge')?.textContent).toBe('Waiting')
  expect(host.textContent).not.toContain('All Garmin streams synchronized')
})

it('does not expose response payloads when a request fails', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) =>
    options?.method === 'POST' ? json({ secret: 'sensitive provider payload' }) : json(initial),
  )
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={initial} />))
  await act(async () => host.querySelector('button')!.click())
  await act(async () => vi.advanceTimersByTimeAsync(3_000))
  expect(host.textContent).toContain('Sync issue')
  expect(host.textContent).not.toContain('sensitive provider payload')
  expect(host.textContent).not.toContain('All Garmin streams synchronized')
})

it('shows the queued streams while the first bounded request is running', async () => {
  let resolve: (value: ReturnType<typeof json>) => void = () => {}
  const waiting = new Promise<ReturnType<typeof json>>((done) => {
    resolve = done
  })
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
    if (!options?.method) return json(initial)
    const { streamId } = JSON.parse(String(options.body)) as {
      streamId: IncrementalSyncResult['streamId']
    }
    return streamId === 'activities'
      ? waiting
      : json({
          ...initial.streams.find((stream) => stream.streamId === streamId),
          status: 'completed',
          lastSuccessAt: new Date().toISOString(),
        })
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={initial} />))
  await act(async () => host.querySelector('button')!.click())
  expect(host.querySelector('li:first-child')?.textContent).toContain('Syncing…')
  expect(host.textContent?.match(/Waiting…/g)).toHaveLength(2)
  expect(host.querySelector('progress, [role="progressbar"]')).toBeNull()
  await act(async () =>
    resolve(
      json({ ...initial.streams[0], status: 'completed', lastSuccessAt: new Date().toISOString() }),
    ),
  )
  expect(host.textContent?.match(/Up to date/g)).toHaveLength(3)
})

it('does not request Garmin on mount and links unfinished imports to Settings', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  await act(async () =>
    root.render(
      <GarminSyncPanel
        initial={{
          ...initial,
          streams: initial.streams.map((s) => ({
            ...s,
            status: 'skipped',
            reason: 'INITIAL_IMPORT_REQUIRED',
          })),
        }}
      />,
    ),
  )
  expect(fetchMock).not.toHaveBeenCalled()
  expect(host.querySelector('details')).toBeNull()
  expect(host.textContent).not.toContain('Stream sync details')
  expect(host.textContent).toContain('Import required')
  expect(host.textContent).not.toContain('Initial import is not complete')
  expect(host.textContent).not.toContain('No successful incremental sync yet')
  expect(host.querySelector('a')?.getAttribute('href')).toBe(
    '/app/settings#garmin-data-import-heading',
  )
})

it('runs the three incremental streams sequentially and refreshes persisted reads after partial success', async () => {
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
    if (!options?.method) return json(initial)
    const { streamId } = JSON.parse(String(options.body)) as {
      streamId: IncrementalSyncResult['streamId']
    }
    return json({
      ...initial.streams.find((s) => s.streamId === streamId),
      status: streamId === 'sleep' ? 'failed' : 'completed',
      reason: streamId === 'sleep' ? 'SYNC_FAILED' : null,
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={initial} />))
  await act(async () => host.querySelector('button')!.click())
  expect(
    fetchMock.mock.calls
      .filter((call) => call[1]?.method === 'POST')
      .map((call) => JSON.parse(String(call[1]?.body)).streamId),
  ).toEqual(incrementalStreamIds)
  expect(host.textContent).toContain('Synchronization incomplete')
  expect(host.textContent).toContain('Failed')
  expect(host.textContent).not.toContain('All Garmin streams synchronized')
  expect(refresh).toHaveBeenCalledOnce()
})

it('keeps a failed attempt visible through other-stream continuation and persisted page refreshes', async () => {
  vi.useFakeTimers()
  const saved: IncrementalSyncSnapshot = {
    ...completedSnapshot(),
    connectionKey: 'same-owner-connection',
  }
  saved.streams = saved.streams.map((stream) => ({
    ...stream,
    lastSuccessAt: new Date(Date.now() - 60_000).toISOString(),
  }))
  let persisted = saved
  let dailyPasses = 0
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
    if (!options?.method) return json(persisted)
    const { streamId } = JSON.parse(String(options.body)) as {
      streamId: IncrementalSyncResult['streamId']
    }
    if (streamId === 'activities')
      return json({ ...saved.streams[0], status: 'failed', reason: 'SYNC_FAILED' })
    const partial = streamId === 'daily_summary' && ++dailyPasses === 1
    const result: IncrementalSyncResult = {
      streamId,
      status: partial ? 'skipped' : 'completed',
      reason: partial ? 'REQUEST_BUDGET' : null,
      lastSuccessAt: partial ? null : new Date().toISOString(),
      retryAt: null,
      progressKey: partial ? 'page-1' : 'done',
    }
    persisted = {
      ...persisted,
      streams: persisted.streams.map((stream) => (stream.streamId === streamId ? result : stream)),
    }
    return json(result)
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={saved} />))
  await act(async () => host.querySelector('button')!.click())
  await act(async () => vi.advanceTimersByTimeAsync(1_000))
  expect(host.querySelector('.badge')?.textContent).toBe('Sync issue')
  expect(host.querySelector('li:first-child')?.textContent).toContain('Failed')
  expect(host.textContent).not.toContain('All Garmin streams synchronized')
  // Simulate router.refresh returning the last saved success before the failed attempt.
  await act(async () => root.render(<GarminSyncPanel initial={{ ...persisted }} />))
  expect(host.querySelector('.badge')?.textContent).toBe('Sync issue')
  expect(host.querySelector('li:first-child')?.textContent).toContain('Failed')
  expect(host.textContent).not.toContain('All Garmin streams synchronized')
  // A genuinely new persisted success, including one from another page, can clear it.
  const recovered: IncrementalSyncSnapshot = {
    ...persisted,
    streams: persisted.streams.map((stream) =>
      stream.streamId === 'activities'
        ? { ...stream, status: 'completed', reason: null, lastSuccessAt: new Date().toISOString() }
        : stream,
    ),
  }
  await act(async () => root.render(<GarminSyncPanel initial={recovered} />))
  expect(host.querySelector('li:first-child')?.textContent).toContain('Up to date')
  expect(host.querySelector('.badge--error')).toBeNull()
  expect(host.querySelector('.badge')?.textContent).toBe('Connected')
  expect(host.textContent).toContain('All Garmin streams synchronized')
})

it.each([false, true])(
  'keeps another stream failure across a targeted retry, honoring earlier confirmed recovery: %s',
  async (externalRecovery) => {
    vi.useFakeTimers()
    const saved: IncrementalSyncSnapshot = {
      ...completedSnapshot(),
      connectionKey: 'same-owner-connection',
    }
    saved.streams = saved.streams.map((stream) => ({
      ...stream,
      lastSuccessAt: new Date(Date.now() - 60_000).toISOString(),
    }))
    let persisted = saved
    let activityPasses = 0
    let sleepPasses = 0
    const posted: string[] = []
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      if (!options?.method) return json(persisted)
      const { streamId } = JSON.parse(String(options.body)) as {
        streamId: IncrementalSyncResult['streamId']
      }
      posted.push(streamId)
      const failed =
        (streamId === 'activities' && ++activityPasses === 1) ||
        (streamId === 'sleep' && ++sleepPasses === 1)
      const result: IncrementalSyncResult = {
        ...saved.streams.find((stream) => stream.streamId === streamId)!,
        status: failed ? 'failed' : 'completed',
        reason: failed ? 'SYNC_FAILED' : null,
        lastSuccessAt: failed ? saved.streams[0].lastSuccessAt : new Date().toISOString(),
      }
      if (!(streamId === 'activities' && failed))
        persisted = {
          ...persisted,
          streams: persisted.streams.map((stream) =>
            stream.streamId === streamId ? result : stream,
          ),
        }
      return json(result)
    })
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => root.render(<GarminSyncPanel initial={saved} />))
    await act(async () => host.querySelector('button')!.click())
    await act(async () => root.render(<GarminSyncPanel initial={{ ...persisted }} />))
    expect(host.querySelector('li:first-child')?.textContent).toContain('Failed')
    await act(async () => vi.advanceTimersByTimeAsync(500))
    if (externalRecovery)
      persisted = {
        ...persisted,
        streams: persisted.streams.map((stream) =>
          stream.streamId === 'activities'
            ? {
                ...stream,
                status: 'completed',
                reason: null,
                lastSuccessAt: new Date().toISOString(),
              }
            : stream,
        ),
      }
    await act(async () => vi.advanceTimersByTimeAsync(500))
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Retry Sleep"]')!.click(),
    )
    expect(posted).toEqual(['activities', 'daily_summary', 'sleep', 'sleep'])
    expect(host.querySelector('li:first-child')?.textContent).toContain(
      externalRecovery ? 'Up to date' : 'Failed',
    )
    expect(host.querySelector('.badge')?.textContent).toBe(
      externalRecovery ? 'Connected' : 'Sync issue',
    )
    if (!externalRecovery) {
      expect(host.textContent).not.toContain('All Garmin streams synchronized')
      await act(async () => root.render(<GarminSyncPanel initial={{ ...persisted }} />))
      expect(host.querySelector('li:first-child')?.textContent).toContain('Failed')
      await act(async () => vi.advanceTimersByTimeAsync(1_000))
      await act(async () =>
        host.querySelector<HTMLButtonElement>('button[aria-label="Retry Activities"]')!.click(),
      )
      expect(posted).toEqual(['activities', 'daily_summary', 'sleep', 'sleep', 'activities'])
      expect(host.querySelector('.badge')?.textContent).toBe('Connected')
    }
    expect(host.textContent).toContain('All Garmin streams synchronized')
  },
)

it('prevents repeated clicks while active and preserves stream progress', async () => {
  let resolve: (value: ReturnType<typeof json>) => void = () => {}
  const waiting = new Promise<ReturnType<typeof json>>((done) => {
    resolve = done
  })
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? waiting
      : json({
          ...initial,
          streams: initial.streams.map((s) =>
            s.streamId === 'activities'
              ? s
              : { ...s, status: 'skipped', reason: 'INITIAL_IMPORT_REQUIRED' },
          ),
        }),
  )
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={initial} />))
  await act(async () => {
    host.querySelector('button')!.click()
    host.querySelector('button')!.click()
  })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(host.querySelector('button')?.disabled).toBe(true)
  expect(host.querySelector('.button__spinner')).toBeNull()
  expect(host.querySelector('button svg')?.getAttribute('class')).toContain('spinning')
  expect(host.textContent).toContain('Synchronization in progress')
  expect(host.textContent).not.toContain('Syncing data from Garmin')
  expect(host.textContent).not.toContain('Retrying selected stream')
  await act(async () => resolve(json({ ...initial.streams[0], status: 'completed' })))
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(host.textContent).toContain('Completed')
})

it('does not carry attempt history or completion announcements to another connection', async () => {
  const saved: IncrementalSyncSnapshot = {
    ...completedSnapshot(),
    connectionKey: 'first-owner-connection',
  }
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
    if (!options?.method) return json(saved)
    const { streamId } = JSON.parse(String(options.body)) as {
      streamId: IncrementalSyncResult['streamId']
    }
    return json({
      ...saved.streams.find((stream) => stream.streamId === streamId),
      status: streamId === 'activities' ? 'failed' : 'completed',
      reason: streamId === 'activities' ? 'SYNC_FAILED' : null,
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={saved} />))
  await act(async () => host.querySelector('button')!.click())
  expect(host.querySelector('.badge')?.textContent).toBe('Sync issue')
  const anotherOwner: IncrementalSyncSnapshot = {
    ...completedSnapshot(),
    connectionKey: 'another-owner-connection',
  }
  await act(async () =>
    root.render(<GarminSyncPanel initial={anotherOwner} asOfInstant={new Date().toISOString()} />),
  )
  expect(host.querySelector('.badge')?.textContent).toBe('Connected')
  expect(host.textContent?.match(/Up to date/g)).toHaveLength(3)
  expect(host.querySelector('[role="status"]')?.textContent).toBe('')
})

it('reports rate limits and remaining work without a success message', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
    if (!options?.method) return json(initial)
    const { streamId } = JSON.parse(String(options.body)) as {
      streamId: IncrementalSyncResult['streamId']
    }
    return json({
      ...initial.streams.find((s) => s.streamId === streamId),
      status: streamId === 'activities' ? 'skipped' : 'rate_limited',
      reason: streamId === 'activities' ? 'REQUEST_BUDGET' : 'BACKOFF',
      retryAt: streamId === 'activities' ? null : '2026-11-13T06:01:00Z',
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={initial} />))
  await act(async () => host.querySelector('button')!.click())
  expect(host.textContent).not.toContain('Progress saved')
  expect(host.querySelector('li:first-child details')).toBeNull()
  expect(host.querySelector('button[aria-label="Continue Activities"]')).toBeNull()
  expect(host.querySelector('button')?.disabled).toBe(true)
  expect(host.querySelector('.badge')?.textContent).toBe('Waiting')
  expect(host.textContent).not.toContain('All Garmin streams synchronized')
})

it('automatically continues Activities after a bounded pass without another click', async () => {
  vi.useFakeTimers()
  let persisted: IncrementalSyncSnapshot = initial
  let activityPasses = 0
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
    if (!options?.method) return json(persisted)
    const { streamId } = JSON.parse(String(options.body)) as {
      streamId: IncrementalSyncResult['streamId']
    }
    if (streamId === 'activities') activityPasses++
    const unfinished = streamId === 'activities' && activityPasses === 1
    const result: IncrementalSyncResult = {
      streamId,
      status: unfinished ? 'skipped' : 'completed',
      reason: unfinished ? 'REQUEST_BUDGET' : null,
      lastSuccessAt: unfinished ? null : new Date().toISOString(),
      retryAt: null,
    }
    persisted = {
      ...persisted,
      streams: persisted.streams.map((stream) => (stream.streamId === streamId ? result : stream)),
    }
    return json(result)
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={initial} />))
  await act(async () => host.querySelector('button')!.click())
  expect(host.querySelector('.badge')?.textContent).toBe('Waiting')
  expect(host.querySelector('.badge--error')).toBeNull()
  expect(host.querySelector('.badge--warning')).not.toBeNull()
  expect(host.textContent).not.toContain('Sync issue')
  expect(host.textContent).not.toContain('All Garmin streams synchronized')
  expect(host.textContent?.match(/Up to date/g)).toHaveLength(2)
  await act(async () => vi.advanceTimersByTimeAsync(1_000))
  expect(
    fetchMock.mock.calls
      .filter((call) => call[1]?.method === 'POST')
      .map((call) => JSON.parse(String(call[1]?.body)).streamId),
  ).toEqual(['activities', 'daily_summary', 'sleep', 'activities'])
  expect(host.querySelector('.badge')?.textContent).toBe('Connected')
  expect(host.textContent?.match(/Up to date/g)).toHaveLength(3)
  expect(host.textContent).toContain('All Garmin streams synchronized')
})

it('observes another page’s sync using status reads and enables the action once it ends', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.fn(async () => json(initial))
  vi.stubGlobal('fetch', fetchMock)
  await act(async () =>
    root.render(
      <GarminSyncPanel
        initial={{
          ...initial,
          streams: initial.streams.map((s) => ({ ...s, status: 'syncing', reason: 'BUSY' })),
        }}
      />,
    ),
  )
  expect(host.querySelector('button')?.disabled).toBe(true)
  await act(async () => vi.advanceTimersByTimeAsync(5_000))
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/integrations/garmin/incremental-sync',
    expect.objectContaining({ cache: 'no-store' }),
  )
  expect(host.querySelector('button')?.disabled).toBe(false)
  expect(refresh).toHaveBeenCalledOnce()
})

it('shows overall success only after every stream completes', async () => {
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
    if (!options?.method) return json(initial)
    const { streamId } = JSON.parse(String(options.body)) as {
      streamId: IncrementalSyncResult['streamId']
    }
    return json({
      ...initial.streams.find((s) => s.streamId === streamId),
      status: 'completed',
      lastSuccessAt: new Date().toISOString(),
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={initial} />))
  await act(async () => host.querySelector('button')!.click())
  expect(host.textContent).toContain('All Garmin streams synchronized')
})

it('does not turn a busy action into overall success when polling older successful stream states', async () => {
  vi.useFakeTimers()
  let reads = 0
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST')
      return json({ ...initial.streams[0], status: 'syncing', reason: 'BUSY' })
    reads++
    return json(
      reads === 1
        ? initial
        : {
            ...initial,
            streams: initial.streams.map((stream) => ({ ...stream, status: 'completed' })),
          },
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={initial} />))
  await act(async () => host.querySelector('button')!.click())
  await act(async () => vi.advanceTimersByTimeAsync(5_000))
  expect(host.querySelector('.badge')?.textContent).toBe('Waiting')
  expect(host.textContent).not.toContain('All Garmin streams synchronized')
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(2)
})

it('starts during an existing rate limit and completes automatically after its deadline', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-13T10:00:00Z'))
  const limited: IncrementalSyncSnapshot = {
    ...initial,
    streams: initial.streams.map((stream) => ({
      ...stream,
      status: 'rate_limited',
      reason: 'BACKOFF',
      retryAt: '2026-11-13T10:00:10Z',
    })),
  }
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
    if (!options?.method) return json(limited)
    const { streamId } = JSON.parse(String(options.body)) as {
      streamId: IncrementalSyncResult['streamId']
    }
    return json({
      ...initial.streams.find((stream) => stream.streamId === streamId),
      status: 'completed',
      lastSuccessAt: new Date().toISOString(),
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={limited} />))
  expect(host.querySelector('button')?.disabled).toBe(false)
  await act(async () => {
    host.querySelector('button')!.click()
    host.querySelector('button')!.click()
  })
  expect(host.querySelector('button')?.disabled).toBe(true)
  expect(host.querySelector('.badge')?.textContent).toBe('Waiting')
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0)
  await act(async () => vi.advanceTimersByTimeAsync(9_999))
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0)
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(host.textContent).toContain('All Garmin streams synchronized')
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(3)
  expect(refresh).toHaveBeenCalledOnce()
})

it('disarms automatic retries when the dashboard unmounts', async () => {
  vi.useFakeTimers()
  const retryAt = new Date(Date.now() + 60_000).toISOString()
  const limited: IncrementalSyncSnapshot = {
    ...initial,
    streams: initial.streams.map((stream) => ({
      ...stream,
      status: 'rate_limited',
      reason: 'BACKOFF',
      retryAt,
    })),
  }
  const fetchMock = vi.fn(async () => json(limited))
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<GarminSyncPanel initial={limited} />))
  await act(async () => host.querySelector('button')!.click())
  await act(async () => root.render(null))
  await act(async () => vi.advanceTimersByTimeAsync(300_000))
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(refresh).not.toHaveBeenCalled()
})
