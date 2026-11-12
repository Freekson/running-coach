// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GarminImportStreamState } from '@/lib/garmin-import-state'
import { GarminDataImport } from './garmin-data-import'

vi.mock('@/components/ui/Toast', () => ({ useToast: () => vi.fn() }))
let host: HTMLDivElement
let root: Root
const base: GarminImportStreamState = {
  streamId: 'activities',
  status: 'not_started',
  startDate: null,
  endDate: null,
  nextDate: null,
  lastCheckedDate: null,
  checkedDays: 0,
  totalDays: null,
  failedDateCount: 0,
  retryAfter: null,
  lastSyncAt: null,
  errorCode: null,
  generation: null,
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('refreshes an import reloaded during a lease and offers Resume after the server pauses', async () => {
  vi.useFakeTimers()
  const running: GarminImportStreamState = {
    ...base,
    status: 'running',
    nextDate: '2026-11-11',
    generation: 1,
  }
  const paused = { ...running, status: 'paused' as const, pagesFetched: 2 }
  const network = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([paused]))
    .mockResolvedValueOnce(Response.json([{ ...paused, status: 'completed', nextDate: null }]))
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[running]} />))
  expect(host.querySelector<HTMLInputElement>('[aria-label="Select Activities"]')!.disabled).toBe(
    true,
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(network.mock.calls[0][1]).toMatchObject({
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
  })
  expect(button('Resume import').disabled).toBe(false)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000)
  })
  expect(network).toHaveBeenCalledTimes(1)
  await act(async () => button('Resume import').click())
  expect(JSON.parse(String(network.mock.calls[1][1]?.body))).toMatchObject({
    streamId: 'activities',
    action: 'resume',
  })
  expect(host.textContent).toContain('Summary complete')
})

it('refreshes a recent sync started elsewhere and enables Sync now when it pauses', async () => {
  vi.useFakeTimers()
  const initial: GarminImportStreamState = {
    ...base,
    status: 'completed',
    recentSync: { ...base, status: 'running', nextDate: '2026-11-12', generation: 1 },
  }
  const network = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json([{ ...initial, recentSync: { ...initial.recentSync, status: 'paused' } }]),
    )
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[initial]} />))
  expect(button('Sync now').disabled).toBe(true)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(button('Sync now').disabled).toBe(false)
  expect(network).toHaveBeenCalledTimes(1)
})

it('ignores a stale progress read after a local import starts', async () => {
  vi.useFakeTimers()
  const initial: GarminImportStreamState[] = [
    { ...base, streamId: 'sleep', status: 'running' },
    base,
  ]
  let finishRead: ((response: Response) => void) | undefined
  const completed: GarminImportStreamState = { ...base, status: 'completed', activityCount: 62 }
  const network = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishRead = resolve
        }),
    )
    .mockResolvedValueOnce(Response.json([initial[0], completed]))
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={initial} />))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  const signal = network.mock.calls[0][1]?.signal
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="Select Activities"]')!.click(),
  )
  await act(async () => button('Import selected').click())
  expect(signal?.aborted).toBe(true)
  await act(async () => {
    finishRead?.(Response.json(initial))
  })
  expect(host.textContent).toContain('62 summaries imported')
  expect(host.querySelector<HTMLInputElement>('[aria-label="Select Activities"]')!.checked).toBe(
    true,
  )
})

it('aborts a progress read and stops polling when Settings unmounts', async () => {
  vi.useFakeTimers()
  const network = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}))
  vi.stubGlobal('fetch', network)
  await act(async () =>
    root.render(<GarminDataImport initial={[{ ...base, status: 'running' }]} />),
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  const signal = network.mock.calls[0][1]?.signal
  await act(async () => root.unmount())
  expect(signal?.aborted).toBe(true)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000)
  })
  expect(network).toHaveBeenCalledTimes(1)
  root = createRoot(host)
})

it('allows Resume after a temporary bearer rejection without restarting history or replacing the key', async () => {
  const paused: GarminImportStreamState = {
    ...base,
    status: 'paused',
    errorCode: 'TOKEN_REJECTED',
    nextDate: '2026-11-11',
    generation: 3,
    activityCount: 40,
  }
  const network = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json([{ ...paused, status: 'completed', nextDate: null, errorCode: null }]),
    )
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[paused]} />))
  expect(host.textContent).toContain('temporary access token')
  expect(host.textContent).not.toContain('Replace it to continue.')
  expect(button('Retry summaries').disabled).toBe(false)
  await act(async () => button('Resume import').click())
  expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toMatchObject({ action: 'resume' })
  expect(host.textContent).toContain('40 summaries imported')
})

it('automatically retries a bearer rejection after backoff with the same history checkpoint', async () => {
  vi.useFakeTimers()
  const waiting: GarminImportStreamState = {
    ...base,
    status: 'waiting_retry',
    errorCode: 'TOKEN_REJECTED',
    nextDate: '2026-11-11',
    generation: 1,
    pagesFetched: 0,
    retryAfter: new Date(Date.now() + 60000).toISOString(),
  }
  const network = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([waiting]))
    .mockResolvedValueOnce(
      Response.json([
        { ...waiting, status: 'completed', nextDate: null, errorCode: null, retryAfter: null },
      ]),
    )
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[base]} />))
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="Select Activities"]')!.click(),
  )
  await act(async () => button('Import selected').click())
  expect(network).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000)
  })
  expect(network.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).action)).toEqual([
    'import',
    'resume',
  ])
  expect(host.textContent).toContain('Summary complete')
})
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(text),
  )
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}

