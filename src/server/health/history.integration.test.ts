import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import {
  disconnectProvider,
  readProviderApiKeySnapshot,
  saveProviderApiKey,
} from '@/server/provider/vault'
import { reserveGarminHealthAttempt } from '@/server/garmin/import-rate-limit'
import {
  getHealthSnapshot,
  getHealthTrendRows,
  listHealthHistory,
  saveGarminHealthObservation,
} from './history'
import type { DailyHealthObservation } from './normalization'

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

describe.skipIf(!enabled)('Garmin health history on isolated PostgreSQL', () => {
  let prisma: PrismaClient
  let owner: ReturnType<typeof getOwnerContext>
  let other: ReturnType<typeof getOwnerContext>
  let nonce: Uint8Array
  const prefix = `run25-health-${randomUUID()}`
  const date = '2026-11-07'

  beforeAll(async () => {
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1'
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 51).toString('base64')
    prisma = await getPrismaClient()
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-a` } })
    const b = await prisma.user.create({ data: { authSubject: `${prefix}-b`, role: 'ADMIN' } })
    owner = getOwnerContext({ id: a.id, role: 'USER', email: null })
    other = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
    await saveProviderApiKey(owner, 'GARMIN', 'synthetic-garmin-health-key', {
      verifiedGarminAccountId: '123456',
    })
    nonce = (await readProviderApiKeySnapshot(owner, 'GARMIN')).nonce
  }, 30_000)

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
      await prisma.$disconnect()
    }
    delete process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1
  })

  function observation(kind: 'API_DAILY_SUMMARY' | 'API_SLEEP'): DailyHealthObservation {
    return {
      userId: owner.userId,
      sourceProvider: 'GARMIN',
      sourceRecordType: kind,
      sourceRecordId: null,
      localDate: date,
      sourceTimezone: 'America/New_York',
      restingHrBpm: kind === 'API_DAILY_SUMMARY' ? 53 : null,
      hrvMs: null,
      sleepDurationMs: kind === 'API_SLEEP' ? 25_200_000 : null,
      sleepStartedAt: kind === 'API_SLEEP' ? '2026-11-06T22:00:00Z' : null,
      sleepEndedAt: kind === 'API_SLEEP' ? '2026-11-07T05:20:00Z' : null,
      sleepLightMs: kind === 'API_SLEEP' ? 14_400_000 : null,
      sleepDeepMs: kind === 'API_SLEEP' ? 5_400_000 : null,
      sleepRemMs: kind === 'API_SLEEP' ? 5_400_000 : null,
      sleepAwakeMs: kind === 'API_SLEEP' ? 1_200_000 : null,
      sleepScore: kind === 'API_SLEEP' ? 82 : null,
      steps: null,
      stress: null,
      bodyBattery: null,
    }
  }

  it('upserts both sources once and isolates an admin owner from the readings', async () => {
    const at = new Date('2026-11-08T12:00:00Z')
    const firstAttempt = await reserveGarminHealthAttempt(owner, nonce, '123456')
    await saveGarminHealthObservation(
      owner,
      'summary',
      date,
      'America/New_York',
      observation('API_DAILY_SUMMARY'),
      nonce,
      '123456',
      at,
      firstAttempt,
    )
    await saveGarminHealthObservation(
      owner,
      'sleep',
      date,
      'America/New_York',
      observation('API_SLEEP'),
      nonce,
      '123456',
      at,
      firstAttempt,
    )
    await saveGarminHealthObservation(
      owner,
      'summary',
      date,
      'America/New_York',
      observation('API_DAILY_SUMMARY'),
      nonce,
      '123456',
      at,
      firstAttempt,
    )
    expect(await prisma.dailyHealthMetric.count({ where: { userId: owner.userId } })).toBe(1)
    const history = await listHealthHistory(owner)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      restingHrBpm: 53,
      sleepDurationMs: BigInt(25_200_000),
      sleepLightMs: BigInt(14_400_000),
      sleepDeepMs: BigInt(5_400_000),
      sleepRemMs: BigInt(5_400_000),
      sleepAwakeMs: BigInt(1_200_000),
      sleepScore: 82,
      sourceTimezone: 'America/New_York',
      sleepSourceTimezone: 'America/New_York',
    })
    expect(history[0].summaryFetchedAt).toEqual(at)
    expect(history[0].sleepFetchedAt).toEqual(at)
    expect(history[0].summaryAttemptSequence).toBe(firstAttempt)
    expect(history[0].sleepAttemptSequence).toBe(firstAttempt)
    const correctedAttempt = await reserveGarminHealthAttempt(owner, nonce, '123456')
    await saveGarminHealthObservation(
      owner,
      'sleep',
      date,
      'Asia/Tokyo',
      { ...observation('API_SLEEP'), sourceTimezone: 'Asia/Tokyo' },
      nonce,
      '123456',
      at,
      correctedAttempt,
    )
    const corrected = await prisma.dailyHealthMetric.findFirstOrThrow({
      where: { userId: owner.userId },
    })
    expect(corrected.sourceTimezone).toBe('America/New_York')
    expect(corrected.sleepSourceTimezone).toBe('Asia/Tokyo')
    expect((await getHealthSnapshot(owner)).sleep?.timezone).toBe('Asia/Tokyo')
    const olderAttempt = await reserveGarminHealthAttempt(owner, nonce, '123456')
    const newerAttempt = await reserveGarminHealthAttempt(owner, nonce, '123456')
    expect(newerAttempt).toBe(olderAttempt + BigInt(1))
    await saveGarminHealthObservation(
      owner,
      'summary',
      date,
      'America/New_York',
      { ...observation('API_DAILY_SUMMARY'), restingHrBpm: 57 },
      nonce,
      '123456',
      at,
      newerAttempt,
    )
    await saveGarminHealthObservation(
      owner,
      'summary',
      date,
      'America/New_York',
      { ...observation('API_DAILY_SUMMARY'), restingHrBpm: 42 },
      nonce,
      '123456',
      at,
      olderAttempt,
    )
    await saveGarminHealthObservation(
      owner,
      'sleep',
      date,
      'Asia/Tokyo',
      {
        ...observation('API_SLEEP'),
        sourceTimezone: 'Asia/Tokyo',
        sleepDurationMs: 26_000_000,
      },
      nonce,
      '123456',
      at,
      newerAttempt,
    )
    await saveGarminHealthObservation(
      owner,
      'sleep',
      date,
      'Asia/Tokyo',
      {
        ...observation('API_SLEEP'),
        sourceTimezone: 'Asia/Tokyo',
        sleepDurationMs: 20_000_000,
      },
      nonce,
      '123456',
      at,
      olderAttempt,
    )
    const afterStaleWrite = await prisma.dailyHealthMetric.findFirstOrThrow({
      where: { userId: owner.userId, localDate: new Date(`${date}T00:00:00Z`) },
    })
    expect(afterStaleWrite.restingHrBpm).toBe(57)
    expect(afterStaleWrite.summaryFetchedAt).toEqual(at)
    expect(afterStaleWrite.summaryAttemptSequence).toBe(newerAttempt)
    expect(afterStaleWrite.sleepDurationMs).toBe(BigInt(26_000_000))
    expect(afterStaleWrite.sleepLightMs).toBe(BigInt(14_400_000))
    expect(afterStaleWrite.sleepScore).toBe(82)
    expect(afterStaleWrite.sleepAttemptSequence).toBe(newerAttempt)
    const emptyCheckAt = new Date('2026-11-09T12:00:00Z')
    await saveGarminHealthObservation(
      owner,
      'summary',
      date,
      'UTC',
      { ...observation('API_DAILY_SUMMARY'), restingHrBpm: null, sourceTimezone: 'UTC' },
      nonce,
      '123456',
      emptyCheckAt,
      await reserveGarminHealthAttempt(owner, nonce, '123456'),
    )
    await saveGarminHealthObservation(
      owner,
      'sleep',
      date,
      'UTC',
      null,
      nonce,
      '123456',
      emptyCheckAt,
      await reserveGarminHealthAttempt(owner, nonce, '123456'),
    )
    const afterEmptyCheck = await prisma.dailyHealthMetric.findFirstOrThrow({
      where: { userId: owner.userId, localDate: new Date(`${date}T00:00:00Z`) },
    })
    expect(afterEmptyCheck).toMatchObject({
      restingHrBpm: 57,
      sleepDurationMs: BigInt(26_000_000),
      sleepLightMs: BigInt(14_400_000),
      sleepScore: 82,
      sourceTimezone: 'America/New_York',
      sleepSourceTimezone: 'Asia/Tokyo',
      summaryFetchedAt: emptyCheckAt,
      sleepFetchedAt: emptyCheckAt,
    })
    await prisma.dailyHealthMetric.create({
      data: {
        userId: owner.userId,
        sourceProvider: 'GARMIN',
        localDate: new Date('2026-11-08T00:00:00Z'),
        sourceTimezone: 'UTC',
        restingHrBpm: 60,
        sleepDurationMs: BigInt(28_800_000),
      },
    })
    const snapshot = await getHealthSnapshot(owner)
    expect(snapshot.restingHr).toMatchObject({ value: 57, date })
    expect(snapshot.sleep).toMatchObject({ value: 26_000_000, date })
    expect(await listHealthHistory(other)).toEqual([])
    expect(await getHealthTrendRows(other, '2026-11-01', '2026-11-09')).toEqual([])
    expect(await getHealthTrendRows(owner, '2026-11-07', '2026-11-08')).toMatchObject([
      {
        date: '2026-11-07',
        restingHrBpm: 57,
        sleepDurationMs: 26_000_000,
        sleepLightMs: 14_400_000,
        sleepDeepMs: 5_400_000,
        sleepRemMs: 5_400_000,
        sleepAwakeMs: 1_200_000,
        sleepScore: 82,
        sleepStartedAt: '2026-11-06T22:00:00.000Z',
        sleepEndedAt: '2026-11-07T05:20:00.000Z',
        summaryChecked: true,
        sleepChecked: true,
      },
    ])
    expect(await getHealthSnapshot(other)).toEqual({
      restingHr: null,
      sleep: null,
      restingHrChecked: false,
      sleepChecked: false,
      lastUpdatedAt: null,
    })
  })

  it('preserves verified account history after a Garmin key replacement', async () => {
    const oldRows = await prisma.dailyHealthMetric.count({ where: { userId: owner.userId } })
    expect(oldRows).toBeGreaterThan(0)
    await saveProviderApiKey(owner, 'GARMIN', 'synthetic-replacement-health-key', {
      verifiedGarminAccountId: '123456',
    })
    expect(await getHealthSnapshot(owner)).toMatchObject({
      restingHr: { value: 57 },
      sleep: { value: 26_000_000 },
    })
    expect(await listHealthHistory(owner)).toHaveLength(1)
    const replacementNonce = (await readProviderApiKeySnapshot(owner, 'GARMIN')).nonce
    const attempt = await reserveGarminHealthAttempt(owner, replacementNonce, '123456')
    await saveGarminHealthObservation(
      owner,
      'summary',
      date,
      'America/New_York',
      observation('API_DAILY_SUMMARY'),
      replacementNonce,
      '123456',
      new Date('2026-11-09T12:00:00Z'),
      attempt,
    )
    expect((await getHealthSnapshot(owner)).restingHr?.value).toBe(53)
    expect(await prisma.dailyHealthMetric.count({ where: { userId: owner.userId } })).toBe(oldRows)
    await disconnectProvider(owner, 'GARMIN')
    expect((await getHealthSnapshot(owner)).restingHr?.value).toBe(53)
    expect(await listHealthHistory(owner)).toHaveLength(1)
  })
})
