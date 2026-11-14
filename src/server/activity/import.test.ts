import { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getPrismaClient,
  isVerifiedCurrentUser,
  transaction,
  upsert,
  findExisting,
  deleteLaps,
  findLaps,
  createLaps,
  findNear,
  deleteCandidates,
  upsertCandidate,
  findOne,
  findMany,
} = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
  isVerifiedCurrentUser: vi.fn(() => true),
  transaction: vi.fn(),
  upsert: vi.fn(),
  findExisting: vi.fn(),
  deleteLaps: vi.fn(),
  findLaps: vi.fn(),
  createLaps: vi.fn(),
  findNear: vi.fn(),
  deleteCandidates: vi.fn(),
  upsertCandidate: vi.fn(),
  findOne: vi.fn(),
  findMany: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser }))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { canonicalActivitySchema } from './normalization'
import { canSkipFitDownload, getActivity, importCanonicalActivity, listActivities } from './import'

const userA = '00000000-0000-4000-8000-000000000001'
const userB = '00000000-0000-4000-8000-000000000002'
const savedId = '00000000-0000-4000-8000-000000000011'
const otherId = '00000000-0000-4000-8000-000000000012'
const ownerA = getOwnerContext({ id: userA, role: 'USER', email: null })
const ownerB = getOwnerContext({ id: userB, role: 'ADMIN', email: null })

const input = canonicalActivitySchema.parse({
  source: {
    userId: userA,
    provider: 'GARMIN',
    externalActivityId: 'synthetic-1',
    externalActivityUuid: null,
    recordType: 'API_ACTIVITY',
  },
  sportType: 'RUNNING',
  sourceSportType: 'running',
  startedAt: '2026-11-08T06:30:00.000Z',
  sourceTimezone: 'UTC',
  gpsAssetRef: null,
  distanceMeters: 5000.125,
  totalMs: 1800000,
  elapsedMs: 1800000,
  movingMs: null,
  avgSpeedMps: 2.77,
  avgHrBpm: null,
  maxHrBpm: null,
  cadenceStepsPerMinute: null,
  elevationGainMeters: null,
  elevationLossMeters: null,
  laps: [
    {
      lapIndex: 0,
      sourceRecordType: 'FIT_LAP',
      startedAt: '2026-11-08T06:30:00.000Z',
      distanceMeters: 5000.125,
      elapsedMs: 1800000,
      movingMs: null,
      avgHrBpm: null,
      avgSpeedMps: null,
      cadenceStepsPerMinute: null,
    },
  ],
})

function storedActivity(overrides: Record<string, unknown> = {}) {
  return {
    id: savedId,
    sourceObservedAt: null,
    lapImportStatus: 'IMPORTED',
    externalActivityUuid: null,
    sourceRecordType: 'API_ACTIVITY',
    sportType: 'RUNNING',
    sourceSportType: 'running',
    startedAt: new Date(input.startedAt),
    listStartedAt: new Date(input.startedAt),
    sourceTimezone: 'UTC',
    distanceMeters: new Prisma.Decimal('5000.125'),
    totalMs: BigInt(1800000),
    elapsedMs: BigInt(1800000),
    movingMs: null,
    avgSpeedMps: new Prisma.Decimal('2.77'),
    avgHrBpm: null,
    maxHrBpm: null,
    cadence: null,
    elevationGainMeters: null,
    elevationLossMeters: null,
    gpsAssetRef: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  upsert.mockResolvedValue({ id: savedId })
  findExisting.mockResolvedValue(null)
  deleteLaps.mockResolvedValue({ count: 0 })
  findLaps.mockResolvedValue([])
  createLaps.mockResolvedValue({ count: 1 })
  findNear.mockResolvedValue([])
  deleteCandidates.mockResolvedValue({ count: 0 })
  upsertCandidate.mockResolvedValue({ id: 'candidate-id' })
  findOne.mockResolvedValue(null)
  findMany.mockResolvedValue([])
  const tx = {
    activity: { findUnique: findExisting, upsert, findMany: findNear },
    activityLap: { findMany: findLaps, deleteMany: deleteLaps, createMany: createLaps },
    activityDuplicateCandidate: { deleteMany: deleteCandidates, upsert: upsertCandidate },
  }
  transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) =>
    callback(tx),
  )
  getPrismaClient.mockResolvedValue({
    $transaction: transaction,
    activity: { findFirst: findOne, findMany, findUnique: findExisting },
    integrationConnection: { findUnique: vi.fn(async () => ({ externalAccountId: '123456' })) },
  })
})

