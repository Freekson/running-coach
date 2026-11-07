// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NavigationGuardProvider, useNavigationGuard } from './app/navigation-guard'
import { SignOutButton } from './sign-out-button'

const { signOut, replace, refresh } = vi.hoisted(() => ({
  signOut: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('@/lib/auth-client', () => ({ authClient: { signOut } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, refresh }) }))

let host: HTMLDivElement
let root: Root
let proceed: (() => void) | null

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

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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

it('waits for the navigation guard before signing out', async () => {
  await act(async () =>
    root.render(
      <NavigationGuardProvider>
        <BlockLeaving />
        <SignOutButton />
      </NavigationGuardProvider>,
    ),
  )
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(proceed).toBeTypeOf('function')
  expect(signOut).not.toHaveBeenCalled()
  await act(async () => proceed?.())
  await vi.waitFor(() => expect(signOut).toHaveBeenCalledOnce())
  expect(replace).toHaveBeenCalledWith('/sign-in')
  expect(refresh).toHaveBeenCalledOnce()
})

it('signs out immediately when there are no pending edits', async () => {
  await act(async () =>
    root.render(
      <NavigationGuardProvider>
        <SignOutButton />
      </NavigationGuardProvider>,
    ),
  )
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(host.querySelector<HTMLButtonElement>('button')?.className).toContain('button--secondary')
  expect(host.querySelector<HTMLButtonElement>('button')?.className).toContain('button--compact')
  expect(signOut).toHaveBeenCalledOnce()
})
