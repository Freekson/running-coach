// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProviderCredentials } from './provider-credentials'

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => notify }))

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
  const result = [...host.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label,
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
  await act(async () => root.render(<ProviderCredentials />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  globalThis.fetch = originalFetch
})

it('saves and removes only a Garmin key through dialogs without displaying the secret', async () => {
  expect(host.textContent).toContain('Not configured')
  expect(host.textContent).toContain('Coming soon')
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
  expect(host.textContent).not.toContain('Connected')
  expect(button('Replace key')).toBeTruthy()
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
  expect(notify).toHaveBeenCalledWith(
    'success',
    'Garmin key removed from Running Coach.',
    'garmin-key',
  )
})

it('shows a known storage error beside the key and through Toast, then clears the secret on cancel', async () => {
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
  expect(notify).toHaveBeenCalledWith('error', message, 'garmin-key')
  await act(async () => button('Cancel').click())
  expect(host.querySelector('input')).toBeNull()
  await openAdd()
  expect(host.querySelector<HTMLInputElement>('#garmin-api-key')?.value).toBe('')
})

it('renders verified, invalid and expired connection states', async () => {
  const base = { provider: 'GARMIN' as const, createdAt: null, updatedAt: null }
  await act(async () =>
    root.render(<ProviderCredentials initial={{ ...base, status: 'CONNECTED' }} />),
  )
  expect(host.textContent).toContain('Connected')
  await act(async () => root.render(<ProviderCredentials initial={{ ...base, status: 'ERROR' }} />))
  expect(host.textContent).toContain('Invalid key')
  await act(async () =>
    root.render(<ProviderCredentials initial={{ ...base, status: 'EXPIRED' }} />),
  )
  expect(host.textContent).toContain('Expired')
})

it('keeps cleanup available for a previously saved OpenAI key without offering new OpenAI saves', async () => {
  await act(async () =>
    root.render(
      <ProviderCredentials
        openaiInitial={{
          provider: 'OPENAI',
          status: 'CONNECTED',
          createdAt: '2026-11-08T00:00:00.000Z',
          updatedAt: '2026-11-08T00:00:00.000Z',
        }}
      />,
    ),
  )
  expect(host.textContent).toContain('Coming soon')
  await act(async () => button('Remove saved key').click())
  fetchMock.mockResolvedValueOnce({ ok: true, status: 204 })
  await act(async () => {
    const dialog = host.querySelector('dialog')!
    ;[...dialog.querySelectorAll('button')]
      .find((item) => item.textContent === 'Remove key')!
      .click()
  })
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/integrations/openai',
    expect.objectContaining({ method: 'DELETE' }),
  )
  expect(host.textContent).not.toContain('Remove saved key')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
