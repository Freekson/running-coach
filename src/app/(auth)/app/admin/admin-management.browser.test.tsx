// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AdminManagement } from './admin-management'

const notify = vi.fn()
vi.mock('@/components/ui/Toast', () => ({ useToast: () => notify }))
const createdAt = new Date(Date.now() - 86_400_000).toISOString()
const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
const invitation = {
  id: 'pending',
  revision: 'a'.repeat(64),
  label: 'Friend',
  createdAt,
  expiresAt,
  status: 'pending' as const,
}
const counts = { all: 11, pending: 11, processing: 0, used: 0, revoked: 0, expired: 0 }
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <AdminManagement
        invitations={[invitation]}
        invitationPage={1}
        invitationTotal={11}
        invitationCounts={counts}
        users={[
          { id: 'u1', email: 'runner@example.test', role: 'USER', status: 'ACTIVE', createdAt },
          { id: 'u2', email: 'admin@example.test', role: 'ADMIN', status: 'ACTIVE', createdAt },
        ]}
        userPage={1}
        userTotal={11}
      />,
    ),
  )
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  notify.mockReset()
})
function button(name: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
  )
}

it('shows a copyable invitation link after generation and disables the pending action', async () => {
  const url = 'https://coach.example.test/sign-up#token=created'
  expect(host.querySelector('label[for="invite-label"]')?.textContent).toBe(
    'Description (optional)',
  )
  expect(host.querySelector<HTMLInputElement>('#invite-label')?.placeholder).toBe(
    'e.g. Invitation for John',
  )
  let finish: ((response: Response) => void) | undefined
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
    )
    .mockResolvedValueOnce(Response.json({ invitations: [invitation], page: 1, total: 11, counts }))
  vi.stubGlobal('fetch', fetchMock)

  act(() => button('Generate link')?.click())
  expect(button('Generate link')?.disabled).toBe(true)
  expect(fetchMock).toHaveBeenCalledWith('/api/admin/invitations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: null }),
  })

  await act(async () => finish?.(Response.json({ id: 'created', url, expiresAt })))
  expect(host.textContent).toContain('Invitation created')
  expect(host.querySelector<HTMLInputElement>('#new-invite-link')?.value).toBe(url)
  expect(button('Copy link to share')).toBeDefined()
  expect(host.textContent).toContain("Save this link now. It won't be shown again")
  expect(button('Generate link')?.disabled).toBe(false)
})

it('loads invitation and user pages independently', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ invitations: [], page: 2, total: 11, counts }))
    .mockResolvedValueOnce(Response.json({ users: [], page: 2, total: 11 }))
  vi.stubGlobal('fetch', fetchMock)
  const navs = host.querySelectorAll('nav[aria-label$="pages"]')
  await act(async () => navs[0].querySelectorAll('button')[1].click())
  expect(fetchMock).toHaveBeenCalledWith('/api/admin/invitations?page=2&status=all', {
    cache: 'no-store',
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await act(async () => navs[1].querySelectorAll('button')[1].click())
  expect(fetchMock).toHaveBeenCalledWith('/api/admin/users?page=2', { cache: 'no-store' })
  expect(host.textContent).toContain('2 / 3')
  expect(host.textContent).toContain('6–10 of 11')
})

it('keeps both list regions visible with centered loading indicators', async () => {
  let finishInvites: ((response: Response) => void) | undefined
  let finishUsers: ((response: Response) => void) | undefined
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finishInvites = resolve
      }),
    )
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finishUsers = resolve
      }),
    )
  vi.stubGlobal('fetch', fetchMock)
  const navs = host.querySelectorAll('nav[aria-label$="pages"]')
  act(() => navs[0].querySelectorAll('button')[1].click())
  act(() => navs[1].querySelectorAll('button')[1].click())
  const inviteRegion = host.querySelector('[aria-label="Invitation rows"]')
  const userRegion = host.querySelector('[aria-label="Registered user rows"]')
  expect(inviteRegion?.getAttribute('aria-busy')).toBe('true')
  expect(userRegion?.getAttribute('aria-busy')).toBe('true')
  expect(inviteRegion?.querySelector('[role="status"] span[aria-hidden="true"]')).not.toBeNull()
  expect(userRegion?.querySelector('[role="status"] span[aria-hidden="true"]')).not.toBeNull()
  expect(inviteRegion?.querySelectorAll('tbody tr')).toHaveLength(5)
  expect(userRegion?.querySelectorAll('tbody tr')).toHaveLength(5)
  await act(async () => {
    finishInvites?.(Response.json({ invitations: [], page: 2, total: 11, counts }))
    finishUsers?.(Response.json({ users: [], page: 2, total: 11 }))
  })
  expect(inviteRegion?.getAttribute('aria-busy')).toBeNull()
  expect(userRegion?.getAttribute('aria-busy')).toBeNull()
})

