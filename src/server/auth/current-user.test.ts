import { beforeEach, describe, expect, it, vi } from 'vitest'

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
      .mockResolvedValueOnce({ id: 'internal-a', role: 'USER', status: 'ACTIVE' })
      .mockResolvedValueOnce({ id: 'internal-b', role: 'USER', status: 'ACTIVE' })

    expect(await getCurrentUser()).toEqual({ id: 'internal-a', role: 'USER' })
    expect(await getCurrentUser()).toEqual({ id: 'internal-b', role: 'USER' })
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
    findUnique.mockResolvedValueOnce({ id: 'internal-a', role: 'ADMIN', status: 'ACTIVE' })
    expect(await getCurrentUser()).toEqual({ id: 'internal-a', role: 'ADMIN' })
    findUnique.mockResolvedValueOnce({ id: 'internal-a', role: 'ADMIN', status: 'SUSPENDED' })
    await expect(getCurrentUser()).rejects.toBeInstanceOf(AccountUnavailableError)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('refuses to attach a legacy athlete record by email', async () => {
    getSession.mockResolvedValue({
      session: { id: 's' },
      user: { id: 'new', email: 'old@example.test' },
    })
    findFirst.mockResolvedValue({ id: 'legacy' })
    await expect(getCurrentUser()).rejects.toBeInstanceOf(AccountUnavailableError)
    expect(upsert).not.toHaveBeenCalled()
  })
})
