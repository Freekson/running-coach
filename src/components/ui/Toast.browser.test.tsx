// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ToastProvider, useToast } from './Toast'

const navigationState = vi.hoisted(() => ({ nullSearchParams: false }))

vi.mock('next/navigation', () => ({
  useSearchParams: () =>
    navigationState.nullSearchParams ? null : new URLSearchParams(window.location.search),
}))

let root: Root
let host: HTMLDivElement

function Trigger() {
  const toast = useToast()
  return <button onClick={() => toast('success', 'Saved')}>Notify</button>
}

function ReplacementTrigger() {
  const toast = useToast()
  return (
    <>
      <button onClick={() => toast('success', 'Invite link copied.', 'invite-action')}>
        Copy feedback
      </button>
      <button onClick={() => toast('success', 'Invite revoked.', 'invite-action')}>
        Revoke feedback
      </button>
    </>
  )
}

function App() {
  const [, rerender] = useState(0)
  return (
    <ToastProvider>
      <Trigger />
      <button onClick={() => rerender((value) => value + 1)}>Route update</button>
    </ToastProvider>
  )
}

beforeEach(() => {
  navigationState.nullSearchParams = false
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.history.replaceState({}, '', '/')
  document.body.innerHTML = '<main id="main-content" tabindex="-1"></main><div id="root"></div>'
  host = document.getElementById('root') as HTMLDivElement
  root = createRoot(host)
})

it('renders transient toasts when Storybook provides no search params context', () => {
  navigationState.nullSearchParams = true
  act(() => root.render(<App />))
  act(() => host.querySelector<HTMLButtonElement>('button')?.click())
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Saved')
})

afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

it('consumes a redirect notice once and handles a same-path query navigation', () => {
  window.history.replaceState({}, '', '/?notice=missing-invite&keep=1')
  act(() => root.render(<App />))
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
  expect(window.location.search).toBe('?keep=1')

  act(() => host.querySelector<HTMLButtonElement>('button:nth-of-type(2)')?.click())
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)

  window.history.pushState({}, '', '/?notice=missing-invite')
  act(() => host.querySelector<HTMLButtonElement>('button:nth-of-type(2)')?.click())
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(2)
  expect(window.location.search).toBe('')
})

it('dismisses transient messages and pauses the timeout while focused', () => {
  vi.useFakeTimers()
  act(() => root.render(<App />))
  act(() => host.querySelector<HTMLButtonElement>('button')?.click())
  const dismiss = host.querySelector<HTMLButtonElement>('[aria-label^="Dismiss notification"]')
  expect(dismiss).not.toBeNull()
  act(() => vi.advanceTimersByTime(4999))
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(1)

  dismiss?.focus()
  act(() => vi.advanceTimersByTime(1))
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(1)
  document.getElementById('main-content')?.focus()
  act(() => vi.advanceTimersByTime(1000))
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(0)
})

it('moves keyboard focus to the next toast dismiss action', () => {
  act(() => root.render(<App />))
  act(() => host.querySelector<HTMLButtonElement>('button')?.click())
  act(() => host.querySelector<HTMLButtonElement>('button')?.click())
  const buttons = host.querySelectorAll<HTMLButtonElement>('[aria-label^="Dismiss notification"]')
  buttons[0].focus()
  act(() => buttons[0].click())
  expect(document.activeElement).toBe(buttons[1])
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(1)
})

it('keeps the focused toast when more than three notifications stack', () => {
  act(() => root.render(<App />))
  for (let count = 0; count < 3; count++) {
    act(() => host.querySelector<HTMLButtonElement>('button')?.click())
  }
  const focused = host.querySelector<HTMLButtonElement>('[data-toast-id="1"] button')
  focused?.focus()

  act(() => host.querySelector<HTMLButtonElement>('button')?.click())
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(3)
  expect(host.querySelector('[data-toast-id="1"] button')).toBe(focused)
  expect(document.activeElement).toBe(focused)
})

it('replaces keyed feedback and resets its dismissal timer', () => {
  vi.useFakeTimers()
  act(() =>
    root.render(
      <ToastProvider>
        <ReplacementTrigger />
      </ToastProvider>,
    ),
  )
  const buttons = host.querySelectorAll<HTMLButtonElement>('button')
  act(() => buttons[0].click())
  expect(host.querySelectorAll('[data-toast-id]')).toHaveLength(1)
  act(() => vi.advanceTimersByTime(4000))
  act(() => buttons[1].click())
  expect(host.querySelectorAll('[data-toast-id]')).toHaveLength(1)
  expect(host.textContent).not.toContain('Invite link copied.')
  expect(host.textContent).toContain('Invite revoked.')
  act(() => vi.advanceTimersByTime(1000))
  expect(host.querySelectorAll('[data-toast-id]')).toHaveLength(1)
  act(() => vi.advanceTimersByTime(4000))
  expect(host.querySelectorAll('[data-toast-id]')).toHaveLength(0)
})
