// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '.'

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

function pointer(
  target: Element,
  type: 'pointerdown' | 'pointerup',
  x: number,
  y: number,
  button = 0,
) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button }))
}

it('labels the dialog and cancels without confirming', () => {
  const close = vi.fn()
  const confirm = vi.fn()
  act(() =>
    root.render(
      <ConfirmDialog
        open
        title="Delete?"
        className="custom-dialog"
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
  expect(dialog.classList.contains('custom-dialog')).toBe(true)
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
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 300, 200))
  act(() => {
    dialog.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }))
    pointer(dialog, 'pointerdown', 50, 50)
    pointer(dialog, 'pointerup', 50, 50)
  })
  expect(close).not.toHaveBeenCalled()
  expect(host.querySelector<HTMLButtonElement>('button[aria-busy]')?.disabled).toBe(true)
  expect(confirm).not.toHaveBeenCalled()
})

it('closes only when a pointer press and release both happen on the backdrop', () => {
  const close = vi.fn()
  act(() =>
    root.render(
      <ConfirmDialog
        open
        title="Delete?"
        confirmText="Delete"
        onClose={close}
        onConfirm={vi.fn()}
      />,
    ),
  )
  const dialog = host.querySelector('dialog')!
  const content = dialog.firstElementChild!
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 300, 200))

  act(() => {
    pointer(content, 'pointerdown', 200, 150)
    pointer(dialog, 'pointerup', 50, 50)
    dialog.click()
    pointer(dialog, 'pointerdown', 50, 50)
    pointer(content, 'pointerup', 200, 150)
    pointer(dialog, 'pointerdown', 110, 110)
    pointer(dialog, 'pointerup', 50, 50)
    pointer(dialog, 'pointerdown', 50, 50, 2)
    pointer(dialog, 'pointerup', 50, 50, 2)
    pointer(dialog, 'pointerdown', 50, 50)
    dialog.dispatchEvent(new Event('pointercancel', { bubbles: true }))
    pointer(dialog, 'pointerup', 50, 50)
  })
  expect(close).not.toHaveBeenCalled()

  act(() => {
    pointer(dialog, 'pointerdown', 50, 50)
    pointer(dialog, 'pointerup', 50, 50)
  })
  expect(close).toHaveBeenCalledOnce()
})

it('locks background scrolling until the last dialog closes and restores existing styles', () => {
  const originalBodyOverflow = document.body.style.overflow
  const originalRootOverflow = document.documentElement.style.overflow
  document.body.style.overflow = 'auto'
  document.documentElement.style.overflow = 'scroll'
  const first = (
    <ConfirmDialog open title="First" confirmText="Confirm" onClose={vi.fn()} onConfirm={vi.fn()} />
  )
  const second = (
    <ConfirmDialog
      open
      title="Second"
      confirmText="Confirm"
      onClose={vi.fn()}
      onConfirm={vi.fn()}
    />
  )

  act(() => root.render(<>{first}</>))
  expect(document.body.style.overflow).toBe('hidden')
  expect(document.documentElement.style.overflow).toBe('hidden')

  act(() =>
    root.render(
      <>
        {first}
        {second}
      </>,
    ),
  )
  act(() => root.render(<>{second}</>))
  expect(document.body.style.overflow).toBe('hidden')
  expect(document.documentElement.style.overflow).toBe('hidden')

  act(() => root.render(null))
  expect(document.body.style.overflow).toBe('auto')
  expect(document.documentElement.style.overflow).toBe('scroll')
  document.body.style.overflow = originalBodyOverflow
  document.documentElement.style.overflow = originalRootOverflow
})
