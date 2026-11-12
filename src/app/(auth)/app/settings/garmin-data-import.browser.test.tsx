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

it('shows read-only progress for a recent sync started elsewhere', async () => {
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
  expect(host.textContent).toContain('Recent sync: Importing')
  expect(host.textContent).not.toContain('Sync now')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(host.textContent).toContain('Recent sync: Paused / needs attention')
  expect(host.textContent).not.toContain('Sync now')
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

it('imports only selected summaries and continues when a page advances within the same date', async () => {
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
    {
      streamId: 'activities',
      action: 'import',
      stage: 'summaries',
      browserTimezone: expect.any(String),
    },
    {
      streamId: 'activities',
      action: 'resume',
      stage: 'summaries',
      browserTimezone: expect.any(String),
    },
    {
      streamId: 'activities',
      action: 'resume',
      stage: 'summaries',
      browserTimezone: expect.any(String),
    },
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
  expect(host.textContent).not.toContain('Sync now')
  expect(network).not.toHaveBeenCalled()
  await act(async () => button('Reimport Activities').click())
  expect(network).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toMatchObject({
    streamId: 'activities',
    action: 'reimport',
  })
})

const lapBase: NonNullable<GarminImportStreamState['laps']> = {
  status: 'not_started',
  eligible: 4,
  processed: 0,
  complete: 0,
  pending: 4,
  failed: 0,
  unavailable: 0,
  retryable: 0,
  totalLaps: 0,
  retryAfter: null,
  lastSyncAt: null,
  errorCode: null,
}
function withLaps(laps: NonNullable<GarminImportStreamState['laps']>): GarminImportStreamState {
  return {
    ...base,
    summaryStatus: 'completed',
    summaryErrorCode: null,
    summaryRetryAfter: null,
    retryAfter: laps.retryAfter,
    errorCode: laps.errorCode,
    status: laps.status === 'not_started' ? 'paused' : laps.status,
    startDate: '2023-11-12',
    endDate: '2026-11-11',
    totalDays: 1096,
    checkedDays: 1096,
    activityCount: 4,
    pagesFetched: 4,
    generation: 1,
    laps,
  }
}

it('automatically starts laps after summaries and continues bounded lap batches until both stages complete', async () => {
  const network = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([withLaps(lapBase)]))
    .mockResolvedValueOnce(
      Response.json([
        withLaps({
          ...lapBase,
          status: 'paused',
          pending: 2,
          complete: 2,
          processed: 2,
          totalLaps: 8,
        }),
      ]),
    )
    .mockResolvedValueOnce(
      Response.json([
        withLaps({
          ...lapBase,
          status: 'completed',
          pending: 0,
          complete: 4,
          processed: 4,
          totalLaps: 16,
        }),
      ]),
    )
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[base]} />))
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="Select Activities"]')!.click(),
  )
  await act(async () => button('Import selected').click())
  expect(network.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    {
      streamId: 'activities',
      stage: 'summaries',
      action: 'import',
      browserTimezone: expect.any(String),
    },
    {
      streamId: 'activities',
      stage: 'laps',
      action: 'import',
      browserTimezone: expect.any(String),
    },
    {
      streamId: 'activities',
      stage: 'laps',
      action: 'resume',
      browserTimezone: expect.any(String),
    },
  ])
  expect(host.textContent).toContain('4 of 4 activities processed')
  expect(host.textContent).toContain('16 laps saved')
  expect(host.querySelector('[aria-labelledby="activity-summary-stage"]')?.textContent).toContain(
    'Completed',
  )
  expect(host.querySelector('[aria-labelledby="activity-laps-stage"]')?.textContent).toContain(
    'Completed',
  )
  const checkbox = host.querySelector<HTMLInputElement>('[aria-label="Select Activities"]')!
  expect(checkbox.checked).toBe(true)
  expect(checkbox.disabled).toBe(true)
  expect(
    [...host.querySelectorAll('button')].some((item) =>
      item.textContent?.includes('Retry failed FITs'),
    ),
  ).toBe(false)
})

