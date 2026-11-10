// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GarminSyncState } from '@/lib/garmin-sync-state'
import { formatLocalDateTime } from '@/lib/local-time'
import { HealthSyncDetails, HealthSyncPanel } from './HealthSyncPanel'
import styles from './health-sync-panel.module.scss'

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

it('waits for the browser timezone instead of showing a UTC time on the server', () => {
  const markup = renderToStaticMarkup(
    <HealthSyncPanel
      initial={{ ...idle, status: 'SUCCESS', lastSuccessAt: '2026-11-09T13:48:00Z' }}
    />,
  )
  expect(markup).toContain('Synced · Loading local time')
  expect(markup).not.toContain('13:48 UTC')
})

it('shows setup guidance without exposing a sync action when disconnected', async () => {
  await act(async () =>
    root.render(<HealthSyncPanel initial={{ ...idle, status: 'NOT_CONNECTED' }} />),
  )
  expect(host.textContent).toContain('Connect Garmin')
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/app/settings')
  expect(host.textContent).not.toContain('Sync now')
})

it('offers one verified first sync for a saved key without account identity', async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ...idle, status: 'SUCCESS', lastSuccessAt: '2026-11-09T09:27:00Z' }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  await act(async () =>
    root.render(
      <HealthSyncPanel
        initial={{ ...idle, status: 'ACTION_REQUIRED', errorCode: 'ACCOUNT_VERIFICATION_REQUIRED' }}
      />,
    ),
  )
  expect(host.textContent).toContain('Verify your saved Garmin key')
  expect(host.textContent).toContain('Verify & sync')
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(refresh).toHaveBeenCalledOnce()
  expect(host.textContent).toContain('Synced')
})

it('keeps the saved-key verification action available after an unverifiable response', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({ code: 'UNVERIFIABLE' }),
    })),
  )
  await act(async () =>
    root.render(
      <HealthSyncPanel
        initial={{ ...idle, status: 'ACTION_REQUIRED', errorCode: 'ACCOUNT_VERIFICATION_REQUIRED' }}
      />,
    ),
  )
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Garmin account identity could not be verified',
  )
  expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
})

