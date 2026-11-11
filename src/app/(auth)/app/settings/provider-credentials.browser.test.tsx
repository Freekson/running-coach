// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProviderCredentials } from './provider-credentials'
import type { GarminImportStreamState } from '@/server/garmin/data-import'
import { GARMIN_HISTORY_YEARS } from '@/lib/garmin-import-window'

const { notify, refresh } = vi.hoisted(() => ({ notify: vi.fn(), refresh: vi.fn() }))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => notify }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

let host: HTMLDivElement
let root: Root
const fetchMock = vi.fn()
const originalFetch = globalThis.fetch
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '')
}
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open')
}

function button(label: string) {
  const result = [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.trim().startsWith(label),
  )
  if (!result) throw new Error(`Button missing: ${label}`)
  return result
}

async function openAdd() {
  await act(async () => button('Add key').click())
}

async function enterKey(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  globalThis.fetch = fetchMock
  fetchMock.mockReset()
  notify.mockReset()
  refresh.mockReset()
  await act(async () => root.render(<ProviderCredentials />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  globalThis.fetch = originalFetch
})

it('saves and removes only a Garmin key through dialogs without displaying the secret', async () => {
  expect(host.textContent).toContain('Not configured')
  expect(host.textContent).not.toContain('OpenAI')
  expect(host.textContent).not.toContain('Integrations & API keys')
  expect(host.querySelector('input')).toBeNull()
  await openAdd()
  const input = host.querySelector<HTMLInputElement>('#garmin-api-key')!
  expect(input.type).toBe('password')
  expect(host.querySelector<HTMLAnchorElement>('a[href*="developer.garmin.com"]')?.target).toBe(
    '_blank',
  )
  const key = 'synthetic-garmin-key-for-browser-test'
  await enterKey(input, key)
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      provider: 'GARMIN',
      status: 'KEY_SAVED',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    }),
  })
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/integrations/garmin',
    expect.objectContaining({ method: 'PUT', body: JSON.stringify({ apiKey: key }) }),
  )
  expect(host.querySelector('input')).toBeNull()
  expect(host.textContent).not.toContain(key)
  expect(host.textContent).toContain('Key saved')
  expect(host.textContent).toContain('Garmin account verified.')
  expect(host.textContent).toContain('Choose streams below to import your data.')
  expect(host.querySelector('.badge--success')).toBeNull()
  expect(host.textContent).not.toContain('Connected')
  expect(button('Replace key')).toBeTruthy()
  expect(refresh).toHaveBeenCalledOnce()
  await act(async () => button('Remove key').click())
  fetchMock.mockResolvedValueOnce({ ok: true, status: 204 })
  await act(async () => {
    const dialog = host.querySelector('dialog')!
    ;[...dialog.querySelectorAll('button')]
      .find((item) => item.textContent === 'Remove key')!
      .click()
  })
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/integrations/garmin',
    expect.objectContaining({ method: 'DELETE' }),
  )
  expect(host.textContent).toContain('Not configured')
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(notify).toHaveBeenCalledWith(
    'success',
    'Garmin key removed from Running Coach.',
    'garmin-key',
  )
})

it('requires a separate destructive confirmation to delete imported Garmin data', async () => {
  await act(async () => button('Delete all imported Garmin data').click())
  expect(host.textContent).toContain('permanently deletes imported Garmin activities')
  expect(fetchMock).not.toHaveBeenCalled()
  fetchMock.mockResolvedValueOnce({ ok: true, status: 204 })
  await act(async () => {
    const dialog = host.querySelector('dialog')!
    ;[...dialog.querySelectorAll('button')]
      .find((item) => item.textContent === 'Delete all imported Garmin data')!
      .click()
  })
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/integrations/garmin/data',
    expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'DELETE_ALL_GARMIN_DATA' }),
    }),
  )
})

