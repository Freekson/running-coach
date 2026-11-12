// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GarminSyncState } from '@/lib/garmin-sync-state'
import { formatLocalDateTime } from '@/lib/local-time'
import { ActivitySyncPanel } from './activity-sync-panel'

const { refresh, notify } = vi.hoisted(() => ({ refresh: vi.fn(), notify: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => notify }))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
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
  refresh.mockClear()
  notify.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

it('directs a disconnected athlete to credential settings', async () => {
  await act(async () =>
    root.render(<ActivitySyncPanel initial={{ ...idle, status: 'NOT_CONNECTED' }} />),
  )
  expect(host.textContent).toContain('Connect Garmin')
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/app/settings')
  expect(host.textContent).not.toContain('Sync activities')
})

it('offers verification and import when a saved key lacks account identity', async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ...idle, status: 'SUCCESS', lastSuccessAt: '2026-11-09T06:00:00Z' }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  await act(async () =>
    root.render(
      <ActivitySyncPanel
        initial={{ ...idle, status: 'ACTION_REQUIRED', errorCode: 'ACCOUNT_VERIFICATION_REQUIRED' }}
      />,
    ),
  )
  expect(host.textContent).toContain('Verify & sync')
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(refresh).toHaveBeenCalledOnce()
  expect(host.textContent).toContain('Synced')
  expect(host.textContent).toContain(formatLocalDateTime('2026-11-09T06:00:00Z'))
  expect(host.textContent).not.toContain('2026-11-09 06:00 UTC')
})

it('resumes an activity checkpoint from Training and refreshes its status', async () => {
  const fetchMock = vi.fn(async (...args: unknown[]) => {
    void args
    return {
      ok: true,
      json: async () => ({ ...idle, status: 'SUCCESS', lastSuccessAt: '2026-11-09T06:00:00Z' }),
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () =>
    root.render(
      <ActivitySyncPanel initial={{ ...idle, status: 'PARTIAL', nextDate: '2026-08-22' }} />,
    ),
  )
  expect(host.textContent).toContain('Sync now')
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(fetchMock).toHaveBeenCalledWith('/api/integrations/garmin/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: '{}',
  })
  expect(refresh).toHaveBeenCalledOnce()
  expect(host.textContent).toContain('Synced')
  expect(notify).toHaveBeenCalledWith(
    'success',
    'Garmin activities are up to date.',
    'garmin-activity-sync',
  )
})

it('keeps the header action compact and does not offer a second history importer', async () => {
  await act(async () => root.render(<ActivitySyncPanel initial={{ ...idle, status: 'SUCCESS' }} />))
  expect(host.querySelector('button')?.textContent).toContain('Sync now')
  expect(host.textContent).not.toContain('Import 7 older days')
  expect(host.querySelectorAll('button')).toHaveLength(1)
})

it('polls a paused RUN-26 state until the activity button is available', async () => {
  vi.useFakeTimers()
  try {
    const paused: GarminSyncState = {
      ...idle,
      status: 'PAUSED',
      nextAttemptAt: new Date(Date.now() + 5_000).toISOString(),
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => paused })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...idle, status: 'PARTIAL' }) })
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => root.render(<ActivitySyncPanel initial={paused} />))
    expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(6_000))
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(refresh).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(6_000))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
    expect(refresh).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it.each(['SUCCESS', 'PARTIAL', 'PARTIAL_FAILURE', 'PAUSED'] as const)(
  'refreshes saved history once when a running batch becomes %s',
  async (status) => {
    vi.useFakeTimers()
    try {
      const syncing: GarminSyncState = { ...idle, status: 'SYNCING' }
      const settled: GarminSyncState = {
        ...idle,
        status,
        lastSuccessAt: status === 'SUCCESS' ? '2026-11-12T00:00:00Z' : null,
        nextAttemptAt: status === 'PAUSED' ? new Date(Date.now() + 120_000).toISOString() : null,
      }
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => syncing })
        .mockResolvedValueOnce({ ok: true, json: async () => settled })
      vi.stubGlobal('fetch', fetchMock)
      await act(async () => root.render(<ActivitySyncPanel initial={syncing} />))
      await act(async () => vi.advanceTimersByTimeAsync(5_000))
      expect(refresh).not.toHaveBeenCalled()
      await act(async () => vi.advanceTimersByTimeAsync(5_000))
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(refresh).toHaveBeenCalledOnce()
      if (status === 'SUCCESS') expect(host.textContent).toContain('Synced')
      if (status !== 'PAUSED') {
        await act(async () => vi.advanceTimersByTimeAsync(60_000))
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(refresh).toHaveBeenCalledOnce()
      }
    } finally {
      vi.useRealTimers()
    }
  },
)

it('marks old saved history stale while disconnected without fetching the provider', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  await act(async () =>
    root.render(
      <ActivitySyncPanel
        initial={{ ...idle, status: 'NOT_CONNECTED' }}
        savedAt="2000-01-01T00:00:00Z"
      />,
    ),
  )
  expect(host.textContent).toContain('Garmin disconnected')
  expect(host.textContent).toContain('Saved history may be out of date')
  expect(fetchMock).not.toHaveBeenCalled()
})
