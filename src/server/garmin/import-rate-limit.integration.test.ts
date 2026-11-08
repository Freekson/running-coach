import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import {
  allowGarminImport,
  getGarminProviderPauseUntil,
  pauseGarminProviderUntil,
} from './import-rate-limit'

const requested = process.env.npm_lifecycle_event === 'test:db'
if (requested) config()
const enabled =
  requested &&
  (process.env.APP_DATABASE_ENV === 'test' || process.env.APP_DATABASE_ENV === 'development') &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DIRECT_URL) &&
  !process.env.VERCEL_ENV
if (requested && !enabled)
  throw new Error('test:db requires isolated development/test database URLs')

describe.skipIf(!enabled)('shared Garmin import limit on isolated PostgreSQL', () => {
  let prisma: PrismaClient
  let ownerA: ReturnType<typeof getOwnerContext>
  let ownerB: ReturnType<typeof getOwnerContext>
  const prefix = `run24-rate-${randomUUID()}`

  beforeAll(async () => {
    prisma = await getPrismaClient()
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-a` } })
    const b = await prisma.user.create({ data: { authSubject: `${prefix}-b` } })
    ownerA = getOwnerContext({ id: a.id, role: 'USER', email: null })
    ownerB = getOwnerContext({ id: b.id, role: 'USER', email: null })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
    await prisma.$disconnect()
  })

  it('limits concurrent attempts by owner and cascades the counter on account deletion', async () => {
    const attempts = await Promise.all(Array.from({ length: 5 }, () => allowGarminImport(ownerA)))
    expect(attempts.filter(Boolean)).toHaveLength(3)
    expect(attempts.filter((allowed) => !allowed)).toHaveLength(2)
    expect(await allowGarminImport(ownerB)).toBe(true)
    await prisma.garminImportRateLimit.update({
      where: { userId: ownerA.userId },
      data: { windowStartedAt: new Date(Date.now() - 61_000) },
    })
    expect(await allowGarminImport(ownerA)).toBe(true)
    await expect(allowGarminImport({ userId: ownerA.userId })).rejects.toThrow(
      'Verified owner context required',
    )
    await prisma.user.delete({ where: { id: ownerA.userId } })
    expect(
      await prisma.garminImportRateLimit.findUnique({ where: { userId: ownerA.userId } }),
    ).toBeNull()
    expect(
      await prisma.garminImportRateLimit.findUnique({ where: { userId: ownerB.userId } }),
    ).not.toBeNull()
  })

  it('shares a provider pause without spending manual attempts or affecting another owner', async () => {
    const pausedUser = await prisma.user.create({ data: { authSubject: `${prefix}-paused` } })
    const otherUser = await prisma.user.create({ data: { authSubject: `${prefix}-other` } })
    const pausedOwner = getOwnerContext({ id: pausedUser.id, role: 'USER', email: null })
    const otherOwner = getOwnerContext({ id: otherUser.id, role: 'USER', email: null })
    const connection = await prisma.integrationConnection.create({
      data: {
        userId: pausedUser.id,
        provider: 'GARMIN',
        authMethod: 'API_KEY',
        status: 'CONNECTED',
      },
    })
    const nonce = Buffer.alloc(12, 11)
    await prisma.integrationCredential.create({
      data: {
        userId: pausedUser.id,
        connectionId: connection.id,
        ciphertext: Buffer.from([1]),
        nonce,
        authTag: Buffer.alloc(16),
        encryptionKeyVersion: 1,
      },
    })
    const until = new Date(Date.now() + 300_000)
    await pauseGarminProviderUntil(pausedOwner, until, nonce)
    expect(await getGarminProviderPauseUntil(pausedOwner)).toEqual(until)
    expect(await allowGarminImport(pausedOwner)).toBe(false)
    expect(
      (
        await prisma.garminImportRateLimit.findUniqueOrThrow({
          where: { userId: pausedUser.id },
        })
      ).count,
    ).toBe(1)
    expect(await allowGarminImport(otherOwner)).toBe(true)
    await pauseGarminProviderUntil(pausedOwner, new Date(Date.now() + 60_000), nonce)
    expect(await getGarminProviderPauseUntil(pausedOwner)).toEqual(until)
    await prisma.garminImportRateLimit.update({
      where: { userId: pausedUser.id },
      data: { providerRetryAt: new Date(Date.now() - 1_000) },
    })
    expect(await allowGarminImport(pausedOwner)).toBe(true)
    await prisma.integrationCredential.update({
      where: { connectionId: connection.id },
      data: { nonce: Buffer.alloc(12, 12) },
    })
    await pauseGarminProviderUntil(pausedOwner, new Date(Date.now() + 600_000), nonce)
    expect((await getGarminProviderPauseUntil(pausedOwner))?.getTime()).toBeLessThan(Date.now())
  })
})