it('resumes only pending laps from durable progress without re-running completed summaries', async () => {
  const initial = withLaps({ ...lapBase, status: 'paused', complete: 2, processed: 2, pending: 2 })
  const network = vi.fn<typeof fetch>().mockResolvedValueOnce(
    Response.json([
      withLaps({
        ...lapBase,
        status: 'completed',
        complete: 4,
        processed: 4,
        pending: 0,
      }),
    ]),
  )
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[initial]} />))
  expect(host.querySelector('[aria-labelledby="activity-summary-stage"]')?.textContent).toContain(
    'Completed',
  )
  expect(host.textContent).toContain('2 of 4 activities processed')
  expect(network).not.toHaveBeenCalled()
  await act(async () => button('Resume laps').click())
  expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toMatchObject({
    streamId: 'activities',
    stage: 'laps',
    action: 'resume',
  })
  expect(network).toHaveBeenCalledTimes(1)
})

it('offers only targeted retries for failed FITs and stops after attempting each due failure once', async () => {
  const failed = withLaps({
    ...lapBase,
    status: 'paused',
    failed: 4,
    processed: 4,
    pending: 0,
    retryable: 4,
  })
  const network = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([withLaps({ ...failed.laps!, retryable: 2 })]))
    .mockResolvedValueOnce(
      Response.json([
        withLaps({
          ...failed.laps!,
          retryable: 0,
          status: 'waiting_retry',
          retryAfter: new Date(Date.now() + 60_000).toISOString(),
        }),
      ]),
    )
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[failed]} />))
  expect(
    [...host.querySelectorAll('button')].some((item) => item.textContent === 'Resume laps'),
  ).toBe(false)
  await act(async () => button('Retry failed FITs (4)').click())
  expect(network).toHaveBeenCalledTimes(2)
  for (const [, init] of network.mock.calls)
    expect(JSON.parse(String(init?.body))).toMatchObject({ stage: 'laps', action: 'retry' })
})

it.each(['RATE_LIMITED', 'TOKEN_REJECTED'] as const)(
  'continues the last failed FIT retry after %s backoff instead of treating it as finished',
  async (errorCode) => {
    vi.useFakeTimers()
    const failed = withLaps({
      ...lapBase,
      status: 'paused',
      eligible: 1,
      pending: 0,
      failed: 1,
      processed: 1,
      retryable: 1,
    })
    const paused = withLaps({
      ...failed.laps!,
      status: 'waiting_retry',
      retryable: 0,
      errorCode,
      retryAfter: new Date(Date.now() + 60_000).toISOString(),
    })
    const completed = withLaps({
      ...failed.laps!,
      status: 'completed',
      complete: 1,
      failed: 0,
      retryable: 0,
      totalLaps: 4,
    })
    const network = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([paused]))
      .mockResolvedValueOnce(Response.json([completed]))
    vi.stubGlobal('fetch', network)
    await act(async () => root.render(<GarminDataImport initial={[failed]} />))
    await act(async () => button('Retry failed FITs (1)').click())
    expect(network).toHaveBeenCalledTimes(1)
    expect(button('Stop import').disabled).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000)
    })
    expect(network).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(network).toHaveBeenCalledTimes(2)
    for (const [, init] of network.mock.calls)
      expect(JSON.parse(String(init?.body))).toMatchObject({
        streamId: 'activities',
        stage: 'laps',
        action: 'retry',
      })
    expect(host.textContent).toContain('4 laps saved')
    expect(
      [...host.querySelectorAll('button')].some((node) => node.textContent === 'Stop import'),
    ).toBe(false)
    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Activities"]')!.checked).toBe(
      true,
    )
  },
)

it('allows stopping a failed FIT retry while it waits for provider backoff', async () => {
  vi.useFakeTimers()
  const failed = withLaps({
    ...lapBase,
    status: 'paused',
    eligible: 1,
    pending: 0,
    failed: 1,
    processed: 1,
    retryable: 1,
  })
  const network = vi.fn<typeof fetch>().mockResolvedValueOnce(
    Response.json([
      withLaps({
        ...failed.laps!,
        status: 'waiting_retry',
        retryable: 0,
        errorCode: 'RATE_LIMITED',
        retryAfter: new Date(Date.now() + 60_000).toISOString(),
      }),
    ]),
  )
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[failed]} />))
  await act(async () => button('Retry failed FITs (1)').click())
  await act(async () => button('Stop import').click())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000)
  })
  expect(network).toHaveBeenCalledTimes(1)
})

