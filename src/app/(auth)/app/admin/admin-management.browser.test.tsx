// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AdminManagement } from './admin-management'

const mocks = vi.hoisted(() => ({ notify: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('@/components/ui/Toast', () => ({ useToast: () => mocks.notify }))

const createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
const invitations = (['pending', 'used', 'revoked', 'expired'] as const).map((status) => ({
  id: status,
  label: `${status} invite`,
  createdAt,
  expiresAt: status === 'expired' ? createdAt : expiresAt,
  status,
}))

type Invitation = ComponentProps<typeof AdminManagement>['invitations'][number]

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
  vi.useRealTimers()
  host.remove()
  if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  mocks.notify.mockReset()
  mocks.refresh.mockReset()
})

function renderAdmin(items: Invitation[] = invitations) {
  act(() =>
    root.render(
      <AdminManagement
        invitations={[...items]}
        users={[
          { id: 'u1', email: 'runner@example.com', role: 'USER', status: 'ACTIVE', createdAt },
        ]}
      />,
    ),
  )
}

function revokeButton() {
  return host.querySelector<HTMLButtonElement>(
    'button[aria-label="Revoke invitation: pending invite"]',
  )
}

function filterButton(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('[aria-pressed]')].find((button) =>
    button.textContent?.startsWith(label),
  )
}

function invitationRows() {
  return [...host.querySelectorAll('section[aria-labelledby="invitations-title"] li')]
}

it('shows distinct invitation statuses, local dates, and revoke only for pending links', () => {
  renderAdmin()
  const badges = [...host.querySelectorAll('.badge')].map((badge) => ({
    label: badge.textContent,
    className: badge.className,
  }))
  expect(badges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        label: 'Pending',
        className: expect.stringContaining('badge--warning'),
      }),
      expect.objectContaining({
        label: 'Used',
        className: expect.stringContaining('badge--success'),
      }),
      expect.objectContaining({
        label: 'Revoked',
        className: expect.stringContaining('badge--error'),
      }),
      expect.objectContaining({ label: 'Expired', className: 'badge' }),
    ]),
  )
  expect(host.querySelectorAll('button[aria-label^="Revoke"]')).toHaveLength(1)
  expect(revokeButton()?.title).toBe('Revoke invitation')
  expect(revokeButton()?.querySelector('svg')).not.toBeNull()
  expect(host.querySelector('time')?.textContent).toBe(
    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(createdAt),
    ),
  )
  expect(host.querySelector('time')?.title).toBe(createdAt)
  expect(host.textContent).toContain('runner@example.com')
  expect(host.textContent).toContain('Active')
})

it('filters the loaded invitations with effective statuses and useful empty states', async () => {
  renderAdmin([
    ...invitations,
    { ...invitations[0], id: 'expired-pending', label: 'late invite', expiresAt: createdAt },
  ])
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(filterButton('All')?.textContent).toContain('5')
  expect(filterButton('Pending')?.textContent).toContain('1')
  expect(filterButton('Expired')?.textContent).toContain('2')
  act(() => filterButton('Expired')?.click())
  expect(filterButton('Expired')?.getAttribute('aria-pressed')).toBe('true')
  expect(invitationRows()).toHaveLength(2)
  expect(host.textContent).toContain('late invite')
  expect(host.querySelector('button[aria-label^="Revoke"]')).toBeNull()

  act(() => filterButton('Used')?.click())
  expect(invitationRows()).toHaveLength(1)
  expect(invitationRows()[0].textContent).toContain('used invite')

  renderAdmin([invitations[0]])
  expect(host.textContent).toContain('No used invitations in this list.')
  expect(filterButton('All')?.textContent).toContain('1')
  expect(filterButton('Used')?.textContent).toContain('0')
  act(() => filterButton('All')?.click())
  expect(invitationRows()).toHaveLength(1)
})

it('keeps filter counts in sync after a pending invite is revoked', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderAdmin([invitations[0]])
  act(() => filterButton('Pending')?.click())
  expect(invitationRows()).toHaveLength(1)
  await act(async () => revokeButton()?.click())
  expect(invitationRows()).toHaveLength(0)
  expect(host.textContent).toContain('No pending invitations in this list.')
  expect(filterButton('Pending')?.textContent).toContain('0')
  expect(filterButton('Revoked')?.textContent).toContain('1')
})

