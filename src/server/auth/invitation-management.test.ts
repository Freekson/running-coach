import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPrismaClient, create, findMany, updateMany, userFindMany, authUserFindMany } =
  vi.hoisted(() => ({
    getPrismaClient: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    userFindMany: vi.fn(),
    authUserFindMany: vi.fn(),
  }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))

import {
  createInvitation,
  invitationStatus,
  listInvitations,
  listRegisteredUsers,
  revokeInvitation,
} from './invitation-management'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.BETTER_AUTH_URL = 'https://coach.example.test'
  getPrismaClient.mockResolvedValue({
    authInvitation: { create, findMany, updateMany },
    user: { findMany: userFindMany },
    authUser: { findMany: authUserFindMany },
  })
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

  it('lists metadata and computes pending, used, expired, and revoked statuses', async () => {
    const future = new Date(Date.now() + 60_000)
    const past = new Date(Date.now() - 60_000)
    findMany.mockResolvedValue([
      {
        id: 'pending',
        label: null,
        createdAt: past,
        expiresAt: future,
        consumedAt: null,
        revokedAt: null,
      },
      {
        id: 'used',
        label: null,
        createdAt: past,
        expiresAt: future,
        consumedAt: past,
        revokedAt: null,
      },
      {
        id: 'expired',
        label: null,
        createdAt: past,
        expiresAt: past,
        consumedAt: null,
        revokedAt: null,
      },
      {
        id: 'revoked',
        label: null,
        createdAt: past,
        expiresAt: future,
        consumedAt: null,
        revokedAt: past,
      },
    ])
    expect((await listInvitations()).map((item) => item.status)).toEqual([
      'pending',
      'used',
      'expired',
      'revoked',
    ])
    expect(findMany.mock.calls[0][0].select).not.toHaveProperty('tokenHash')
    expect(invitationStatus({ consumedAt: null, revokedAt: null, expiresAt: past })).toBe('expired')
  })

  it('revokes only a still-pending invitation with one conditional update', async () => {
    updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    expect(await revokeInvitation('invite-id')).toBe(true)
    expect(await revokeInvitation('invite-id')).toBe(false)
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: {
        id: 'invite-id',
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
    expect(await listRegisteredUsers()).toEqual([
      { id: 'admin', email: 'admin@example.test', createdAt, role: 'ADMIN', status: 'ACTIVE' },
      { id: 'new', email: 'new@example.test', createdAt, role: 'USER', status: null },
    ])
    expect(userFindMany.mock.calls[0][0].where).toEqual({ authSubject: { in: ['admin', 'new'] } })
  })
})
