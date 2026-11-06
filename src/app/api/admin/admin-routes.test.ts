import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getCurrentUser,
  createInvitation,
  listInvitations,
  checkInvitationStatus,
  revokeInvitation,
  listRegisteredUsers,
} = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  createInvitation: vi.fn(),
  listInvitations: vi.fn(),
  checkInvitationStatus: vi.fn(),
  revokeInvitation: vi.fn(),
  listRegisteredUsers: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  AccountUnavailableError: class AccountUnavailableError extends Error {},
  getCurrentUser,
}))
vi.mock('@/server/auth/invitation-management', () => ({
  createInvitation,
  listInvitations,
  checkInvitationStatus,
  revokeInvitation,
  listRegisteredUsers,
}))

import { GET as getInvitations, POST as createInvite } from './invitations/route'
import { DELETE as revokeInvite } from './invitations/[id]/route'
import { POST as checkInvite } from './invitations/[id]/status/route'
import { GET as getUsers } from './users/route'

const id = '3b759a5a-6069-4f03-b17c-75111709f039'
const url = `https://coach.example.test/api/admin/invitations/${id}`
const createRequest = () =>
  new Request('https://coach.example.test/api/admin/invitations', {
    method: 'POST',
    headers: { Origin: 'https://coach.example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Friend' }),
  })
const deleteRequest = (origin = 'https://coach.example.test') =>
  new Request(url, { method: 'DELETE', headers: { Origin: origin } })
const checkRequest = (origin = 'https://coach.example.test') =>
  new Request(`${url}/status`, { method: 'POST', headers: { Origin: origin } })
const context = { params: Promise.resolve({ id }) } as Parameters<typeof revokeInvite>[1]

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'admin-a', role: 'ADMIN' })
  listInvitations.mockResolvedValue([])
  listRegisteredUsers.mockResolvedValue([])
  revokeInvitation.mockResolvedValue(true)
  checkInvitationStatus.mockResolvedValue('pending')
})

describe('admin API authorization', () => {
  for (const [name, user, status] of [
    ['anonymous', null, 401],
    ['different USER', { id: 'user-b', role: 'USER' }, 403],
  ] as const) {
    it(`rejects ${name} on every admin API`, async () => {
      getCurrentUser.mockResolvedValue(user)
      expect((await getInvitations()).status).toBe(status)
      expect((await createInvite(createRequest())).status).toBe(status)
      expect((await revokeInvite(deleteRequest(), context)).status).toBe(status)
      expect((await checkInvite(checkRequest(), context)).status).toBe(status)
      expect((await getUsers()).status).toBe(status)
      expect(createInvitation).not.toHaveBeenCalled()
      expect(listInvitations).not.toHaveBeenCalled()
      expect(revokeInvitation).not.toHaveBeenCalled()
      expect(checkInvitationStatus).not.toHaveBeenCalled()
      expect(listRegisteredUsers).not.toHaveBeenCalled()
    })
  }

  it('returns a newly created link only on creation, never in a listing', async () => {
    createInvitation.mockResolvedValue({
      id,
      url: 'https://coach.example.test/sign-up#token=secret',
      expiresAt: new Date('2026-11-12T00:00:00Z'),
    })
    listInvitations.mockResolvedValue([{ id, label: 'Friend', status: 'pending' }])
    expect((await createInvite(createRequest())).status).toBe(201)
    const listed = await getInvitations()
    expect(await listed.json()).toEqual({
      invitations: [{ id, label: 'Friend', status: 'pending' }],
    })
    expect(listed.headers.get('cache-control')).toContain('no-store')
    expect(createInvitation).toHaveBeenCalledWith('Friend')
  })

  it('creates an invite when the optional description is omitted', async () => {
    createInvitation.mockResolvedValue({
      id,
      url: 'https://coach.example.test/sign-up#token=secret',
    })
    const request = new Request('https://coach.example.test/api/admin/invitations', {
      method: 'POST',
      headers: { Origin: 'https://coach.example.test', 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect((await createInvite(request)).status).toBe(201)
    expect(createInvitation).toHaveBeenCalledWith(null)
  })

  it('rejects cross-origin or invalid mutation input', async () => {
    const forged = new Request('https://coach.example.test/api/admin/invitations', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: null }),
    })
    expect((await createInvite(forged)).status).toBe(403)
    expect((await revokeInvite(deleteRequest('https://evil.example'), context)).status).toBe(403)
    expect((await checkInvite(checkRequest('https://evil.example'), context)).status).toBe(403)
    const invalid = new Request('https://coach.example.test/api/admin/invitations', {
      method: 'POST',
      headers: { Origin: 'https://coach.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'x'.repeat(121) }),
    })
    expect((await createInvite(invalid)).status).toBe(400)
    expect(createInvitation).not.toHaveBeenCalled()
  })

  it('reports a revocation conflict when the link is no longer pending', async () => {
    revokeInvitation.mockResolvedValue(false)
    expect((await revokeInvite(deleteRequest(), context)).status).toBe(409)
  })

  it('checks only a validated invitation ID and returns private status', async () => {
    const checked = await checkInvite(checkRequest(), context)
    expect(checked.status).toBe(200)
    expect(await checked.json()).toEqual({ status: 'pending' })
    expect(checked.headers.get('cache-control')).toContain('no-store')
    expect(checkInvitationStatus).toHaveBeenCalledWith(id)

    checkInvitationStatus.mockResolvedValueOnce(null)
    expect((await checkInvite(checkRequest(), context)).status).toBe(404)
    const invalidContext = { params: Promise.resolve({ id: 'not-a-uuid' }) }
    expect((await checkInvite(checkRequest(), invalidContext)).status).toBe(400)
    expect(checkInvitationStatus).toHaveBeenCalledTimes(2)
  })
})
