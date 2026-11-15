// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IntervalsConnection } from './intervals-connection'

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
const status = {
  provider: 'INTERVALS',
  status: 'KEY_SAVED',
  createdAt: null,
  updatedAt: null,
} as const

function button(label: string) {
  const result = [...host.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label,
  )
  if (!result) throw new Error(`Missing button ${label}`)
  return result
}
async function typeKey(value: string) {
  const input = host.querySelector<HTMLInputElement>('#intervals-api-key')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function submit() {
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
}

beforeEach(async () => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  globalThis.fetch = fetchMock
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<IntervalsConnection />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  globalThis.fetch = originalFetch
})

it('connects, explicitly tests and confirms disconnect without publishing or exposing the saved key', async () => {
  expect(fetchMock).not.toHaveBeenCalled()
  expect(button('Test connection').disabled).toBe(true)
  expect(host.textContent).toContain('requires no Intervals.icu account')
  expect(host.textContent).toContain('Upload planned workouts')
  expect(host.textContent).toContain('next 7 days')
  expect(host.textContent).toContain('Connecting, testing and approving a plan do not publish')
  await act(async () => button('Connect Intervals.icu').click())
  expect(host.querySelector<HTMLInputElement>('input')!.type).toBe('password')
  const key = 'synthetic-intervals-browser-key'
  await typeKey(key)
  fetchMock.mockResolvedValueOnce(Response.json(status))
  await submit()
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/integrations/intervals',
    expect.objectContaining({ method: 'PUT', body: JSON.stringify({ apiKey: key }) }),
  )
  expect(host.querySelector('input')).toBeNull()
  expect(host.textContent).not.toContain(key)
  expect(host.textContent).toContain('Key saved')
  expect(fetchMock).toHaveBeenCalledOnce()
  fetchMock.mockResolvedValueOnce(Response.json({ ...status, status: 'CONNECTED' }))
  await act(async () => button('Test connection').click())
  expect(host.textContent).toContain('Calendar access verified')
  expect(host.textContent).toContain('watch delivery are not verified')
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/integrations/intervals',
    expect.objectContaining({ method: 'POST' }),
  )
  await act(async () => button('Disconnect Intervals.icu').click())
  expect(host.textContent).toContain('Previously published workouts')
  expect(fetchMock).toHaveBeenCalledTimes(2)
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
  await act(async () => button('Disconnect').click())
  expect(host.textContent).toContain('Not configured')
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/integrations/intervals',
    expect.objectContaining({ method: 'DELETE' }),
  )
  expect(refresh).toHaveBeenCalledTimes(3)
})

it('clears an unsaved secret on cancel and validates before a request', async () => {
  await act(async () => button('Connect Intervals.icu').click())
  await typeKey('bad key')
  await submit()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('without spaces')
  expect(host.querySelector('input')?.getAttribute('aria-invalid')).toBe('true')
  expect(fetchMock).not.toHaveBeenCalled()
  await act(async () => button('Cancel').click())
  await act(async () => button('Connect Intervals.icu').click())
  expect(host.querySelector<HTMLInputElement>('input')!.value).toBe('')
})

it.each([
  [422, 'invalid or revoked'],
  [429, 'rate limiting'],
  [503, 'temporarily unavailable'],
  [401, 'session expired'],
  [409, 'missing or unavailable'],
])('shows actionable connection error %s', async (code, message) => {
  await act(async () => root.render(<IntervalsConnection initial={status} />))
  fetchMock.mockResolvedValueOnce(new Response(null, { status: Number(code) }))
  await act(async () => button('Test connection').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(message)
  expect(button('Replace Intervals.icu key')).toBeTruthy()
  if (code === 422) expect(host.textContent).toContain('Connection issue')
})

it('does not claim verified access if the saved connection changed during a test', async () => {
  await act(async () => root.render(<IntervalsConnection initial={status} />))
  fetchMock.mockResolvedValueOnce(Response.json({ ...status, status: 'DISCONNECTED' }))
  await act(async () => button('Test connection').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('changed during the test')
  expect(host.textContent).toContain('Not configured')
  expect(notify).not.toHaveBeenCalled()
})

it('shows an actionable conflict when another request changes the connection during save', async () => {
  await act(async () => button('Connect Intervals.icu').click())
  await typeKey('synthetic-conflicting-key')
  fetchMock.mockResolvedValueOnce(Response.json({ code: 'CONNECTION_CHANGED' }, { status: 409 }))
  await submit()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'changed while this key was being checked',
  )
  expect(notify).not.toHaveBeenCalled()
})

it('disables actions during a test and recovers from network failure', async () => {
  await act(async () => root.render(<IntervalsConnection initial={status} />))
  let rejectRequest: (error: Error) => void = () => {}
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectRequest = reject
      }),
  )
  await act(async () => button('Test connection').click())
  expect(button('Test connection').disabled).toBe(true)
  expect(button('Disconnect Intervals.icu').disabled).toBe(true)
  await act(async () => rejectRequest(new Error('offline')))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Check your connection')
  expect(button('Test connection').disabled).toBe(false)
})