it('renders semantic columns and five stable row slots for both lists', () => {
  const tables = host.querySelectorAll('table')
  expect(tables).toHaveLength(2)
  expect([...tables[0].querySelectorAll('th')].map((cell) => cell.textContent)).toEqual([
    'Invitation',
    'Created',
    'Expires',
    'Status',
    'Actions',
  ])
  expect([...tables[1].querySelectorAll('th')].map((cell) => cell.textContent)).toEqual([
    'User',
    'Joined',
    'Role',
  ])
  expect(tables[0].querySelectorAll('tbody tr')).toHaveLength(5)
  expect(tables[1].querySelectorAll('tbody tr')).toHaveLength(5)
  expect(tables[0].querySelectorAll('tbody tr[aria-hidden="true"]')).toHaveLength(4)
  expect(tables[1].querySelectorAll('tbody tr[aria-hidden="true"]')).toHaveLength(3)
  expect(tables[1].querySelector('tbody tr:not([aria-hidden]) td:last-child')?.textContent).toBe(
    'USER',
  )
  expect(
    tables[1].querySelectorAll('tbody tr:not([aria-hidden])')[1].lastElementChild?.textContent,
  ).toBe('ADMIN')
  expect(
    tables[1].querySelectorAll('tbody tr:not([aria-hidden])')[1].querySelector('svg'),
  ).not.toBeNull()
})

it('does not revoke until the destructive dialog is confirmed', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(
      Response.json({
        invitations: [],
        page: 1,
        total: 0,
        counts: { ...counts, all: 0, pending: 0, revoked: 1 },
      }),
    )
  vi.stubGlobal('fetch', fetchMock)
  act(() => button('Revoke invitation: Friend')?.click())
  expect(host.querySelector('dialog[open]')?.textContent).toContain('stop working immediately')
  act(() => button('Cancel')?.click())
  expect(fetchMock).not.toHaveBeenCalled()
  act(() => button('Revoke invitation: Friend')?.click())
  await act(async () => button('Revoke invitation')?.click())
  expect(fetchMock).toHaveBeenCalledWith('/api/admin/invitations/pending', { method: 'DELETE' })
  expect(host.querySelector('dialog[open]')).toBeNull()
  expect(host.querySelector('[aria-label="Invitation rows"]')?.textContent).toContain(
    'No invitations yet',
  )
  expect(notify).toHaveBeenCalledWith(
    'success',
    'Invite revoked. Generate a new link if you need a replacement.',
    'admin-invite-activity',
  )
})

it('rotates only after confirmation and clears the one-time link on close', async () => {
  const url = 'https://coach.example.test/sign-up#token=fresh'
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ id: 'pending', url, expiresAt }))
    .mockResolvedValueOnce(Response.json({ invitations: [invitation], page: 1, total: 11, counts }))
  vi.stubGlobal('fetch', fetchMock)
  act(() => button('Regenerate invitation link')?.click())
  expect(fetchMock).not.toHaveBeenCalled()
  const confirmationDialog = host.querySelector('dialog[open]')
  expect(host.querySelector('dialog[open]')?.textContent).toContain(
    'previous link will stop working immediately',
  )
  await act(async () => button('Regenerate link')?.click())
  expect(fetchMock).toHaveBeenCalledWith('/api/admin/invitations/pending/regenerate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: invitation.revision }),
  })
  expect(host.querySelector('dialog[open]')).toBe(confirmationDialog)
  expect(confirmationDialog?.textContent).toContain('Invitation regenerated')
  expect(confirmationDialog?.textContent).toContain('previous link is no longer valid')
  expect(host.querySelector<HTMLInputElement>('#regenerated-invite-link')?.value).toBe(url)
  act(() => button('Close dialog')?.click())
  expect(host.querySelector('#regenerated-invite-link')).toBeNull()
})

it('keeps the dialog open and blocks duplicate regeneration while the request is pending', async () => {
  let finish: ((response: Response) => void) | undefined
  const pendingRequest = new Promise<Response>((resolve) => {
    finish = resolve
  })
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(pendingRequest)
    .mockResolvedValueOnce(Response.json({ invitations: [invitation], page: 1, total: 11, counts }))
  vi.stubGlobal('fetch', fetchMock)
  act(() => button('Regenerate invitation link')?.click())
  act(() => button('Regenerate link')?.click())
  expect(button('Regenerate link')?.disabled).toBe(true)
  act(() => button('Close dialog')?.click())
  expect(host.querySelector('dialog[open]')).not.toBeNull()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await act(async () => finish?.(new Response(null, { status: 409 })))
  expect(host.querySelector('dialog[open]')).toBeNull()
})

it('resets the invitation page on filter changes without loading users', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      Response.json({ invitations: [], page: 1, total: 0, counts: { ...counts, used: 0 } }),
    )
  vi.stubGlobal('fetch', fetchMock)
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>('[aria-pressed]')]
      .find((item) => item.textContent?.startsWith('Used'))
      ?.click(),
  )
  expect(fetchMock).toHaveBeenCalledWith('/api/admin/invitations?page=1&status=used', {
    cache: 'no-store',
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