it('requires confirmation and removes a freshly generated link immediately after revocation', async () => {
  const url = `https://running.example/sign-up#token=${'a'.repeat(180)}`
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ id: 'pending', url, expiresAt }, { status: 201 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  renderAdmin([invitations[0]])

  await act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(host.querySelector<HTMLInputElement>('#new-invite-link')?.value).toBe(url)
  expect(host.querySelector('label[for="new-invite-link"]')?.textContent).toBe('Link to share')
  expect(host.textContent?.match(/New invite link/g)).toHaveLength(1)
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Copy link to share"]')?.click(),
  )
  expect(writeText).toHaveBeenCalledWith(url)
  expect(mocks.notify).toHaveBeenCalledWith(
    'success',
    'Invite link copied.',
    'admin-invite-activity',
  )

  await act(async () => revokeButton()?.click())
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(host.querySelector('#new-invite-link')).not.toBeNull()
  confirm.mockReturnValue(true)
  await act(async () => revokeButton()?.click())
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(host.querySelector('#new-invite-link')).toBeNull()
  expect(host.querySelector('button[aria-label^="Revoke"]')).toBeNull()
  expect(host.textContent).toContain('Revoked')
  expect(mocks.notify).toHaveBeenCalledWith(
    'success',
    expect.stringContaining('Invite revoked.'),
    'admin-invite-activity',
  )
})

it('hides a generated link when refreshed server data reports it used', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ id: 'pending', url: 'secret', expiresAt })),
  )
  renderAdmin([invitations[0]])
  await act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(host.querySelector('#new-invite-link')).not.toBeNull()
  renderAdmin([{ ...invitations[0], status: 'used' }])
  expect(host.querySelector('#new-invite-link')).toBeNull()
  expect(host.querySelector('button[aria-label^="Revoke"]')).toBeNull()
})

it('reports copy failure and keeps the full generated URL selectable', async () => {
  const url = `https://running.example/sign-up#token=${'b'.repeat(180)}`
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ id: 'pending', url, expiresAt })),
  )
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard unavailable')) },
  })
  renderAdmin([invitations[0]])
  await act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Copy link to share"]')?.click(),
  )
  expect(host.querySelector<HTMLInputElement>('#new-invite-link')?.value).toBe(url)
  expect(host.querySelector<HTMLInputElement>('#new-invite-link')?.readOnly).toBe(true)
  expect(mocks.notify).toHaveBeenCalledWith(
    'error',
    expect.stringContaining('Copy failed'),
    'admin-invite-activity',
  )
})

it('disables the revoke action while the request is pending', async () => {
  let finishRequest: ((response: Response) => void) | undefined
  const pendingRequest = new Promise<Response>((resolve) => {
    finishRequest = resolve
  })
  const fetchMock = vi.fn().mockReturnValue(pendingRequest)
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderAdmin([invitations[0]])
  act(() => revokeButton()?.click())
  expect(revokeButton()?.disabled).toBe(true)
  expect(revokeButton()?.getAttribute('aria-busy')).toBe('true')
  act(() => revokeButton()?.click())
  expect(fetchMock).toHaveBeenCalledOnce()
  await act(async () => finishRequest?.(new Response(null, { status: 204 })))
  expect(revokeButton()).toBeNull()
})

it('shows conflict feedback without claiming the invite was revoked', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 409 })))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderAdmin([invitations[0]])
  act(() => filterButton('Pending')?.click())
  await act(async () => revokeButton()?.click())
  expect(mocks.notify).toHaveBeenCalledWith(
    'warning',
    expect.stringContaining('no longer pending'),
    'admin-invite-activity',
  )
  expect(mocks.refresh).toHaveBeenCalled()
  expect(host.textContent).toContain('Checking status')
  expect(filterButton('All')?.getAttribute('aria-pressed')).toBe('true')
  expect(invitationRows()).toHaveLength(1)
  expect(revokeButton()).toBeNull()
  expect(host.querySelector('button[aria-label^="Check status for"]')).not.toBeNull()
})

