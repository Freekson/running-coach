import 'server-only'

import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import {
  healthStreamIds,
  type HealthStreamId,
  type ImportStreamId,
  type GarminImportStreamState,
} from '@/lib/garmin-import-state'
import {
  earliestGarminHistoryDate,
  garminHistoryWindowDays,
  GARMIN_MAX_HISTORY_DAYS,
  GARMIN_HISTORY_YEARS,
} from '@/lib/garmin-import-window'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import {
  importGarminHealthDate,
  GarminHealthImportError,
  type GarminHealthSession,
} from './health-import'
import { healthZoneForDay, localDay } from './health-sync'
import {
  allowGarminImport,
  getGarminImportBlock,
  getGarminProviderPauseUntil,
} from './import-rate-limit'
import { claimGarminProviderLease, releaseGarminProviderLease } from './provider-lease'
import { isGarminImportAllowed } from './sync-policy'
import { createGarminStreamCoordinator, processGarminStreamWork } from './stream-coordinator'

import { GarminDataImportError } from './data-import-error'
import {
  ACTIVITY_LAPS_CURSOR,
  getActivityLapState,
  runActivityLapHistory,
  type ActivityLapDependencies,
} from './lap-history'
import {
  ACTIVITY_HISTORY_CURSOR,
  ACTIVITY_RECENT_CURSOR,
  activityHistoryState,
  runActivityHistory,
  type ActivityHistoryDependencies,
} from './activity-history'
export { GarminDataImportError } from './data-import-error'
export type {
  HealthStreamId,
  ImportStreamId,
  GarminImportStreamState,
} from '@/lib/garmin-import-state'
export { GARMIN_HISTORY_YEARS }
export const GARMIN_DAILY_BATCH_DAYS = 365
export const GARMIN_SLEEP_BATCH_DAYS = 30
const MAX_RETRY_DATES_PER_INVOCATION = 10
const RUN_BUDGET_MS = 22_000
const LEASE_MS = 100_000

type HealthAdapter = {
  dataType: string
  source: 'SUMMARY_ONLY' | 'SLEEP_ONLY'
  coverageField: 'summaryFetchedAt' | 'sleepFetchedAt'
  batchEnvironmentKey: string
  maximumBatchDays: number
  importDay: typeof importGarminHealthDate
  planWindow: typeof historicalWindow
}

// The existing source importer owns fetch, validation, normalization and idempotent persistence.
const healthAdapters = {
  daily_summary: {
    dataType: 'GARMIN_IMPORT_DAILY_SUMMARY',
    source: 'SUMMARY_ONLY',
    coverageField: 'summaryFetchedAt',
    batchEnvironmentKey: 'GARMIN_DAILY_BATCH_DAYS',
    maximumBatchDays: GARMIN_DAILY_BATCH_DAYS,
    importDay: importGarminHealthDate,
    planWindow: historicalWindow,
  },
  sleep: {
    dataType: 'GARMIN_IMPORT_SLEEP',
    source: 'SLEEP_ONLY',
    coverageField: 'sleepFetchedAt',
    batchEnvironmentKey: 'GARMIN_SLEEP_BATCH_DAYS',
    maximumBatchDays: GARMIN_SLEEP_BATCH_DAYS,
    importDay: importGarminHealthDate,
    planWindow: historicalWindow,
  },
} satisfies Record<HealthStreamId, HealthAdapter>

