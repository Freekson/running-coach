import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { saveProviderApiKey } from '@/server/provider/vault'
import {
  getActivity,
  importCanonicalActivity,
  replaceGarminActivityLaps,
} from '@/server/activity/import'
import {
  ACTIVITY_HISTORY_CURSOR,
  ACTIVITY_RECENT_CURSOR,
  activityHistoryWindow,
} from './activity-history'
import { importGarminActivityPage, openGarminActivitySession } from './activity-import'
import { getGarminImportState, runGarminDataImport } from './data-import'
import { ACTIVITY_LAPS_CURSOR, runActivityLapHistory } from './lap-history'
import { normalizeGarminActivitySummary } from './normalization'
import { syntheticActivityFit } from './fit-test-fixtures'
import { testGarminAccountId } from './test-identity'
import { claimGarminProviderLease, releaseGarminProviderLease } from './provider-lease'

const requested = process.env.npm_lifecycle_event === 'test:db'
if (requested) config()
const enabled =
  requested &&
  ['development', 'test'].includes(process.env.APP_DATABASE_ENV ?? '') &&
  Boolean(process.env.DATABASE_URL && process.env.DIRECT_URL) &&
  !process.env.VERCEL_ENV
if (requested && !enabled)
  throw new Error('test:db requires isolated development/test database URLs')