it('explains the three options after a Garmin account mismatch', async () => {
  await openAdd()
  const input = host.querySelector<HTMLInputElement>('#garmin-api-key')!
  await enterKey(input, 'synthetic-other-account-key')
  fetchMock.mockResolvedValueOnce({ ok: false, status: 409 })
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  const error = host.querySelector('#garmin-api-key-error')?.textContent ?? ''
  expect(error).toContain('original Garmin account')
  expect(error).toContain('delete all imported Garmin data')
  expect(error).toContain('separate Running Coach account')
  expect(error).toContain('invitation')
  expect(notify).not.toHaveBeenCalled()
})

it('highlights the key input and shows a storage error without a toast, then clears the secret on cancel', async () => {
  await openAdd()
  const input = host.querySelector<HTMLInputElement>('#garmin-api-key')!
  const key = 'synthetic-garmin-key-for-error-test'
  await enterKey(input, 'invalid key with spaces')
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(fetchMock).not.toHaveBeenCalled()
  expect(host.querySelector('#garmin-api-key-error')?.textContent).toContain('without spaces')
  expect(notify).not.toHaveBeenCalled()
  await enterKey(input, key)
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 503,
    json: async () => ({ code: 'KEY_STORAGE_UNCONFIGURED' }),
  })
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  const message = 'Key storage is not configured. Contact the site administrator.'
  expect(host.querySelector('#garmin-api-key-error')?.textContent).toBe(message)
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(input.getAttribute('aria-describedby')).toBe('garmin-api-key-error')
  expect(notify).not.toHaveBeenCalled()
  await act(async () => button('Cancel').click())
  expect(host.querySelector('input')).toBeNull()
  await openAdd()
  expect(host.querySelector<HTMLInputElement>('#garmin-api-key')?.value).toBe('')
})

it('renders connected, connection issue and expired states with next steps', async () => {
  const base = { provider: 'GARMIN' as const, createdAt: null, updatedAt: null }
  await act(async () =>
    root.render(<ProviderCredentials initial={{ ...base, status: 'CONNECTED' }} />),
  )
  expect(host.textContent).toContain('Connected')
  expect(host.textContent).toContain('Garmin access verified.')
  await act(async () => root.render(<ProviderCredentials initial={{ ...base, status: 'ERROR' }} />))
  expect(host.textContent).toContain('Connection issue')
  expect(host.textContent).toContain('Replace the key to resume imports.')
  await act(async () =>
    root.render(<ProviderCredentials initial={{ ...base, status: 'EXPIRED' }} />),
  )
  expect(host.textContent).toContain('Expired')
  expect(host.textContent).toContain('Garmin access has expired.')
  await act(async () =>
    root.render(<ProviderCredentials initial={{ ...base, status: 'VERIFICATION_REQUIRED' }} />),
  )
  expect(host.textContent).toContain('Verification needed')
  expect(host.textContent).toContain('Verify it here or replace the key.')
  expect(button('Verify saved key')).toBeTruthy()
})

