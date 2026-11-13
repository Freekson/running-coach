import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { testGarminAccountId } from '@/server/garmin/test-identity'

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { saveProviderApiKey } from '@/server/provider/vault'
import { addCalendarDays, getGarminImportState, runGarminDataImport } from './data-import'
import { GarminHealthImportError, type importGarminHealthDate } from './health-import'
import { importGarminActivityPage } from './activity-import'
import { getActivity } from '@/server/activity/import'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'
import { ACTIVITY_HISTORY_CURSOR, activityHistoryWindow } from './activity-history'
import * as importRateLimit from './import-rate-limit'
import { getTrainingSyncState, runTrainingSync } from './training-sync'

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

  beforeEach(async () => {
    await prisma.garminImportRateLimit.updateMany({
      where: { userId: { in: [owner.userId, retryOwner.userId] } },
      data: { count: 1, windowStartedAt: new Date(Date.now() - 61_000), providerRetryAt: null },
    })
  })

  it('syncs recent Training activity coverage despite an old unfinished INITIAL cursor', async () => {
    const user = await prisma.user.create({ data: { authSubject: `${prefix}-training-recent` } })
    const context = getOwnerContext({ id: user.id, role: 'USER', email: null })
    await saveProviderApiKey(context, 'GARMIN', 'synthetic-training-recent-key', {
      verifiedGarminAccountId: testGarminAccountId(context),
    })
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { userId_provider: { userId: user.id, provider: 'GARMIN' } },
    })
    await prisma.syncCursor.createMany({
      data: [
        {
          userId: user.id,
          connectionId: connection.id,
          dataType: ACTIVITY_HISTORY_CURSOR,
          cursorOrCheckpoint: { ...activityHistoryWindow('2026-11-10', 'UTC'), nextDate: null },
        },
        {
          userId: user.id,
          connectionId: connection.id,
          dataType: 'ACTIVITIES',
          cursorOrCheckpoint: { version: 1, mode: 'INITIAL', nextDate: '2026-08-23' },
        },
      ],
    })
    const at = new Date('2026-11-13T02:00:00Z')
    expect((await getTrainingSyncState(context, at)).status).toBe('IDLE')
    const importActivityPage = vi.fn<typeof importGarminActivityPage>(async () => ({
      imported: [],
      providerIds: [],
      pageIds: [],
      hasMore: false,
      nextStart: null,
      beforeCheckpoint: async () => {},
    }))
    const result = await runTrainingSync(context, 'UTC', {
      now: () => at,
      runImport: (owner, options) =>
        runGarminDataImport(owner, options, { now: () => at, importActivityPage }),
    })
    expect(result).toMatchObject({
      status: 'SUCCESS',
      window: { start: '2026-11-03', end: '2026-11-13' },
    })
    expect(importActivityPage.mock.calls[0][1].summariesOnly).toEqual({
      timezone: 'UTC',
      startDate: '2026-11-03',
      endDate: '2026-11-13',
    })
    const old = await prisma.syncCursor.findUniqueOrThrow({
      where: { connectionId_dataType: { connectionId: connection.id, dataType: 'ACTIVITIES' } },
    })
    expect(old.cursorOrCheckpoint).toMatchObject({ nextDate: '2026-08-23' })
    expect(await getTrainingSyncState(other, at)).toMatchObject({ status: 'NOT_CONNECTED' })
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

  it('persists all-sport summaries, resumes and reimports sparsely without changing health or another owner', async () => {
    const before = (await getGarminImportState(owner, now)).filter(
      (stream) => stream.streamId !== 'activities',
    )
    let rows = [
      {
        activityId: 8001,
        activityType: { typeKey: 'cycling' },
        startTimeGMT: '2026-11-08 03:00:00',
        distance: 20000,
        averageHR: 130,
        calories: 400,
        activityName: 'Synthetic cycling',
        duration: 3600,
      },
      {
        activityId: 8002,
        activityType: { typeKey: 'walking' },
        startTimeGMT: '2026-11-08 06:00:00',
        distance: 2000,
        averageHR: 100,
        calories: 100,
        activityName: 'Synthetic walking',
        duration: 1800,
      },
    ]
    const network: typeof fetch = async (input) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/personal-api-key/token')) return new Response('synthetic-bearer')
      if (url.pathname.includes('/usersummary/daily'))
        return Response.json({
          calendarDate: url.searchParams.get('calendarDate'),
          userProfileId: Number(testGarminAccountId(owner)),
        })
      if (url.pathname.includes('/search/activities'))
        return Response.json(rows.slice(Number(url.searchParams.get('start'))))
      throw new Error('Summary import requested detail or FIT')
    }
    const importActivityPage: typeof importGarminActivityPage = (context, window, options) =>
      importGarminActivityPage(context, window, {
        ...options,
        fetcher: network,
        pause: async () => {},
      })
    async function run(action: 'import' | 'resume' | 'reimport') {
      await prisma.garminImportRateLimit.updateMany({
        where: { userId: owner.userId },
        data: { count: 1, windowStartedAt: new Date(Date.now() - 61_000) },
      })
      return runGarminDataImport(
        owner,
        { streamId: 'activities', action, browserTimezone: 'UTC' },
        { now: () => now, importActivityPage, maxPagesPerRun: 1 },
      )
    }
    await run('import')
    await run('resume')
    await run('resume')
    const state = await run('resume')
    expect(state.find((stream) => stream.streamId === 'activities')).toMatchObject({
      activityCount: 2,
      pagesFetched: 4,
      checkedDays: state.find((stream) => stream.streamId === 'activities')!.totalDays,
      summaryStatus: 'completed',
      status: 'paused',
      laps: { eligible: 2, pending: 2 },
    })
    expect(state.filter((stream) => stream.streamId !== 'activities')).toEqual(before)
    const saved = await prisma.activity.findMany({
      where: { userId: owner.userId },
      orderBy: { externalActivityId: 'asc' },
    })
    expect(saved).toHaveLength(2)
    expect(saved.map((row) => row.sportType)).toEqual(['CYCLING', 'WALKING'])
    expect(saved[0]).toMatchObject({ calories: 400, activityTitle: 'Synthetic cycling' })
    expect(saved.every((row) => row.garminAccountId === testGarminAccountId(owner))).toBe(true)
    expect(await getActivity(other, saved[0].id)).toBeNull()
    rows = rows.map((row) => ({ ...row, distance: row.distance + 50 }))
    const sparseNetwork: typeof importGarminActivityPage = (context, window, options) =>
      importGarminActivityPage(context, window, {
        ...options,
        pause: async () => {},
        fetcher: async (input, init) => {
          const response = await network(input, init)
          if (new URL(String(input)).pathname.includes('/search/activities'))
            return Response.json(rows.map((row) => ({ ...row, averageHR: undefined })))
          return response
        },
      })
    await prisma.garminImportRateLimit.updateMany({
      where: { userId: owner.userId },
      data: { count: 1, windowStartedAt: new Date(Date.now() - 61_000) },
    })
    await runGarminDataImport(
      owner,
      { streamId: 'activities', action: 'reimport', browserTimezone: 'UTC' },
      { now: () => now, importActivityPage: sparseNetwork, maxPagesPerRun: 1 },
    )
    const updated = await prisma.activity.findMany({
      where: { userId: owner.userId },
      orderBy: { externalActivityId: 'asc' },
    })
    expect(updated.map((row) => row.id)).toEqual(saved.map((row) => row.id))
    expect(updated[0].distanceMeters?.toNumber()).toBe(20050)
    expect(updated[0].avgHrBpm).toBe(130)
    expect(await prisma.activityLap.count({ where: { userId: owner.userId } })).toBe(0)
  }, 120_000)

  it.each(['credential replacement', 'provider lease replacement'] as const)(
    'preserves a newer reimport after %s revokes a planning request',
    async (scenario) => {
      const user = await prisma.user.create({
        data: { authSubject: `${prefix}-rotation-race-${scenario}` },
      })
      const context = getOwnerContext({ id: user.id, role: 'USER', email: null })
      const accountId = testGarminAccountId(context)
      await saveProviderApiKey(context, 'GARMIN', 'synthetic-original-race-key', {
        verifiedGarminAccountId: accountId,
      })
      const connection = await prisma.integrationConnection.findUniqueOrThrow({
        where: { userId_provider: { userId: user.id, provider: 'GARMIN' } },
        select: { id: true },
      })
      const key = { connectionId: connection.id, dataType: ACTIVITY_HISTORY_CURSOR }
      await prisma.syncCursor.create({
        data: {
          userId: user.id,
          ...key,
          cursorOrCheckpoint: {
            ...activityHistoryWindow('2026-11-10', 'UTC'),
            nextDate: '2026-09-12',
          },
        },
      })
      const raceNow = new Date('2026-11-12T02:00:00Z')
      const emptyPage: typeof importGarminActivityPage = async () => ({
        imported: [],
        providerIds: [],
        pageIds: [],
        hasMore: false,
        nextStart: null,
        beforeCheckpoint: async () => {},
      })
      const stalePage = vi.fn(emptyPage)
      const allowOriginal = importRateLimit.allowGarminImport
      let newer: Awaited<ReturnType<typeof prisma.syncCursor.findUnique>>
      const replacement = vi
        .spyOn(importRateLimit, 'allowGarminImport')
        .mockImplementationOnce(async (requestOwner) => {
          const allowed = await allowOriginal(requestOwner)
          if (scenario === 'credential replacement') {
            await saveProviderApiKey(requestOwner, 'GARMIN', 'synthetic-replacement-race-key', {
              verifiedGarminAccountId: accountId,
            })
          } else {
            await prisma.syncCursor.updateMany({
              where: { userId: user.id, connectionId: connection.id, dataType: 'GARMIN_REQUESTS' },
              data: { leaseExpiresAt: new Date(raceNow.getTime() - 1) },
            })
          }
          await runGarminDataImport(
            requestOwner,
            { streamId: 'activities', action: 'reimport', browserTimezone: 'UTC' },
            { now: () => raceNow, importActivityPage: emptyPage, maxPagesPerRun: 1 },
          )
          newer = await prisma.syncCursor.findUnique({ where: { connectionId_dataType: key } })
          expect(newer?.cursorOrCheckpoint).toMatchObject({ generation: 2, endDate: '2026-11-11' })
          return allowed
        })
      try {
        const staleRequest = runGarminDataImport(
          context,
          { streamId: 'activities', action: 'resume', browserTimezone: 'UTC' },
          { now: () => raceNow, importActivityPage: stalePage },
        )
        if (scenario === 'credential replacement')
          await expect(staleRequest).rejects.toBeInstanceOf(CredentialUnavailableError)
        else await expect(staleRequest).rejects.toThrow('BUSY')
        expect(stalePage).not.toHaveBeenCalled()
        const current = await prisma.syncCursor.findUniqueOrThrow({
          where: { connectionId_dataType: key },
        })
        expect(current.cursorOrCheckpoint).toEqual(newer!.cursorOrCheckpoint)
        expect(current.leaseToken).toBeNull()
      } finally {
        replacement.mockRestore()
      }
    },
    30_000,
  )
})
