import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPrismaClient, findFirst, isVerifiedCurrentUser } = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
  findFirst: vi.fn(),
  isVerifiedCurrentUser: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser }))

import {
  getOwnerContext,
  InvalidOwnerContextError,
  ownedIdWhere,
  ownedWhere,
  OwnedResourceNotFoundError,
  ownerId,
  requireOwnedConnection,
} from './ownership'

beforeEach(() => {
  vi.clearAllMocks()
  getPrismaClient.mockResolvedValue({ integrationConnection: { findFirst } })
  isVerifiedCurrentUser.mockReturnValue(true)
})

const userA = { id: 'athlete-a', role: 'USER' as const, email: null }

describe('owner-scoped access', () => {
  it('builds owner-scoped list and ID filters for service queries', async () => {
    const ownerA = getOwnerContext(userA)
    expect(ownedWhere(ownerA, { measurementType: 'WEIGHT' })).toEqual({
      measurementType: 'WEIGHT',
      userId: 'athlete-a',
    })
    expect(ownedIdWhere(ownerA, 'guessed-reading-id')).toEqual({
      id: 'guessed-reading-id',
      userId: 'athlete-a',
    })
    expect(ownedWhere(ownerA, { sourceProvider: 'GARMIN' })).toEqual({
      sourceProvider: 'GARMIN',
      userId: 'athlete-a',
    })
  })

  it('rejects a forged context even if it contains the same user ID', async () => {
    const ownerA = getOwnerContext(userA)
    expect(ownerId(ownerA)).toBe('athlete-a')
    expect(() => ownedWhere({ userId: 'athlete-a' }, {})).toThrow(InvalidOwnerContextError)
    await expect(
      requireOwnedConnection({ userId: 'athlete-a' }, 'connection-a'),
    ).rejects.toBeInstanceOf(InvalidOwnerContextError)
    expect(getPrismaClient).not.toHaveBeenCalled()
  })

  it('does not issue a context for an unverified user object', () => {
    isVerifiedCurrentUser.mockReturnValue(false)
    expect(() => getOwnerContext(userA)).toThrow(InvalidOwnerContextError)
  })

  it('rejects another owner’s nested connection without revealing whether it exists', async () => {
    const ownerA = getOwnerContext(userA)
    findFirst.mockResolvedValue(null)
    await expect(requireOwnedConnection(ownerA, 'connection-b')).rejects.toBeInstanceOf(
      OwnedResourceNotFoundError,
    )
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'connection-b', userId: 'athlete-a' },
      select: { id: true },
    })
  })

  it('accepts an owned nested connection', async () => {
    const ownerA = getOwnerContext(userA)
    findFirst.mockResolvedValue({ id: 'connection-a' })
    await expect(requireOwnedConnection(ownerA, 'connection-a')).resolves.toEqual({
      id: 'connection-a',
    })
  })
})
