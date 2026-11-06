// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:3000/"}

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { replace, notify, routerMock } = vi.hoisted(() => {
  const replace = vi.fn()
  const refresh = vi.fn()
  return { replace, notify: vi.fn(), routerMock: { replace, refresh } }
})
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => notify }))

import SignUpPage from './page'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.body.innerHTML = '<div id="root"></div>'
  host = document.getElementById('root') as HTMLDivElement
  root = createRoot(host)
  window.history.replaceState({}, '', '/sign-up')
  window.sessionStorage.clear()
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function renderWithInvite(status = 'valid') {
  window.history.replaceState({}, '', `/sign-up#token=${'a'.repeat(64)}`)
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    void _input
    void _init
    return Response.json({ status })
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => {
    root.render(<SignUpPage />)
  })
  return fetchMock
}

async function remountPage() {
  act(() => root.unmount())
  root = createRoot(host)
  await act(async () => {
    root.render(<SignUpPage />)
  })
}

it('redirects without rendering a signup form when the fragment is missing', () => {
  act(() => root.render(<SignUpPage />))
  expect(host.querySelector('form')).toBeNull()
  expect(replace).toHaveBeenCalledWith('/?notice=missing-invite')
})

it('restores the invite on refresh of the same history entry', async () => {
  const fetchMock = await renderWithInvite()
  expect(window.location.hash).toBe('')
  expect(host.querySelector('form')).not.toBeNull()
  await remountPage()
  expect(host.querySelector('form')).not.toBeNull()
  expect(replace).not.toHaveBeenCalled()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('redirects a new history entry without a token even when the tab stored an invite', async () => {
  const fetchMock = await renderWithInvite()
  const inviteEntryState = window.history.state
  window.history.pushState({}, '', '/sign-up')
  await remountPage()
  expect(host.querySelector('form')).toBeNull()
  expect(replace).toHaveBeenCalledWith('/?notice=missing-invite')
  window.history.replaceState(inviteEntryState, '', '/sign-up')
  await remountPage()
  expect(host.querySelector('form')).not.toBeNull()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('checks a new invitation fragment in the same tab', async () => {
  const fetchMock = await renderWithInvite('expired')
  expect(host.querySelector('form')).toBeNull()
  fetchMock.mockImplementationOnce(async () => Response.json({ status: 'valid' }))
  window.history.pushState(window.history.state, '', `/sign-up#token=${'b'.repeat(64)}`)
  await act(async () => {
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
  expect(host.querySelector('form')).not.toBeNull()
  expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain('b'.repeat(64))
})

it('ignores an older signup response after a new invitation opens', async () => {
  const fetchMock = await renderWithInvite()
  let resolveSignup: (response: Response) => void = () => {
    throw new Error('Signup was not started')
  }
  fetchMock.mockImplementationOnce(
    async () =>
      new Promise<Response>((resolve) => {
        resolveSignup = resolve
      }),
  )
  for (const [name, value] of Object.entries({
    name: 'Runner',
    email: 'runner@example.test',
    password: 'long-enough-password',
  })) {
    const input = host.querySelector<HTMLInputElement>(`[name="${name}"]`)
    if (!input) throw new Error(`Missing ${name}`)
    input.value = value
  }
  await act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  fetchMock.mockImplementationOnce(async () => Response.json({ status: 'valid' }))
  window.history.pushState(window.history.state, '', `/sign-up#token=${'b'.repeat(64)}`)
  await act(async () => {
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
  expect(host.querySelector('form')).not.toBeNull()
  await act(async () => {
    resolveSignup(
      new Response(null, {
        status: 422,
        headers: { 'X-Running-Coach-Error': 'duplicate-email' },
      }),
    )
  })
  expect(host.querySelector('#email-error')).toBeNull()
  expect(host.querySelector('form')).not.toBeNull()
  expect(notify).not.toHaveBeenCalled()
  expect(replace).not.toHaveBeenCalled()
})

it('ignores an older invitation status response after a new link opens', async () => {
  window.history.replaceState({}, '', `/sign-up#token=${'a'.repeat(64)}`)
  let resolveOldStatus: (response: Response) => void = () => {
    throw new Error('Status check was not started')
  }
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveOldStatus = resolve
        }),
    )
    .mockImplementationOnce(async () => Response.json({ status: 'valid' }))
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => {
    root.render(<SignUpPage />)
  })
  window.history.pushState(window.history.state, '', `/sign-up#token=${'b'.repeat(64)}`)
  await act(async () => {
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
  await act(async () => {
    resolveOldStatus(Response.json({ status: 'expired' }))
  })
  expect(host.querySelector('form')).not.toBeNull()
  expect(host.textContent).not.toContain('Invitation unavailable')
})

it('restores the correct token when navigating back across two invite entries', async () => {
  const fetchMock = await renderWithInvite()
  const firstEntryState = window.history.state
  window.history.pushState(window.history.state, '', `/sign-up#token=${'b'.repeat(64)}`)
  await act(async () => {
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
  expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain('b'.repeat(64))
  window.history.replaceState(firstEntryState, '', '/sign-up')
  await act(async () => {
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  expect(host.querySelector('form')).not.toBeNull()
  expect(String(fetchMock.mock.calls[2]?.[1]?.body)).toContain('a'.repeat(64))
})

it.each(['invalid', 'expired', 'revoked', 'used'])(
  'blocks a %s invitation before showing fields',
  async (status) => {
    await renderWithInvite(status)
    expect(host.querySelector('form')).toBeNull()
    expect(host.textContent).toContain('Invitation unavailable')
    expect(notify).toHaveBeenCalledWith('error', expect.any(String), 'signup-invitation')
  },
)

it('keeps a processing invitation available for a later status check', async () => {
  const fetchMock = await renderWithInvite('processing')
  expect(host.querySelector('form')).toBeNull()
  expect(host.textContent).toContain('in progress')
  fetchMock.mockImplementationOnce(async () => Response.json({ status: 'valid' }))
  await act(async () => {
    host.querySelector('button')?.click()
  })
  expect(host.querySelector('form')).not.toBeNull()
})

it('points a duplicate email to Email, leaves Password valid, and offers sign in', async () => {
  const fetchMock = await renderWithInvite()
  fetchMock.mockImplementationOnce(
    async () =>
      new Response(null, {
        status: 422,
        headers: { 'X-Running-Coach-Error': 'duplicate-email' },
      }),
  )
  for (const [name, value] of Object.entries({
    name: 'Runner',
    email: 'used@example.test',
    password: 'long-enough-password',
  })) {
    const input = host.querySelector<HTMLInputElement>(`[name="${name}"]`)
    if (!input) throw new Error(`Missing ${name}`)
    await act(async () => {
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  await act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(host.querySelector('#email')?.getAttribute('aria-invalid')).toBe('true')
  expect(host.querySelector('#email-error')?.textContent).toBe(
    'An account with this email already exists.',
  )
  expect(host.querySelector('#password')?.hasAttribute('aria-invalid')).toBe(false)
  expect(document.activeElement?.id).toBe('email')
  expect(host.querySelector('a[href="/sign-in"]')?.textContent).toBe('Sign in instead')
})

it('keeps local validation by its fields and does not submit invalid details', async () => {
  const fetchMock = await renderWithInvite()
  await act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(host.querySelector('#name')?.getAttribute('aria-invalid')).toBe('true')
  expect(host.querySelector('#email')?.getAttribute('aria-invalid')).toBe('true')
  expect(host.querySelector('#password')?.getAttribute('aria-invalid')).toBe('true')
  expect(host.querySelector('#email-error')?.getAttribute('role')).toBe('alert')
  expect(document.activeElement?.id).toBe('name')
})

it('uses a transient toast for a server failure', async () => {
  const fetchMock = await renderWithInvite()
  fetchMock.mockImplementationOnce(async () => new Response(null, { status: 500 }))
  for (const [name, value] of Object.entries({
    name: 'Runner',
    email: 'new@example.test',
    password: 'long-enough-password',
  })) {
    const input = host.querySelector<HTMLInputElement>(`[name="${name}"]`)
    if (!input) throw new Error(`Missing ${name}`)
    input.value = value
  }
  await act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(notify).toHaveBeenCalledWith(
    'error',
    'Registration could not finish. Try again.',
    'signup-error',
  )
  expect(host.querySelector('#email-error')).toBeNull()
  expect(host.querySelector('form [role="alert"]')).toBeNull()
})

it('does not suggest retrying an uncertain registration outcome', async () => {
  const fetchMock = await renderWithInvite()
  fetchMock.mockImplementationOnce(
    async () =>
      new Response(null, {
        status: 503,
        headers: { 'X-Running-Coach-Error': 'registration-outcome-unknown' },
      }),
  )
  for (const [name, value] of Object.entries({
    name: 'Runner',
    email: 'new@example.test',
    password: 'long-enough-password',
  })) {
    const input = host.querySelector<HTMLInputElement>(`[name="${name}"]`)
    if (!input) throw new Error(`Missing ${name}`)
    input.value = value
  }
  await act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(notify).toHaveBeenCalledWith(
    'error',
    'Registration may have completed. Try signing in or ask for a new invitation.',
    'signup-error',
  )
  expect(host.querySelector('form')).toBeNull()
  expect(host.querySelector('a[href="/sign-in"]')).not.toBeNull()
})

it('checks invitation status after a lost signup response before offering another attempt', async () => {
  const fetchMock = await renderWithInvite()
  fetchMock.mockImplementationOnce(async () => {
    throw new TypeError('Failed to fetch')
  })
  for (const [name, value] of Object.entries({
    name: 'Runner',
    email: 'new@example.test',
    password: 'long-enough-password',
  })) {
    const input = host.querySelector<HTMLInputElement>(`[name="${name}"]`)
    if (!input) throw new Error(`Missing ${name}`)
    input.value = value
  }
  await act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(host.querySelector('form')).toBeNull()
  expect(host.textContent).toContain('Registration may have completed')
  expect(host.querySelector('a[href="/sign-in"]')).not.toBeNull()
  expect(fetchMock).toHaveBeenCalledTimes(2)

  fetchMock.mockImplementationOnce(async () => Response.json({ status: 'used' }))
  await act(async () => host.querySelector<HTMLButtonElement>('button')?.click())
  expect(host.querySelector('form')).toBeNull()
  expect(host.textContent).toContain('already been used')
  expect(host.querySelector('a[href="/sign-in"]')).not.toBeNull()
  expect(fetchMock).toHaveBeenCalledTimes(3)
})