it('preserves a filter selected while a status check is in flight', async () => {
  let finishStatusCheck: ((response: Response) => void) | undefined
  const statusCheck = new Promise<Response>((resolve) => {
    finishStatusCheck = resolve
  })
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockReturnValueOnce(statusCheck)
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderAdmin([invitations[0], invitations[1]])
  act(() => filterButton('Pending')?.click())

  await act(async () => {
    revokeButton()?.click()
    await Promise.resolve()
  })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  act(() => filterButton('Used')?.click())
  expect(filterButton('Used')?.getAttribute('aria-pressed')).toBe('true')

  await act(async () => finishStatusCheck?.(new Response(null, { status: 503 })))
  expect(filterButton('Used')?.getAttribute('aria-pressed')).toBe('true')
  expect(invitationRows()).toHaveLength(1)
  expect(invitationRows()[0].textContent).toContain('used invite')
})

it('hides a generated URL when revocation conflicts with a nonpending status', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ id: 'pending', url: 'one-time-url', expiresAt }, { status: 201 }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ invitations: [{ id: 'pending', status: 'used' }] }))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderAdmin([invitations[0]])
  await act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await act(async () => revokeButton()?.click())
  expect(host.querySelector('#new-invite-link')).toBeNull()
  expect(host.textContent).toContain('Used')
  expect(revokeButton()).toBeNull()
  expect(mocks.refresh).toHaveBeenCalled()
})

it('keeps the one-time URL but blocks copying until a retry verifies pending status', async () => {
  const url = 'https://running.example/sign-up#token=one-time-url'
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ id: 'pending', url, expiresAt }, { status: 201 }))
    .mockRejectedValueOnce(new Error('network unavailable'))
    .mockRejectedValueOnce(new Error('status check unavailable'))
    .mockResolvedValueOnce(Response.json({ invitations: [{ id: 'pending', status: 'pending' }] }))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderAdmin([invitations[0]])
  await act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  act(() => filterButton('Pending')?.click())
  await act(async () => revokeButton()?.click())
  expect(host.querySelector<HTMLInputElement>('#new-invite-link')?.value).toBe(url)
  expect(host.querySelector<HTMLInputElement>('#new-invite-link')?.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Copy link to share"]')?.disabled).toBe(
    true,
  )
  expect(host.textContent).toContain('Checking status')
  expect(filterButton('All')?.getAttribute('aria-pressed')).toBe('true')
  expect(invitationRows()).toHaveLength(1)
  expect(revokeButton()).toBeNull()
  expect(mocks.notify).toHaveBeenCalledWith(
    'warning',
    expect.stringContaining('Could not confirm revocation'),
    'admin-invite-activity',
  )
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label^="Check status for"]')?.click(),
  )
  expect(host.querySelector<HTMLInputElement>('#new-invite-link')?.disabled).toBe(false)
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Copy link to share"]')?.disabled).toBe(
    false,
  )
  expect(host.textContent).toContain('Pending')
  expect(revokeButton()).not.toBeNull()
  expect(mocks.refresh).toHaveBeenCalled()
})

it('marks a pending invite expired and removes revoke when its deadline passes', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(Date.parse(expiresAt) - 1000))
  renderAdmin([invitations[0]])
  act(() => vi.advanceTimersByTime(0))
  expect(host.textContent).toContain('Pending')
  expect(revokeButton()).not.toBeNull()
  act(() => vi.advanceTimersByTime(1000))
  expect(host.textContent).toContain('Expired')
  expect(revokeButton()).toBeNull()
})

it.each(['used', 'revoked'] as const)(
  'keeps a confirmed %s status after stale pending props pass their deadline',
  async (status) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.parse(expiresAt) - 1000))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ invitations: [{ id: 'pending', status }] }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderAdmin([invitations[0]])
    act(() => vi.advanceTimersByTime(0))

    await act(async () => revokeButton()?.click())
    expect(host.querySelector('.badge')?.textContent).toBe(
      status[0].toUpperCase() + status.slice(1),
    )
    act(() => vi.advanceTimersByTime(1000))
    expect(host.querySelector('.badge')?.textContent).toBe(
      status[0].toUpperCase() + status.slice(1),
    )
    expect(revokeButton()).toBeNull()
  },
)
