// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CopyableField } from './CopyableField'

let root: Root
let host: HTMLDivElement
let previousClipboard: PropertyDescriptor | undefined

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  vi.unstubAllGlobals()
  host.remove()
})

it('copies the complete long value and shows brief success feedback', async () => {
  const value = `https://running.example/sign-up#invite=${'a'.repeat(180)}`
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  act(() => root.render(<CopyableField id="link" label="Invite link" value={value} />))

  await act(async () => host.querySelector('button')?.click())
  expect(writeText).toHaveBeenCalledWith(value)
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied.')
  expect(host.querySelector('input')?.value).toBe(value)
  expect(host.querySelector('button svg')?.getAttribute('class')).toContain('lucide-check')
  expect(host.querySelector('button svg')?.getAttribute('aria-hidden')).toBe('true')
})

it('announces clipboard failure and keeps the full field selectable', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) },
  })
  const onCopyError = vi.fn()
  act(() =>
    root.render(
      <CopyableField id="link" label="Invite link" value="full-token" onCopyError={onCopyError} />,
    ),
  )

  await act(async () => host.querySelector('button')?.click())
  expect(onCopyError).toHaveBeenCalledOnce()
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Select the field')
  expect(host.querySelector('input')?.readOnly).toBe(true)
  expect(host.querySelector('input')?.value).toBe('full-token')
  expect(host.querySelector('button svg')?.getAttribute('class')).toContain('lucide-circle-x')
  expect(host.querySelector('[role="status"]')?.getAttribute('class')).toContain('feedbackError')
})

it('ignores a second copy while the first clipboard request is pending', async () => {
  let completeCopy: (() => void) | undefined
  const pendingCopy = new Promise<void>((resolve) => {
    completeCopy = resolve
  })
  const writeText = vi.fn().mockReturnValue(pendingCopy)
  const onCopySuccess = vi.fn()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  act(() =>
    root.render(
      <CopyableField
        id="link"
        label="Invite link"
        value="full-token"
        onCopySuccess={onCopySuccess}
      />,
    ),
  )

  const button = host.querySelector<HTMLButtonElement>('button')
  button?.focus()
  act(() => {
    button?.click()
    button?.click()
  })
  expect(writeText).toHaveBeenCalledOnce()
  expect(button?.disabled).toBe(false)
  expect(button?.getAttribute('aria-disabled')).toBe('true')
  expect(button?.getAttribute('aria-busy')).toBe('true')
  expect(document.activeElement).toBe(button)

  await act(async () => completeCopy?.())
  expect(button?.disabled).toBe(false)
  expect(button?.hasAttribute('aria-disabled')).toBe(false)
  expect(document.activeElement).toBe(button)
  expect(onCopySuccess).toHaveBeenCalledOnce()
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied.')
})

it('ignores an obsolete clipboard result after the value changes', async () => {
  let rejectOldCopy: ((reason: Error) => void) | undefined
  const oldCopy = new Promise<void>((_resolve, reject) => {
    rejectOldCopy = reject
  })
  const writeText = vi.fn().mockReturnValueOnce(oldCopy).mockResolvedValue(undefined)
  const onCopyError = vi.fn()
  const onCopySuccess = vi.fn()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

  act(() =>
    root.render(
      <CopyableField
        id="link"
        label="Invite link"
        value="old-token"
        onCopyError={onCopyError}
        onCopySuccess={onCopySuccess}
      />,
    ),
  )
  act(() => host.querySelector('button')?.click())

  act(() =>
    root.render(
      <CopyableField
        id="link"
        label="Invite link"
        value="new-token"
        onCopyError={onCopyError}
        onCopySuccess={onCopySuccess}
      />,
    ),
  )
  expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false)
  await act(async () => host.querySelector('button')?.click())
  await act(async () => rejectOldCopy?.(new Error('old clipboard request failed')))

  expect(writeText).toHaveBeenNthCalledWith(2, 'new-token')
  expect(onCopySuccess).toHaveBeenCalledOnce()
  expect(onCopyError).not.toHaveBeenCalled()
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied.')
})

it('does not report clipboard failure after unmounting', async () => {
  let rejectCopy: ((reason: Error) => void) | undefined
  const pendingCopy = new Promise<void>((_resolve, reject) => {
    rejectCopy = reject
  })
  const onCopyError = vi.fn()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockReturnValue(pendingCopy) },
  })
  act(() =>
    root.render(
      <CopyableField id="link" label="Invite link" value="old-token" onCopyError={onCopyError} />,
    ),
  )
  act(() => host.querySelector('button')?.click())
  act(() => root.render(<div />))

  await act(async () => rejectCopy?.(new Error('clipboard unavailable')))
  expect(onCopyError).not.toHaveBeenCalled()
})

it('clears old success feedback while another copy is pending', async () => {
  let completeSecondCopy: (() => void) | undefined
  const secondCopy = new Promise<void>((resolve) => {
    completeSecondCopy = resolve
  })
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockReturnValueOnce(secondCopy)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  act(() => root.render(<CopyableField id="link" label="Invite link" value="token" />))

  await act(async () => host.querySelector('button')?.click())
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied.')

  act(() => host.querySelector('button')?.click())
  expect(host.querySelector('[role="status"]')?.textContent).toBe('')
  expect(host.querySelector('button svg')?.getAttribute('class')).toContain('lucide-copy')
  expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false)
  expect(host.querySelector('button')?.getAttribute('aria-disabled')).toBe('true')

  await act(async () => completeSecondCopy?.())
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied.')
})

it('keeps the input and copy button mounted and focused when the value changes', () => {
  act(() => root.render(<CopyableField id="link" label="Invite link" value="first-token" />))
  const input = host.querySelector<HTMLInputElement>('input')
  const button = host.querySelector<HTMLButtonElement>('button')
  input?.focus()

  act(() => root.render(<CopyableField id="link" label="Invite link" value="second-token" />))
  expect(host.querySelector('input')).toBe(input)
  expect(host.querySelector('button')).toBe(button)
  expect(document.activeElement).toBe(input)
  expect(input?.value).toBe('second-token')

  button?.focus()
  act(() => root.render(<CopyableField id="link" label="Invite link" value="first-token" />))
  expect(host.querySelector('button')).toBe(button)
  expect(document.activeElement).toBe(button)
  expect(host.querySelector('[role="status"]')?.textContent).toBe('')
})

it('resets copied feedback when the value or disabled state changes', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
  act(() => root.render(<CopyableField id="link" label="Invite link" value="first-token" />))
  await act(async () => host.querySelector('button')?.click())
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied.')

  act(() => root.render(<CopyableField id="link" label="Invite link" value="second-token" />))
  expect(host.querySelector('[role="status"]')?.textContent).toBe('')
  act(() => root.render(<CopyableField id="link" label="Invite link" value="first-token" />))
  expect(host.querySelector('[role="status"]')?.textContent).toBe('')

  await act(async () => host.querySelector('button')?.click())
  act(() =>
    root.render(<CopyableField id="link" label="Invite link" value="first-token" disabled />),
  )
  expect(host.querySelector('[role="status"]')?.textContent).toBe('')
  expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
})