it('shows only key management when Garmin is connected', async () => {
  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{ provider: 'GARMIN', status: 'CONNECTED', createdAt: null, updatedAt: null }}
      />,
    ),
  )
  expect(host.textContent).toContain('Replace key')
  expect(host.textContent).toContain('Remove key')
  expect(host.textContent).not.toContain('Sync now')
  expect(host.textContent).not.toContain('Backfill')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('imports only the selected stream and shows persisted date coverage', async () => {
  const stream = (streamId: GarminImportStreamState['streamId']): GarminImportStreamState => ({
    streamId,
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
  })
  const imports = [stream('daily_summary'), stream('sleep'), stream('activities')]
  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{ provider: 'GARMIN', status: 'KEY_SAVED', createdAt: null, updatedAt: null }}
        garminImports={imports}
      />,
    ),
  )
  expect(host.textContent).toContain('Garmin Data Import')
  expect(host.textContent).toContain(`${GARMIN_HISTORY_YEARS} calendar years`)
  expect(host.querySelector('#garmin-import-help')).toBeNull()
  await act(async () => button('How it works').click())
  const help = host.querySelector('#garmin-import-help')
  expect(help?.querySelectorAll('li')).toHaveLength(4)
  expect(help?.textContent).toContain('Import continues automatically while Settings stays open.')
  expect(help?.textContent).toContain('Resume import continues unchecked history.')
  expect(help?.textContent).toContain('Retry failed dates checks only unresolved dates.')
  expect(help?.textContent).toContain('Reimport starts a new pass for that stream.')
  expect(button('How it works').getAttribute('aria-expanded')).toBe('true')
  await act(async () => button('How it works').click())
  expect(host.querySelector('#garmin-import-help')).toBeNull()
  expect(button('How it works').getAttribute('aria-expanded')).toBe('false')
  const choices = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  expect(choices[2].disabled).toBe(true)
  await act(async () => choices[1].click())
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => [
      imports[0],
      {
        ...imports[1],
        status: 'paused',
        startDate: '2023-11-10',
        endDate: '2026-11-09',
        nextDate: '2026-11-08',
        lastCheckedDate: '2026-11-09',
        checkedDays: 1,
        totalDays: 1096,
        generation: 1,
      },
      imports[2],
    ],
  })
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => [
      imports[0],
      {
        ...imports[1],
        status: 'completed',
        startDate: '2023-11-10',
        endDate: '2026-11-09',
        nextDate: null,
        lastCheckedDate: '2023-11-10',
        checkedDays: 1096,
        totalDays: 1096,
        generation: 1,
      },
      imports[2],
    ],
  })
  await act(async () => button('Import selected').click())
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
    streamId: 'sleep',
    action: 'import',
  })
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
    streamId: 'sleep',
    action: 'resume',
  })
  expect(host.querySelector('#garmin-sleep-details')).toBeNull()
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Show Sleep details"]')?.click(),
  )
  expect(host.textContent).toContain('1,096 of 1,096 dates checked')
  expect(notify).not.toHaveBeenCalledWith('info', 'Import progress saved.', 'garmin-data-import')
  expect(host.textContent).not.toContain('Stop import')
})

it('keeps historical Activities not imported and unavailable after a recent sync', async () => {
  const activity: GarminImportStreamState = {
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
  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{ provider: 'GARMIN', status: 'CONNECTED', createdAt: null, updatedAt: null }}
        garminImports={[activity]}
      />,
    ),
  )
  const choice = host.querySelector<HTMLInputElement>('input[aria-label="Select Activities"]')
  expect(choice?.disabled).toBe(true)
  expect(host.textContent).toContain('Coming later')
  expect(host.querySelector('button[aria-label="Show Activities details"]')).toBeNull()
  expect(host.querySelector('button[aria-label="Hide Activities details"]')).toBeNull()
  expect(host.querySelector('#garmin-activities-details')).toBeNull()
  await act(async () => choice?.click())
  expect(choice?.checked).toBe(false)
  expect(button('Import selected').disabled).toBe(true)
  expect(fetchMock).not.toHaveBeenCalled()
})

it('only offers stream details after they exist and opens newly available details closed', async () => {
  const empty: GarminImportStreamState = {
    streamId: 'daily_summary',
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
  const connection = {
    provider: 'GARMIN' as const,
    status: 'CONNECTED' as const,
    createdAt: null,
    updatedAt: null,
  }
  await act(async () =>
    root.render(<ProviderCredentials initial={connection} garminImports={[empty]} />),
  )
  expect(host.querySelector('button[aria-label="Show Daily summaries details"]')).toBeNull()
  expect(host.querySelector('#garmin-daily_summary-details')).toBeNull()

  const withDetails: GarminImportStreamState = {
    ...empty,
    status: 'paused',
    startDate: '2023-11-10',
    endDate: '2026-11-09',
    nextDate: '2026-11-08',
    totalDays: 1096,
  }
  await act(async () =>
    root.render(<ProviderCredentials initial={connection} garminImports={[withDetails]} />),
  )
  const expand = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Show Daily summaries details"]',
  )
  expect(expand?.getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelector('#garmin-daily_summary-details')).toBeNull()
  await act(async () => expand?.click())
  expect(host.querySelector('#garmin-daily_summary-details')).not.toBeNull()
})

