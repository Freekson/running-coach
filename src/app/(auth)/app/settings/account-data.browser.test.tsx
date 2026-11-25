// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AccountData } from './account-data'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '')
}
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open')
}

let host: HTMLDivElement
let root: Root
const fetcher = vi.fn<typeof fetch>()
const originalFetch = globalThis.fetch
function button(label: string) {
  const result = [...host.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label,
  )
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
async function confirm() {
  await act(async () => {
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    const input = host.querySelector<HTMLInputElement>('#account-deletion-confirmation')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'DELETE')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
beforeEach(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  fetcher.mockReset()
  globalThis.fetch = fetcher
  await act(async () => root.render(<AccountData />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  globalThis.fetch = originalFetch
})

it('offers a private download and requires both revocation acknowledgement and typed confirmation', async () => {
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/api/account/export')
  expect(host.querySelector('a')?.hasAttribute('download')).toBe(true)
  await act(async () => button('Delete account').click())
  expect(button('Permanently delete account').disabled).toBe(true)
  expect(host.querySelector('dialog')?.open).toBe(true)
  expect(host.textContent).toContain('90 days')
  await confirm()
  expect(button('Permanently delete account').disabled).toBe(false)
  await act(async () => button('Cancel').click())
  await act(async () => button('Delete account').click())
  expect(button('Permanently delete account').disabled).toBe(true)
  expect(fetcher).not.toHaveBeenCalled()
})

it('holds confirmation open during deletion and gives a retry message for active sync', async () => {
  let resolve: (value: Response) => void = () => {
    throw new Error('Missing pending request')
  }
  fetcher.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  await act(async () => button('Delete account').click())
  await confirm()
  await act(async () => button('Permanently delete account').click())
  expect(button('Cancel').disabled).toBe(true)
  expect(button('Permanently delete account').disabled).toBe(true)
  expect(fetcher).toHaveBeenCalledWith(
    '/api/account',
    expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ confirmation: 'DELETE', providerAccessRevoked: true }),
    }),
  )
  await act(async () => resolve(new Response(null, { status: 409 })))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Wait for current sync')
  expect(button('Permanently delete account').disabled).toBe(false)
})

it('explains how to check a lost response without revealing server errors', async () => {
  fetcher.mockRejectedValueOnce(new Error('PRIVATE TOKEN'))
  await act(async () => button('Delete account').click())
  await confirm()
  await act(async () => button('Permanently delete account').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Reload')
  expect(host.textContent).not.toContain('PRIVATE TOKEN')
})