it('places sync controls in the header and details after the charts without extra requests', async () => {
  const fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  await act(async () =>
    root.render(
      <>
        <HealthSyncPanel
          initial={{ ...idle, status: 'SUCCESS', lastSuccessAt: '2026-11-09T09:27:00Z' }}
          hideDetails
        />
        <HealthSyncDetails
          state={{ ...idle, status: 'SUCCESS', lastSuccessAt: '2026-11-09T09:27:00Z' }}
        />
      </>,
    ),
  )
  expect(host.querySelectorAll('details')).toHaveLength(1)
  expect(host.textContent).toContain('Synced')
  expect(host.textContent).toContain('Garmin sync details')
  expect(host.textContent).toContain(formatLocalDateTime('2026-11-09T09:27:00Z'))
  expect(host.querySelector('details summary')?.textContent).toContain('Last completed')
  expect(host.querySelectorAll(`details .${styles.detailCard}`)).toHaveLength(3)
  expect(host.textContent).toContain('Refresh window')
  expect(host.textContent).not.toContain('2026-11-09 09:27 UTC')
  expect(host.textContent).not.toMatch(/GMT[+-]\d+/)
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('shows the verified sync window and the last request in separate cards', async () => {
  await act(async () =>
    root.render(
      <HealthSyncDetails
        state={{
          ...idle,
          status: 'PARTIAL',
          window: { start: '2026-10-11', end: '2026-11-09' },
          processed: 10,
        }}
      />,
    ),
  )
  const cards = host.querySelectorAll(`.${styles.detailCard}`)
  expect(cards).toHaveLength(3)
  expect(cards[0].textContent).toContain('10 dates')
  expect(cards[1].textContent).toContain('Oct 11 – Nov 9')
  expect(cards[1].textContent).toContain('2026')
  expect(cards[2].textContent).toContain('7 days')
  expect(host.querySelector('summary')?.textContent).toContain('Last completed not yet')
})

it('shows recent owned sync attempts and API error codes in the diagnostic log', async () => {
  await act(async () =>
    root.render(
      <HealthSyncDetails
        state={{
          ...idle,
          status: 'PAUSED',
          errorCode: 'SLEEP_HTTP_503',
          nextAttemptAt: '2026-11-09T08:15:00Z',
          recentRuns: [
            {
              kind: 'SYNC',
              status: 'FAILED',
              startedAt: '2026-11-09T08:00:00Z',
              finishedAt: '2026-11-09T08:00:10Z',
              datesProcessed: 3,
              errorCode: 'SLEEP_HTTP_503',
              retryAt: null,
              recoveredApiErrors: ['SLEEP_HTTP_503'],
            },
            {
              kind: 'SYNC',
              status: 'SUCCEEDED',
              startedAt: '2026-11-09T07:00:00Z',
              finishedAt: '2026-11-09T07:00:10Z',
              datesProcessed: 10,
              errorCode: null,
              retryAt: null,
              recoveredApiErrors: ['SLEEP_HTTP_503'],
            },
          ],
        }}
      />,
    ),
  )
  const log = host.querySelector<HTMLElement>(
    '[aria-labelledby="garmin-sync-diagnostics-heading"]',
  )!
  expect(log.textContent).toContain('Diagnostic log')
  expect(log.textContent).toContain('Last error codeSLEEP_HTTP_503')
  expect(log.textContent).toContain(formatLocalDateTime('2026-11-09T08:15:00Z'))
  expect(log.querySelectorAll('ol li')).toHaveLength(2)
  expect(log.textContent).toContain('3 dates processed · Sleep API HTTP 503')
  expect(log.textContent).toContain('Error code: SLEEP_HTTP_503')
  expect(log.textContent).toContain('10 dates processed')
  expect(log.textContent).toContain('Sleep range API error')
  expect(log.textContent).toContain('Recovered Sleep API error · HTTP 503: SLEEP_HTTP_503')
  expect(log.textContent).not.toMatch(/GMT[+-]\d+/)
})

it('shows a rejected pre-sync verification request without claiming dates were processed', async () => {
  await act(async () =>
    root.render(
      <HealthSyncDetails
        state={{
          ...idle,
          status: 'ACTION_REQUIRED',
          errorCode: 'ACCOUNT_VERIFICATION_REQUIRED',
          recentRuns: [
            {
              kind: 'REQUEST',
              status: 'FAILED',
              startedAt: '2026-11-09T08:00:00Z',
              finishedAt: '2026-11-09T08:00:00Z',
              datesProcessed: 0,
              errorCode: 'UNVERIFIABLE',
              retryAt: '2026-11-09T08:01:00Z',
              recoveredApiErrors: [],
            },
          ],
        }}
      />,
    ),
  )
  const log = host.querySelector<HTMLElement>(
    '[aria-labelledby="garmin-sync-diagnostics-heading"]',
  )!
  expect(log.textContent).toContain('Request rejected')
  expect(log.textContent).toContain('Last error codeUNVERIFIABLE')
  expect(log.textContent).toContain(`Retry after ${formatLocalDateTime('2026-11-09T08:01:00Z')}`)
  expect(log.textContent).not.toContain('0 dates processed')
})

it('keeps saved failure progress available without repeating the error inline', async () => {
  await act(async () =>
    root.render(
      <HealthSyncPanel initial={{ ...idle, status: 'PARTIAL_FAILURE', nextDate: '2026-11-05' }} />,
    ),
  )
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.textContent).toContain('Next date for daily summaries: 2026-11-05')
  expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
})

it('keeps per-date sleep progress without repeating the warning inline', async () => {
  const incomplete = {
    ...idle,
    status: 'PARTIAL' as const,
    nextDate: '2026-10-21',
    sleepRetryDates: ['2026-10-20'],
    sleepFailedDates: ['2026-10-20'],
  }
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => incomplete }))
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<HealthSyncPanel initial={incomplete} />))
  expect(host.textContent).toContain('Partial Garmin health data saved')
  expect(host.textContent).not.toContain('Some Garmin sleep dates could not be verified')
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(notify).toHaveBeenCalledWith(
    'warning',
    expect.stringContaining('Other dates were saved'),
    'garmin-health-sync',
  )
})