it('merges sparse unchanged summaries and retains FIT laps and their check timestamp', async () => {
  findExisting.mockResolvedValue(storedActivity({ avgHrBpm: 145, maxHrBpm: 175 }))
  await importCanonicalActivity(
    ownerA,
    {
      ...input,
      distanceMeters: null,
      totalMs: null,
      elapsedMs: null,
      avgSpeedMps: null,
      laps: null,
    },
    { summaryOnly: true, garminAccountId: 'synthetic-account' },
  )
  expect(upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        userId_sourceProvider_externalActivityId_garminAccountId: {
          userId: userA,
          sourceProvider: 'GARMIN',
          externalActivityId: 'synthetic-1',
          garminAccountId: 'synthetic-account',
        },
      },
      update: expect.objectContaining({
        distanceMeters: 5000.125,
        totalMs: BigInt(1800000),
        avgHrBpm: 145,
        maxHrBpm: 175,
        avgSpeedMps: 2.77,
        lapImportStatus: 'RETAINED',
        fitCheckedAt: undefined,
      }),
    }),
  )
  expect(deleteLaps).not.toHaveBeenCalled()
  expect(createLaps).not.toHaveBeenCalled()
})

it.each([null, 'ROAD'] as const)(
  'retains FIT data when only surface metadata changes from %s',
  async (surfaceType) => {
    const observedAt = new Date('2026-11-12T02:00:00Z')
    findExisting.mockResolvedValue(
      storedActivity({
        surfaceType,
        sourceSportType: 'trail_running',
        fitCheckedAt: observedAt,
        fitImportState: 'COMPLETE',
      }),
    )
    const summary = { ...input, sourceSportType: 'trail_running', surfaceType: 'TRAIL', laps: null }
    expect(
      await canSkipFitDownload(ownerA, summary, {
        observedAt,
        refresh: true,
        garminAccountId: 'synthetic-account',
      }),
    ).toBe(true)
    expect(
      (
        await importCanonicalActivity(ownerA, summary, {
          summaryOnly: true,
          garminAccountId: 'synthetic-account',
          sourceObservedAt: observedAt,
        })
      ).lapImportStatus,
    ).toBe('RETAINED')
    expect(upsert.mock.calls[0][0].update).toMatchObject({
      surfaceType: 'TRAIL',
      lapImportStatus: 'RETAINED',
      fitCheckedAt: undefined,
    })
    expect(upsert.mock.calls[0][0].update).not.toHaveProperty('fitImportState')
    expect(deleteLaps).not.toHaveBeenCalled()
    expect(createLaps).not.toHaveBeenCalled()
  },
)

it('invalidates old FIT laps and freshness when a summary changes their verified identity', async () => {
  const observedAt = new Date('2026-11-12T02:00:00Z')
  findExisting.mockResolvedValue(storedActivity({ fitCheckedAt: observedAt }))
  const changed = { ...input, distanceMeters: 10000, laps: null }
  await importCanonicalActivity(ownerA, changed, {
    summaryOnly: true,
    garminAccountId: 'synthetic-account',
    sourceObservedAt: observedAt,
  })
  expect(upsert.mock.calls[0][0].update).toMatchObject({
    distanceMeters: 10000,
    lapImportStatus: 'UNAVAILABLE',
    fitCheckedAt: null,
  })
  expect(deleteLaps).toHaveBeenCalledWith({ where: { userId: userA, activityId: savedId } })
  expect(createLaps).not.toHaveBeenCalled()
  findExisting.mockResolvedValue(
    storedActivity({
      distanceMeters: new Prisma.Decimal(10000),
      lapImportStatus: 'UNAVAILABLE',
      fitCheckedAt: null,
    }),
  )
  for (const refresh of [false, true])
    expect(
      await canSkipFitDownload(ownerA, changed, {
        refresh,
        observedAt,
        garminAccountId: 'synthetic-account',
      }),
    ).toBe(false)
})

