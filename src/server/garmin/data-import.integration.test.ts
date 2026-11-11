import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { testGarminAccountId } from '@/server/garmin/test-identity'

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { saveProviderApiKey } from '@/server/provider/vault'
import { addCalendarDays, getGarminImportState, runGarminDataImport } from './data-import'
import { GarminHealthImportError, type importGarminHealthDate } from './health-import'

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

describe.skipIf(!enabled)('Garmin stream import on isolated PostgreSQL', () => {
  let prisma: PrismaClient
  let owner: ReturnType<typeof getOwnerContext>
  let other: ReturnType<typeof getOwnerContext>
  let retryOwner: ReturnType<typeof getOwnerContext>
  const prefix = `run76-data-import-${randomUUID()}`
  const now = new Date('2026-11-10T02:00:00.000Z')
  const importDay: typeof importGarminHealthDate = async (_owner, date, zone) => ({
    status: 'SUCCEEDED',
    date,
    sourceTimezone: zone,
  })
  const dependencies = {
    now: () => now,
    importDay,
    zoneForDay: async () => ({ summary: 'Asia/Tokyo', sleep: 'Asia/Tokyo' }),
    maxDatesPerRun: 2,
  }

  beforeAll(async () => {
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1'
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 46).toString('base64')
    prisma = await getPrismaClient()
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-a` } })
    const b = await prisma.user.create({ data: { authSubject: `${prefix}-b`, role: 'ADMIN' } })
    const c = await prisma.user.create({ data: { authSubject: `${prefix}-c` } })
    owner = getOwnerContext({ id: a.id, role: 'USER', email: null })
    other = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
    retryOwner = getOwnerContext({ id: c.id, role: 'USER', email: null })
    await saveProviderApiKey(owner, 'GARMIN', 'synthetic-garmin-key', {
      verifiedGarminAccountId: testGarminAccountId(owner),
    })
    await saveProviderApiKey(retryOwner, 'GARMIN', 'synthetic-garmin-key', {
      verifiedGarminAccountId: testGarminAccountId(retryOwner),
    })
    await prisma.athleteProfile.create({ data: { userId: a.id, preferredTimezone: 'Asia/Tokyo' } })
    await prisma.athleteProfile.create({ data: { userId: c.id, preferredTimezone: 'Asia/Tokyo' } })
    await prisma.dailyHealthMetric.createMany({
      data: Array.from({ length: 30 }, (_, index) => ({
        userId: a.id,
        sourceProvider: 'GARMIN' as const,
        garminAccountId: testGarminAccountId(owner),
        localDate: new Date(`${addCalendarDays('2026-11-09', -index)}T00:00:00.000Z`),
        sourceTimezone: 'Asia/Tokyo',
        summaryFetchedAt: now,
      })),
    })
  })

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
      await prisma.$disconnect()
    }
    delete process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1
  })

  it('seeds only verified Daily coverage and keeps Sleep and other owners independent', async () => {
    const summary = await runGarminDataImport(
      owner,
      { streamId: 'daily_summary', action: 'import', browserTimezone: 'UTC' },
      dependencies,
    )
    const daily = summary.find((stream) => stream.streamId === 'daily_summary')!
    expect(daily.checkedDays).toBe(32)
    expect(daily.nextDate).toBe('2026-10-08')
    expect(daily.currentRange?.end).toBe('2026-10-08')
    expect(summary.find((stream) => stream.streamId === 'sleep')?.status).toBe('not_started')
    const sleep = await runGarminDataImport(
      owner,
      { streamId: 'sleep', action: 'import', browserTimezone: 'UTC' },
      dependencies,
    )
    expect(sleep.find((stream) => stream.streamId === 'daily_summary')?.nextDate).toBe(
      daily.nextDate,
    )
    expect(sleep.find((stream) => stream.streamId === 'sleep')?.checkedDays).toBe(2)
    expect(
      (await getGarminImportState(other)).every((stream) => stream.status === 'not_started'),
    ).toBe(true)
  })

  it('persists a failed date reason and counts it after a successful retry', async () => {
    const failFirstDate: typeof importGarminHealthDate = async (_owner, date, zone) => {
      if (date === '2026-11-09')
        throw new GarminHealthImportError('SUMMARY_INVALID_RESPONSE', 'SUMMARY_EMPTY_BODY')
      return { status: 'SUMMARY_ONLY', date, sourceTimezone: zone }
    }
    const first = await runGarminDataImport(
      retryOwner,
      { streamId: 'daily_summary', action: 'import', browserTimezone: 'UTC' },
      { ...dependencies, importDay: failFirstDate },
    )
    expect(first.find((stream) => stream.streamId === 'daily_summary')).toMatchObject({
      checkedDays: 1,
      failedDateCount: 1,
      errorCode: 'SUMMARY_EMPTY_BODY',
    })
    const firstRun = await prisma.syncRun.findFirst({
      where: { userId: retryOwner.userId, jobType: 'GARMIN_IMPORT_DAILY_SUMMARY' },
      orderBy: { startedAt: 'desc' },
      select: { recordsSeen: true, recordsWritten: true },
    })
    expect(firstRun).toMatchObject({ recordsSeen: 2, recordsWritten: 1 })
    const retried = await runGarminDataImport(
      retryOwner,
      { streamId: 'daily_summary', action: 'retry', browserTimezone: 'UTC' },
      dependencies,
    )
    expect(retried.find((stream) => stream.streamId === 'daily_summary')).toMatchObject({
      checkedDays: 2,
      failedDateCount: 0,
      errorCode: null,
    })
  })

  it('retries a failed Sleep date through its dated one-day range', async () => {
    const failFirstSleep: typeof importGarminHealthDate = async (_owner, date, zone) =>
      date === '2026-11-09'
        ? { status: 'PARTIAL', date, sourceTimezone: zone, errorCode: 'SLEEP_INVALID_RESPONSE' }
        : { status: 'SUCCEEDED', date, sourceTimezone: zone }
    const first = await runGarminDataImport(
      retryOwner,
      { streamId: 'sleep', action: 'import', browserTimezone: 'UTC' },
      { ...dependencies, importDay: failFirstSleep },
    )
    expect(first.find((stream) => stream.streamId === 'sleep')?.failedDateCount).toBe(1)
    const retriedDates: string[] = []
    const retrySleep: typeof importGarminHealthDate = async (_owner, date, zone, options) => {
      expect(options?.batchStartDate).toBe(date)
      expect(options?.sources).toBe('SLEEP_ONLY')
      retriedDates.push(date)
      return { status: 'SUCCEEDED', date, sourceTimezone: zone }
    }
    const retried = await runGarminDataImport(
      retryOwner,
      { streamId: 'sleep', action: 'retry', browserTimezone: 'UTC' },
      { ...dependencies, importDay: retrySleep },
    )
    expect(retriedDates).toEqual(['2026-11-09'])
    expect(retried.find((stream) => stream.streamId === 'sleep')?.failedDateCount).toBe(0)
  })
})
