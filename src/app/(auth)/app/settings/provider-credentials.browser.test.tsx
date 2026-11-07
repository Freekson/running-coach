// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProviderCredentials } from './provider-credentials'

let host: HTMLDivElement
let root: Root
const fetchMock = vi.fn()
const originalFetch = globalThis.fetch
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

beforeEach(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  globalThis.fetch = fetchMock
  fetchMock.mockReset()
  await act(async () => root.render(<ProviderCredentials />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  globalThis.fetch = originalFetch
})

it('clears a saved key and explains local disconnect without rendering the secret', async () => {
  expect(host.textContent).toContain('The planned manual ChatGPT workflow')
  const key = 'synthetic-key-for-browser-test'
  const input = host.querySelector<HTMLInputElement>('#openai-api-key')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, key)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      provider: 'OPENAI',
      status: 'CONNECTED',
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
    '/api/integrations/openai',
    expect.objectContaining({ method: 'PUT', body: JSON.stringify({ apiKey: key }) }),
  )
  expect(input.value).toBe('')
  expect(host.textContent).not.toContain(key)
  expect(host.textContent).toContain('Replace key')
  fetchMock.mockResolvedValueOnce({ ok: true })
  const disconnect = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Disconnect',
  )!
  await act(async () => disconnect.click())
  expect(host.textContent).toContain('Revoke it separately in your OpenAI account.')
  expect(host.textContent).toContain('Add key')
})

it('updates the displayed status when fresh server props arrive without remounting', async () => {
  const connected = {
    provider: 'OPENAI' as const,
    status: 'CONNECTED' as const,
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z',
  }
  await act(async () => root.render(<ProviderCredentials initial={connected} />))
  expect(host.textContent).toContain('Key stored')

  await act(async () =>
    root.render(
      <ProviderCredentials
        initial={{
          ...connected,
          status: 'DISCONNECTED',
          updatedAt: '2026-11-09T00:00:00.000Z',
        }}
      />,
    ),
  )
  expect(host.textContent).toContain('disconnected')
  expect(host.textContent).not.toContain('Key stored')
  expect(host.textContent).toContain('Add key')
})
