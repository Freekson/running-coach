import 'server-only'

import { randomUUID } from 'node:crypto'
import { type Prisma } from '@prisma/client'
import { z } from 'zod'
import type { GarminSyncState } from '@/lib/garmin-sync-state'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { GarminImportError, importGarminActivityPage } from './activity-import'
import { getGarminProviderPauseUntil, pauseGarminProviderUntil } from './import-rate-limit'
import { isGarminImportAllowed } from './sync-policy'

const DAY_MS = 86_400_000
const LEASE_MS = 100_000
function boundedSetting(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}
const checkpointSchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(['INITIAL', 'INCREMENTAL', 'EXTENSION', 'DONE']),
  oldestIncludedDate: z.iso.date(),
  latestRecentDate: z.iso.date().nullable().default(null),
  windowStart: z.iso.date(),
  windowEnd: z.iso.date(),
  nextDate: z.iso.date().nullable(),
  offset: z.number().int().min(0).max(10_000),
  seenIds: z.array(z.string().max(32).regex(/^\d+$/)).max(10_001).default([]),
  verifyingDay: z.boolean().default(false),
  changedDuringVerification: z.boolean().default(false),
  actionRequired: z.boolean().default(false),
})
type Checkpoint = z.infer<typeof checkpointSchema>

export class GarminSyncUnavailableError extends Error {
  constructor(
    readonly code: 'NOT_CONNECTED' | 'APPROVAL_REQUIRED' | 'BUSY' | 'PAUSED' | 'INVALID_EXTENSION',
  ) {
    super('Garmin sync unavailable')
  }
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(value: string, count: number): string {
  return day(new Date(Date.parse(`${value}T00:00:00.000Z`) + count * DAY_MS))
}

function initialWindow(now: Date): Checkpoint {
  const requested = Number(process.env.GARMIN_INITIAL_IMPORT_DAYS)
  const days = Number.isInteger(requested) && requested >= 7 && requested <= 84 ? requested : 84
  const end = day(now)
  const start = addDays(end, 1 - days)
  return {
    version: 1,
    mode: 'INITIAL',
    oldestIncludedDate: start,
    latestRecentDate: null,
    windowStart: start,
    windowEnd: end,
    nextDate: start,
    offset: 0,
    seenIds: [],
    verifyingDay: false,
    changedDuringVerification: false,
    actionRequired: false,
  }
}

function nextWindow(checkpoint: Checkpoint, now: Date, extendDays?: number): Checkpoint {
  if (checkpoint.nextDate !== null) {
    if (extendDays !== undefined) throw new GarminSyncUnavailableError('INVALID_EXTENSION')
    return checkpoint
  }
  if (extendDays !== undefined) {
    if (!Number.isInteger(extendDays) || extendDays < 1 || extendDays > 28)
      throw new GarminSyncUnavailableError('INVALID_EXTENSION')
    const end = addDays(checkpoint.oldestIncludedDate, -1)
    const start = addDays(end, 1 - extendDays)
    return {
      version: 1,
      mode: 'EXTENSION',
      oldestIncludedDate: start,
      latestRecentDate: checkpoint.latestRecentDate,
      windowStart: start,
      windowEnd: end,
      nextDate: start,
      offset: 0,
      seenIds: [],
      verifyingDay: false,
      changedDuringVerification: false,
      actionRequired: false,
    }
  }
  const end = day(now)
  const overlapStart = addDays(end, -6)
  // A backfill or older extension can finish days after its last recent window.
  // Catch up in seven-day windows before returning to the recent overlap.
  const firstMissingDate = addDays(checkpoint.latestRecentDate ?? checkpoint.windowEnd, 1)
  const start = firstMissingDate < overlapStart ? firstMissingDate : overlapStart
  const windowEnd = firstMissingDate < overlapStart ? addDays(start, 6) : end
  return {
    ...checkpoint,
    mode: 'INCREMENTAL',
    windowStart: start,
    windowEnd,
    nextDate: start,
    offset: 0,
    seenIds: [],
    verifyingDay: false,
    changedDuringVerification: false,
    actionRequired: false,
  }
}

export async function getGarminSyncState(
  owner: OwnerContext,
  observedAt: Date = new Date(),
): Promise<GarminSyncState> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: { id: true, status: true, credential: { select: { connectionId: true } } },
  })
  if (!connection?.credential)
    return {
      status: 'NOT_CONNECTED',
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextAttemptAt: null,
      window: null,
      nextDate: null,
      processed: 0,
      errorCode: null,
    }
  const [cursor, run, providerPauseUntil] = await Promise.all([
    prisma.syncCursor.findUnique({
      where: { connectionId_dataType: { connectionId: connection.id, dataType: 'ACTIVITIES' } },
    }),
    prisma.syncRun.findFirst({
      where: { userId, connectionId: connection.id, jobType: 'GARMIN_ACTIVITIES' },
      orderBy: { startedAt: 'desc' },
    }),
    getGarminProviderPauseUntil(owner),
  ])
  const parsed = checkpointSchema.safeParse(cursor?.cursorOrCheckpoint)
  const checkpoint = parsed.success ? parsed.data : null
  const currentRun = cursor ? run : null
  const status: GarminSyncState['status'] = !isGarminImportAllowed()
    ? 'UNAVAILABLE'
    : connection.status !== 'CONNECTED'
      ? 'ACTION_REQUIRED'
      : providerPauseUntil && providerPauseUntil > observedAt
        ? 'PAUSED'
        : cursor?.leaseExpiresAt && cursor.leaseExpiresAt > observedAt
          ? 'SYNCING'
          : cursor?.nextAttemptAt && cursor.nextAttemptAt > observedAt
            ? 'PAUSED'
            : checkpoint?.actionRequired ||
                (currentRun?.status === 'FAILED' &&
                  (currentRun.errorCode === 'INVALID_KEY' ||
                    currentRun.errorCode === 'ACCESS_DENIED'))
              ? 'ACTION_REQUIRED'
              : currentRun?.status === 'FAILED'
                ? currentRun.recordsWritten > 0
                  ? 'PARTIAL_FAILURE'
                  : 'ERROR'
                : checkpoint?.nextDate
                  ? 'PARTIAL'
                  : cursor?.lastSyncedAt
                    ? 'SUCCESS'
                    : 'IDLE'
  return {
    status,
    lastAttemptAt: currentRun?.startedAt.toISOString() ?? null,
    lastSuccessAt: cursor?.lastSyncedAt?.toISOString() ?? null,
    nextAttemptAt:
      providerPauseUntil && providerPauseUntil > observedAt
        ? providerPauseUntil.toISOString()
        : (cursor?.nextAttemptAt?.toISOString() ?? null),
    window: checkpoint ? { start: checkpoint.windowStart, end: checkpoint.windowEnd } : null,
    nextDate: checkpoint?.nextDate ?? null,
    processed: currentRun?.recordsWritten ?? 0,
    errorCode: currentRun?.status === 'FAILED' ? currentRun.errorCode : null,
  }
}