it('rejects another owner even in summaries-only mode', async () => {
  await expect(
    importCanonicalActivity(ownerB, { ...input, laps: null }, { summaryOnly: true }),
  ).rejects.toThrow()
  expect(transaction).not.toHaveBeenCalled()
})

describe('owner-scoped activity persistence', () => {
  it('writes one owner/provider identity, ordered laps and serializable duplicate query', async () => {
    await importCanonicalActivity(ownerA, input)
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_sourceProvider_externalActivityId_garminAccountId: {
            userId: userA,
            sourceProvider: 'GARMIN',
            externalActivityId: 'synthetic-1',
            garminAccountId: 'LEGACY_UNVERIFIED',
          },
        },
        update: expect.objectContaining({ distanceMeters: 5000.125, totalMs: BigInt(1800000) }),
      }),
    )
    expect(createLaps).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({ activityId: savedId, lapIndex: 0, distanceMeters: 5000.125 }),
        ],
      }),
    )
    expect(findNear).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: userA, sourceProvider: { not: 'GARMIN' } }),
      }),
    )
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    })
  })

  it('retains verified laps on unchanged JSON when FIT is unavailable', async () => {
    findExisting.mockResolvedValue(storedActivity())
    const result = await importCanonicalActivity(ownerA, { ...input, laps: null })
    expect(result.lapImportStatus).toBe('RETAINED')
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ lapImportStatus: 'RETAINED' }),
      }),
    )
    expect(deleteLaps).not.toHaveBeenCalled()
    expect(createLaps).not.toHaveBeenCalled()
  })

  it('drops stale laps when JSON changed and FIT is unavailable', async () => {
    findExisting.mockResolvedValue(storedActivity())
    const result = await importCanonicalActivity(ownerA, {
      ...input,
      distanceMeters: 5100,
      laps: null,
    })
    expect(result.lapImportStatus).toBe('UNAVAILABLE')
    expect(deleteLaps).toHaveBeenCalledWith({ where: { userId: userA, activityId: savedId } })
  })

  it('does not let an older observation replace a newer committed activity', async () => {
    findExisting.mockResolvedValue(
      storedActivity({
        sourceObservedAt: new Date('2026-11-08T12:00:00Z'),
        lapImportStatus: 'RETAINED',
      }),
    )
    const result = await importCanonicalActivity(
      ownerA,
      {
        ...input,
        distanceMeters: 4000,
      },
      { sourceObservedAt: new Date('2026-11-08T11:00:00Z') },
    )
    expect(result).toEqual({ id: savedId, lapImportStatus: 'RETAINED' })
    expect(upsert).not.toHaveBeenCalled()
    expect(deleteLaps).not.toHaveBeenCalled()
    expect(deleteCandidates).not.toHaveBeenCalled()
  })

  it('keeps a lap ID with its source start when an earlier lap is inserted', async () => {
    findLaps.mockResolvedValue([
      {
        id: 'old-lap-id',
        startedAt: new Date(input.laps?.[0].startedAt ?? ''),
        sourceRecordType: 'FIT_LAP',
      },
    ])
    const earlier = { ...input.laps?.[0], lapIndex: 0, startedAt: '2026-11-08T06:20:00.000Z' }
    const shifted = { ...input.laps?.[0], lapIndex: 1 }
    await importCanonicalActivity(ownerA, { ...input, laps: [earlier, shifted] })
    expect(createLaps).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            id: 'old-lap-id',
            lapIndex: 1,
            startedAt: new Date(input.startedAt),
          }),
          expect.objectContaining({ lapIndex: 0, startedAt: new Date('2026-11-08T06:20:00.000Z') }),
        ]),
      }),
    )
  })

  it('flags a plausible second provider only within the same owner', async () => {
    findNear.mockResolvedValue([
      {
        id: otherId,
        userId: userA,
        sourceProvider: 'INTERVALS',
        externalActivityId: 'other-1',
        externalActivityUuid: null,
        sourceRecordType: 'API_ACTIVITY',
        sportType: 'RUNNING',
        sourceSportType: 'Run',
        startedAt: new Date(input.startedAt),
        sourceTimezone: 'UTC',
        gpsAssetRef: null,
        distanceMeters: new Prisma.Decimal('5000.125'),
        totalMs: BigInt(1800000),
        elapsedMs: BigInt(1800000),
        movingMs: null,
        avgSpeedMps: null,
        avgHrBpm: null,
        maxHrBpm: null,
        cadence: null,
        elevationGainMeters: null,
        elevationLossMeters: null,
      },
    ])
    await importCanonicalActivity(ownerA, input)
    expect(upsertCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { userId: userA, firstActivityId: savedId, secondActivityId: otherId },
      }),
    )
  })

  it('rejects forged and cross-owner writes before database access', async () => {
    await expect(importCanonicalActivity({ userId: userA }, input)).rejects.toThrow(
      'Verified owner context required',
    )
    await expect(importCanonicalActivity(ownerB, input)).rejects.toThrow('Invalid activity import')
    expect(getPrismaClient).not.toHaveBeenCalled()
  })

  it('scopes detail and cursor reads to the owner', async () => {
    expect(await getActivity(ownerB, savedId)).toBeNull()
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: userB, id: savedId }) }),
    )
    await expect(listActivities(ownerB, 2, savedId)).rejects.toThrow('Invalid activity import')
    expect(findMany).not.toHaveBeenCalled()
    await listActivities(ownerA, 2)
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: userA }),
        take: 3,
        orderBy: [{ listStartedAt: 'desc' }, { id: 'desc' }],
      }),
    )
  })

  it('uses the encoded original sort boundary and rejects another owner cursor', async () => {
    const row = {
      ...storedActivity(),
      sourceProvider: 'GARMIN',
      externalActivityId: 'synthetic-1',
      duplicateCandidatesAsFirst: [],
      duplicateCandidatesAsSecond: [],
    }
    findMany.mockResolvedValueOnce([row, { ...row, id: otherId }])
    const first = await listActivities(ownerA, 1)
    expect(first.nextCursor).toBeTruthy()
    await expect(listActivities(ownerB, 1, first.nextCursor ?? undefined)).rejects.toThrow(
      'Invalid activity import',
    )
    expect(findMany).toHaveBeenCalledTimes(1)

    await listActivities(ownerA, 1, first.nextCursor ?? undefined)
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: userA,
          AND: [
            {
              OR: [
                { listStartedAt: { lt: new Date(input.startedAt) } },
                { listStartedAt: new Date(input.startedAt), id: { lt: savedId } },
              ],
            },
          ],
        }),
        take: 2,
      }),
    )
    expect(findMany.mock.lastCall?.[0]).not.toHaveProperty('cursor')
    expect(findMany.mock.lastCall?.[0]).not.toHaveProperty('skip')
  })

  it('returns canonical owner data without private raw or GPS references', async () => {
    findMany.mockResolvedValue([
      {
        id: savedId,
        sourceProvider: 'GARMIN',
        externalActivityId: 'synthetic-1',
        externalActivityUuid: null,
        sourceRecordType: 'API_ACTIVITY',
        sportType: 'RUNNING',
        sourceSportType: 'running',
        startedAt: new Date(input.startedAt),
        listStartedAt: new Date(input.startedAt),
        sourceTimezone: 'UTC',
        distanceMeters: new Prisma.Decimal('5000.125'),
        totalMs: BigInt(1800000),
        elapsedMs: BigInt(1800000),
        movingMs: null,
        avgSpeedMps: new Prisma.Decimal('2.77'),
        avgHrBpm: null,
        maxHrBpm: null,
        cadence: null,
        elevationGainMeters: null,
        elevationLossMeters: null,
        lapImportStatus: 'UNAVAILABLE',
        duplicateCandidatesAsFirst: [],
        duplicateCandidatesAsSecond: [],
        rawObjectRef: 'private-object-ref',
        gpsAssetRef: 'private-gps-ref',
      },
    ])
    const page = await listActivities(ownerA, 20)
    expect(page.items[0]).toMatchObject({ distanceMeters: 5000.125, totalMs: 1800000 })
    expect(JSON.stringify(page)).not.toContain('private-object-ref')
    expect(JSON.stringify(page)).not.toContain('private-gps-ref')
  })
})
