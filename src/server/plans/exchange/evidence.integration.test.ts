import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
import { getOwnerContext, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { readTrainingEvidence } from './evidence'
import { coverageFixture, fixtureNow } from './fixtures'

const requested = process.env.npm_lifecycle_event === 'test:db'
if (requested) config()
const enabled =
  requested &&
  ['test', 'development'].includes(process.env.APP_DATABASE_ENV ?? '') &&
  !!process.env.DATABASE_URL &&
  !!process.env.DIRECT_URL &&
  !process.env.VERCEL_ENV
if (requested && !enabled) throw new Error('Isolated development/test database required')

describe.skipIf(!enabled)('RUN-34 owner-scoped persisted evidence in PostgreSQL', () => {
  let prisma: PrismaClient
  let owner: OwnerContext, other: OwnerContext
  let runId: string
  const prefix = 'run34-' + randomUUID()
  const options = {
    timezone: 'Asia/Tokyo',
    now: fixtureNow,
    coverage: coverageFixture(),
    includeHeartRate: true,
    includeLaps: true,
  }
  beforeAll(async () => {
    prisma = await getPrismaClient()
    const a = await prisma.user.create({ data: { authSubject: prefix + '-a' } })
    const b = await prisma.user.create({ data: { authSubject: prefix + '-b', role: 'ADMIN' } })
    owner = getOwnerContext({ id: a.id, role: 'USER', email: null })
    other = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
    await prisma.integrationConnection.create({
      data: {
        userId: a.id,
        provider: 'GARMIN',
        authMethod: 'API_KEY',
        status: 'REVOKED',
        externalAccountId: 'synthetic-current-account',
      },
    })
    const data = {
      userId: a.id,
      sourceProvider: 'GARMIN' as const,
      garminAccountId: 'synthetic-current-account',
      sportType: 'RUNNING',
      startedAt: new Date('2026-11-13T23:30:00Z'),
      listStartedAt: new Date('2026-11-13T23:30:00Z'),
      distanceMeters: 5000,
      elapsedMs: BigInt(1900000),
      movingMs: BigInt(1800000),
      avgHrBpm: 140,
      maxHrBpm: 165,
      sourceObservedAt: new Date('2026-11-15T02:00:00Z'),
      surfaceType: 'ROAD',
      sourceTimezone: 'Asia/Tokyo',
    }
    const run = await prisma.activity.create({
      data: {
        ...data,
        rawObjectRef: 'synthetic-private-fit',
        gpsAssetRef: 'synthetic-private-gps',
      },
    })
    runId = run.id
    await prisma.activityLap.create({
      data: {
        userId: a.id,
        activityId: run.id,
        lapIndex: 0,
        sourceRecordType: 'FIT_LAP',
        distanceMeters: 400,
        elapsedMs: BigInt(120000),
        avgHrBpm: 160,
      },
    })
    const duplicateA = await prisma.activity.create({ data })
    const duplicateB = await prisma.activity.create({ data: { ...data, sourceProvider: 'FILE' } })
    const [firstActivityId, secondActivityId] = [duplicateA.id, duplicateB.id].sort()
    await prisma.activityDuplicateCandidate.create({
      data: { userId: a.id, firstActivityId, secondActivityId },
    })
    await prisma.activity.createMany({
      data: [
        { ...data, userId: b.id, sourceProvider: 'FILE', distanceMeters: 90000 },
        { ...data, garminAccountId: 'synthetic-replaced-account', distanceMeters: 80000 },
        { ...data, sportType: 'CYCLING', distanceMeters: 70000 },
      ],
    })
  }, 30000)
  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
    await prisma.$disconnect()
  })
  it('reads only the verified owner/account and completed run measurements with nested owned laps', async () => {
    const evidence = await readTrainingEvidence(owner, options)
    expect(evidence.selection).toMatchObject({ eligibleRuns: 1, excludedDuplicateCandidates: 2 })
    expect(evidence.recentRunSamples).toHaveLength(1)
    expect(evidence.recentRunSamples[0]).toMatchObject({
      activityId: runId,
      localDate: '2026-11-14',
      averagePace: { value: 360 },
      averageHr: { value: 140 },
      lapSamples: [{ averagePace: { value: 300 }, averageHr: { value: 160 } }],
    })
    const json = JSON.stringify(evidence)
    expect(json).not.toContain('synthetic-private')
    expect(json).not.toContain('synthetic-current-account')
  })
  it('ADMIN receives its own history, and unissued/unauthenticated contexts fail before reads', async () => {
    const evidence = await readTrainingEvidence(other, options)
    expect(evidence.recentRunSamples).toHaveLength(1)
    expect(evidence.recentRunSamples[0].distance.value).toBe(90000)
    expect(evidence.recentRunSamples[0].activityId).not.toBe(runId)
    await expect(readTrainingEvidence({ userId: owner.userId }, options)).rejects.toThrow(
      'Verified owner context required',
    )
  })
  it('omits HR and laps unless selected, retaining saved history after disconnect', async () => {
    const evidence = await readTrainingEvidence(owner, {
      ...options,
      includeHeartRate: false,
      includeLaps: false,
    })
    expect(evidence.recentRunSamples[0]).toMatchObject({
      averageHr: { value: null },
      maxHr: { value: null },
      lapSamples: null,
    })
  })
})