type Dependencies = {
  now?: () => Date
  importPage?: typeof importGarminActivityPage
}

/** A request executes a few pages and then returns; another request resumes from the committed page. */
export async function runGarminSync(
  owner: OwnerContext,
  options: { extendDays?: number } = {},
  dependencies: Dependencies = {},
): Promise<GarminSyncState> {
  const userId = ownerId(owner)
  if (!isGarminImportAllowed()) throw new GarminSyncUnavailableError('APPROVAL_REQUIRED')
  const now = dependencies.now ?? (() => new Date())
  const maxPages = boundedSetting(process.env.GARMIN_SYNC_MAX_PAGES, 4, 1, 4)
  const runBudgetMs = boundedSetting(process.env.GARMIN_SYNC_RUN_BUDGET_MS, 20_000, 5_000, 20_000)
  const pageSize = boundedSetting(process.env.GARMIN_SYNC_PAGE_SIZE, 1, 1, 2) as 1 | 2
  const requestTimeoutMs = boundedSetting(process.env.GARMIN_SYNC_TIMEOUT_MS, 7_000, 3_000, 7_000)
  const pacingMs = boundedSetting(process.env.GARMIN_SYNC_PACING_MS, 1_000, 1_000, 2_000)
  const started = now()
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: { id: true, status: true, credential: { select: { connectionId: true, nonce: true } } },
  })
  if (!connection?.credential || connection.status !== 'CONNECTED')
    throw new GarminSyncUnavailableError('NOT_CONNECTED')
  const sharedPauseUntil = await getGarminProviderPauseUntil(owner)
  if (sharedPauseUntil && sharedPauseUntil > started) throw new GarminSyncUnavailableError('PAUSED')
  const cursorKey = { connectionId: connection.id, dataType: 'ACTIVITIES' }
  await prisma.syncCursor.upsert({
    where: { connectionId_dataType: cursorKey },
    create: { userId, ...cursorKey, cursorOrCheckpoint: initialWindow(started) },
    update: {},
  })
  const token = randomUUID()
  const claimed = await prisma.syncCursor.updateMany({
    where: {
      userId,
      ...cursorKey,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: started } }],
      AND: [{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: started } }] }],
    },
    data: { leaseToken: token, leaseExpiresAt: new Date(started.getTime() + LEASE_MS) },
  })
  if (claimed.count !== 1) {
    const state = await getGarminSyncState(owner, now())
    throw new GarminSyncUnavailableError(state.status === 'PAUSED' ? 'PAUSED' : 'BUSY')
  }
  let run: { id: string } | null = null
  let processed = 0
  try {
    await prisma.syncRun.updateMany({
      where: {
        userId,
        connectionId: connection.id,
        jobType: 'GARMIN_ACTIVITIES',
        status: 'RUNNING',
        startedAt: { lt: new Date(started.getTime() - LEASE_MS) },
      },
      data: {
        status: 'FAILED',
        finishedAt: started,
        errorCode: 'INTERRUPTED',
        errorSafeMessage: 'Interrupted sync',
      },
    })
    const cursor = await prisma.syncCursor.findUniqueOrThrow({
      where: { connectionId_dataType: cursorKey },
    })
    const parsed = checkpointSchema.safeParse(cursor.cursorOrCheckpoint)
    if (!parsed.success) {
      const retryAt = new Date(now().getTime() + 3_600_000)
      await prisma.$transaction([
        prisma.syncRun.create({
          data: {
            userId,
            connectionId: connection.id,
            jobType: 'GARMIN_ACTIVITIES',
            status: 'FAILED',
            startedAt: started,
            finishedAt: now(),
            errorCode: 'INVALID_CHECKPOINT',
            errorSafeMessage: 'Invalid saved checkpoint',
          },
        }),
        prisma.syncCursor.updateMany({
          where: { userId, ...cursorKey, leaseToken: token },
          data: { nextAttemptAt: retryAt, consecutiveFailures: { increment: 1 } },
        }),
      ])
      throw new Error('Invalid saved Garmin checkpoint')
    }
    if (parsed.data.actionRequired) throw new GarminSyncUnavailableError('NOT_CONNECTED')
    let checkpoint = nextWindow(parsed.data, started, options.extendDays)
    run = await prisma.syncRun.create({
      data: {
        userId,
        connectionId: connection.id,
        jobType: 'GARMIN_ACTIVITIES',
        status: 'RUNNING',
      },
    })
    for (let page = 0; page < maxPages && checkpoint.nextDate !== null; page++) {
      if (now().getTime() - started.getTime() >= runBudgetMs) break
      const result = await (dependencies.importPage ?? importGarminActivityPage)(
        owner,
        {
          startDate: checkpoint.nextDate,
          endDate: checkpoint.nextDate,
          start: checkpoint.offset,
          pageSize,
          refreshLaps: checkpoint.mode !== 'INITIAL',
        },
        { requestTimeoutMs, pacingMs, deadlineAt: started.getTime() + runBudgetMs },
      )
      processed += result.imported.length
      const nextOffset = result.hasMore ? result.nextStart : null
      if (result.hasMore && nextOffset === null) throw new GarminImportError('UNAVAILABLE')
      const seen = new Set(checkpoint.seenIds)
      const newIds = (result.providerIds ?? []).filter((id) => !seen.has(id))
      for (const id of newIds) seen.add(id)
      const changedDuringVerification =
        checkpoint.changedDuringVerification || (checkpoint.verifyingDay && newIds.length > 0)
      if (nextOffset !== null) {
        checkpoint = {
          ...checkpoint,
          offset: nextOffset,
          seenIds: [...seen],
          changedDuringVerification,
        }
      } else if (
        (checkpoint.verifyingDay && changedDuringVerification) ||
        (!checkpoint.verifyingDay && checkpoint.offset > 0)
      ) {
        checkpoint = {
          ...checkpoint,
          offset: 0,
          seenIds: [...seen],
          verifyingDay: true,
          changedDuringVerification: false,
        }
      } else {
        const nextDate = addDays(checkpoint.nextDate, 1)
        const complete = nextDate > checkpoint.windowEnd
        checkpoint = {
          ...checkpoint,
          mode: complete ? 'DONE' : checkpoint.mode,
          latestRecentDate:
            complete && checkpoint.mode !== 'EXTENSION'
              ? checkpoint.windowEnd
              : checkpoint.latestRecentDate,
          nextDate: complete ? null : nextDate,
          offset: 0,
          seenIds: [],
          verifyingDay: false,
          changedDuringVerification: false,
        }
      }
      const committed = await prisma.syncCursor.updateMany({
        where: { userId, ...cursorKey, leaseToken: token, leaseExpiresAt: { gt: now() } },
        data: {
          cursorOrCheckpoint: checkpoint as Prisma.InputJsonValue,
          lastSyncedAt: checkpoint.nextDate === null ? now() : undefined,
          consecutiveFailures: 0,
          nextAttemptAt: null,
        },
      })
      if (committed.count !== 1) throw new GarminImportError('STORAGE_UNAVAILABLE')
    }
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: now(),
        recordsSeen: processed,
        recordsWritten: processed,
        checkpointSummary: {
          windowStart: checkpoint.windowStart,
          windowEnd: checkpoint.windowEnd,
          complete: checkpoint.nextDate === null,
        },
      },
    })
  } catch (error) {
    if (!run || error instanceof GarminSyncUnavailableError) throw error
    if (error instanceof GarminImportError) processed += error.persistedCount
    const code = error instanceof GarminImportError ? error.code : 'UNAVAILABLE'
    const actionRequired = code === 'INVALID_KEY' || code === 'ACCESS_DENIED'
    if (code === 'INVALID_KEY')
      await prisma.integrationConnection.updateMany({
        where: {
          userId,
          id: connection.id,
          status: 'CONNECTED',
          credential: { is: { userId, nonce: connection.credential.nonce } },
        },
        data: { status: 'ERROR', lastFailureAt: now() },
      })
    const current = await prisma.syncCursor.findUniqueOrThrow({
      where: { connectionId_dataType: cursorKey },
    })
    const currentCheckpoint = checkpointSchema.safeParse(current.cursorOrCheckpoint)
    const failures = current.consecutiveFailures + 1
    const backoff =
      Math.min(3_600_000, 60_000 * 2 ** Math.min(failures - 1, 6)) +
      Math.floor(Math.random() * 10_000)
    const retryAfter = error instanceof GarminImportError ? (error.retryAfterMs ?? 0) : 0
    const providerDelay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0
    const retryAt = actionRequired
      ? null
      : new Date(
          Math.min(8_640_000_000_000_000, now().getTime() + Math.max(backoff, providerDelay)),
        )
    if (retryAt) await pauseGarminProviderUntil(owner, retryAt, connection.credential.nonce)
    await prisma.syncCursor.updateMany({
      where: { userId, ...cursorKey, leaseToken: token },
      data: {
        nextAttemptAt: retryAt,
        consecutiveFailures: failures,
        cursorOrCheckpoint:
          actionRequired && currentCheckpoint.success
            ? ({ ...currentCheckpoint.data, actionRequired: true } as Prisma.InputJsonValue)
            : undefined,
      },
    })
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: now(),
        recordsSeen: processed,
        recordsWritten: processed,
        retryCount: failures,
        errorCode: code,
        errorSafeMessage: code,
      },
    })
  } finally {
    await prisma.syncCursor.updateMany({
      where: { userId, ...cursorKey, leaseToken: token },
      data: { leaseToken: null, leaseExpiresAt: null },
    })
  }
  return getGarminSyncState(owner, now())
}