it('blocks a duplicate click while another health sync holds the lease', async () => {
  await act(async () => root.render(<HealthSyncPanel initial={{ ...idle, status: 'SYNCING' }} />))
  expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
  expect(host.textContent).toContain('already running')
})

it('automatically continues bounded initial chunks and refreshes the Neon view', async () => {
  const states = [
    { ...idle, status: 'PARTIAL', nextDate: '2026-10-21' },
    { ...idle, status: 'PARTIAL', nextDate: '2026-10-31' },
    { ...idle, status: 'SUCCESS', nextDate: null, lastSuccessAt: '2026-11-09T01:00:00Z' },
  ]
  const fetchMock = vi.fn(async (...args: unknown[]) => {
    void args
    return { ok: true, json: async () => states.shift() }
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<HealthSyncPanel initial={idle} />))
  expect(host.querySelector('input')).toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(refresh).toHaveBeenCalledTimes(3)
  expect(notify).toHaveBeenCalledWith('success', 'Health data is up to date.', 'garmin-health-sync')
  expect(fetchMock.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    body: JSON.stringify({
      browserTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    }),
  })
})

it('explains the application request limit and its retry time', async () => {
  let release!: (response: {
    ok: false
    status: number
    json: () => Promise<{ code: string; retryAt: string }>
  }) => void
  const fetchMock = vi.fn(
    () =>
      new Promise<{
        ok: false
        status: number
        json: () => Promise<{ code: string; retryAt: string }>
      }>((resolve) => (release = resolve)),
  )
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<HealthSyncPanel initial={idle} />))
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  const button = host.querySelector<HTMLButtonElement>('button')!
  expect(button.disabled).toBe(true)
  expect(button.closest('[aria-busy]')?.getAttribute('aria-busy')).toBe('true')
  expect(button.querySelector('svg')?.classList.contains(styles.spinning)).toBe(true)
  expect(button.querySelectorAll('.button__spinner')).toHaveLength(0)
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(0)
  await act(async () =>
    release({
      ok: false,
      status: 429,
      json: async () => ({ code: 'APP_RATE_LIMITED', retryAt: '2026-11-09T06:01:00Z' }),
    }),
  )
  expect(host.querySelector('[role="status"]')).toBeNull()
  expect(notify).toHaveBeenCalledWith(
    'warning',
    expect.stringContaining('Too many Garmin sync requests'),
    'garmin-health-sync',
  )
  expect(refresh).toHaveBeenCalledOnce()
  expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
})

it('does not repeat paused failure reasons inline', async () => {
  await act(async () =>
    root.render(
      <HealthSyncPanel
        initial={{
          ...idle,
          status: 'PAUSED',
          errorCode: 'RATE_LIMITED',
          nextAttemptAt: '2026-11-09T06:05:00Z',
        }}
      />,
    ),
  )
  expect(host.textContent).not.toContain('Garmin asked us to pause')
  await act(async () =>
    root.render(
      <HealthSyncPanel
        initial={{
          ...idle,
          status: 'PAUSED',
          errorCode: 'UNAVAILABLE',
          nextAttemptAt: '2026-11-09T06:05:00Z',
        }}
      />,
    ),
  )
  expect(host.textContent).not.toContain('Saved readings remain available')
})

it('shows saved summary progress without a duplicate sleep timeout message', async () => {
  await act(async () =>
    root.render(
      <HealthSyncPanel
        initial={{
          ...idle,
          status: 'PAUSED',
          window: { start: '2026-11-03', end: '2026-11-09' },
          nextDate: '2026-11-08',
          sleepRetryDates: ['2026-11-07'],
          processed: 1,
          errorCode: 'SLEEP_TIMEOUT',
          nextAttemptAt: '2026-11-09T08:15:00Z',
        }}
      />,
    ),
  )
  expect(host.textContent).not.toContain('Garmin sleep did not respond')
  expect(host.textContent).toContain('Sleep dates still to check: 1 date')
  expect(host.textContent).toContain('Next date for daily summaries: 2026-11-08')
  expect(host.textContent).toContain('1 date')
  expect(host.textContent).not.toContain('Retry after')
})