it('shows completed warnings with a checked disabled checkbox when only terminal missing FITs remain', async () => {
  const state = withLaps({
    ...lapBase,
    status: 'completed_with_warnings',
    pending: 0,
    complete: 3,
    unavailable: 1,
    processed: 4,
    totalLaps: 12,
  })
  await act(async () => root.render(<GarminDataImport initial={[state]} />))
  const checkbox = host.querySelector<HTMLInputElement>('[aria-label="Select Activities"]')!
  expect(checkbox.checked).toBe(true)
  expect(checkbox.disabled).toBe(true)
  expect(host.textContent).toContain('Completed with warnings')
  expect(
    [...host.querySelectorAll('button')].some((item) =>
      /Resume|Retry failed FITs/.test(item.textContent ?? ''),
    ),
  ).toBe(false)
})

it('polls a running lap stage after reload while keeping completed summaries visually complete', async () => {
  vi.useFakeTimers()
  const running = withLaps({ ...lapBase, status: 'running', processed: 1, complete: 1, pending: 3 })
  const network = vi.fn<typeof fetch>().mockResolvedValueOnce(
    Response.json([
      withLaps({
        ...lapBase,
        status: 'paused',
        processed: 2,
        complete: 2,
        pending: 2,
      }),
    ]),
  )
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[running]} />))
  expect(host.querySelector('[aria-labelledby="activity-summary-stage"]')?.textContent).toContain(
    'Completed',
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(network.mock.calls[0][1]?.method).toBe('GET')
  expect(host.textContent).toContain('2 of 4 activities processed')
  expect(button('Resume laps').disabled).toBe(false)
})

it('allows summary reimport during a FIT-only cooldown while keeping failed FIT retries disabled', async () => {
  const state = withLaps({
    ...lapBase,
    status: 'waiting_retry',
    processed: 4,
    pending: 0,
    complete: 3,
    failed: 1,
    retryable: 0,
    retryAfter: new Date(Date.now() + 3_600_000).toISOString(),
  })
  const network = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([state]))
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[state]} />))
  expect(button('Retry failed FITs (1)').disabled).toBe(true)
  expect(button('Reimport Activities').disabled).toBe(false)
  await act(async () => button('Reimport Activities').click())
  expect(network).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toMatchObject({
    streamId: 'activities',
    stage: 'summaries',
    action: 'reimport',
  })
  expect(button('Retry failed FITs (1)').disabled).toBe(true)
})

it('keeps reimport disabled during its own cooldown', async () => {
  const state = {
    ...withLaps({
      ...lapBase,
      status: 'waiting_retry',
      processed: 4,
      pending: 0,
      complete: 3,
      failed: 1,
      retryable: 0,
      retryAfter: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    summaryRetryAfter: new Date(Date.now() + 60_000).toISOString(),
  }
  const network = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[state]} />))
  expect(button('Reimport Activities').disabled).toBe(true)
  await act(async () => button('Reimport Activities').click())
  expect(network).not.toHaveBeenCalled()
  expect(button('Reimport Activities').getAttribute('aria-describedby')).toBe(
    'garmin-activities-reimport-retry-time',
  )
})

it('keeps summary reimport disabled by a shared Garmin pause from another stream', async () => {
  const state = withLaps({
    ...lapBase,
    status: 'waiting_retry',
    processed: 4,
    pending: 0,
    complete: 3,
    failed: 1,
    retryable: 0,
    retryAfter: new Date(Date.now() + 3_600_000).toISOString(),
  })
  const sleep: GarminImportStreamState = {
    ...base,
    streamId: 'sleep',
    status: 'waiting_retry',
    errorCode: 'RATE_LIMITED',
    retryAfter: new Date(Date.now() + 60_000).toISOString(),
  }
  const network = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', network)
  await act(async () => root.render(<GarminDataImport initial={[sleep, state]} />))
  expect(state.summaryRetryAfter).toBeNull()
  expect(button('Reimport Activities').disabled).toBe(true)
  expect(button('Retry failed FITs (1)').disabled).toBe(true)
  expect(network).not.toHaveBeenCalled()
})
