import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getPrismaClient,
  create,
  findMany,
  findUnique,
  updateMany,
  userFindMany,
  authUserFindMany,
  invitationCount,
  authUserCount,
  reconcileStaleInvitationClaim,
} = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
  create: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  userFindMany: vi.fn(),
  authUserFindMany: vi.fn(),
  invitationCount: vi.fn(),
  authUserCount: vi.fn(),
  reconcileStaleInvitationClaim: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))
vi.mock('./invitations', () => ({ reconcileStaleInvitationClaim }))

import {
  checkInvitationStatus,
  createInvitation,
  invitationStatus,
  listInvitations,
  listRegisteredUsers,
  regenerateInvitation,
  revokeInvitation,
} from './invitation-management'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.BETTER_AUTH_URL = 'https://coach.example.test'
  getPrismaClient.mockResolvedValue({
    authInvitation: { create, findMany, findUnique, updateMany, count: invitationCount },
    user: { findMany: userFindMany },
    authUser: { findMany: authUserFindMany, count: authUserCount },
  })
  invitationCount.mockResolvedValue(5)
  authUserCount.mockResolvedValue(2)
})

afterEach(() => vi.unstubAllEnvs())

describe('invitation management', () => {
  it('creates a seven-day link and stores only its hash', async () => {
    const now = new Date()
    create.mockResolvedValue({ id: 'invite-id', label: 'Friend', createdAt: now, expiresAt: now })
    const result = await createInvitation('Friend')
    const token = new URL(result.url).hash.slice('#token='.length)
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(create.mock.calls[0][0].data.tokenHash).toBe(
      createHash('sha256').update(token).digest('hex'),
    )
    expect(result.url).toMatch(/^https:\/\/coach\.example\.test\/sign-up#token=/)
    expect(create).toHaveBeenCalledWith({
      data: {
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        label: 'Friend',
        expiresAt: expect.any(Date),
      },
      select: { id: true, createdAt: true, expiresAt: true, label: true },
    })
    expect(create.mock.calls[0][0].data).not.toHaveProperty('token')
    expect(create.mock.calls[0][0].data.expiresAt.getTime() - Date.now()).toBeGreaterThan(
      6 * 24 * 60 * 60 * 1000,
    )
  })

  it('uses the configured Preview alias instead of the deployment host', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('APP_DATABASE_ENV', 'preview')
    vi.stubEnv('BETTER_AUTH_URL', 'https://coach-git-development-team.vercel.app')
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'coach.vercel.app')
    vi.stubEnv('VERCEL_URL', 'coach-commit-team.vercel.app')
    create.mockResolvedValue({ id: 'invite-id' })

    const result = await createInvitation(null)
    const link = new URL(result.url)
    expect(link.origin).toBe('https://coach-git-development-team.vercel.app')
    expect(link.pathname).toBe('/sign-up')
    expect(link.hash).toMatch(/^#token=[a-f0-9]{64}$/)
  })

  it('refuses to store a link when Preview points to the Production domain', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('APP_DATABASE_ENV', 'preview')
    vi.stubEnv('BETTER_AUTH_URL', 'https://coach.vercel.app')
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'coach.vercel.app')

    await expect(createInvitation(null)).rejects.toThrow('Preview BETTER_AUTH_URL')
    expect(getPrismaClient).not.toHaveBeenCalled()
  })

  it('lists metadata and distinguishes claimed invitations from revocable pending ones', async () => {
    const future = new Date(Date.now() + 60_000)
    const past = new Date(Date.now() - 60_000)
    findMany.mockResolvedValue([
      {
        id: 'pending',
        tokenHash: 'pending-hash',
        label: null,
        createdAt: past,
        expiresAt: future,
        consumedAt: null,
        revokedAt: null,
        claimedAt: null,
      },
      {
        id: 'processing',
        tokenHash: 'processing-hash',
        label: null,
        createdAt: past,
        expiresAt: future,
        consumedAt: null,
        revokedAt: null,
        claimedAt: past,
      },
      {
        id: 'used',
        tokenHash: 'used-hash',
        label: null,
        createdAt: past,
        expiresAt: future,
        consumedAt: past,
        revokedAt: null,
        claimedAt: past,
      },
      {
        id: 'expired',
        tokenHash: 'expired-hash',
        label: null,
        createdAt: past,
        expiresAt: past,
        consumedAt: null,
        revokedAt: null,
        claimedAt: past,
      },
      {
        id: 'revoked',
        tokenHash: 'revoked-hash',
        label: null,
        createdAt: past,
        expiresAt: future,
        consumedAt: null,
        revokedAt: past,
        claimedAt: null,
      },
    ])
    const listed = await listInvitations()
    expect(listed.invitations.map((item) => item.status)).toEqual([
      'pending',
      'processing',
      'used',
      'expired',
      'revoked',
    ])
    expect(listed.invitations[1]).not.toHaveProperty('claimedAt')
    expect(listed.invitations[0]).not.toHaveProperty('tokenHash')
    expect(
      invitationStatus({ consumedAt: null, revokedAt: null, claimedAt: null, expiresAt: past }),
    ).toBe('expired')
  })

  it('does not run unbounded claim recovery when listing invitations', async () => {
    const staleAt = new Date(Date.now() - 121_000)
    const future = new Date(Date.now() + 60_000)
    const claimed = {
      id: 'abandoned',
      tokenHash: 'abandoned-hash',
      label: null,
      createdAt: staleAt,
      expiresAt: future,
      consumedAt: null,
      revokedAt: null,
      claimedAt: staleAt,
    }
    findMany.mockResolvedValue([claimed])

    expect((await listInvitations()).invitations.map((item) => item.status)).toEqual(['processing'])
    expect(reconcileStaleInvitationClaim).not.toHaveBeenCalled()
    expect(findMany).toHaveBeenCalledOnce()
  })

  it('filters before paging and clamps a stranded page', async () => {
    invitationCount.mockImplementation(({ where }) =>
      Promise.resolve(where.claimedAt === null ? 11 : 2),
    )
    findMany.mockResolvedValue([])
    const result = await listInvitations(99, 'pending')
    expect(result.page).toBe(3)
    expect(result.total).toBe(11)
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: expect.any(Date) },
          claimedAt: null,
        },
        skip: 10,
        take: 5,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    )
    expect(result.counts.all).toBe(2)
  })

  it('counts expired invitations only after excluding used and revoked records', async () => {
    invitationCount.mockResolvedValue(0)
    findMany.mockResolvedValue([])
    await listInvitations(1, 'expired')
    expect(findMany.mock.calls[0][0].where).toEqual({
      consumedAt: null,
      revokedAt: null,
      expiresAt: { lte: expect.any(Date) },
    })
    expect(
      invitationCount.mock.calls.some(
        ([query]) =>
          query.where.consumedAt === null &&
          query.where.revokedAt === null &&
          query.where.expiresAt?.lte instanceof Date,
      ),
    ).toBe(true)
  })

  it('regenerates only a still-pending invitation with a conditional token update', async () => {
    const expiresAt = new Date(Date.now() + 60_000)
    findMany.mockResolvedValue([{ tokenHash: 'old-hash', expiresAt }])
    updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    const revision = createHash('sha256').update('old-hash').digest('hex')
    const result = await regenerateInvitation('invite-id', revision)
    expect(result?.expiresAt).toBe(expiresAt)
    const rawToken = new URL(result!.url).hash.slice('#token='.length)
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: {
        id: 'invite-id',
        tokenHash: 'old-hash',
        claimedAt: null,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { tokenHash: createHash('sha256').update(rawToken).digest('hex') },
    })
    expect(await regenerateInvitation('invite-id', revision)).toBeNull()
  })

  it('reconciles only the requested invitation before returning its status', async () => {
    const future = new Date(Date.now() + 60_000)
    findUnique.mockResolvedValue({
      claimedAt: null,
      consumedAt: null,
      revokedAt: null,
      expiresAt: future,
    })

    expect(await checkInvitationStatus('abandoned')).toBe('pending')
    expect(reconcileStaleInvitationClaim).toHaveBeenCalledWith('abandoned')
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'abandoned' },
      select: { consumedAt: true, revokedAt: true, claimedAt: true, expiresAt: true },
    })
    findUnique.mockResolvedValueOnce(null)
    expect(await checkInvitationStatus('missing')).toBeNull()
  })

  it('revokes only a still-pending invitation with one conditional update', async () => {
    updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    expect(await revokeInvitation('invite-id')).toBe(true)
    expect(await revokeInvitation('invite-id')).toBe(false)
    expect(reconcileStaleInvitationClaim).toHaveBeenCalledWith('invite-id')
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: {
        id: 'invite-id',
        claimedAt: null,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { revokedAt: expect.any(Date) },
    })
  })

  it('lists all registrations with local roles and a USER default', async () => {
    const createdAt = new Date()
    authUserFindMany.mockResolvedValue([
      { id: 'admin', email: 'admin@example.test', createdAt },
      { id: 'new', email: 'new@example.test', createdAt },
    ])
    userFindMany.mockResolvedValue([{ authSubject: 'admin', role: 'ADMIN', status: 'ACTIVE' }])
    expect((await listRegisteredUsers()).users).toEqual([
      { id: 'admin', email: 'admin@example.test', createdAt, role: 'ADMIN', status: 'ACTIVE' },
      { id: 'new', email: 'new@example.test', createdAt, role: 'USER', status: null },
    ])
    expect(userFindMany.mock.calls[0][0].where).toEqual({ authSubject: { in: ['admin', 'new'] } })
    expect(authUserFindMany.mock.calls[0][0]).toMatchObject({
      skip: 0,
      take: 5,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
  })

  it('clamps the registered-users page after the last page is removed', async () => {
    authUserCount.mockResolvedValue(11)
    authUserFindMany.mockResolvedValue([])
    userFindMany.mockResolvedValue([])
    const result = await listRegisteredUsers(5)
    expect(result).toMatchObject({ page: 3, total: 11, users: [] })
    expect(authUserFindMany.mock.calls[0][0]).toMatchObject({ skip: 10, take: 5 })
  })
})
