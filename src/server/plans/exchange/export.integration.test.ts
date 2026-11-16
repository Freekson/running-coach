import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
import { getPrismaClient } from '@/server/db/client'
import { getOwnerContext, type OwnerContext } from '@/server/authorization/ownership'
import { addHealthDays, healthLocalDay } from '@/lib/health-history'
import { defaultExportConsent } from '@/lib/plan-export'
import { exchangeRequestSchema } from '@/schemas/plan-exchange.v1'
import { openPlanExport, issuePlanExport, getIssuedPlanExport } from './export'

const requested = process.env.npm_lifecycle_event === 'test:db'
if (requested) config()
const enabled =
  requested &&
  ['test', 'development'].includes(process.env.APP_DATABASE_ENV ?? '') &&
  !!process.env.DATABASE_URL &&
  !!process.env.DIRECT_URL &&
  !process.env.VERCEL_ENV
if (requested && !enabled) throw new Error('Isolated development/test database required')

describe.skipIf(!enabled)('RUN-35 persisted exports and tenant foreign keys in PostgreSQL', () => {
  let prisma: PrismaClient
  let owner: OwnerContext, other: OwnerContext
  let goalId: string
  let savedId: string
  const prefix = 'run35-' + randomUUID()
  const today = healthLocalDay(new Date().toISOString(), 'Asia/Tokyo')
  const yesterday = addHealthDays(today, -1)
  beforeAll(async () => {
    prisma = await getPrismaClient()
    const a = await prisma.user.create({ data: { authSubject: prefix + '-a' } })
    const b = await prisma.user.create({ data: { authSubject: prefix + '-b', role: 'ADMIN' } })
    owner = getOwnerContext({ id: a.id, role: 'USER', email: null })
    other = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
    await prisma.athleteProfile.create({
      data: { userId: a.id, preferredTimezone: 'Asia/Tokyo', measurementSystem: 'IMPERIAL' },
    })
    const goal = await prisma.goal.create({
      data: {
        userId: a.id,
        name: 'Synthetic 17 km goal',
        type: 'COMPLETION',
        distanceMeters: 17000,
        surface: 'TRAIL',
        elevationGainM: 600,
        targetDate: new Date(addHealthDays(today, 90)),
      },
    })
    goalId = goal.id
    const connection = await prisma.integrationConnection.create({
      data: {
        userId: a.id,
        provider: 'GARMIN',
        authMethod: 'API_KEY',
        status: 'REVOKED',
        externalAccountId: 'synthetic-export-current-account',
      },
    })
    await prisma.syncCursor.create({
      data: {
        userId: a.id,
        connectionId: connection.id,
        dataType: 'GARMIN_IMPORT_ACTIVITIES',
        lastSyncedAt: new Date(),
        cursorOrCheckpoint: {
          version: 2,
          startDate: addHealthDays(today, -84),
          endDate: yesterday,
          nextDate: null,
          timezone: 'Asia/Tokyo',
        },
      },
    })
    await prisma.activity.createMany({
      data: [
        {
          userId: a.id,
          sourceProvider: 'GARMIN',
          garminAccountId: 'synthetic-export-current-account',
          sportType: 'RUNNING',
          startedAt: new Date(yesterday + 'T03:00:00Z'),
          listStartedAt: new Date(yesterday + 'T03:00:00Z'),
          distanceMeters: 5000,
          movingMs: BigInt(1800000),
          elapsedMs: BigInt(1900000),
          avgHrBpm: 145,
          rawObjectRef: 'PRIVATE-FIT',
        },
        {
          userId: b.id,
          sourceProvider: 'MANUAL',
          sportType: 'RUNNING',
          startedAt: new Date(yesterday + 'T03:00:00Z'),
          listStartedAt: new Date(yesterday + 'T03:00:00Z'),
          distanceMeters: 90000,
        },
      ],
    })
    await prisma.dailyHealthMetric.createMany({
      data: [
        {
          userId: a.id,
          sourceProvider: 'GARMIN',
          garminAccountId: 'synthetic-export-current-account',
          localDate: new Date(yesterday),
          sourceTimezone: 'Asia/Tokyo',
          sleepSourceTimezone: 'Asia/Tokyo',
          restingHrBpm: 55,
          hrvMs: 40,
          sleepDurationMs: BigInt(28800000),
          summaryFetchedAt: new Date(),
          sleepFetchedAt: new Date(),
        },
        {
          userId: b.id,
          sourceProvider: 'GARMIN',
          garminAccountId: 'other-account',
          localDate: new Date(yesterday),
          sourceTimezone: 'Asia/Tokyo',
          restingHrBpm: 99,
          summaryFetchedAt: new Date(),
        },
      ],
    })
  }, 30000)
  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
    await prisma.$disconnect()
  })
  it('opens a reusable owner draft and saves consent-filtered dated evidence without credentials', async () => {
    const setup = await openPlanExport(owner, { goalId })
    expect((await openPlanExport(owner, { goalId })).draftId).toBe(setup.draftId)
    const artifact = await issuePlanExport(owner, {
      draftId: setup.draftId,
      expectedVersion: setup.version,
      allowedDetailWindow: {
        startDate: addHealthDays(today, 1),
        endDate: addHealthDays(today, 28),
      },
      consent: {
        ...defaultExportConsent,
        recordedActivityMetrics: true,
        activityHeartRate: true,
        recovery: true,
      },
    })
    const request = exchangeRequestSchema.parse(JSON.parse(artifact.json).request)
    savedId = request.requestId
    expect(request.goal).toMatchObject({
      distanceMeters: 17000,
      surface: 'TRAIL',
      elevationGainM: 600,
    })
    expect(request.trainingContext.recentRunSamples).toHaveLength(1)
    expect(request.trainingContext.recentRunSamples[0]).toMatchObject({
      distance: { value: 5000 },
      averagePace: { value: 360 },
      averageHr: { value: 145 },
    })
    expect(request.trainingContext.recoveryContext?.days[0]).toMatchObject({
      restingHr: { value: 55 },
      hrv: { value: null },
      sleepDuration: { value: 28800 },
    })
    expect(request.trainingContext.activityHistoryCoverage.status).toBe('sufficient')
    expect(await getIssuedPlanExport(owner, savedId)).toEqual(request)
    expect(artifact.prompt).toContain(artifact.json)
    for (const privateValue of ['PRIVATE-FIT', 'synthetic-export-current-account', 'other-account'])
      expect(artifact.prompt).not.toContain(privateValue)
  })
  it('denies cross-user ADMIN access and forged ownership at both service and foreign-key boundaries', async () => {
    await expect(openPlanExport(other, { goalId })).rejects.toThrow('not found')
    const setup = await openPlanExport(owner, { goalId })
    await expect(
      issuePlanExport(other, {
        draftId: setup.draftId,
        expectedVersion: setup.version,
        allowedDetailWindow: {
          startDate: addHealthDays(today, 1),
          endDate: addHealthDays(today, 28),
        },
        consent: defaultExportConsent,
      }),
    ).rejects.toThrow('not found')
    await expect(getIssuedPlanExport(other, savedId)).rejects.toThrow('not found')
    await expect(
      prisma.planExchangeRequest.create({
        data: {
          id: randomUUID(),
          userId: other.userId,
          goalId,
          draftId: setup.draftId,
          draftVersion: 0,
          schemaVersion: 1,
          generatedAt: new Date(),
          snapshot: {},
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' })
  })
  it('makes snapshots immutable and preserves their original version after draft edits', async () => {
    const snapshot = await getIssuedPlanExport(owner, savedId)
    await expect(
      prisma.planExchangeRequest.update({ where: { id: savedId }, data: { snapshot: {} } }),
    ).rejects.toThrow('immutable')
    await prisma.planDraft.update({
      where: { id: snapshot.draft.draftId },
      data: { version: { increment: 1 } },
    })
    expect((await getIssuedPlanExport(owner, savedId)).draft.version).toBe(snapshot.draft.version)
  })
  it('supersedes a prior consent snapshot so excluded health cannot reappear through an older response', async () => {
    const setup = await openPlanExport(owner, { goalId })
    const artifact = await issuePlanExport(owner, {
      draftId: setup.draftId,
      expectedVersion: setup.version,
      allowedDetailWindow: {
        startDate: addHealthDays(today, 1),
        endDate: addHealthDays(today, 28),
      },
      consent: defaultExportConsent,
    })
    await expect(getIssuedPlanExport(owner, savedId)).rejects.toThrow('changed')
    const current = await getIssuedPlanExport(owner, artifact.requestId)
    expect(current.trainingContext.recoveryContext).toBeUndefined()
    expect(current.trainingContext.recentRunSamples).toEqual([])
    expect(
      current.trainingContext.recentTrainingSummary.rollingTotals.every(
        (total) => total.movingDuration?.value === null,
      ),
    ).toBe(true)
  })
  it('orders tied generation times by database issuance, even when the later UUID sorts first', async () => {
    const setup = await openPlanExport(owner, { goalId })
    const artifact = await issuePlanExport(owner, {
      draftId: setup.draftId,
      expectedVersion: setup.version,
      allowedDetailWindow: {
        startDate: addHealthDays(today, 1),
        endDate: addHealthDays(today, 28),
      },
      consent: defaultExportConsent,
    })
    const snapshot = await getIssuedPlanExport(owner, artifact.requestId)
    const [lowerId, higherId] = [randomUUID(), randomUUID()].sort()
    const data = {
      userId: owner.userId,
      goalId,
      draftId: setup.draftId,
      draftVersion: setup.version,
      schemaVersion: 1,
      generatedAt: new Date(snapshot.generatedAt),
    }
    const earlier = await prisma.planExchangeRequest.create({
      data: { ...data, id: higherId, snapshot: { ...snapshot, requestId: higherId } },
    })
    const later = await prisma.planExchangeRequest.create({
      data: { ...data, id: lowerId, snapshot: { ...snapshot, requestId: lowerId } },
    })
    expect(later.issuanceSequence).toBeGreaterThan(earlier.issuanceSequence)
    expect((await getIssuedPlanExport(owner, lowerId)).requestId).toBe(lowerId)
    await expect(getIssuedPlanExport(owner, higherId)).rejects.toThrow('changed')
    await expect(getIssuedPlanExport(other, lowerId)).rejects.toThrow('not found')
  })
  it('assigns unique issuance order to concurrent previews without modifying the draft version', async () => {
    const setup = await openPlanExport(owner, { goalId })
    const command = {
      draftId: setup.draftId,
      expectedVersion: setup.version,
      allowedDetailWindow: {
        startDate: addHealthDays(today, 1),
        endDate: addHealthDays(today, 28),
      },
      consent: defaultExportConsent,
    }
    const artifacts = await Promise.all([
      issuePlanExport(owner, command),
      issuePlanExport(owner, command),
    ])
    const rows = await prisma.planExchangeRequest.findMany({
      where: { userId: owner.userId, id: { in: artifacts.map((a) => a.requestId) } },
      orderBy: { issuanceSequence: 'desc' },
    })
    expect(rows).toHaveLength(2)
    expect(rows[0].issuanceSequence).toBeGreaterThan(rows[1].issuanceSequence)
    expect((await getIssuedPlanExport(owner, rows[0].id)).requestId).toBe(rows[0].id)
    await expect(getIssuedPlanExport(owner, rows[1].id)).rejects.toThrow('changed')
    expect(
      (await prisma.planDraft.findUniqueOrThrow({ where: { id: setup.draftId } })).version,
    ).toBe(setup.version)
  })
})
