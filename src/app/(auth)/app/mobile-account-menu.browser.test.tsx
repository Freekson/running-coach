// @vitest-environment jsdom
import { act, useEffect, type ComponentPropsWithoutRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileAccountMenu } from './mobile-account-menu'
import { AppNavigation } from './navigation'
import { NavigationGuardProvider, useNavigationGuard } from './navigation-guard'

const { signOut, push, replace, refresh, navigatePrevented } = vi.hoisted(() => ({
  signOut: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  navigatePrevented: vi.fn(),
}))

vi.mock('@/lib/auth-client', () => ({ authClient: { signOut } }))
vi.mock('next/navigation', () => ({
  usePathname: () => '/app/settings',
  useRouter: () => ({ push, replace, refresh }),
}))
vi.mock('next/link', () => ({
  default: ({
    onNavigate,
    ...props
  }: ComponentPropsWithoutRef<'a'> & {
    onNavigate?: (event: { preventDefault: () => void }) => void
  }) => (
    <a
      {...props}
      onClick={(event) => {
        event.preventDefault()
        onNavigate?.({ preventDefault: navigatePrevented })
      }}
    />
  ),
}))

let host: HTMLDivElement
let root: Root
let proceed: (() => void) | null
let breakpointListener: (() => void) | undefined
let desktop: boolean

function BlockLeaving() {
  const { registerBlocker } = useNavigationGuard()
  useEffect(
    () =>
      registerBlocker((continueLeaving) => {
        proceed = continueLeaving
      }),
    [registerBlocker],
  )
  return null
}

async function renderAccount(role: 'USER' | 'ADMIN' = 'USER', blocked = false) {
  await act(async () =>
    root.render(
      <NavigationGuardProvider>
        {blocked && <BlockLeaving />}
        <MobileAccountMenu identity="Avery Runner" initial="A" role={role} />
        <AppNavigation role={role} />
        <button>Outside</button>
      </NavigationGuardProvider>,
    ),
  )
}

function trigger() {
  return host.querySelector<HTMLButtonElement>('[aria-label="Account"]')!
}

function panel() {
  return host.querySelector<HTMLDivElement>('[role="region"]')!
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  desktop = false
  breakpointListener = undefined
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return desktop
    },
    addEventListener: (_: string, listener: () => void) => {
      breakpointListener = listener
    },
    removeEventListener: vi.fn(),
  }))
  signOut.mockResolvedValue({ error: null })
  proceed = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

it('opens an account disclosure with identity and closes with Escape, restoring focus', async () => {
  await renderAccount()
  expect(panel().hidden).toBe(true)
  expect(trigger().getAttribute('aria-expanded')).toBe('false')
  act(() => trigger().click())
  expect(panel().hidden).toBe(false)
  expect(trigger().getAttribute('aria-controls')).toBe(panel().id)
  expect(panel().textContent).toContain('Avery Runner')
  expect(panel().querySelector('a')).toBeNull()
  act(() => panel().querySelector('button')!.focus())
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(panel().hidden).toBe(true)
  expect(document.activeElement).toBe(trigger())
})

it('closes when clicking outside, tabbing out, navigating back, or switching to desktop', async () => {
  await renderAccount()
  act(() => trigger().click())
  act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
  expect(panel().hidden).toBe(true)
  act(() => {
    trigger().click()
    trigger().focus()
  })
  act(() => host.querySelector<HTMLButtonElement>(':scope > button')!.focus())
  expect(panel().hidden).toBe(true)
  act(() => trigger().click())
  act(() => window.dispatchEvent(new PopStateEvent('popstate')))
  expect(panel().hidden).toBe(true)
  act(() => trigger().click())
  act(() => {
    desktop = true
    breakpointListener?.()
  })
  expect(panel().hidden).toBe(true)
})