const checkpointSchema = z
  .strictObject({
    version: z.literal(1),
    generation: z.number().int().positive(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    nextDate: z.iso.date().nullable(),
    failedDates: z.array(z.iso.date()).max(GARMIN_MAX_HISTORY_DAYS),
    timezone: z.string().min(1),
    lastCheckedDate: z.iso.date().nullable(),
    summaryFailureCode: z
      .enum([
        'SUMMARY_EMPTY_BODY',
        'SUMMARY_NULL_DATA',
        'SUMMARY_INVALID_ENVELOPE',
        'SUMMARY_MULTIPLE_RECORDS',
        'SUMMARY_INVALID_RECORD',
        'SUMMARY_DATE_MISMATCH',
        'SUMMARY_INVALID_RESPONSE',
      ])
      .nullable()
      .optional(),
  })
  .refine((checkpoint) => {
    const days = garminHistoryWindowDays(checkpoint.startDate, checkpoint.endDate)
    return (
      days !== null &&
      checkpoint.failedDates.length <= days &&
      new Set(checkpoint.failedDates).size === checkpoint.failedDates.length &&
      checkpoint.failedDates.every(
        (date) => date >= checkpoint.startDate && date <= checkpoint.endDate,
      ) &&
      (checkpoint.nextDate === null ||
        (checkpoint.nextDate >= checkpoint.startDate && checkpoint.nextDate <= checkpoint.endDate))
    )
  })
type Checkpoint = z.infer<typeof checkpointSchema>

export function addCalendarDays(date: string, count: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + count * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

export function inclusiveDays(start: string, end: string): number {
  return (
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
  )
}

function configuredBatchDays(streamId: HealthStreamId): number {
  const adapter = healthAdapters[streamId]
  const maximum = adapter.maximumBatchDays
  const value = Number(process.env[adapter.batchEnvironmentKey])
  return Number.isInteger(value) && value >= 1 && value <= maximum ? value : maximum
}

/** Configured calendar years ending on the most recently completed athlete-local day. */
export function historicalWindow(today: string, timezone: string): Checkpoint {
  const endDate = addCalendarDays(today, -1)
  const startDate = earliestGarminHistoryDate(endDate)
  return {
    version: 1,
    generation: 1,
    startDate,
    endDate,
    nextDate: endDate,
    failedDates: [],
    timezone,
    lastCheckedDate: null,
    summaryFailureCode: null,
  }
}

/** Seed only contiguous, source-verified recent coverage; rows never complete a new import. */
export function seedHistoricalCoverage(
  checkpoint: Checkpoint,
  checkedDates: readonly string[],
): Checkpoint {
  const checked = new Set(checkedDates)
  let nextDate = checkpoint.endDate
  while (nextDate >= checkpoint.startDate && checked.has(nextDate))
    nextDate = addCalendarDays(nextDate, -1)
  if (nextDate < checkpoint.startDate) nextDate = checkpoint.startDate
  return {
    ...checkpoint,
    nextDate,
    lastCheckedDate: nextDate === checkpoint.endDate ? null : checkpoint.endDate,
  }
}

function cursorType(streamId: HealthStreamId): string {
  return healthAdapters[streamId].dataType
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

export function isTerminalGarminImportError(code: string): boolean {
  return (
    code === 'NOT_CONNECTED' ||
    code === 'ACCOUNT_MISMATCH' ||
    code === 'ACCOUNT_UNVERIFIABLE' ||
    /^(?:SUMMARY|SLEEP)_HTTP_40[13]$/.test(code)
  )
}

function emptyState(streamId: ImportStreamId): GarminImportStreamState {
  return {
    streamId,
    status: 'not_started',
    startDate: null,
    endDate: null,
    nextDate: null,
    lastCheckedDate: null,
    checkedDays: 0,
    totalDays: null,
    failedDateCount: 0,
    retryAfter: null,
    lastSyncAt: null,
    errorCode: null,
    generation: null,
  }
}

async function getImportStates(
  owner: OwnerContext,
  observedAt = new Date(),
): Promise<GarminImportStreamState[]> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: {
      id: true,
      externalAccountId: true,
      status: true,
      credential: { select: { connectionId: true, rotatedAt: true } },
    },
  })
  if (!connection?.credential) return [...healthStreamIds, 'activities' as const].map(emptyState)
  const [cursors, pause, runs] = await Promise.all([
    prisma.syncCursor.findMany({
      where: {
        userId,
        connectionId: connection.id,
        dataType: {
          in: [
            ...healthStreamIds.map(cursorType),
            ACTIVITY_HISTORY_CURSOR,
            ACTIVITY_RECENT_CURSOR,
            ACTIVITY_LAPS_CURSOR,
          ],
        },
      },
    }),
    getGarminProviderPauseUntil(owner),
    Promise.all(
      [
        ...healthStreamIds.map((id) => `GARMIN_IMPORT_${id.toUpperCase()}`),
        ACTIVITY_HISTORY_CURSOR,
        ACTIVITY_RECENT_CURSOR,
        ACTIVITY_LAPS_CURSOR,
      ].map((jobType) =>
        prisma.syncRun.findFirst({
          where: {
            userId,
            connectionId: connection.id,
            jobType,
          },
          orderBy: { startedAt: 'desc' },
          select: {
            jobType: true,
            status: true,
            errorCode: true,
            finishedAt: true,
            startedAt: true,
          },
        }),
      ),
    ),
  ])
  const result = healthStreamIds.map((streamId) => {
    const cursor = cursors.find((row) => row.dataType === cursorType(streamId))
    if (!cursor) return emptyState(streamId)
    const parsed = checkpointSchema.safeParse(cursor.cursorOrCheckpoint)
    if (!parsed.success)
      return { ...emptyState(streamId), status: 'paused' as const, errorCode: 'INVALID_CHECKPOINT' }
    const checkpoint = parsed.data
    const latestRun = runs[healthStreamIds.indexOf(streamId)]
    const totalDays = inclusiveDays(checkpoint.startDate, checkpoint.endDate)
    const traversed = checkpoint.nextDate
      ? inclusiveDays(checkpoint.nextDate, checkpoint.endDate) - 1
      : totalDays
    const retryAfter = [cursor.nextAttemptAt, pause]
      .filter((date): date is Date => Boolean(date && date > observedAt))
      .sort((a, b) => b.getTime() - a.getTime())[0]
    const status: GarminImportStreamState['status'] =
      !connection.externalAccountId ||
      connection.status === 'ERROR' ||
      connection.status === 'EXPIRED'
        ? 'paused'
        : cursor.leaseExpiresAt && cursor.leaseExpiresAt > observedAt
          ? 'running'
          : checkpoint.nextDate === null
            ? checkpoint.failedDates.length
              ? 'completed_with_warnings'
              : 'completed'
            : retryAfter
              ? 'waiting_retry'
              : 'paused'
    return {
      streamId,
      status,
      startDate: checkpoint.startDate,
      endDate: checkpoint.endDate,
      nextDate: checkpoint.nextDate,
      lastCheckedDate: checkpoint.lastCheckedDate,
      checkedDays: Math.max(0, traversed - checkpoint.failedDates.length),
      totalDays,
      failedDateCount: checkpoint.failedDates.length,
      retryAfter:
        checkpoint.nextDate === null && checkpoint.failedDates.length === 0
          ? null
          : (retryAfter?.toISOString() ?? null),
      lastSyncAt: cursor.lastSyncedAt?.toISOString() ?? null,
      errorCode: !connection.externalAccountId
        ? 'ACCOUNT_VERIFICATION_REQUIRED'
        : latestRun?.status === 'FAILED'
          ? latestRun.errorCode
          : checkpoint.failedDates.length
            ? (checkpoint.summaryFailureCode ?? null)
            : null,
      generation: checkpoint.generation,
      currentRange: checkpoint.nextDate
        ? {
            start:
              addCalendarDays(checkpoint.nextDate, -(configuredBatchDays(streamId) - 1)) <
              checkpoint.startDate
                ? checkpoint.startDate
                : addCalendarDays(checkpoint.nextDate, -(configuredBatchDays(streamId) - 1)),
            end: checkpoint.nextDate,
          }
        : checkpoint.failedDates[0]
          ? { start: checkpoint.failedDates[0], end: checkpoint.failedDates[0] }
          : null,
    }
  })
  const ready = Boolean(connection.externalAccountId && connection.status === 'CONNECTED')
  const activityState = (type: string, index: number) =>
    activityHistoryState(
      cursors.find((row) => row.dataType === type),
      ready,
      pause,
      runs[index]?.status === 'FAILED' &&
        !(
          connection.credential?.rotatedAt &&
          runs[index]?.finishedAt &&
          runs[index].finishedAt < connection.credential.rotatedAt
        )
        ? (runs[index]?.errorCode ?? null)
        : null,
      observedAt,
    )
  const activities = activityState(ACTIVITY_HISTORY_CURSOR, healthStreamIds.length)
  const recent = activityState(ACTIVITY_RECENT_CURSOR, healthStreamIds.length + 1)
  if (recent.status !== 'not_started') activities.recentSync = recent
  activities.summaryErrorCode = activities.errorCode
  activities.summaryRetryAfter =
    [cursors.find((row) => row.dataType === ACTIVITY_HISTORY_CURSOR)?.nextAttemptAt, pause]
      .filter((date): date is Date => Boolean(date && date > observedAt))
      .sort((a, b) => b.getTime() - a.getTime())[0]
      ?.toISOString() ?? null
  activities.summaryStatus =
    activities.generation !== null && activities.nextDate === null ? 'completed' : activities.status
  if (
    connection.externalAccountId &&
    activities.startDate &&
    activities.endDate &&
    activities.errorCode !== 'INVALID_CHECKPOINT'
  ) {
    const lapRun = runs[healthStreamIds.length + 2]
    activities.laps = await getActivityLapState(
      owner,
      connection.id,
      connection.externalAccountId,
      cursors.find((row) => row.dataType === ACTIVITY_LAPS_CURSOR),
      ready,
      pause,
      lapRun?.status === 'FAILED' &&
        !(connection.credential?.rotatedAt && lapRun.startedAt < connection.credential.rotatedAt)
        ? lapRun.errorCode
        : null,
      observedAt,
    )
    if (activities.summaryStatus === 'completed') {
      activities.status =
        activities.laps.status === 'not_started' ? 'paused' : activities.laps.status
      activities.retryAfter = activities.laps.retryAfter
      activities.errorCode = activities.laps.errorCode
    }
  }
  return [...result, activities]
}

