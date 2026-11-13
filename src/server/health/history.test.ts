import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPrismaClient, assertProviderApiKeySnapshotCurrent, isVerifiedCurrentUser } = vi.hoisted(
  () => ({
    getPrismaClient: vi.fn(),
    assertProviderApiKeySnapshotCurrent: vi.fn(async () => {}),
    isVerifiedCurrentUser: vi.fn(() => true),
  }),
)
vi.mock('server-only', () => ({}))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))
vi.mock('@/server/provider/vault', () => ({ assertProviderApiKeySnapshotCurrent }))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { getHealthSnapshot, getHealthTrendRows, saveGarminHealthObservation } from './history'

const owner = getOwnerContext({
  id: '00000000-0000-4000-8000-000000000001',
  role: 'USER',
  email: null,
})
const other = getOwnerContext({
  id: '00000000-0000-4000-8000-000000000002',
  role: 'ADMIN',
  email: null,
})
const fetchedAt = new Date('2026-11-08T12:00:00Z')

function fixture() {
  const createMany = vi.fn(async (...args: [{ data: Record<string, unknown> }]) => {
    void args
    return { count: 1 }
  })
  const updateMany = vi.fn(
    async (...args: [{ data: Record<string, unknown>; where: Record<string, unknown> }]) => {
      void args
      return { count: 1 }
    },
  )
  const findFirst = vi.fn<
    (_query: { where: { userId: string; garminAccountId?: string } }) => Promise<unknown>
  >(async () => null)
  const findMany = vi.fn<(_query: { where: { userId: string } }) => Promise<unknown[]>>(
    async () => [],
  )
  const tx = { dailyHealthMetric: { createMany, updateMany } }
  const db = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<void>) => callback(tx)),
    dailyHealthMetric: { findFirst, findMany },
    integrationConnection: {
      findUnique: vi.fn(async () => ({
        externalAccountId: '123456',
      })),
    },
  }
  getPrismaClient.mockResolvedValue(db)
  return { createMany, updateMany, findFirst, findMany }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('owner-scoped Garmin health history', () => {
  it('reads all stored dates only for the owner and linked Garmin account', async () => {
    const { findMany } = fixture()
    await getHealthTrendRows(owner, null, '2026-11-10')
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: owner.userId,
          sourceProvider: 'GARMIN',
          garminAccountId: '123456',
          localDate: { lte: new Date('2026-11-10T00:00:00.000Z') },
        }),
      }),
    )
    await getHealthTrendRows(other, null, '2026-11-10')
    expect(findMany.mock.calls[1][0].where.userId).toBe(other.userId)
  })

  it('upserts distinct source fields without replacing missing metrics with zero', async () => {
    const { createMany, updateMany } = fixture()
    const base = {
      userId: owner.userId,
      sourceProvider: 'GARMIN' as const,
      sourceRecordId: null,
      localDate: '2026-11-07',
      sourceTimezone: 'America/New_York',
      restingHrBpm: null,
      hrvMs: null,
      sleepDurationMs: null,
      sleepStartedAt: null,
      sleepScore: null,
      steps: null,
      stress: null,
      bodyBattery: null,
    }
    await saveGarminHealthObservation(
      owner,
      'summary',
      base.localDate,
      base.sourceTimezone,
      {
        ...base,
        sourceRecordType: 'API_DAILY_SUMMARY',
        restingHrBpm: 54,
      },
      new Uint8Array([1]),
      '123456',
      fetchedAt,
      BigInt(1),
    )
    await saveGarminHealthObservation(
      owner,
      'sleep',
      base.localDate,
      base.sourceTimezone,
      {
        ...base,
        sourceRecordType: 'API_SLEEP',
        sleepDurationMs: 25_200_000,
      },
      new Uint8Array([1]),
      '123456',
      fetchedAt,
      BigInt(1),
    )
    expect(createMany).toHaveBeenCalledTimes(2)
    expect(updateMany).toHaveBeenCalledTimes(2)
    expect(updateMany.mock.calls[0][0].data).toEqual({
      credentialNonce: new Uint8Array([1]),
      restingHrBpm: 54,
      summaryFetchedAt: fetchedAt,
      summaryAttemptSequence: BigInt(1),
      sourceTimezone: base.sourceTimezone,
      sourceTimezoneBasis: 'REQUEST_INFERRED',
    })
    expect(updateMany.mock.calls[1][0].data).toEqual({
      credentialNonce: new Uint8Array([1]),
      sleepDurationMs: BigInt(25_200_000),
      sleepStartedAt: null,
      sleepEndedAt: null,
      sleepLightMs: null,
      sleepDeepMs: null,
      sleepRemMs: null,
      sleepAwakeMs: null,
      sleepScore: null,
      sleepFetchedAt: fetchedAt,
      sleepAttemptSequence: BigInt(1),
      sleepSourceTimezone: base.sourceTimezone,
      sleepTimezoneBasis: 'REQUEST_INFERRED',
    })
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      OR: [{ summaryAttemptSequence: null }, { summaryAttemptSequence: { lte: BigInt(1) } }],
    })
    expect(updateMany.mock.calls[1][0].where).toMatchObject({
      OR: [{ sleepAttemptSequence: null }, { sleepAttemptSequence: { lte: BigInt(1) } }],
    })
  })

  it('records checked-empty sources without clearing existing measurements', async () => {
    const { updateMany } = fixture()
    for (const kind of ['summary', 'sleep'] as const) {
      await saveGarminHealthObservation(
        owner,
        kind,
        '2026-11-07',
        'UTC',
        null,
        new Uint8Array([1]),
        '123456',
        fetchedAt,
        BigInt(2),
      )
    }
    expect(updateMany.mock.calls[0][0].data).toMatchObject({ summaryFetchedAt: fetchedAt })
    expect(updateMany.mock.calls[0][0].data).not.toHaveProperty('restingHrBpm')
    expect(updateMany.mock.calls[0][0].data).not.toHaveProperty('sourceTimezone')
    expect(updateMany.mock.calls[1][0].data).toMatchObject({ sleepFetchedAt: fetchedAt })
    expect(updateMany.mock.calls[1][0].data).not.toHaveProperty('sleepDurationMs')
    expect(updateMany.mock.calls[1][0].data).not.toHaveProperty('sleepSourceTimezone')
  })

  it('rejects another user observation even for an admin owner', async () => {
    const { createMany, updateMany } = fixture()
    await expect(
      saveGarminHealthObservation(
        other,
        'summary',
        '2026-11-07',
        'UTC',
        {
          userId: owner.userId,
          sourceProvider: 'GARMIN',
          sourceRecordType: 'API_DAILY_SUMMARY',
          sourceRecordId: null,
          localDate: '2026-11-07',
          sourceTimezone: 'UTC',
          restingHrBpm: 55,
          hrvMs: null,
          sleepDurationMs: null,
          sleepStartedAt: null,
          sleepScore: null,
          steps: null,
          stress: null,
          bodyBattery: null,
        },
        new Uint8Array([1]),
        '123456',
        fetchedAt,
        BigInt(1),
      ),
    ).rejects.toThrow('identity mismatch')
    expect(createMany).not.toHaveBeenCalled()
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('queries only the authenticated owner and keeps each metric dated', async () => {
    const { findFirst } = fixture()
    findFirst
      .mockResolvedValueOnce({
        restingHrBpm: 52,
        summaryFetchedAt: fetchedAt,
        localDate: new Date('2026-11-05'),
        sourceTimezone: 'UTC',
      })
      .mockResolvedValueOnce({
        sleepDurationMs: BigInt(21_600_000),
        sleepFetchedAt: fetchedAt,
        localDate: new Date('2026-11-07'),
        sourceTimezone: 'UTC',
        sleepSourceTimezone: 'Asia/Tokyo',
      })
      .mockResolvedValueOnce({
        sleepScore: 82,
        sleepFetchedAt: fetchedAt,
        localDate: new Date('2026-11-06'),
        sourceTimezone: 'UTC',
        sleepSourceTimezone: 'America/New_York',
      })
      .mockResolvedValueOnce({ summaryFetchedAt: fetchedAt })
      .mockResolvedValueOnce({ sleepFetchedAt: fetchedAt })
    const snapshot = await getHealthSnapshot(other)
    expect(snapshot.restingHr).toMatchObject({ value: 52, date: '2026-11-05' })
    expect(snapshot.sleep).toMatchObject({
      value: 21_600_000,
      date: '2026-11-07',
      timezone: 'Asia/Tokyo',
    })
    expect(snapshot.sleepScore).toMatchObject({
      value: 82,
      date: '2026-11-06',
      timezone: 'America/New_York',
    })
    expect(snapshot.restingHrChecked).toBe(true)
    expect(snapshot.sleepChecked).toBe(true)
    expect(snapshot.lastUpdatedAt).toBe(fetchedAt.toISOString())
    expect(findFirst.mock.calls.every(([query]) => query.where.userId === other.userId)).toBe(true)
    expect(findFirst.mock.calls.every(([query]) => query.where.garminAccountId === '123456')).toBe(
      true,
    )
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ summaryFetchedAt: { not: null } })
    expect(findFirst.mock.calls[1][0].where).toMatchObject({ sleepFetchedAt: { not: null } })
    expect(findFirst.mock.calls[2][0].where).toMatchObject({
      sleepScore: { not: null },
      sleepFetchedAt: { not: null },
    })
  })

  it.each([
    {
      name: 'the latest duration has no score',
      latestDuration: BigInt(25_000_000),
      latestScore: null,
      olderScore: 0,
      expectedScore: 0,
      expectedDate: '2026-11-12',
    },
    {
      name: 'the latest score has no duration',
      latestDuration: null,
      latestScore: 90,
      olderScore: 78,
      expectedScore: 90,
      expectedDate: '2026-11-13',
    },
  ])(
    'selects Sleep Score independently when $name, keeping owner and account isolation',
    async ({ latestDuration, latestScore, olderScore, expectedScore, expectedDate }) => {
      const { findFirst } = fixture()
      const row = (
        userId: string,
        date: string,
        duration: bigint | null,
        score: number | null,
        account = '123456',
        checked: Date | null = fetchedAt,
      ) => ({
        userId,
        sourceProvider: 'GARMIN',
        garminAccountId: account,
        localDate: new Date(date),
        sleepDurationMs: duration,
        sleepScore: score,
        sleepFetchedAt: checked,
        sourceTimezone: 'UTC',
        sleepSourceTimezone: 'Asia/Tokyo',
      })
      const rows = [
        row(owner.userId, '2026-11-13', latestDuration, latestScore),
        row(owner.userId, '2026-11-12', BigInt(24_000_000), olderScore),
        row(other.userId, '2026-11-13', BigInt(27_000_000), 99),
        row(owner.userId, '2026-11-14', BigInt(28_000_000), 100, 'different-account'),
        row(owner.userId, '2026-11-14', BigInt(29_000_000), 98, '123456', null),
      ]
      findFirst.mockImplementation(async ({ where }) => {
        const owned = rows
          .filter(
            (item) =>
              item.userId === where.userId &&
              item.garminAccountId === where.garminAccountId &&
              item.sleepFetchedAt,
          )
          .sort((a, b) => b.localDate.getTime() - a.localDate.getTime())
        if ('restingHrBpm' in where || 'summaryFetchedAt' in where) return null
        if ('sleepDurationMs' in where)
          return owned.find((item) => item.sleepDurationMs !== null) ?? null
        if ('sleepScore' in where) return owned.find((item) => item.sleepScore !== null) ?? null
        return owned[0] ?? null
      })
      expect((await getHealthSnapshot(owner)).sleepScore).toMatchObject({
        value: expectedScore,
        date: expectedDate,
        timezone: 'Asia/Tokyo',
        fetchedAt: fetchedAt.toISOString(),
      })
      expect((await getHealthSnapshot(other)).sleepScore?.value).toBe(99)
      expect(
        findFirst.mock.calls.every(([query]) => query.where.garminAccountId === '123456'),
      ).toBe(true)
    },
  )
})