it('waits for unsaved changes confirmation before navigating to Admin from the account', async () => {
  await renderAccount('ADMIN', true)
  act(() => trigger().click())
  act(() => panel().querySelector<HTMLAnchorElement>('a[href="/app/admin"]')!.click())
  expect(navigatePrevented).toHaveBeenCalledOnce()
  expect(push).not.toHaveBeenCalled()
  expect(panel().hidden).toBe(true)
  act(() => proceed?.())
  expect(push).toHaveBeenCalledWith('/app/admin')
})

it('keeps the unsaved changes guard on the bottom navigation', async () => {
  await renderAccount('USER', true)
  act(() => host.querySelector<HTMLAnchorElement>('nav a[href="/app/training"]')!.click())
  expect(navigatePrevented).toHaveBeenCalledOnce()
  expect(push).not.toHaveBeenCalled()
  act(() => proceed?.())
  expect(push).toHaveBeenCalledWith('/app/training')
})

it('opens Training and closes its submenu with Escape, restoring keyboard focus', async () => {
  await renderAccount()
  const training = host.querySelector<HTMLButtonElement>(
    'button[aria-controls="training-navigation"]',
  )!
  const submenu = host.querySelector<HTMLDivElement>('#training-navigation')!
  expect(submenu.getAttribute('aria-hidden')).toBe('true')
  expect(submenu.hasAttribute('inert')).toBe(true)
  act(() => training.click())
  expect(submenu.getAttribute('aria-hidden')).toBe('false')
  expect(submenu.hasAttribute('inert')).toBe(false)
  const goals = submenu.querySelector<HTMLAnchorElement>('a[href="/app/goals"]')!
  goals.focus()
  act(() => goals.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(submenu.getAttribute('aria-hidden')).toBe('true')
  expect(submenu.hasAttribute('inert')).toBe(true)
  expect(document.activeElement).toBe(training)
})

it('keeps submenu accessibility synchronized when toggled rapidly during animation', async () => {
  await renderAccount()
  const training = host.querySelector<HTMLButtonElement>(
    'button[aria-controls="training-navigation"]',
  )!
  const submenu = host.querySelector<HTMLDivElement>('#training-navigation')!
  act(() => training.click())
  act(() => training.click())
  act(() => training.click())
  expect(training.getAttribute('aria-expanded')).toBe('true')
  expect(submenu.getAttribute('aria-hidden')).toBe('false')
  expect(submenu.hasAttribute('inert')).toBe(false)
})

it('guards Goals navigation when profile edits are unsaved', async () => {
  await renderAccount('USER', true)
  act(() =>
    host.querySelector<HTMLButtonElement>('button[aria-controls="training-navigation"]')!.click(),
  )
  act(() => host.querySelector<HTMLAnchorElement>('nav a[href="/app/goals"]')!.click())
  expect(navigatePrevented).toHaveBeenCalledOnce()
  expect(push).not.toHaveBeenCalled()
  act(() => proceed?.())
  expect(push).toHaveBeenCalledWith('/app/goals')
})

it('waits for unsaved changes confirmation before signing out from the account', async () => {
  await renderAccount('USER', true)
  act(() => trigger().click())
  await act(async () => panel().querySelector<HTMLButtonElement>('button')!.click())
  expect(signOut).not.toHaveBeenCalled()
  await act(async () => proceed?.())
  expect(signOut).toHaveBeenCalledOnce()
  expect(replace).toHaveBeenCalledWith('/sign-in')
  expect(refresh).toHaveBeenCalledOnce()
})

it('keeps sign-out errors visible and allows retry without redirecting', async () => {
  signOut.mockResolvedValueOnce({ error: { message: 'Unavailable' } })
  await renderAccount()
  act(() => trigger().click())
  await act(async () => panel().querySelector<HTMLButtonElement>('button')!.click())
  expect(panel().hidden).toBe(false)
  expect(panel().querySelector('[role="alert"]')?.textContent).toContain('Sign out failed')
  expect(replace).not.toHaveBeenCalled()
  await act(async () => panel().querySelector<HTMLButtonElement>('button')!.click())
  expect(replace).toHaveBeenCalledWith('/sign-in')
})