export async function getGarminImportState(
  owner: OwnerContext,
  observedAt = new Date(),
): Promise<GarminImportStreamState[]> {
  return getImportStates(owner, observedAt)
}

export async function healthInitialImportReady(owner: OwnerContext): Promise<boolean> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: { id: true, externalAccountId: true, credential: { select: { connectionId: true } } },
  })
  if (!connection?.credential || !connection.externalAccountId) return false
  const cursors = await prisma.syncCursor.findMany({
    where: {
      userId,
      connectionId: connection.id,
      dataType: { in: healthStreamIds.map(cursorType) },
    },
    select: { dataType: true, cursorOrCheckpoint: true },
  })
  return healthStreamIds.every((id) => {
    const parsed = checkpointSchema.safeParse(
      cursors.find((cursor) => cursor.dataType === cursorType(id))?.cursorOrCheckpoint,
    )
    return parsed.success && parsed.data.nextDate === null
  })
}

type RunOptions = {
  stage?: 'summaries' | 'laps'
  streamId: ImportStreamId
  action: 'import' | 'resume' | 'retry' | 'reimport' | 'sync'
  browserTimezone: string
}
type HealthRunOptions = RunOptions & { streamId: HealthStreamId }
type Dependencies = ActivityHistoryDependencies &
  ActivityLapDependencies & {
    now?: () => Date
    importDay?: typeof importGarminHealthDate
    zoneForDay?: typeof healthZoneForDay
    maxDatesPerRun?: number
  }

