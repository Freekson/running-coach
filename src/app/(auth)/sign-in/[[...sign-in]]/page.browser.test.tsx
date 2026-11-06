// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:3000/sign-in"}

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { signInEmail, replace, refresh } = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('@/lib/auth-client', () => ({ authClient: { signIn: { email: signInEmail } } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, refresh }) }))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

import SignInPage from './page'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<SignInPage />))
  const email = host.querySelector<HTMLInputElement>('[name="email"]')!
  const password = host.querySelector<HTMLInputElement>('[name="password"]')!
  email.value = 'runner@example.test'
  password.value = 'a-long-password'
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function submit() {
  host
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

it('shows loading, disables the form, and blocks duplicate sign-in requests', async () => {
  let finish: ((result: { error: { message: string } }) => void) | undefined
  signInEmail.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )

  act(submit)
  const button = host.querySelector<HTMLButtonElement>('button[type="submit"]')!
  expect(button.disabled).toBe(true)
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(button.querySelector('.button__spinner')).not.toBeNull()
  expect(host.querySelector('form')?.getAttribute('aria-busy')).toBe('true')
  expect(host.querySelector<HTMLInputElement>('[name="email"]')?.disabled).toBe(true)
  expect(host.querySelector<HTMLInputElement>('[name="password"]')?.disabled).toBe(true)
  act(submit)
  expect(signInEmail).toHaveBeenCalledOnce()

  await act(async () => finish?.({ error: { message: 'Invalid credentials' } }))
  expect(button.disabled).toBe(false)
  expect(button.querySelector('.button__spinner')).toBeNull()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Sign in failed')
})

it('keeps loading through navigation after successful sign-in', async () => {
  signInEmail.mockResolvedValue({ error: null })
  await act(async () => submit())
  expect(replace).toHaveBeenCalledWith('/app/dashboard')
  expect(refresh).toHaveBeenCalledOnce()
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
})