describe.skipIf(!enabled)('durable FIT backfill on isolated PostgreSQL', () => {
  let prisma: PrismaClient
  let owner: ReturnType<typeof getOwnerContext>
  let other: ReturnType<typeof getOwnerContext>
  let connectionId: string
  let now: Date
  const prefix = `run78-laps-${randomUUID()}`
  const starts = new Map<string, string>()
  const fitStatuses = new Map<string, number>()
  const downloaded: string[] = []
  let corruptId: string | undefined
  let tokenStatus = 200
  let identityAccount: string | undefined
  let onDownload: (() => Promise<void>) | undefined
  const network = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    expect(init?.cache).toBe('no-store')
    expect(init?.redirect).toBe('error')
    if (url.pathname.endsWith('/personal-api-key/token'))
      return new Response(tokenStatus === 200 ? 'synthetic-bearer' : null, { status: tokenStatus })
    if (url.pathname.endsWith('/usersummary/daily'))
      return Response.json({
        calendarDate: url.searchParams.get('calendarDate'),
        userProfileId: Number(identityAccount ?? testGarminAccountId(owner)),
      })
    if (url.pathname.includes('/download-service/files/activity/')) {
      const id = url.pathname.split('/').at(-1)!
      downloaded.push(id)
      await onDownload?.()
      const status = fitStatuses.get(id) ?? 200
      if (status !== 200)
        return new Response(null, {
          status,
          headers: status === 429 ? { 'Retry-After': '300' } : undefined,
        })
      return new Response(
        new Uint8Array(
          id === corruptId
            ? Buffer.from('invalid binary')
            : syntheticActivityFit({ start: starts.get(id) }),
        ),
      )
    }
    throw new Error(
      'Unexpected provider route: no health backfill or activity detail requests are allowed',
    )
  })

  beforeAll(async () => {
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1'
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 78).toString('base64')
    prisma = await getPrismaClient()
  })
  beforeEach(async () => {
    starts.clear()
    fitStatuses.clear()
    downloaded.length = 0
    corruptId = undefined
    tokenStatus = 200
    identityAccount = undefined
    onDownload = undefined
    now = new Date('2026-11-10T02:00:00Z')
    network.mockClear()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Live provider access is forbidden in tests')
      }),
    )
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-${randomUUID()}-a` } })
    const b = await prisma.user.create({
      data: { authSubject: `${prefix}-${randomUUID()}-b`, role: 'ADMIN' },
    })
    owner = getOwnerContext({ id: a.id, role: 'USER', email: null })
    other = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
    await saveProviderApiKey(owner, 'GARMIN', 'synthetic-run78-key', {
      verifiedGarminAccountId: testGarminAccountId(owner),
    })
    connectionId = (
      await prisma.integrationConnection.findUniqueOrThrow({
        where: { userId_provider: { userId: a.id, provider: 'GARMIN' } },
      })
    ).id
    await prisma.syncCursor.create({
      data: {
        userId: a.id,
        connectionId,
        dataType: ACTIVITY_HISTORY_CURSOR,
        cursorOrCheckpoint: { ...activityHistoryWindow('2026-11-10', 'UTC'), nextDate: null },
      },
    })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
  })

  async function seed(
    id: string,
    sport = 'running',
    context = owner,
    account = testGarminAccountId(context),
  ) {
    const start = `2026-11-0${8 - (Number(id) % 3)}T08:00:00Z`
    starts.set(id, start)
    const summary = normalizeGarminActivitySummary(context, {
      activityId: id,
      activityType: { typeKey: sport },
      startTimeGMT: start.replace('T', ' ').replace('Z', ''),
      distance: 4000,
      elapsedDuration: 1200,
      duration: 1160,
    })
    const saved = await prisma.activity.create({
      data: {
        userId: context.userId,
        sourceProvider: 'GARMIN',
        garminAccountId: account,
        externalActivityId: id,
        sportType: sport.toUpperCase(),
        sourceSportType: sport,
        startedAt: new Date(start),
        listStartedAt: new Date(start),
        distanceMeters: 4000,
        elapsedMs: BigInt(1_200_000),
        totalMs: BigInt(1_160_000),
      },
    })
    return { id: saved.id, summary }
  }
  const dependencies = () => ({
    now: () => now,
    openLapSession: (
      context: Parameters<typeof openGarminActivitySession>[0],
      options: Parameters<typeof openGarminActivitySession>[1],
    ) =>
      openGarminActivitySession(context, { ...options, fetcher: network, pause: async () => {} }),
  })
  async function quota() {
    await prisma.garminImportRateLimit.updateMany({
      where: { userId: owner.userId },
      data: { count: 1, windowStartedAt: new Date(Date.now() - 61_000) },
    })
  }
  async function run(action: 'import' | 'resume' | 'retry' = 'import', limit = 3) {
    await quota()
    await runActivityLapHistory(
      owner,
      { action, browserTimezone: 'UTC' },
      { ...dependencies(), maxActivitiesPerRun: limit },
    )
    return (await getGarminImportState(owner, now)).find(
      (stream) => stream.streamId === 'activities',
    )!
  }

  it('persists four ordered laps for all sports, keeps raw records out, and completes both stages idempotently', async () => {
    const rows = [await seed('1001'), await seed('1002', 'cycling'), await seed('1003', 'walking')]
    const before = (await getGarminImportState(owner, now)).filter(
      (stream) => stream.streamId !== 'activities',
    )
    const state = await run()
    expect(state).toMatchObject({
      summaryStatus: 'completed',
      status: 'completed',
      laps: { processed: 3, eligible: 3, complete: 3, failed: 0, unavailable: 0, totalLaps: 12 },
    })
    for (const row of rows) {
      const saved = await getActivity(owner, row.id)
      expect(saved?.laps).toHaveLength(4)
      expect(saved?.laps.map((lap) => lap.lapIndex)).toEqual([0, 1, 2, 3])
      expect(saved?.laps[0]).toMatchObject({
        elapsedMs: 300_000,
        timerMs: 290_000,
        movingMs: null,
        avgPowerWatts: 230,
        cadenceCyclesPerMinute: 80.5,
      })
      expect(await getActivity(other, row.id)).toBeNull()
      expect(JSON.stringify(saved)).not.toMatch(
        /positionLat|positionLong|recordMesgs|654321|synthetic-bearer/,
      )
    }
    expect(
      (await getGarminImportState(owner, now)).filter((stream) => stream.streamId !== 'activities'),
    ).toEqual(before)
    const ids = (
      await prisma.activityLap.findMany({ where: { userId: owner.userId }, orderBy: { id: 'asc' } })
    ).map((lap) => lap.id)
    await run('resume')
    expect(downloaded).toHaveLength(3)
    expect(
      (
        await prisma.activityLap.findMany({
          where: { userId: owner.userId },
          orderBy: { id: 'asc' },
        })
      ).map((lap) => lap.id),
    ).toEqual(ids)
  })

  it('preserves all persisted lap metrics through a subsequent Training FIT refresh', async () => {
    const row = await seed('1001')
    await run()
    const before = await getActivity(owner, row.id)
    expect(before?.laps[0]).toMatchObject({ avgPowerWatts: 230, timerMs: 290_000 })
    const previousIds = (
      await prisma.activityLap.findMany({
        where: { userId: owner.userId, activityId: row.id },
        orderBy: { lapIndex: 'asc' },
      })
    ).map((lap) => lap.id)
    now = new Date(now.getTime() + 25 * 60 * 60 * 1000)
    const legacyNetwork: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/search/activities')) return Response.json([{ activityId: 1001 }])
      if (url.pathname.endsWith('/activity-service/activity/1001'))
        return Response.json({
          activityId: 1001,
          activityTypeDTO: { typeKey: 'running' },
          summaryDTO: {
            startTimeGMT: starts.get('1001')!.replace('T', ' ').replace('Z', ''),
            distance: 4000,
            elapsedDuration: 1200,
            duration: 1160,
          },
        })
      return network(input, init)
    }
    await importGarminActivityPage(
      owner,
      { startDate: '2026-11-01', endDate: '2026-11-10', start: 0, refreshLaps: true },
      { fetcher: legacyNetwork, pause: async () => {}, observedAt: () => now, now },
    )
    expect(downloaded).toEqual(['1001', '1001'])
    expect((await getActivity(owner, row.id))?.laps).toEqual(before?.laps)
    expect(
      (
        await prisma.activityLap.findMany({
          where: { userId: owner.userId, activityId: row.id },
          orderBy: { lapIndex: 'asc' },
        })
      ).map((lap) => lap.id),
    ).toEqual(previousIds)
    expect(
      (await prisma.activity.findUniqueOrThrow({ where: { id: row.id } })).fitImportState,
    ).toBe('COMPLETE')
    expect(await getActivity(other, row.id)).toBeNull()
  })

  it('separates FIT cooldowns from summary and provider-wide cooldowns', async () => {
    const row = await seed('1001')
    const fitRetryAt = new Date(now.getTime() + 3_600_000)
    await prisma.activity.update({
      where: { id: row.id },
      data: {
        fitImportState: 'FAILED',
        fitImportErrorCode: 'INVALID_RESPONSE',
        fitNextAttemptAt: fitRetryAt,
      },
    })
    const state = async () =>
      (await getGarminImportState(owner, now)).find((stream) => stream.streamId === 'activities')!
    expect(await state()).toMatchObject({
      summaryStatus: 'completed',
      summaryRetryAfter: null,
      retryAfter: fitRetryAt.toISOString(),
      laps: { failed: 1, retryable: 0 },
    })
    const summaryRetryAt = new Date(now.getTime() + 60_000)
    await prisma.syncCursor.updateMany({
      where: { userId: owner.userId, connectionId, dataType: ACTIVITY_HISTORY_CURSOR },
      data: { nextAttemptAt: summaryRetryAt },
    })
    expect((await state()).summaryRetryAfter).toBe(summaryRetryAt.toISOString())
    const providerRetryAt = new Date(now.getTime() + 120_000)
    await prisma.garminImportRateLimit.create({
      data: { userId: owner.userId, count: 1, windowStartedAt: now, providerRetryAt },
    })
    expect(await state()).toMatchObject({
      summaryRetryAfter: providerRetryAt.toISOString(),
      retryAfter: fitRetryAt.toISOString(),
    })
    expect(network).not.toHaveBeenCalled()
  })

  it('resumes bounded work after reload and keeps completed FITs through an unchanged summary reimport', async () => {
    const first = await seed('1001')
    await seed('1002')
    expect((await run('import', 1)).laps).toMatchObject({ processed: 1, pending: 1 })
    expect(
      (await getGarminImportState(owner, now)).find((stream) => stream.streamId === 'activities')
        ?.status,
    ).toBe('paused')
    await run('resume', 1)
    await importCanonicalActivity(owner, first.summary, {
      summaryOnly: true,
      garminAccountId: testGarminAccountId(owner),
    })
    await run()
    expect(downloaded.sort()).toEqual(['1001', '1002'])
  })

  it('continues past corrupt/404 FITs and retries only the failed activity after its cooldown', async () => {
    await seed('1001')
    await seed('1002')
    await seed('1003')
    corruptId = '1001'
    fitStatuses.set('1002', 404)
    const initial = await run()
    expect(initial).toMatchObject({
      status: 'waiting_retry',
      summaryStatus: 'completed',
      laps: { processed: 3, complete: 1, failed: 1, unavailable: 1, retryable: 0 },
    })
    expect(await prisma.activity.count({ where: { userId: owner.userId } })).toBe(3)
    const failed = await prisma.activity.findFirstOrThrow({
      where: { userId: owner.userId, externalActivityId: '1001' },
    })
    expect(failed.fitNextAttemptAt).not.toBeNull()
    expect((await run('retry')).laps?.failed).toBe(1)
    expect(downloaded).toHaveLength(3)
    now = new Date(failed.fitNextAttemptAt!.getTime() + 1)
    corruptId = undefined
    expect((await run('retry')).status).toBe('completed_with_warnings')
    expect(downloaded.filter((id) => id === '1001')).toHaveLength(2)
    expect(downloaded.filter((id) => id === '1002')).toHaveLength(1)
    expect(await prisma.activityLap.count({ where: { userId: owner.userId } })).toBe(8)
  })

  it.each([500, 503])(
    'tracks HTTP %s per activity without stopping remaining jobs',
    async (status) => {
      await seed('1001')
      await seed('1002')
      fitStatuses.set('1001', status)
      expect((await run()).laps).toMatchObject({ failed: 1, complete: 1, pending: 0 })
      expect(downloaded.sort()).toEqual(['1001', '1002'])
    },
  )

  it('stops on 429, persists shared Retry-After, and leaves unfinished work resumable', async () => {
    await seed('1001')
    await seed('1002')
    fitStatuses.set('1002', 429)
    const state = await run()
    expect(state).toMatchObject({
      status: 'waiting_retry',
      errorCode: 'RATE_LIMITED',
      laps: { failed: 0 },
    })
    expect(Date.parse(state.retryAfter!)).toBeGreaterThanOrEqual(Date.now() + 290_000)
    expect(
      (await prisma.garminImportRateLimit.findUniqueOrThrow({ where: { userId: owner.userId } }))
        .providerRetryAt,
    ).not.toBeNull()
    await expect(
      runActivityLapHistory(owner, { action: 'resume', browserTimezone: 'UTC' }, dependencies()),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  })

  it('resumes a rejected downstream bearer with a new token while retaining the queue', async () => {
    await seed('1001')
    fitStatuses.set('1001', 401)
    const state = await run()
    expect(state).toMatchObject({
      status: 'waiting_retry',
      errorCode: 'TOKEN_REJECTED',
      laps: { pending: 1, failed: 0 },
    })
    now = new Date(Date.parse(state.retryAfter!) + 1)
    fitStatuses.clear()
    expect((await run('resume')).status).toBe('completed')
    expect(
      network.mock.calls.filter(([input]) => String(input).includes('/personal-api-key/token')),
    ).toHaveLength(2)
  })

  it('treats a rejected API key as terminal and never downloads or overwrites summaries', async () => {
    const row = await seed('1001')
    tokenStatus = 401
    expect(await run()).toMatchObject({ status: 'paused', errorCode: 'INVALID_KEY' })
    expect(downloaded).toHaveLength(0)
    expect(
      (
        await prisma.activity.findUniqueOrThrow({ where: { id: row.id } })
      ).distanceMeters?.toNumber(),
    ).toBe(4000)
  })

  it('verifies the provider account before selecting an activity for FIT binding', async () => {
    await seed('1001')
    identityAccount = testGarminAccountId(other)
    expect(await run()).toMatchObject({ status: 'paused', errorCode: 'ACCOUNT_MISMATCH' })
    expect(downloaded).toHaveLength(0)
    expect(await prisma.activityLap.count({ where: { userId: owner.userId } })).toBe(0)
  })

  it('excludes another owner, an old account and activities outside athlete-local coverage', async () => {
    await seed('1001')
    await seed('1002', 'running', other)
    await seed('1003', 'running', owner, testGarminAccountId(other))
    const old = await seed('1004')
    await prisma.activity.update({
      where: { id: old.id },
      data: { startedAt: new Date('2020-01-01Z') },
    })
    expect((await run()).laps).toMatchObject({ eligible: 1, complete: 1 })
    expect(downloaded).toEqual(['1001'])
    const snapshot = await prisma.activity.findUniqueOrThrow({ where: { id: old.id } })
    await expect(
      prisma.$transaction((tx) => replaceGarminActivityLaps(tx, other, snapshot, [], now)),
    ).rejects.toThrow()
  })

  it('uses the provider-wide lease and quota before any network work', async () => {
    await seed('1001')
    const lease = await claimGarminProviderLease(owner, connectionId, now)
    await expect(run()).rejects.toMatchObject({ code: 'BUSY' })
    expect(network).not.toHaveBeenCalled()
    await releaseGarminProviderLease(owner, connectionId, lease!)
    await prisma.garminImportRateLimit.upsert({
      where: { userId: owner.userId },
      create: { userId: owner.userId, count: 4, windowStartedAt: new Date() },
      update: { count: 4, windowStartedAt: new Date() },
    })
    await expect(
      runActivityLapHistory(owner, { action: 'import', browserTimezone: 'UTC' }, dependencies()),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(network).not.toHaveBeenCalled()
  })

  it('reclaims interrupted running work without resetting completed activities', async () => {
    const row = await seed('1001')
    await prisma.activity.update({ where: { id: row.id }, data: { fitImportState: 'RUNNING' } })
    await prisma.syncCursor.create({
      data: {
        userId: owner.userId,
        connectionId,
        dataType: ACTIVITY_LAPS_CURSOR,
        cursorOrCheckpoint: { version: 1 },
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(now.getTime() - 1),
      },
    })
    expect((await run('resume')).laps).toMatchObject({ complete: 1, failed: 0, pending: 0 })
  })

  it.each(['credential', 'lease'] as const)(
    'fences a FIT response after its %s is replaced',
    async (scenario) => {
      const row = await seed('1001')
      const replacementToken = randomUUID()
      onDownload = async () => {
        if (scenario === 'credential')
          await saveProviderApiKey(owner, 'GARMIN', 'synthetic-replaced-key', {
            verifiedGarminAccountId: testGarminAccountId(owner),
          })
        else {
          await prisma.syncCursor.updateMany({
            where: {
              userId: owner.userId,
              dataType: { in: ['GARMIN_REQUESTS', ACTIVITY_LAPS_CURSOR] },
            },
            data: {
              leaseToken: replacementToken,
              leaseExpiresAt: new Date(now.getTime() + 100_000),
            },
          })
        }
      }
      await run()
      expect(await prisma.activityLap.count({ where: { userId: owner.userId } })).toBe(0)
      expect(
        (await prisma.activity.findUniqueOrThrow({ where: { id: row.id } })).fitImportState,
      ).toBe('RUNNING')
      if (scenario === 'lease')
        expect(
          (
            await prisma.syncCursor.findFirstOrThrow({
              where: { userId: owner.userId, dataType: ACTIVITY_LAPS_CURSOR },
            })
          ).leaseToken,
        ).toBe(replacementToken)
    },
  )

  it('requires completed summaries and dispatches an explicit laps stage through the shared coordinator', async () => {
    await seed('1001')
    const states = await runGarminDataImport(
      owner,
      { streamId: 'activities', stage: 'laps', action: 'import', browserTimezone: 'UTC' },
      dependencies(),
    )
    expect(states.find((stream) => stream.streamId === 'activities')?.status).toBe('completed')
    await prisma.syncCursor.updateMany({
      where: { userId: owner.userId, dataType: ACTIVITY_HISTORY_CURSOR },
      data: { cursorOrCheckpoint: activityHistoryWindow('2026-11-10', 'UTC') },
    })
    await expect(run('resume')).rejects.toMatchObject({ code: 'NOT_READY' })
  })

  it('processes historical laps without restarting an interrupted legacy recent sync', async () => {
    const row = await seed('1001')
    const checkpoint = activityHistoryWindow('2026-11-12', 'UTC')
    await prisma.syncCursor.create({
      data: {
        userId: owner.userId,
        connectionId,
        dataType: ACTIVITY_RECENT_CURSOR,
        cursorOrCheckpoint: checkpoint,
        leaseExpiresAt: new Date(now.getTime() - 1),
      },
    })
    expect((await run()).laps).toMatchObject({ complete: 1, pending: 0, failed: 0 })
    expect(downloaded).toEqual(['1001'])
    expect((await getActivity(owner, row.id))?.laps).toHaveLength(4)
    expect(await getActivity(other, row.id)).toBeNull()
    const recent = await prisma.syncCursor.findFirstOrThrow({
      where: {
        userId: owner.userId,
        connectionId,
        dataType: ACTIVITY_RECENT_CURSOR,
      },
    })
    expect(recent.cursorOrCheckpoint).toEqual(checkpoint)
    expect(recent.lastSyncedAt).toBeNull()
  })

  it('recovers a failed summary-first FIT on targeted retry without changing its activity summary', async () => {
    const row = await seed('1001')
    await prisma.activity.update({
      where: { id: row.id },
      data: {
        fitImportState: 'FAILED',
        fitImportErrorCode: 'INVALID_RESPONSE',
        fitImportAttempts: 1,
        fitNextAttemptAt: new Date(now.getTime() - 1),
      },
    })
    const before = await prisma.activity.findUniqueOrThrow({ where: { id: row.id } })
    await runActivityLapHistory(
      owner,
      { action: 'retry', browserTimezone: 'UTC' },
      {
        ...dependencies(),
        downloadFit: async () => ({
          status: 200,
          bytes: syntheticActivityFit({
            start: starts.get('1001'),
            summaryFirst: true,
            summaryTimestamp: 'start',
          }),
        }),
      },
    )
    const saved = await prisma.activity.findUniqueOrThrow({ where: { id: row.id } })
    expect(saved).toMatchObject({
      fitImportState: 'COMPLETE',
      fitImportErrorCode: null,
      fitImportAttempts: 2,
    })
    expect(saved.startedAt).toEqual(before.startedAt)
    expect(saved.elapsedMs).toBe(before.elapsedMs)
    expect(saved.sourceObservedAt).toEqual(before.sourceObservedAt)
    expect(saved.distanceMeters?.toString()).toBe(before.distanceMeters?.toString())
    const laps = await prisma.activityLap.findMany({
      where: { userId: owner.userId, activityId: row.id },
      orderBy: { lapIndex: 'asc' },
    })
    expect(laps).toHaveLength(4)
    expect(laps[0].endedAt?.getTime()).toBe(before.startedAt.getTime() + 300_000)
    expect(
      (await getGarminImportState(owner, now)).find((stream) => stream.streamId === 'activities')
        ?.status,
    ).toBe('completed')
  })

  it('keeps prior valid laps after a corrupt or empty targeted refresh', async () => {
    const row = await seed('1001')
    await run()
    const previous = (
      await prisma.activityLap.findMany({
        where: { activityId: row.id },
        orderBy: { lapIndex: 'asc' },
      })
    ).map((lap) => lap.id)
    await prisma.activity.update({ where: { id: row.id }, data: { fitImportState: 'PENDING' } })
    corruptId = '1001'
    expect((await run()).laps?.failed).toBe(1)
    expect(
      (
        await prisma.activityLap.findMany({
          where: { activityId: row.id },
          orderBy: { lapIndex: 'asc' },
        })
      ).map((lap) => lap.id),
    ).toEqual(previous)
    await prisma.activity.update({
      where: { id: row.id },
      data: { fitImportState: 'PENDING', fitNextAttemptAt: null },
    })
    await quota()
    await runActivityLapHistory(
      owner,
      { action: 'import', browserTimezone: 'UTC' },
      {
        ...dependencies(),
        downloadFit: async () => ({
          status: 200,
          bytes: syntheticActivityFit({
            start: starts.get('1001'),
            emitLaps: false,
            declaredLaps: 0,
          }),
        }),
      },
    )
    const saved = await prisma.activity.findUniqueOrThrow({ where: { id: row.id } })
    expect(saved).toMatchObject({
      fitImportState: 'UNAVAILABLE',
      fitImportErrorCode: 'FIT_EMPTY_RETAINED',
      lapImportStatus: 'IMPORTED',
    })
    expect(
      (
        await prisma.activityLap.findMany({
          where: { activityId: row.id },
          orderBy: { lapIndex: 'asc' },
        })
      ).map((lap) => lap.id),
    ).toEqual(previous)
  })

  it('completes a provider-confirmed zero-lap activity without inventing rows', async () => {
    const row = await seed('1001')
    await prisma.activity.update({
      where: { id: row.id },
      data: { distanceMeters: 0, elapsedMs: BigInt(0), totalMs: BigInt(0) },
    })
    await runActivityLapHistory(
      owner,
      { action: 'import', browserTimezone: 'UTC' },
      {
        ...dependencies(),
        downloadFit: async () => ({
          status: 200,
          bytes: syntheticActivityFit({ start: starts.get('1001'), laps: 0 }),
        }),
      },
    )
    expect(
      (await prisma.activity.findUniqueOrThrow({ where: { id: row.id } })).fitImportState,
    ).toBe('COMPLETE')
    expect(await prisma.activityLap.count({ where: { activityId: row.id } })).toBe(0)
  })

  it('stops at the invocation time budget with remaining jobs durably pending', async () => {
    await seed('1001')
    await seed('1002')
    await runActivityLapHistory(
      owner,
      { action: 'import', browserTimezone: 'UTC' },
      {
        ...dependencies(),
        downloadFit: async (_fetcher, path) => {
          now = new Date(now.getTime() + 21_000)
          return {
            status: 200,
            bytes: syntheticActivityFit({ start: starts.get(path.split('/').at(-1)!) }),
          }
        },
      },
    )
    const state = (await getGarminImportState(owner, now)).find(
      (stream) => stream.streamId === 'activities',
    )!
    expect(state).toMatchObject({
      status: 'paused',
      laps: { complete: 1, pending: 1, processed: 1 },
    })
  })

  it.each([401, 503])(
    'treats account-verification HTTP %s as transient and does not mark files unavailable',
    async (status) => {
      await seed('1001')
      const identityNetwork: typeof fetch = async (input, init) =>
        String(input).includes('/usersummary/daily')
          ? new Response(null, { status })
          : network(input, init)
      await runActivityLapHistory(
        owner,
        { action: 'import', browserTimezone: 'UTC' },
        {
          ...dependencies(),
          openLapSession: (context, options) =>
            openGarminActivitySession(context, {
              ...options,
              fetcher: identityNetwork,
              pause: async () => {},
            }),
        },
      )
      expect(
        (await getGarminImportState(owner, now)).find((stream) => stream.streamId === 'activities'),
      ).toMatchObject({
        status: 'waiting_retry',
        errorCode: status === 401 ? 'TOKEN_REJECTED' : 'UNAVAILABLE',
        laps: { pending: 1, unavailable: 0 },
      })
      expect(downloaded).toHaveLength(0)
    },
  )
})