it('animates the Importing status icon without adding an empty accordion', async () => {
  const running: GarminImportStreamState = {
    streamId: 'daily_summary',
    status: 'running',
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
  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{ provider: 'GARMIN', status: 'CONNECTED', createdAt: null, updatedAt: null }}
        garminImports={[running]}
      />,
    ),
  )
  expect(host.querySelector('button[aria-label="Show Daily summaries details"]')).toBeNull()
  expect(host.querySelector('[class*="statusSpinner"]')).not.toBeNull()
})

it('automatically retries remaining failed dates until they are checked', async () => {
  const daily: GarminImportStreamState = {
    streamId: 'daily_summary',
    status: 'completed_with_warnings',
    startDate: '2023-11-10',
    endDate: '2026-11-09',
    nextDate: null,
    lastCheckedDate: '2023-11-10',
    checkedDays: 1094,
    totalDays: 1096,
    failedDateCount: 2,
    retryAfter: null,
    lastSyncAt: null,
    errorCode: 'SUMMARY_INVALID_RECORD',
    generation: 1,
  }
  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{ provider: 'GARMIN', status: 'CONNECTED', createdAt: null, updatedAt: null }}
        garminImports={[daily]}
      />,
    ),
  )
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...daily, checkedDays: 1095, failedDateCount: 1 }],
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { ...daily, status: 'completed', checkedDays: 1096, failedDateCount: 0, errorCode: null },
      ],
    })
  await act(async () => button('Retry failed dates').click())
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).action)).toEqual([
    'retry',
    'retry',
  ])
  expect(host.textContent).toContain('1,096 of 1,096 dates checked')
})

it('stops automatic retries when failed-date coverage does not improve', async () => {
  const daily: GarminImportStreamState = {
    streamId: 'daily_summary',
    status: 'completed_with_warnings',
    startDate: '2023-11-10',
    endDate: '2026-11-09',
    nextDate: null,
    lastCheckedDate: '2023-11-10',
    checkedDays: 1095,
    totalDays: 1096,
    failedDateCount: 1,
    retryAfter: null,
    lastSyncAt: null,
    errorCode: 'SUMMARY_INVALID_RECORD',
    generation: 1,
  }
  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{ provider: 'GARMIN', status: 'CONNECTED', createdAt: null, updatedAt: null }}
        garminImports={[daily]}
      />,
    ),
  )
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [daily] })
  await act(async () => button('Retry failed dates').click())
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(notify).toHaveBeenCalledWith(
    'warning',
    'Import paused with unresolved dates. Review the stream status.',
    'garmin-data-import',
  )
})

it('waits longer after repeated import rate limits without another click', async () => {
  const daily: GarminImportStreamState = {
    streamId: 'daily_summary',
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
  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{ provider: 'GARMIN', status: 'CONNECTED', createdAt: null, updatedAt: null }}
        garminImports={[daily]}
      />,
    ),
  )
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  vi.useFakeTimers()
  fetchMock
    .mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        code: 'APP_RATE_LIMITED',
        retryAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    })
    .mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ code: 'APP_RATE_LIMITED', retryAt: null }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          ...daily,
          status: 'completed',
          startDate: '2023-11-10',
          endDate: '2026-11-09',
          checkedDays: 1096,
          totalDays: 1096,
          generation: 1,
        },
      ],
    })
  try {
    await act(async () => button('Import selected').click())
    expect(host.textContent).toContain('Garmin import rate limit reached.')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(host.querySelector('#garmin-daily_summary-details')).toBeNull()
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Show Daily summaries details"]')
        ?.click(),
    )
    expect(host.textContent).toContain('1,096 of 1,096 dates checked')
  } finally {
    vi.useRealTimers()
  }
})

