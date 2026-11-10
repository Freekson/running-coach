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
  expect(host.textContent).toContain('Connect Garmin to import activities')
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
  expect(host.textContent).toContain('Verify & import')
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(refresh).toHaveBeenCalledOnce()
  expect(host.textContent).toContain('Last completed window')
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
  expect(host.textContent).toContain('Next day to check: 2026-08-22')
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(fetchMock).toHaveBeenCalledWith('/api/integrations/garmin/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: '{}',
  })
  expect(refresh).toHaveBeenCalledOnce()
  expect(host.textContent).toContain('Last completed window')
  expect(notify).toHaveBeenCalledWith(
    'success',
    'Garmin activities are up to date.',
    'garmin-activity-sync',
  )
})

it('keeps the explicit older import action on Training', async () => {
  const fetchMock = vi.fn(async (...args: unknown[]) => {
    void args
    return { ok: true, json: async () => ({ ...idle, status: 'PARTIAL', nextDate: '2026-10-27' }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<ActivitySyncPanel initial={{ ...idle, status: 'SUCCESS' }} />))
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Import 7 older days')!
      .click(),
  )
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ body: JSON.stringify({ extendDays: 7 }) })
  expect(host.textContent).toContain('Next day to check: 2026-10-27')
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
    await act(async () => vi.advanceTimersByTimeAsync(6_000))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})
