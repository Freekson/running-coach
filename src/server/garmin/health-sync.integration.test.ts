import { testGarminAccountId } from '@/server/garmin/test-identity'
import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { readProviderApiKeySnapshot, saveProviderApiKey } from '@/server/provider/vault'
import { importGarminHealthDate } from './health-import'
import { getGarminHealthSyncState, healthZoneForDay, runGarminHealthSync } from './health-sync'
import { runGarminSync } from './sync'

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

describe.skipIf(!enabled)('Garmin health sync on isolated PostgreSQL', () => {
  let prisma: PrismaClient
  let owner: ReturnType<typeof getOwnerContext>
  let other: ReturnType<typeof getOwnerContext>
  const prefix = `run25-health-sync-${randomUUID()}`
  const now = new Date('2026-11-08T15:30:00.000Z')
  const successfulDay = async (
    owner: typeof other,
    date: string,
    timezone: string,
    _options?: Parameters<typeof importGarminHealthDate>[3],
  ) => {
    void _options
    return { status: 'SUCCEEDED' as const, date, sourceTimezone: timezone }
  }

  beforeAll(async () => {
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1'
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 39).toString('base64')
    prisma = await getPrismaClient()
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-a` } })
    const b = await prisma.user.create({ data: { authSubject: `${prefix}-b`, role: 'ADMIN' } })
    owner = getOwnerContext({ id: a.id, role: 'USER', email: null })
    other = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
    await saveProviderApiKey(owner, 'GARMIN', 'synthetic-garmin-key', {
      verifiedGarminAccountId: testGarminAccountId(owner),
    })
    await prisma.athleteProfile.upsert({
      where: { userId: a.id },
      create: { userId: a.id, preferredTimezone: 'Asia/Tokyo' },
      update: { preferredTimezone: 'Asia/Tokyo' },
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

  it('resumes a 30-day initial window, then rechecks the latest seven days', async () => {
    const importDay = vi.fn(successfulDay)
    let clock = now
    const options = {
      now: () => clock,
      importDay,
      zoneForDay: async () => ({ summary: 'Asia/Tokyo', sleep: 'Asia/Tokyo' }),
    }
    for (let i = 0; i < 3; i++) await runGarminHealthSync(owner, 'America/Los_Angeles', options)
    const initialDates = importDay.mock.calls.map((call) => call[1])
    expect(initialDates).toHaveLength(30)
    expect(initialDates[0]).toBe('2026-10-11')
    expect(initialDates.at(-1)).toBe('2026-11-09')
    expect(importDay.mock.calls[0][2]).toBe('Asia/Tokyo')
    expect(importDay.mock.calls[0][3]?.batchEndDate).toBe('2026-10-20')
    expect(importDay.mock.calls[10][3]?.batchEndDate).toBe('2026-10-30')
    expect(importDay.mock.calls[20][3]?.batchEndDate).toBe('2026-11-09')
    expect((await getGarminHealthSyncState(owner, now)).status).toBe('SUCCESS')
    await runGarminHealthSync(owner, 'America/Los_Angeles', options)
    expect(importDay).toHaveBeenCalledTimes(30)
    clock = new Date(now.getTime() + 3_600_001)
    await runGarminHealthSync(owner, 'America/Los_Angeles', options)
    expect(importDay.mock.calls.slice(30).map((call) => call[1])).toEqual([
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
    ])
    expect(importDay.mock.calls[30][3]?.batchEndDate).toBe('2026-11-09')
    expect((await getGarminHealthSyncState(other, now)).status).toBe('NOT_CONNECTED')
  })

  it('continues later sleep dates after one malformed day without a global cooldown', async () => {
    const user = await prisma.user.create({ data: { authSubject: `${prefix}-malformed-sleep` } })
    const testOwner = getOwnerContext({ id: user.id, role: 'USER', email: null })
    await saveProviderApiKey(testOwner, 'GARMIN', 'synthetic-malformed-sleep-key', {
      verifiedGarminAccountId: testGarminAccountId(testOwner),
    })
    const importDay = vi.fn(
      async (
        _owner: typeof testOwner,
        date: string,
        timezone: string,
        options: Parameters<typeof importGarminHealthDate>[3],
      ) => {
        if (date === '2026-10-11' && options?.sources !== 'SUMMARY_ONLY') {
          if (options?.session) options.session.recoveredApiErrorCodes = ['SLEEP_HTTP_503']
          return {
            status: 'PARTIAL' as const,
            date,
            sourceTimezone: timezone,
            errorCode: 'SLEEP_INVALID_RESPONSE' as const,
          }
        }
        return { status: 'SUCCEEDED' as const, date, sourceTimezone: timezone }
      },
    )
    const options = {
      now: () => now,
      importDay,
      zoneForDay: async () => ({ summary: 'Asia/Tokyo', sleep: 'Asia/Tokyo' }),
    }
    const first = await runGarminHealthSync(testOwner, 'Asia/Tokyo', options)
    expect(first).toMatchObject({
      status: 'PARTIAL',
      nextDate: '2026-10-21',
      sleepRetryDates: ['2026-10-11'],
      sleepFailedDates: ['2026-10-11'],
      nextAttemptAt: null,
      errorCode: 'SLEEP_INVALID_RESPONSE',
    })
    expect(
      await prisma.syncRun.findFirst({
        where: { userId: user.id, jobType: 'GARMIN_HEALTH' },
        orderBy: { startedAt: 'desc' },
        select: { status: true, errorCode: true, checkpointSummary: true },
      }),
    ).toMatchObject({
      status: 'SUCCEEDED',
      errorCode: 'SLEEP_INVALID_RESPONSE',
      checkpointSummary: { recoveredApiErrorCodes: ['SLEEP_HTTP_503'] },
    })
    expect(importDay.mock.calls.slice(1, 10).every((call) => call[3]?.sources === 'BOTH')).toBe(
      true,
    )
    const second = await runGarminHealthSync(testOwner, 'Asia/Tokyo', options)
    expect(importDay.mock.calls[10][1]).toBe('2026-10-11')
    expect(importDay.mock.calls[10][3]?.sources).toBe('SLEEP_ONLY')
    expect(importDay.mock.calls[11][1]).toBe('2026-10-21')
    expect(importDay.mock.calls[11][3]?.sources).toBe('BOTH')
    expect(second.sleepRetryDates).toEqual(['2026-10-11'])
    expect(second.nextDate).toBe('2026-10-30')
  })

  it('uses bounded range requests plus one account check per invocation', async () => {
    const user = await prisma.user.create({ data: { authSubject: `${prefix}-batch-count` } })
    const testOwner = getOwnerContext({ id: user.id, role: 'USER', email: null })
    await saveProviderApiKey(testOwner, 'GARMIN', 'synthetic-batch-count-key', {
      verifiedGarminAccountId: testGarminAccountId(testOwner),
    })
    const addDays = (date: string, count: number) =>
      new Date(Date.parse(`${date}T00:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10)
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/token')) return new Response('synthetic-token')
      if (url.pathname.endsWith('/usersummary/daily'))
        return Response.json({
          calendarDate: url.searchParams.get('calendarDate'),
          userProfileId: Number(testGarminAccountId(testOwner)),
        })
      const start = url.searchParams.get('startDate')
      const end = url.searchParams.get('endDate')
      if (!start || !end) throw new Error('Unexpected single-day fallback')
      const count = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1
      const dates = Array.from({ length: count }, (_, index) => addDays(start, index))
      if (url.pathname.endsWith('/dailysummaries'))
        return Response.json({
          data: dates.map((calendarDate) => ({
            calendarDate,
            heartRate: { restingValue: 52 },
          })),
        })
      if (url.pathname.endsWith('/dailySleepSummariesByDate'))
        return Response.json(
          dates.map((calendarDate) => ({ calendarDate, sleepTimeSeconds: 24_000 })),
        )
      throw new Error('Unexpected Garmin endpoint')
    })
    const importDay: typeof importGarminHealthDate = (owner, date, zone, options) =>
      importGarminHealthDate(owner, date, zone, {
        ...options,
        fetcher,
        pause: async () => {},
      })
    let clock = now
    const options = {
      now: () => clock,
      importDay,
      zoneForDay: async () => ({ summary: 'Asia/Tokyo', sleep: 'Asia/Tokyo' }),
    }
    for (let index = 0; index < 3; index++)
      await runGarminHealthSync(testOwner, 'Asia/Tokyo', options)
    expect(fetcher).toHaveBeenCalledTimes(12)
    expect((await getGarminHealthSyncState(testOwner, clock)).status).toBe('SUCCESS')
    clock = new Date(now.getTime() + 3_600_001)
    await runGarminHealthSync(testOwner, 'Asia/Tokyo', options)
    expect(fetcher).toHaveBeenCalledTimes(16)
    expect(fetcher.mock.calls.filter(([input]) => String(input).includes('/token'))).toHaveLength(4)
  }, 20_000)

  it('preserves a bounded checkpoint after same-account key rotation while ignoring legacy rows', async () => {
    const user = await prisma.user.create({ data: { authSubject: `${prefix}-replacement` } })
    const replacementOwner = getOwnerContext({ id: user.id, role: 'USER', email: null })
    await saveProviderApiKey(replacementOwner, 'GARMIN', 'synthetic-old-account-key', {
      verifiedGarminAccountId: testGarminAccountId(replacementOwner),
    })
    const oldNonce = (await readProviderApiKeySnapshot(replacementOwner, 'GARMIN')).nonce
    await prisma.dailyHealthMetric.create({
      data: {
        userId: user.id,
        sourceProvider: 'GARMIN',
        credentialNonce: Uint8Array.from(oldNonce),
        localDate: new Date('2026-11-08T00:00:00Z'),
        sourceTimezone: 'Asia/Tokyo',
        summaryFetchedAt: now,
        restingHrBpm: 54,
      },
    })
    await runGarminHealthSync(replacementOwner, 'Asia/Tokyo', {
      now: () => now,
      importDay: successfulDay,
      zoneForDay: async () => ({ summary: 'Asia/Tokyo', sleep: 'Asia/Tokyo' }),
    })
    expect(
      await prisma.syncCursor.findFirst({
        where: { userId: user.id, dataType: 'HEALTH' },
      }),
    ).not.toBeNull()
    await saveProviderApiKey(replacementOwner, 'GARMIN', 'synthetic-new-account-key', {
      verifiedGarminAccountId: testGarminAccountId(replacementOwner),
    })
    const importDay = vi.fn(successfulDay)
    await runGarminHealthSync(replacementOwner, 'Asia/Tokyo', {
      now: () => now,
      importDay,
      zoneForDay: async () => ({ summary: 'Asia/Tokyo', sleep: 'Asia/Tokyo' }),
    })
    expect(importDay.mock.calls[0][1]).toBe('2026-10-21')
    expect((await getGarminHealthSyncState(replacementOwner, now)).nextDate).toBe('2026-10-31')
  })

  it('does not run health while an activity job holds the owner provider lease', async () => {
    const user = await prisma.user.create({ data: { authSubject: `${prefix}-cross-job` } })
    const testOwner = getOwnerContext({ id: user.id, role: 'USER', email: null })
    await saveProviderApiKey(testOwner, 'GARMIN', 'synthetic-cross-job-key', {
      verifiedGarminAccountId: testGarminAccountId(testOwner),
    })
    let release!: (value: {
      imported: []
      providerIds: []
      hasMore: false
      nextStart: null
    }) => void
    let pageCalls = 0
    const importPage = vi.fn(() => {
      pageCalls++
      if (pageCalls > 1)
        return Promise.resolve({
          imported: [],
          providerIds: [],
          hasMore: false as const,
          nextStart: null,
        })
      return new Promise<{
        imported: []
        providerIds: []
        hasMore: false
        nextStart: null
      }>((resolve) => {
        release = resolve
      })
    })
    const activity = runGarminSync(testOwner, {}, { now: () => now, importPage })
    await vi.waitFor(() => expect(importPage).toHaveBeenCalledOnce())
    await expect(
      runGarminHealthSync(testOwner, 'Asia/Tokyo', { now: () => now }),
    ).rejects.toMatchObject({ code: 'BUSY' })
    release({ imported: [], providerIds: [], hasMore: false, nextStart: null })
    await activity
  })

  it('uses a travel-day activity zone and preserves an existing sleep zone', async () => {
    await prisma.activity.create({
      data: {
        userId: owner.userId,
        sourceProvider: 'GARMIN',
        garminAccountId: testGarminAccountId(owner),
        externalActivityId: `travel-${randomUUID()}`,
        sportType: 'RUNNING',
        startedAt: new Date('2026-11-01T06:30:00.000Z'),
        listStartedAt: new Date('2026-11-01T06:30:00.000Z'),
        sourceTimezone: 'America/New_York',
      },
    })
    await prisma.dailyHealthMetric.create({
      data: {
        userId: owner.userId,
        sourceProvider: 'GARMIN',
        garminAccountId: testGarminAccountId(owner),
        credentialNonce: Uint8Array.from((await readProviderApiKeySnapshot(owner, 'GARMIN')).nonce),
        localDate: new Date('2026-11-01T00:00:00.000Z'),
        sourceTimezone: 'Asia/Tokyo',
        sleepSourceTimezone: 'Europe/Kyiv',
      },
    })
    expect(await healthZoneForDay(owner, '2026-11-01', 'Asia/Tokyo')).toMatchObject({
      summary: 'America/New_York',
      sleep: 'Europe/Kyiv',
    })
    expect(await healthZoneForDay(other, '2026-11-01', 'UTC')).toMatchObject({
      summary: 'UTC',
      sleep: 'UTC',
    })
  })

  it('falls back to the browser zone when the athlete has no saved timezone', async () => {
    const user = await prisma.user.create({ data: { authSubject: `${prefix}-browser-zone` } })
    const browserOwner = getOwnerContext({ id: user.id, role: 'USER', email: null })
    await saveProviderApiKey(browserOwner, 'GARMIN', 'synthetic-browser-zone-key', {
      verifiedGarminAccountId: testGarminAccountId(browserOwner),
    })
    let clock = now
    const importDay = vi.fn(async (_owner: typeof browserOwner, date: string, timezone: string) => {
      clock = new Date(clock.getTime() + 23_000)
      return { status: 'SUCCEEDED' as const, date, sourceTimezone: timezone }
    })
    await runGarminHealthSync(browserOwner, 'America/Los_Angeles', {
      now: () => clock,
      importDay,
    })
    expect(importDay.mock.calls[0][1]).toBe('2026-10-10')
    expect(importDay.mock.calls[0][2]).toBe('America/Los_Angeles')
  })

  it('rejects a concurrent request and leaves a failed sleep day ready for retry', async () => {
    const user = await prisma.user.create({ data: { authSubject: `${prefix}-concurrent` } })
    const testOwner = getOwnerContext({ id: user.id, role: 'USER', email: null })
    await saveProviderApiKey(testOwner, 'GARMIN', 'synthetic-concurrent-key', {
      verifiedGarminAccountId: testGarminAccountId(testOwner),
    })
    let clock = now
    let release!: (value: Awaited<ReturnType<typeof successfulDay>>) => void
    const delayed = vi.fn(
      (_owner: typeof owner, date: string, zone: string) =>
        new Promise<Awaited<ReturnType<typeof successfulDay>>>((resolve) => {
          release = resolve
          void date
          void zone
        }),
    )
    const running = runGarminHealthSync(testOwner, 'Asia/Tokyo', {
      now: () => clock,
      importDay: delayed,
      zoneForDay: async () => ({ summary: 'Asia/Tokyo', sleep: 'Asia/Tokyo' }),
    })
    await vi.waitFor(() => expect(delayed).toHaveBeenCalledOnce())
    await expect(
      runGarminHealthSync(testOwner, 'Asia/Tokyo', { now: () => clock }),
    ).rejects.toMatchObject({
      code: 'BUSY',
    })
    const date = delayed.mock.calls[0][1]
    clock = new Date(clock.getTime() + 29_000)
    release({ status: 'SUCCEEDED', date, sourceTimezone: 'Asia/Tokyo' })
    await running
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { userId_provider: { userId: testOwner.userId, provider: 'GARMIN' } },
    })
    const partial = vi.fn(
      async (
        _owner: typeof testOwner,
        currentDate: string,
        timezone: string,
        options: Parameters<typeof importGarminHealthDate>[3],
      ) =>
        options?.sources === 'SUMMARY_ONLY'
          ? { status: 'SUMMARY_ONLY' as const, date: currentDate, sourceTimezone: timezone }
          : {
              status: 'PARTIAL' as const,
              date: currentDate,
              sourceTimezone: timezone,
              errorCode: 'SLEEP_TIMEOUT' as const,
            },
    )
    const state = await runGarminHealthSync(testOwner, 'Asia/Tokyo', {
      now: () => clock,
      importDay: partial,
      zoneForDay: async () => ({ summary: 'Asia/Tokyo', sleep: 'Asia/Tokyo' }),
    })
    expect(state.nextDate).toBe('2026-10-22')
    expect(state.status).toBe('PAUSED')
    expect(state.sleepRetryDates).toHaveLength(10)
    expect(state.sleepFailedDates).toEqual(['2026-10-12'])
    expect(partial.mock.calls[0][3]?.sources).toBe('BOTH')
    expect(partial.mock.calls[1][3]?.sources).toBe('SUMMARY_ONLY')
    const cursor = await prisma.syncCursor.findUniqueOrThrow({
      where: { connectionId_dataType: { connectionId: connection.id, dataType: 'HEALTH' } },
    })
    expect(cursor.cursorOrCheckpoint).toMatchObject({
      nextDate: '2026-10-22',
      sleepRetryDates: expect.arrayContaining(['2026-10-12']),
      sleepFailedDates: ['2026-10-12'],
    })
    clock = new Date(clock.getTime() + 61_000)
    const recovered = vi.fn(
      async (
        _owner: typeof testOwner,
        currentDate: string,
        timezone: string,
        _options: Parameters<typeof importGarminHealthDate>[3],
      ) => {
        void _options
        return { status: 'SUCCEEDED' as const, date: currentDate, sourceTimezone: timezone }
      },
    )
    const options = {
      now: () => clock,
      importDay: recovered,
      zoneForDay: async () => ({ summary: 'Asia/Tokyo', sleep: 'Asia/Tokyo' }),
    }
    await runGarminHealthSync(testOwner, 'Asia/Tokyo', options)
    expect(recovered.mock.calls[0][3]?.sources).toBe('SLEEP_ONLY')
    await runGarminHealthSync(testOwner, 'Asia/Tokyo', options)
    const completed = await runGarminHealthSync(testOwner, 'Asia/Tokyo', options)
    expect(completed.status).toBe('SUCCESS')
    expect(completed.sleepRetryDates).toEqual([])
    expect(completed.sleepFailedDates).toEqual([])
    expect(completed.nextDate).toBeNull()
  })
})
