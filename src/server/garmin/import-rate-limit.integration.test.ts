import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { allowGarminImport } from './import-rate-limit'

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
})
