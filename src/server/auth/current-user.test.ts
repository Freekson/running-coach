import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

const { getSession, getAuth, getPrismaClient, findUnique, findFirst, upsert } = vi.hoisted(() => ({
  getSession: vi.fn(),
  getAuth: vi.fn(),
  getPrismaClient: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }))
vi.mock('./better-auth', () => ({ getAuth }))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))

import { AccountUnavailableError, getCurrentUser } from './current-user'

beforeEach(() => {
  vi.clearAllMocks()
  getAuth.mockResolvedValue({ api: { getSession } })
  getPrismaClient.mockResolvedValue({ user: { findUnique, findFirst, upsert } })
  findUnique.mockResolvedValue(null)
  findFirst.mockResolvedValue(null)
})

describe('getCurrentUser', () => {
  it('rejects a missing or expired session', async () => {
    getSession.mockResolvedValue(null)
    await expect(getCurrentUser()).resolves.toBeNull()
    expect(upsert).not.toHaveBeenCalled()
  })

  it('creates separate USER identities for separate authenticated subjects', async () => {
    getSession
      .mockResolvedValueOnce({ session: { id: 's-a' }, user: { id: 'a', email: 'a@example.test' } })
      .mockResolvedValueOnce({ session: { id: 's-b' }, user: { id: 'b', email: 'b@example.test' } })
    upsert
      .mockResolvedValueOnce({
        id: 'internal-a',
        role: 'USER',
        email: 'a@example.test',
        status: 'ACTIVE',
      })
      .mockResolvedValueOnce({
        id: 'internal-b',
        role: 'USER',
        email: 'b@example.test',
        status: 'ACTIVE',
      })

    expect(await getCurrentUser()).toEqual({
      id: 'internal-a',
      role: 'USER',
      email: 'a@example.test',
    })
    expect(await getCurrentUser()).toEqual({
      id: 'internal-b',
      role: 'USER',
      email: 'b@example.test',
    })
    expect(upsert.mock.calls.map(([query]) => query.create)).toEqual([
      { authSubject: 'a', email: 'a@example.test', role: 'USER' },
      { authSubject: 'b', email: 'b@example.test', role: 'USER' },
    ])
  })

  it('preserves a trusted ADMIN role and rejects suspended users', async () => {
    getSession.mockResolvedValue({
      session: { id: 's' },
      user: { id: 'a', email: 'a@example.test' },
    })
    findUnique.mockResolvedValueOnce({
      id: 'internal-a',
      role: 'ADMIN',
      email: 'a@example.test',
      status: 'ACTIVE',
    })
    expect(await getCurrentUser()).toEqual({
      id: 'internal-a',
      role: 'ADMIN',
      email: 'a@example.test',
    })
    findUnique.mockResolvedValueOnce({ id: 'internal-a', role: 'ADMIN', status: 'SUSPENDED' })
    await expect(getCurrentUser()).rejects.toBeInstanceOf(AccountUnavailableError)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('provides the name entered at registration for the signed-in owner', async () => {
    getSession.mockResolvedValue({
      session: { id: 's' },
      user: { id: 'a', email: 'a@example.test', name: '  Avery Runner  ' },
    })
    findUnique.mockResolvedValue({
      id: 'internal-a',
      role: 'USER',
      email: 'a@example.test',
      status: 'ACTIVE',
    })
    await expect(getCurrentUser()).resolves.toMatchObject({
      id: 'internal-a',
      name: 'Avery Runner',
    })
  })

  it('reads the saved display name only from the signed-in owner profile', async () => {
    getSession
      .mockResolvedValueOnce({
        session: { id: 's-a' },
        user: { id: 'a', email: 'a@example.test', name: 'Avery Runner' },
      })
      .mockResolvedValueOnce({
        session: { id: 's-b' },
        user: { id: 'b', email: 'b@example.test', name: 'Blair Runner' },
      })
    findUnique
      .mockResolvedValueOnce({
        id: 'internal-a',
        role: 'USER',
        email: 'a@example.test',
        status: 'ACTIVE',
        profile: { displayName: '  Trail Avery  ' },
      })
      .mockResolvedValueOnce({
        id: 'internal-b',
        role: 'USER',
        email: 'b@example.test',
        status: 'ACTIVE',
        profile: { displayName: 'Blair on Track' },
      })

    await expect(getCurrentUser()).resolves.toMatchObject({
      id: 'internal-a',
      displayName: 'Trail Avery',
    })
    await expect(getCurrentUser()).resolves.toMatchObject({
      id: 'internal-b',
      displayName: 'Blair on Track',
    })
    expect(findUnique.mock.calls.map(([query]) => query.where)).toEqual([
      { authSubject: 'a' },
      { authSubject: 'b' },
    ])
    expect(findUnique.mock.calls[0][0].select.profile).toEqual({
      select: { displayName: true },
    })
  })

  it('reads the same auth identity after a concurrent create wins the unique key', async () => {
    getSession.mockResolvedValue({
      session: { id: 's' },
      user: { id: 'a', email: 'a@example.test' },
    })
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'internal-a',
      role: 'ADMIN',
      email: 'a@example.test',
      status: 'ACTIVE',
    })
    upsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate auth subject', {
        code: 'P2002',
        clientVersion: '6.19.0',
      }),
    )

    await expect(getCurrentUser()).resolves.toEqual({
      id: 'internal-a',
      role: 'ADMIN',
      email: 'a@example.test',
    })
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        email: { equals: 'a@example.test', mode: 'insensitive' },
        authSubject: { not: 'a' },
      },
    })
    expect(findUnique).toHaveBeenCalledTimes(2)
  })

  it('still rejects a suspended identity created by another request', async () => {
    getSession.mockResolvedValue({
      session: { id: 's' },
      user: { id: 'a', email: 'a@example.test' },
    })
    findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'internal-a', role: 'USER', status: 'SUSPENDED' })
    upsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate auth subject', {
        code: 'P2002',
        clientVersion: '6.19.0',
      }),
    )

    await expect(getCurrentUser()).rejects.toBeInstanceOf(AccountUnavailableError)
  })

  it('does not mask a unique conflict unrelated to this auth identity', async () => {
    getSession.mockResolvedValue({
      session: { id: 's' },
      user: { id: 'a', email: 'a@example.test' },
    })
    const conflict = new Prisma.PrismaClientKnownRequestError('duplicate value', {
      code: 'P2002',
      clientVersion: '6.19.0',
    })
    upsert.mockRejectedValue(conflict)

    await expect(getCurrentUser()).rejects.toBe(conflict)
    expect(findUnique).toHaveBeenCalledTimes(2)
  })

  it('refuses to attach a legacy athlete record by email', async () => {
    getSession.mockResolvedValue({
      session: { id: 's' },
      user: { id: 'new', email: 'old@example.test' },
    })
    findFirst.mockResolvedValue({ id: 'legacy' })
    await expect(getCurrentUser()).rejects.toBeInstanceOf(AccountUnavailableError)
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        email: { equals: 'old@example.test', mode: 'insensitive' },
        authSubject: { not: 'new' },
      },
    })
    expect(upsert).not.toHaveBeenCalled()
  })
})
