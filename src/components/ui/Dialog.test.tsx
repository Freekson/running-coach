// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './Dialog'

const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '')
}
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open')
}
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
afterEach(() => act(() => root.render(null)))

it('labels the dialog and cancels without confirming', () => {
  const close = vi.fn()
  const confirm = vi.fn()
  act(() =>
    root.render(
      <ConfirmDialog
        open
        title="Delete?"
        description="This is permanent."
        confirmText="Delete"
        variant="destructive"
        onClose={close}
        onConfirm={confirm}
      />,
    ),
  )
  const dialog = host.querySelector('dialog')!
  expect(dialog.open).toBe(true)
  expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
  expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
  act(() => dialog.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true })))
  expect(close).toHaveBeenCalledOnce()
  expect(confirm).not.toHaveBeenCalled()
})

it('prevents Escape, backdrop, and duplicate confirmation while pending', () => {
  const close = vi.fn()
  const confirm = vi.fn()
  act(() =>
    root.render(
      <ConfirmDialog
        open
        title="Delete?"
        confirmText="Delete"
        pending
        onClose={close}
        onConfirm={confirm}
      />,
    ),
  )
  const dialog = host.querySelector('dialog')!
  act(() => {
    dialog.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }))
    dialog.click()
  })
  expect(close).not.toHaveBeenCalled()
  expect(host.querySelector<HTMLButtonElement>('button[aria-busy]')?.disabled).toBe(true)
  expect(confirm).not.toHaveBeenCalled()
})