it('keeps completed streams checked and disabled without selecting them for import', async () => {
  const initial: GarminImportStreamState[] = [
    { ...base, streamId: 'daily_summary', status: 'completed' },
    { ...base, streamId: 'sleep', status: 'completed' },
    base,
  ]
  const network = vi.fn<typeof fetch>().mockResolvedValue(Response.json(initial))
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={initial} />))
  for (const name of ['Daily summaries', 'Sleep']) {
    const checkbox = host.querySelector<HTMLInputElement>(`[aria-label="Select ${name}"]`)!
    expect(checkbox.checked).toBe(true)
    expect(checkbox.disabled).toBe(true)
    await act(async () => checkbox.click())
    expect(checkbox.checked).toBe(true)
  }
  expect(button('Import selected').disabled).toBe(true)
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="Select Activities"]')!.click(),
  )
  await act(async () => button('Import selected').click())
  expect(network).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toMatchObject({
    streamId: 'activities',
    action: 'import',
  })
})

it('imports only selected summaries, continues when a page advances within the same date, and keeps laps inert', async () => {
  const inProgress = {
    ...base,
    status: 'paused' as const,
    startDate: '2023-11-12',
    endDate: '2026-11-11',
    nextDate: '2026-11-11',
    totalDays: 1096,
    pagesFetched: 1,
    activityCount: 20,
    generation: 1,
  }
  const completed = {
    ...inProgress,
    status: 'completed' as const,
    nextDate: null,
    pagesFetched: 3,
    activityCount: 62,
    checkedDays: 1096,
  }
  const network = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([inProgress]))
    .mockResolvedValueOnce(Response.json([{ ...inProgress, pagesFetched: 2, activityCount: 40 }]))
    .mockResolvedValueOnce(Response.json([completed]))
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[base]} />))
  expect(host.textContent).toContain('Normalized laps')
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="Select Activities"]')!.click(),
  )
  await act(async () => button('Import selected').click())
  expect(network).toHaveBeenCalledTimes(3)
  expect(network.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { streamId: 'activities', action: 'import', browserTimezone: expect.any(String) },
    { streamId: 'activities', action: 'resume', browserTimezone: expect.any(String) },
    { streamId: 'activities', action: 'resume', browserTimezone: expect.any(String) },
  ])
  expect(host.textContent).toContain('Summary complete · Laps pending')
  expect(host.textContent).toContain('62 summaries imported')
  expect(host.querySelector<HTMLInputElement>('[aria-label="Select Activities"]')!.checked).toBe(
    true,
  )
  expect(host.querySelector<HTMLInputElement>('[aria-label="Select Activities"]')!.disabled).toBe(
    true,
  )
  const laps = host.querySelector('[aria-labelledby="activity-laps-stage"]')!
  expect(laps.textContent).toContain('Not started')
  expect(laps.querySelector('button, input, progress')).toBeNull()
})

it('restores durable progress after reload and reimports only Activities', async () => {
  const completed = {
    ...base,
    status: 'completed' as const,
    startDate: '2023-11-12',
    endDate: '2026-11-11',
    checkedDays: 1096,
    totalDays: 1096,
    activityCount: 62,
    pagesFetched: 80,
    generation: 1,
  }
  const network = vi.fn<typeof fetch>().mockResolvedValue(Response.json([completed]))
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[completed]} />))
  expect(host.textContent).toContain('62 summaries imported')
  expect(host.textContent).toContain('80 pages checked')
  expect(network).not.toHaveBeenCalled()
  await act(async () => button('Reimport Activities').click())
  expect(network).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toMatchObject({
    streamId: 'activities',
    action: 'reimport',
  })
})

it('uses the separate recent checkpoint for Sync now without restarting history', async () => {
  const completed = {
    ...base,
    status: 'completed' as const,
    startDate: '2023-11-12',
    endDate: '2026-11-11',
    activityCount: 62,
    generation: 1,
  }
  const recent = {
    ...base,
    status: 'paused' as const,
    nextDate: '2026-11-12',
    startDate: '2026-11-05',
    endDate: '2026-11-12',
    pagesFetched: 1,
  }
  const network = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([{ ...completed, recentSync: recent }]))
    .mockResolvedValueOnce(
      Response.json([
        {
          ...completed,
          recentSync: { ...recent, status: 'completed', nextDate: null, pagesFetched: 2 },
        },
      ]),
    )
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[completed]} />))
  await act(async () => button('Sync now').click())
  expect(network.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).action)).toEqual([
    'sync',
    'sync',
  ])
  expect(host.textContent).toContain('62 summaries imported')
  expect(host.textContent).toContain('Recent sync: Completed')
})
