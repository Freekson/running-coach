import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getCurrentUser,
  createInvitation,
  listInvitations,
  checkInvitationStatus,
  revokeInvitation,
  regenerateInvitation,
  listRegisteredUsers,
} = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  createInvitation: vi.fn(),
  listInvitations: vi.fn(),
  checkInvitationStatus: vi.fn(),
  revokeInvitation: vi.fn(),
  regenerateInvitation: vi.fn(),
  listRegisteredUsers: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  AccountUnavailableError: class AccountUnavailableError extends Error {},
  getCurrentUser,
}))
vi.mock('@/server/auth/invitation/invitation-management', () => ({
  createInvitation,
  listInvitations,
  checkInvitationStatus,
  revokeInvitation,
  regenerateInvitation,
  listRegisteredUsers,
}))

import { GET as getInvitations, POST as createInvite } from './invitations/route'
import { DELETE as revokeInvite } from './invitations/[id]/route'
import { POST as checkInvite } from './invitations/[id]/status/route'
import { POST as regenerateInvite } from './invitations/[id]/regenerate/route'
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
  listInvitations.mockResolvedValue({
    invitations: [],
    page: 1,
    total: 0,
    counts: { all: 0, pending: 0, processing: 0, used: 0, revoked: 0, expired: 0 },
  })
  listRegisteredUsers.mockResolvedValue({ users: [], page: 1, total: 0 })
  revokeInvitation.mockResolvedValue(true)
  regenerateInvitation.mockResolvedValue(null)
  checkInvitationStatus.mockResolvedValue('pending')
})

describe('admin API authorization', () => {
  for (const [name, user, status] of [
    ['anonymous', null, 401],
    ['different USER', { id: 'user-b', role: 'USER' }, 403],
  ] as const) {
    it(`rejects ${name} on every admin API`, async () => {
      getCurrentUser.mockResolvedValue(user)
      expect(
        (await getInvitations(new Request('https://coach.example.test/api/admin/invitations')))
          .status,
      ).toBe(status)
      expect((await createInvite(createRequest())).status).toBe(status)
      expect((await revokeInvite(deleteRequest(), context)).status).toBe(status)
      expect(
        (
          await regenerateInvite(
            new Request(`${url}/regenerate`, {
              method: 'POST',
              headers: { Origin: 'https://coach.example.test' },
            }),
            context,
          )
        ).status,
      ).toBe(status)
      expect((await checkInvite(checkRequest(), context)).status).toBe(status)
      expect(
        (await getUsers(new Request('https://coach.example.test/api/admin/users'))).status,
      ).toBe(status)
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
    listInvitations.mockResolvedValue({
      invitations: [{ id, label: 'Friend', status: 'pending' }],
      page: 1,
      total: 1,
      counts: { all: 1, pending: 1, processing: 0, used: 0, revoked: 0, expired: 0 },
    })
    expect((await createInvite(createRequest())).status).toBe(201)
    const listed = await getInvitations(
      new Request('https://coach.example.test/api/admin/invitations'),
    )
    expect((await listed.json()).invitations).toEqual([{ id, label: 'Friend', status: 'pending' }])
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

  it('validates pagination and applies filters server-side', async () => {
    const inviteUrl = 'https://coach.example.test/api/admin/invitations'
    const usersUrl = 'https://coach.example.test/api/admin/users'
    expect((await getInvitations(new Request(`${inviteUrl}?page=0`))).status).toBe(400)
    expect((await getInvitations(new Request(`${inviteUrl}?status=unknown`))).status).toBe(400)
    expect((await getUsers(new Request(`${usersUrl}?page=NaN`))).status).toBe(400)
    await getInvitations(new Request(`${inviteUrl}?page=3&status=expired`))
    await getUsers(new Request(`${usersUrl}?page=2`))
    expect(listInvitations).toHaveBeenCalledWith(3, 'expired')
    expect(listRegisteredUsers).toHaveBeenCalledWith(2)
  })

  it('returns a rotated link only from the protected mutation', async () => {
    const revision = 'a'.repeat(64)
    const request = () =>
      new Request(`${url}/regenerate`, {
        method: 'POST',
        headers: { Origin: 'https://coach.example.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision }),
      })
    expect((await regenerateInvite(request(), context)).status).toBe(409)
    regenerateInvitation.mockResolvedValue({
      id,
      url: 'https://coach.example.test/sign-up#token=fresh',
      expiresAt: new Date(),
    })
    const result = await regenerateInvite(request(), context)
    expect(result.status).toBe(200)
    expect((await result.json()).url).toContain('#token=fresh')
    expect(result.headers.get('cache-control')).toContain('no-store')
    expect(regenerateInvitation).toHaveBeenCalledWith(id, revision)
    expect(
      (
        await regenerateInvite(
          new Request(`${url}/regenerate`, {
            method: 'POST',
            headers: { Origin: 'https://coach.example.test' },
            body: '{}',
          }),
          context,
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await regenerateInvite(
          new Request(`${url}/regenerate`, {
            method: 'POST',
            headers: { Origin: 'https://evil.example' },
          }),
          context,
        )
      ).status,
    ).toBe(403)
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