/** One user request processes a bounded range and saves its checkpoint before returning. */
async function runGarminHealthImport(
  owner: OwnerContext,
  options: HealthRunOptions,
  dependencies: Dependencies = {},
): Promise<GarminImportStreamState[]> {
  if (!isGarminImportAllowed()) throw new GarminDataImportError('APPROVAL_REQUIRED')
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: {
      id: true,
      externalAccountId: true,
      status: true,
      credential: { select: { connectionId: true } },
    },
  })
  if (
    !connection?.credential ||
    !connection.externalAccountId ||
    connection.status === 'ERROR' ||
    connection.status === 'EXPIRED'
  )
    throw new GarminDataImportError('NOT_CONNECTED')
  const profile = await prisma.athleteProfile.findUnique({
    where: { userId },
    select: { preferredTimezone: true },
  })
  const timezone =
    profile?.preferredTimezone && validTimezone(profile.preferredTimezone)
      ? profile.preferredTimezone
      : options.browserTimezone
  if (!validTimezone(timezone)) throw new GarminDataImportError('INVALID_TIMEZONE')
  const clock = dependencies.now ?? (() => new Date())
  const now = clock()
  const adapter = healthAdapters[options.streamId]
  const cursorKey = { connectionId: connection.id, dataType: cursorType(options.streamId) }
  if (options.action === 'import') {
    const fresh = adapter.planWindow(localDay(now, timezone), timezone)
    const existing = await prisma.dailyHealthMetric.findMany({
      where: {
        userId,
        sourceProvider: 'GARMIN',
        garminAccountId: connection.externalAccountId,
        localDate: {
          gte: new Date(`${fresh.startDate}T00:00:00.000Z`),
          lte: new Date(`${fresh.endDate}T00:00:00.000Z`),
        },
        [adapter.coverageField]: { not: null },
      },
      select: { localDate: true },
    })
    const seeded = seedHistoricalCoverage(
      fresh,
      existing.map((row) => row.localDate.toISOString().slice(0, 10)),
    )
    await prisma.syncCursor.upsert({
      where: { connectionId_dataType: cursorKey },
      create: { userId, ...cursorKey, cursorOrCheckpoint: seeded },
      update: {},
    })
  }
  const cursor = await prisma.syncCursor.findUnique({ where: { connectionId_dataType: cursorKey } })
  if (!cursor) throw new GarminDataImportError('NOT_STARTED')
  let parsed = checkpointSchema.safeParse(cursor.cursorOrCheckpoint)
  if (!parsed.success) throw new GarminDataImportError('INVALID_CHECKPOINT')
  if (options.action === 'reimport' && !(await allowGarminImport(owner)))
    throw new GarminDataImportError('RATE_LIMITED')
  if (options.action === 'reimport' && parsed.data.nextDate === null) {
    const reset = {
      ...adapter.planWindow(localDay(now, timezone), timezone),
      generation: parsed.data.generation + 1,
    }
    const changed = await prisma.syncCursor.updateMany({
      where: {
        userId,
        ...cursorKey,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: { cursorOrCheckpoint: reset, nextAttemptAt: null, consecutiveFailures: 0 },
    })
    if (changed.count !== 1) throw new GarminDataImportError('BUSY')
    parsed = checkpointSchema.safeParse(reset)
  }
  if (!parsed.data) throw new GarminDataImportError('INVALID_CHECKPOINT')
  let checkpoint: Checkpoint = parsed.data
  if (options.action === 'retry' && checkpoint.failedDates.length === 0)
    return getGarminImportState(owner, clock())
  if (options.action !== 'retry' && checkpoint.nextDate === null)
    return getGarminImportState(owner, clock())
  if (options.action !== 'reimport' && !(await allowGarminImport(owner)))
    throw new GarminDataImportError('RATE_LIMITED')
  const token = randomUUID()
  const claimed = await prisma.syncCursor.updateMany({
    where: {
      userId,
      ...cursorKey,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      AND: [{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }],
    },
    data: { leaseToken: token, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
  })
  if (claimed.count !== 1) throw new GarminDataImportError('BUSY')
  let providerToken: string | null = null
  let runId: string | null = null
  const session: GarminHealthSession = {}
  let processed = 0
  let written = 0
  try {
    providerToken = await claimGarminProviderLease(owner, connection.id, now)
    if (!providerToken) throw new GarminDataImportError('BUSY')
    await prisma.syncRun.updateMany({
      where: {
        userId,
        connectionId: connection.id,
        jobType: `GARMIN_IMPORT_${options.streamId.toUpperCase()}`,
        status: 'RUNNING',
        startedAt: { lt: new Date(now.getTime() - LEASE_MS) },
      },
      data: { status: 'FAILED', finishedAt: clock(), errorCode: 'INTERRUPTED' },
    })
    const run = await prisma.syncRun.create({
      data: {
        userId,
        connectionId: connection.id,
        jobType: `GARMIN_IMPORT_${options.streamId.toUpperCase()}`,
        status: 'RUNNING',
      },
    })
    runId = run.id
    const batchLimit = configuredBatchDays(options.streamId)
    const runLimit =
      dependencies.maxDatesPerRun && Number.isInteger(dependencies.maxDatesPerRun)
        ? Math.min(batchLimit, Math.max(1, dependencies.maxDatesPerRun))
        : batchLimit
    const dates =
      options.action === 'retry'
        ? checkpoint.failedDates.slice(0, Math.min(MAX_RETRY_DATES_PER_INVOCATION, runLimit))
        : Array.from(
            {
              length: Math.min(runLimit, inclusiveDays(checkpoint.startDate, checkpoint.nextDate!)),
            },
            (_, index) => addCalendarDays(checkpoint.nextDate!, -index),
          )
    const batch = await processGarminStreamWork({
      checkpoint,
      maxSteps: dates.length,
      next: (_current, index) => {
        const date = dates[index]
        if (!date) return null
        return {
          date,
          batchStartDate:
            options.action === 'retry'
              ? adapter.source === 'SLEEP_ONLY'
                ? date
                : undefined
              : dates[Math.min(dates.length - 1, index + batchLimit - 1)],
        }
      },
      execute: async (current, work) => {
        const zones = await (dependencies.zoneForDay ?? healthZoneForDay)(
          owner,
          work.date,
          current.timezone,
        )
        const result = await (dependencies.importDay ?? adapter.importDay)(
          owner,
          work.date,
          zones.summary,
          {
            sleepTimezone: zones.sleep,
            selectionTimezone: current.timezone,
            earliestAllowedDate: current.startDate,
            now: clock(),
            session,
            sources: adapter.source,
            recheckFetchedSleep: adapter.source === 'SLEEP_ONLY',
            batchStartDate: work.batchStartDate,
            summaryTimezoneBasis: zones.summaryBasis,
            sleepTimezoneBasis: zones.sleepBasis,
            requestTimeoutMs: 10_000,
          },
        )
        if (result.status === 'PARTIAL' && result.errorCode === 'RATE_LIMITED')
          throw new GarminHealthImportError('RATE_LIMITED')
        if (result.status === 'PARTIAL' && isTerminalGarminImportError(result.errorCode))
          throw new GarminHealthImportError(result.errorCode)
        if (result.status === 'PARTIAL' && !result.errorCode.startsWith('SLEEP_'))
          throw new GarminHealthImportError(result.errorCode)
        const failedDates =
          result.status === 'PARTIAL'
            ? current.failedDates.includes(work.date)
              ? current.failedDates
              : [...current.failedDates, work.date]
            : current.failedDates.filter((item) => item !== work.date)
        return {
          checkpoint: {
            ...current,
            nextDate:
              options.action === 'retry'
                ? current.nextDate
                : work.date === current.startDate
                  ? null
                  : addCalendarDays(work.date, -1),
            lastCheckedDate: work.date,
            failedDates,
            summaryFailureCode: failedDates.length ? current.summaryFailureCode : null,
          },
          written: true,
        }
      },
      recover: (current, work, error) => {
        if (
          !(error instanceof GarminHealthImportError) ||
          (error.code !== 'SUMMARY_INVALID_RESPONSE' && error.code !== 'SUMMARY_DATE_MISMATCH')
        )
          return null
        const summaryFailureCode: Checkpoint['summaryFailureCode'] =
          error.diagnosticCode ??
          (error.code === 'SUMMARY_DATE_MISMATCH'
            ? 'SUMMARY_DATE_MISMATCH'
            : 'SUMMARY_INVALID_RESPONSE')
        return {
          checkpoint: {
            ...current,
            nextDate:
              options.action === 'retry'
                ? current.nextDate
                : work.date === current.startDate
                  ? null
                  : addCalendarDays(work.date, -1),
            lastCheckedDate: work.date,
            failedDates: current.failedDates.includes(work.date)
              ? current.failedDates
              : [...current.failedDates, work.date],
            summaryFailureCode,
          },
          written: false,
        }
      },
      save: async (step) => {
        const saved = await prisma.syncCursor.updateMany({
          where: { userId, ...cursorKey, leaseToken: token, leaseExpiresAt: { gt: clock() } },
          data: {
            cursorOrCheckpoint: step.checkpoint as Prisma.InputJsonValue,
            lastSyncedAt: clock(),
            ...(step.written ? { nextAttemptAt: null, consecutiveFailures: 0 } : {}),
          },
        })
        if (saved.count !== 1) throw new GarminDataImportError('BUSY')
      },
      shouldStop: () => clock().getTime() - now.getTime() >= RUN_BUDGET_MS,
    })
    checkpoint = batch.checkpoint
    processed = batch.processed
    written = batch.written
    await prisma.syncRun.update({
      where: { id: runId },
      data: {
        status: 'SUCCEEDED',
        finishedAt: clock(),
        recordsSeen: processed,
        recordsWritten: written,
      },
    })
  } catch (error) {
    if (!runId) throw error
    const code =
      error instanceof GarminHealthImportError || error instanceof GarminDataImportError
        ? error.code
        : 'UNAVAILABLE'
    const terminal = isTerminalGarminImportError(code)
    const current = await prisma.syncCursor.findUnique({
      where: { connectionId_dataType: cursorKey },
      select: { consecutiveFailures: true },
    })
    const delayMs = Math.min(
      3_600_000,
      60_000 * 2 ** Math.min(current?.consecutiveFailures ?? 0, 6),
    )
    const block = terminal ? null : await getGarminImportBlock(owner)
    const backoffUntil = new Date(clock().getTime() + delayMs)
    const retryAt = terminal
      ? null
      : block && block.retryAt > backoffUntil
        ? block.retryAt
        : backoffUntil
    await prisma.syncCursor.updateMany({
      where: { userId, ...cursorKey, leaseToken: token },
      data: { nextAttemptAt: retryAt, consecutiveFailures: { increment: 1 } },
    })
    await prisma.syncRun.update({
      where: { id: runId },
      data: {
        status: 'FAILED',
        finishedAt: clock(),
        recordsSeen: processed,
        recordsWritten: written,
        errorCode: code,
        errorSafeMessage: code,
      },
    })
  } finally {
    if (providerToken) await releaseGarminProviderLease(owner, connection.id, providerToken)
    await prisma.syncCursor.updateMany({
      where: { userId, ...cursorKey, leaseToken: token },
      data: { leaseToken: null, leaseExpiresAt: null },
    })
  }
  return getGarminImportState(owner, clock())
}

const streamCoordinator = createGarminStreamCoordinator<
  ImportStreamId,
  RunOptions['action'],
  GarminImportStreamState[],
  Dependencies
>(
  [
    ...healthStreamIds.map((streamId) => ({
      streamId,
      execute: (owner: OwnerContext, options: RunOptions, dependencies: Dependencies) => {
        if (options.action === 'sync') throw new GarminDataImportError('NOT_READY')
        return runGarminHealthImport(owner, { ...options, streamId }, dependencies)
      },
    })),
    {
      streamId: 'activities',
      execute: async (owner, options: RunOptions, dependencies) => {
        if (options.stage === 'laps') await runActivityLapHistory(owner, options, dependencies)
        else await runActivityHistory(owner, options, dependencies)
        return getGarminImportState(owner, dependencies.now?.())
      },
    },
  ],
  () => new GarminDataImportError('NOT_READY'),
)

/** Dispatches only the selected stream through the shared bounded work loop. */
export function runGarminDataImport(
  owner: OwnerContext,
  options: RunOptions,
  dependencies: Dependencies = {},
): Promise<GarminImportStreamState[]> {
  return streamCoordinator.run(owner, options, dependencies)
}
