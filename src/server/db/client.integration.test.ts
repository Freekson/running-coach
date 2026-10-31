import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPrismaClient } from './client'

const databaseTestRequested = process.env.npm_lifecycle_event === 'test:db'
if (databaseTestRequested) config()

const runDatabaseTest =
  databaseTestRequested &&
  (process.env.APP_DATABASE_ENV === 'test' || process.env.APP_DATABASE_ENV === 'development') &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DIRECT_URL) &&
  !process.env.VERCEL_ENV

if (databaseTestRequested && !runDatabaseTest) {
  throw new Error('test:db requires isolated development/test DATABASE_URL and DIRECT_URL')
}

describe.skipIf(!runDatabaseTest)('Prisma on an isolated PostgreSQL database', () => {
  let prisma: PrismaClient | null = null
  const subjectPrefix = `run-15-${randomUUID()}`

  beforeAll(async () => {
    prisma = await getPrismaClient()
  }, 30_000)

  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { authSubject: { startsWith: subjectPrefix } } })
    await prisma.$disconnect()
  })

  it('reads, writes, rolls back transactions, and rejects another owner on a nested record', async () => {
    if (!prisma) throw new Error('An isolated test database is required')
    const userA = await prisma.user.create({ data: { authSubject: `${subjectPrefix}-a` } })
    const userB = await prisma.user.create({ data: { authSubject: `${subjectPrefix}-b` } })

    expect(userA.role).toBe('USER')
    expect(await prisma.user.findUnique({ where: { id: userA.id } })).toMatchObject({
      authSubject: `${subjectPrefix}-a`,
    })

    const externalActivityId = `synthetic-${randomUUID()}`
    for (const userId of [userA.id, userB.id]) {
      await prisma.activity.create({
        data: {
          userId,
          sourceProvider: 'GARMIN',
          externalActivityId,
          sportType: 'RUN',
          startedAt: new Date('2026-10-01T00:00:00Z'),
        },
      })
    }
    expect(await prisma.activity.count({ where: { userId: userA.id } })).toBe(1)
    expect(await prisma.activity.count({ where: { userId: userB.id } })).toBe(1)

    const connectionA = await prisma.integrationConnection.create({
      data: { userId: userA.id, provider: 'GARMIN', authMethod: 'OAUTH' },
    })
    await expect(
      prisma.syncRun.create({
        data: {
          userId: userB.id,
          connectionId: connectionA.id,
          jobType: 'ACTIVITIES',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' })

    const rolledBackId = randomUUID()
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.activity.create({
          data: {
            id: rolledBackId,
            userId: userA.id,
            sourceProvider: 'MANUAL',
            sportType: 'RUN',
            startedAt: new Date('2026-10-02T00:00:00Z'),
          },
        })
        throw new Error('rollback probe')
      }),
    ).rejects.toThrow('rollback probe')
    expect(await prisma.activity.findUnique({ where: { id: rolledBackId } })).toBeNull()
  }, 30_000)

  it('rejects Production when pointed at the marked development database', async () => {
    const originalVercelEnvironment = process.env.VERCEL_ENV
    const originalDatabaseEnvironment = process.env.APP_DATABASE_ENV
    process.env.VERCEL_ENV = 'production'
    process.env.APP_DATABASE_ENV = 'production'

    try {
      await expect(getPrismaClient()).rejects.toThrow('Database environment verification failed')
    } finally {
      if (originalVercelEnvironment === undefined) delete process.env.VERCEL_ENV
      else process.env.VERCEL_ENV = originalVercelEnvironment
      if (originalDatabaseEnvironment === undefined) delete process.env.APP_DATABASE_ENV
      else process.env.APP_DATABASE_ENV = originalDatabaseEnvironment
    }
  }, 30_000)
})