it('continues after a saved provider backoff checkpoint', async () => {
  const daily: GarminImportStreamState = {
    streamId: 'daily_summary',
    status: 'paused',
    startDate: '2023-11-10',
    endDate: '2026-11-09',
    nextDate: '2026-11-08',
    lastCheckedDate: '2026-11-09',
    checkedDays: 1,
    totalDays: 1096,
    failedDateCount: 0,
    retryAfter: null,
    lastSyncAt: null,
    errorCode: null,
    generation: 1,
  }
  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{ provider: 'GARMIN', status: 'CONNECTED', createdAt: null, updatedAt: null }}
        garminImports={[daily]}
      />,
    ),
  )
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          ...daily,
          status: 'waiting_retry',
          retryAfter: new Date(Date.now() - 1_000).toISOString(),
          errorCode: 'SUMMARY_TIMEOUT',
        },
      ],
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...daily, status: 'completed', nextDate: null, checkedDays: 1096 }],
    })
  await act(async () => button('Resume import').click())
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_100))
  })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).action)).toEqual([
    'resume',
    'resume',
  ])
  expect(host.textContent).toContain('1,096 of 1,096 dates checked')
})

it('keeps retrying provider rate limits with increasing pauses', async () => {
  const daily: GarminImportStreamState = {
    streamId: 'daily_summary',
    status: 'paused',
    startDate: '2023-11-10',
    endDate: '2026-11-09',
    nextDate: '2026-11-08',
    lastCheckedDate: '2026-11-09',
    checkedDays: 1,
    totalDays: 1096,
    failedDateCount: 0,
    retryAfter: null,
    lastSyncAt: null,
    errorCode: null,
    generation: 1,
  }
  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{ provider: 'GARMIN', status: 'CONNECTED', createdAt: null, updatedAt: null }}
        garminImports={[daily]}
      />,
    ),
  )
  vi.useFakeTimers()
  for (let index = 0; index < 3; index++)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          ...daily,
          status: 'waiting_retry',
          retryAfter: new Date(Date.now() - 1_000).toISOString(),
          errorCode: 'RATE_LIMITED',
        },
      ],
    })
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => [{ ...daily, status: 'completed', nextDate: null, checkedDays: 1096 }],
  })
  try {
    await act(async () => button('Resume import').click())
    for (const [elapsed, expectedCalls] of [
      [60_000, 2],
      [120_000, 3],
      [240_000, 4],
    ]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(elapsed)
      })
      expect(fetchMock).toHaveBeenCalledTimes(expectedCalls)
    }
    expect(host.textContent).toContain('1,096 of 1,096 dates checked')
  } finally {
    vi.useRealTimers()
  }
})

it('stops automatic continuation after the current request', async () => {
  const daily: GarminImportStreamState = {
    streamId: 'daily_summary',
    status: 'paused',
    startDate: '2023-11-10',
    endDate: '2026-11-09',
    nextDate: '2026-11-08',
    lastCheckedDate: '2026-11-09',
    checkedDays: 1,
    totalDays: 1096,
    failedDateCount: 0,
    retryAfter: null,
    lastSyncAt: null,
    errorCode: null,
    generation: 1,
  }
  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{ provider: 'GARMIN', status: 'CONNECTED', createdAt: null, updatedAt: null }}
        garminImports={[daily]}
      />,
    ),
  )
  let finishRequest: ((response: unknown) => void) | undefined
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRequest = resolve
      }),
  )
  await act(async () => button('Resume import').click())
  expect(host.textContent).toContain('Stop import')
  expect(host.textContent).not.toContain('Importing Daily summaries automatically.')
  expect(button('Stop import').parentElement).toBe(button('Import selected').parentElement)
  await act(async () => button('Stop import').click())
  await act(async () =>
    finishRequest?.({ ok: true, json: async () => [{ ...daily, nextDate: '2026-11-07' }] }),
  )
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(host.textContent).not.toContain('Stop import')
})

it('explains why reached daily dates remain unresolved', async () => {
  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{ provider: 'GARMIN', status: 'CONNECTED', createdAt: null, updatedAt: null }}
        garminImports={[
          {
            streamId: 'daily_summary',
            status: 'paused',
            startDate: '2023-11-10',
            endDate: '2026-11-09',
            nextDate: '2026-08-10',
            lastCheckedDate: '2026-08-11',
            checkedDays: 29,
            totalDays: 1096,
            failedDateCount: 62,
            retryAfter: null,
            lastSyncAt: null,
            errorCode: 'SUMMARY_INVALID_RECORD',
            generation: 1,
          },
        ]}
      />,
    ),
  )
  expect(host.textContent).toContain('29 of 1,096 dates checked; 91 reached, 62 unresolved')
  expect(host.textContent).toContain(
    'Garmin returned a daily summary with invalid or missing fields.',
  )
})

it('shows only Garmin management and import cards', async () => {
  expect(host.textContent).toContain('Garmin Connect')
  expect(host.textContent).toContain('Delete imported Garmin data')
  expect(host.textContent).not.toContain('OpenAI')
  expect(host.textContent).not.toContain('Integrations & API keys')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('keeps Resume import separate from retrying failed dates', async () => {
  const sleep: GarminImportStreamState = {
    streamId: 'sleep',
    status: 'paused',
    startDate: '2023-11-10',
    endDate: '2026-11-09',
    nextDate: '2026-03-15',
    lastCheckedDate: '2026-03-16',
    checkedDays: 240,
    totalDays: 1096,
    failedDateCount: 2,
    retryAfter: null,
    lastSyncAt: null,
    errorCode: null,
    generation: 1,
  }
  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{ provider: 'GARMIN', status: 'CONNECTED', createdAt: null, updatedAt: null }}
        garminImports={[sleep]}
      />,
    ),
  )
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { ...sleep, status: 'completed_with_warnings', nextDate: null, failedDateCount: 2 },
      ],
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ...sleep, status: 'completed', nextDate: null, failedDateCount: 0 }],
    })
  await act(async () => button('Resume import').click())
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).action).toBe('resume')
  await act(async () => button('Retry failed dates').click())
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).action).toBe('retry')
})

it('disables import actions and explains the retry time after Garmin 429', async () => {
  const sleep: GarminImportStreamState = {
    streamId: 'sleep',
    status: 'paused',
    startDate: '2023-11-10',
    endDate: '2026-11-09',
    nextDate: '2026-03-15',
    lastCheckedDate: '2026-03-16',
    checkedDays: 240,
    totalDays: 1096,
    failedDateCount: 2,
    retryAfter: null,
    lastSyncAt: null,
    errorCode: null,
    generation: 1,
  }
  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{ provider: 'GARMIN', status: 'CONNECTED', createdAt: null, updatedAt: null }}
        garminImports={[sleep]}
      />,
    ),
  )
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 429,
    json: async () => ({
      code: 'RATE_LIMITED',
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  })
  await act(async () => button('Resume import').click())
  expect(host.textContent).toContain('Garmin import rate limit reached.')
  await act(async () => button('Stop import').click())
  expect(button('Resume import').disabled).toBe(true)
  expect(button('Retry failed dates').disabled).toBe(true)
  expect(host.textContent).toContain('Try again after')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('keeps the retry time after Stop import when the in-flight request returns 429', async () => {
  const sleep: GarminImportStreamState = {
    streamId: 'sleep',
    status: 'paused',
    startDate: '2023-11-10',
    endDate: '2026-11-09',
    nextDate: '2026-03-15',
    lastCheckedDate: '2026-03-16',
    checkedDays: 240,
    totalDays: 1096,
    failedDateCount: 2,
    retryAfter: null,
    lastSyncAt: null,
    errorCode: null,
    generation: 1,
  }
  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{ provider: 'GARMIN', status: 'CONNECTED', createdAt: null, updatedAt: null }}
        garminImports={[sleep]}
      />,
    ),
  )
  let finishRequest: ((response: unknown) => void) | undefined
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRequest = resolve
      }),
  )
  await act(async () => button('Resume import').click())
  await act(async () => button('Stop import').click())
  await act(async () =>
    finishRequest?.({
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name === 'Retry-After' ? '90' : null) },
      json: async () => ({ code: 'RATE_LIMITED' }),
    }),
  )
  expect(button('Resume import').disabled).toBe(true)
  expect(button('Retry failed dates').disabled).toBe(true)
  expect(host.textContent).toContain('Try again after')
})
