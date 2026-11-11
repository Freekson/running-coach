import 'server-only'

import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import {
  earliestGarminHistoryDate,
  garminHistoryWindowDays,
  GARMIN_MAX_HISTORY_DAYS,
} from '@/lib/garmin-import-window'
import type { GarminSyncState } from '@/lib/garmin-sync-state'
import type { HealthTimezoneBasis } from '@/lib/health-history'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import {
  GarminHealthImportError,
  importGarminHealthDate,
  type GarminHealthImportErrorCode,
  type GarminHealthSession,
} from './health-import'
import { getGarminProviderPauseUntil } from './import-rate-limit'
import { isGarminImportAllowed } from './sync-policy'
import { claimGarminProviderLease, releaseGarminProviderLease } from './provider-lease'

const LEASE_MS = 100_000
const RUN_BUDGET_MS = 22_000
const MAX_DAYS_PER_REQUEST = 10
const COMPLETED_COOLDOWN_MS = 60 * 60 * 1000
type HealthDayZones = {
  summary: string
  sleep: string
  summaryBasis?: HealthTimezoneBasis
  sleepBasis?: HealthTimezoneBasis
}
const checkpointSchema = z
  .strictObject({
    version: z.literal(1),
    mode: z.enum(['INITIAL', 'RECENT']),
    windowStart: z.iso.date(),
    windowEnd: z.iso.date(),
    nextDate: z.iso.date().nullable(),
    sleepRetryDates: z.array(z.iso.date()).max(GARMIN_MAX_HISTORY_DAYS).default([]),
    sleepFailedDates: z.array(z.iso.date()).max(GARMIN_MAX_HISTORY_DAYS).default([]),
    fallbackTimezone: z.string().min(1),
  })
  .refine(
    (checkpoint) =>
      validTimezone(checkpoint.fallbackTimezone) &&
      garminHistoryWindowDays(checkpoint.windowStart, checkpoint.windowEnd) !== null &&
      checkpoint.sleepRetryDates.length <=
        (garminHistoryWindowDays(checkpoint.windowStart, checkpoint.windowEnd) ?? 0) &&
      checkpoint.sleepFailedDates.length <= checkpoint.sleepRetryDates.length &&
      new Set(checkpoint.sleepRetryDates).size === checkpoint.sleepRetryDates.length &&
      new Set(checkpoint.sleepFailedDates).size === checkpoint.sleepFailedDates.length &&
      checkpoint.sleepFailedDates.every((date) => checkpoint.sleepRetryDates.includes(date)) &&
      checkpoint.sleepRetryDates.every(
        (date) => date >= checkpoint.windowStart && date <= checkpoint.windowEnd,
      ) &&
      (checkpoint.nextDate === null ||
        (checkpoint.nextDate >= checkpoint.windowStart &&
          checkpoint.nextDate <= checkpoint.windowEnd)),
  )
type Checkpoint = z.infer<typeof checkpointSchema>

export class GarminHealthSyncUnavailableError extends Error {
  constructor(readonly code: 'NOT_CONNECTED' | 'APPROVAL_REQUIRED' | 'BUSY' | 'PAUSED') {
    super('Garmin health sync unavailable')
  }
}

const knownDiagnosticCodes = new Set([
  'APP_RATE_LIMITED',
  'PROVIDER_PAUSED',
  'RATE_LIMITED',
  'INVALID_KEY',
  'UNVERIFIABLE',
  'CREDENTIAL_CHANGED',
  'CREDENTIAL_REPLACED',
  'CONNECTION_REMOVED',
  'ACCOUNT_MISMATCH',
  'ACCOUNT_ALREADY_LINKED',
  'ACCOUNT_UNVERIFIABLE',
  'ACCOUNT_VERIFICATION_REQUIRED',
  'KEY_STORAGE_UNCONFIGURED',
  'NOT_CONNECTED',
  'INVALID_CHECKPOINT',
  'INVALID_DATE',
  'INTERRUPTED',
  'APPROVAL_REQUIRED',
  'BUSY',
  'PAUSED',
  'UNAVAILABLE',
])

function safeSyncErrorCode(code: string | null | undefined): string | null {
  if (!code) return null
  if (/^(?:SLEEP|SUMMARY)_HTTP_[1-5]\d{2}$/.test(code)) return code
  if (/^(?:SLEEP|SUMMARY)_(?:TIMEOUT|NETWORK|INVALID_RESPONSE|DATE_MISMATCH)$/.test(code))
    return code
  return knownDiagnosticCodes.has(code) ? code : 'UNKNOWN_ERROR'
}

function recoveredSleepApiErrors(summary: unknown): string[] {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return []
  const codes = 'recoveredApiErrorCodes' in summary ? summary.recoveredApiErrorCodes : null
  if (!Array.isArray(codes)) return []
  return codes
    .slice(0, 3)
    .filter(
      (code): code is string =>
        typeof code === 'string' &&
        /^SLEEP_(?:HTTP_[1-5]\d{2}|TIMEOUT|NETWORK|INVALID_RESPONSE|DATE_MISMATCH)$/.test(code),
    )
}

function diagnosticRetryAt(summary: unknown): string | null {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null
  const retryAt = 'retryAt' in summary ? summary.retryAt : null
  return typeof retryAt === 'string' && z.iso.datetime().safeParse(retryAt).success ? retryAt : null
}

/** Record a safe failed request without changing the actual import checkpoint or run status. */
export async function recordGarminHealthRequestDiagnostic(
  owner: OwnerContext,
  code: string,
  retryAt?: Date | null,
): Promise<void> {
  const errorCode = safeSyncErrorCode(code)
  if (!errorCode) return
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: { id: true, credential: { select: { connectionId: true } } },
  })
  if (!connection?.credential) return
  const startedAt = new Date()
  const existing = await prisma.syncRun.findFirst({
    where: {
      userId,
      connectionId: connection.id,
      jobType: 'GARMIN_HEALTH_REQUEST',
      errorCode,
      startedAt: { gte: new Date(startedAt.getTime() - 60_000) },
    },
    select: { id: true },
  })
  if (existing) return
  await prisma.syncRun.create({
    data: {
      userId,
      connectionId: connection.id,
      jobType: 'GARMIN_HEALTH_REQUEST',
      status: 'FAILED',
      startedAt,
      finishedAt: startedAt,
      errorCode,
      checkpointSummary:
        retryAt && Number.isFinite(retryAt.getTime())
          ? { retryAt: retryAt.toISOString() }
          : undefined,
    },
  })
}

async function recentGarminHealthRuns(
  prisma: Awaited<ReturnType<typeof getPrismaClient>>,
  userId: string,
  connectionId: string,
): Promise<NonNullable<GarminSyncState['recentRuns']>> {
  const rows = await prisma.syncRun.findMany({
    where: {
      userId,
      connectionId,
      jobType: { in: ['GARMIN_HEALTH', 'GARMIN_HEALTH_REQUEST'] },
    },
    orderBy: { startedAt: 'desc' },
    take: 5,
    select: {
      jobType: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      recordsWritten: true,
      errorCode: true,
      checkpointSummary: true,
    },
  })
  return rows.map((entry) => ({
    kind: entry.jobType === 'GARMIN_HEALTH_REQUEST' ? 'REQUEST' : 'SYNC',
    status: entry.status,
    startedAt: entry.startedAt.toISOString(),
    finishedAt: entry.finishedAt?.toISOString() ?? null,
    datesProcessed: entry.recordsWritten,
    errorCode: safeSyncErrorCode(entry.errorCode),
    retryAt: diagnosticRetryAt(entry.checkpointSummary),
    recoveredApiErrors: recoveredSleepApiErrors(entry.checkpointSummary),
  }))
}

export function localDay(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function addDays(date: string, count: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + count * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

export function healthWindow(today: string, hasHistory: boolean, timezone: string): Checkpoint {
  return {
    version: 1,
    mode: hasHistory ? 'RECENT' : 'INITIAL',
    windowStart: addDays(today, hasHistory ? -6 : -29),
    windowEnd: today,
    nextDate: addDays(today, hasHistory ? -6 : -29),
    sleepRetryDates: [],
    sleepFailedDates: [],
    fallbackTimezone: timezone,
  }
}

export function nextHealthWindow(
  checkpoint: Checkpoint,
  today: string,
  timezone: string,
): Checkpoint {
  const overlapStart = addDays(today, -6)
  const firstMissingDate = addDays(checkpoint.windowEnd, 1)
  const oldest = earliestGarminHistoryDate(today)
  const start =
    firstMissingDate < overlapStart
      ? firstMissingDate < oldest
        ? oldest
        : firstMissingDate
      : overlapStart
  return {
    version: 1,
    mode: 'RECENT',
    windowStart: start,
    windowEnd: today,
    nextDate: start,
    sleepRetryDates: [],
    sleepFailedDates: [],
    fallbackTimezone: timezone,
  }
}

export function eligibleHealthCheckpoint(
  checkpoint: Checkpoint,
  today: string,
  timezone: string,
): Checkpoint {
  const oldest = earliestGarminHistoryDate(today)
  if (checkpoint.windowEnd < oldest) return nextHealthWindow(checkpoint, today, timezone)
  const windowStart = checkpoint.windowStart < oldest ? oldest : checkpoint.windowStart
  const nextDate =
    checkpoint.nextDate && checkpoint.nextDate < oldest ? oldest : checkpoint.nextDate
  const sleepRetryDates = checkpoint.sleepRetryDates.filter((date) => date >= oldest)
  const sleepFailedDates = checkpoint.sleepFailedDates.filter((date) => date >= oldest)
  if (
    windowStart === checkpoint.windowStart &&
    nextDate === checkpoint.nextDate &&
    sleepRetryDates.length === checkpoint.sleepRetryDates.length &&
    sleepFailedDates.length === checkpoint.sleepFailedDates.length
  )
    return checkpoint
  return { ...checkpoint, windowStart, nextDate, sleepRetryDates, sleepFailedDates }
}

export function advanceHealthCheckpoint(
  checkpoint: Checkpoint,
  date: string,
  result: 'SUCCEEDED' | 'SUMMARY_ONLY' | 'PARTIAL',
  retrySleep: boolean,
): Checkpoint {
  const retryIndex = checkpoint.sleepRetryDates.indexOf(date)
  if (retrySleep ? retryIndex < 0 : date !== checkpoint.nextDate)
    throw new Error('Health checkpoint day mismatch')
  const sleepRetryDates = [...checkpoint.sleepRetryDates]
  const sleepFailedDates = [...checkpoint.sleepFailedDates]
  if (retrySleep) {
    if (result === 'SUCCEEDED') {
      sleepRetryDates.splice(retryIndex, 1)
      const failedIndex = sleepFailedDates.indexOf(date)
      if (failedIndex !== -1) sleepFailedDates.splice(failedIndex, 1)
    } else if (result === 'PARTIAL' && !sleepFailedDates.includes(date)) {
      sleepFailedDates.push(date)
    }
    return { ...checkpoint, sleepRetryDates, sleepFailedDates }
  }
  if (result !== 'SUCCEEDED' && !sleepRetryDates.includes(date)) sleepRetryDates.push(date)
  if (result === 'PARTIAL' && !sleepFailedDates.includes(date)) sleepFailedDates.push(date)
  const followingDate = addDays(date, 1)
  return {
    ...checkpoint,
    nextDate: followingDate > checkpoint.windowEnd ? null : followingDate,
    sleepRetryDates,
    sleepFailedDates,
  }
}

function validTimezone(value: string | null | undefined): value is string {
  if (!value) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

function storedBasis(value: string | null | undefined): HealthTimezoneBasis {
  if (
    value === 'ACTIVITY_INFERRED' ||
    value === 'PROFILE_INFERRED' ||
    value === 'BROWSER_INFERRED' ||
    value === 'STORED_INFERRED' ||
    value === 'REQUEST_INFERRED'
  )
    return value
  return 'STORED_INFERRED'
}

/** Stored day zones and Garmin activity zones preserve travel-day provenance. */
export async function healthZoneForDay(
  owner: OwnerContext,
  date: string,
  fallbackTimezone: string,
  fallbackBasis: HealthTimezoneBasis = 'PROFILE_INFERRED',
): Promise<HealthDayZones> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: { externalAccountId: true },
  })
  const garminAccountId = connection?.externalAccountId
  if (!garminAccountId)
    return {
      summary: fallbackTimezone,
      sleep: fallbackTimezone,
      summaryBasis: fallbackBasis,
      sleepBasis: fallbackBasis,
    }
  const [stored, activities] = await Promise.all([
    prisma.dailyHealthMetric.findUnique({
      where: {
        userId_sourceProvider_localDate_garminAccountId: {
          userId,
          sourceProvider: 'GARMIN',
          localDate: new Date(`${date}T00:00:00.000Z`),
          garminAccountId,
        },
      },
      select: {
        sourceTimezone: true,
        sleepSourceTimezone: true,
        sourceTimezoneBasis: true,
        sleepTimezoneBasis: true,
      },
    }),
    prisma.activity.findMany({
      where: {
        userId,
        sourceProvider: 'GARMIN',
        garminAccountId,
        sourceTimezone: { not: null },
        startedAt: {
          gte: new Date(`${addDays(date, -2)}T00:00:00.000Z`),
          lt: new Date(`${addDays(date, 2)}T00:00:00.000Z`),
        },
      },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, sourceTimezone: true },
    }),
  ])
  const activityZone = activities.find(
    (activity) =>
      validTimezone(activity.sourceTimezone) &&
      localDay(activity.startedAt, activity.sourceTimezone) === date,
  )?.sourceTimezone
  const summary =
    (validTimezone(activityZone) && activityZone) ||
    (validTimezone(stored?.sourceTimezone) && stored.sourceTimezone) ||
    fallbackTimezone
  const sleep = validTimezone(stored?.sleepSourceTimezone) ? stored.sleepSourceTimezone : summary
  const summaryBasis: HealthTimezoneBasis = validTimezone(activityZone)
    ? 'ACTIVITY_INFERRED'
    : validTimezone(stored?.sourceTimezone)
      ? storedBasis(stored?.sourceTimezoneBasis)
      : fallbackBasis
  const sleepBasis: HealthTimezoneBasis = validTimezone(stored?.sleepSourceTimezone)
    ? storedBasis(stored?.sleepTimezoneBasis)
    : summaryBasis
  return { summary, sleep, summaryBasis, sleepBasis }
}

export async function getGarminHealthSyncState(
  owner: OwnerContext,
  observedAt: Date = new Date(),
): Promise<GarminSyncState> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: {
      id: true,
      status: true,
      externalAccountId: true,
      credential: { select: { connectionId: true, rotatedAt: true } },
    },
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
      sleepRetryDates: [],
      sleepFailedDates: [],
    }
  const importAllowed = isGarminImportAllowed()
  if (!connection.externalAccountId)
    return {
      status: importAllowed ? 'ACTION_REQUIRED' : 'UNAVAILABLE',
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextAttemptAt: null,
      window: null,
      nextDate: null,
      processed: 0,
      errorCode: !importAllowed
        ? null
        : connection.status === 'CONNECTED'
          ? 'ACCOUNT_VERIFICATION_REQUIRED'
          : 'INVALID_KEY',
      sleepRetryDates: [],
      sleepFailedDates: [],
      recentRuns: await recentGarminHealthRuns(prisma, userId, connection.id),
    }
  const [cursor, run, recentRuns, providerPauseUntil] = await Promise.all([
    prisma.syncCursor.findUnique({
      where: { connectionId_dataType: { connectionId: connection.id, dataType: 'HEALTH' } },
    }),
    prisma.syncRun.findFirst({
      where: { userId, connectionId: connection.id, jobType: 'GARMIN_HEALTH' },
      orderBy: { startedAt: 'desc' },
    }),
    recentGarminHealthRuns(prisma, userId, connection.id),
    getGarminProviderPauseUntil(owner),
  ])
  const parsed = checkpointSchema.safeParse(cursor?.cursorOrCheckpoint)
  const checkpoint = parsed.success ? parsed.data : null
  const currentRun = cursor && run && run.startedAt >= connection.credential.rotatedAt ? run : null
  const sleepRetryDates = [...(checkpoint?.sleepRetryDates ?? [])]
  const sleepFailedDates = [...(checkpoint?.sleepFailedDates ?? [])]
  // Older RUN-25 runs stored only UNAVAILABLE. A summary saved during that
  // failed attempt identifies the uncompleted sleep read without guessing a value.
  if (
    currentRun?.status === 'FAILED' &&
    currentRun.errorCode === 'UNAVAILABLE' &&
    checkpoint?.nextDate &&
    connection.externalAccountId
  ) {
    const row = await prisma.dailyHealthMetric.findUnique({
      where: {
        userId_sourceProvider_localDate_garminAccountId: {
          userId,
          sourceProvider: 'GARMIN',
          localDate: new Date(`${checkpoint.nextDate}T00:00:00.000Z`),
          garminAccountId: connection.externalAccountId,
        },
      },
      select: { summaryFetchedAt: true, sleepFetchedAt: true },
    })
    if (
      row?.summaryFetchedAt &&
      row.summaryFetchedAt >= currentRun.startedAt &&
      !row.sleepFetchedAt
    ) {
      if (!sleepRetryDates.includes(checkpoint.nextDate)) sleepRetryDates.push(checkpoint.nextDate)
      if (!sleepFailedDates.includes(checkpoint.nextDate))
        sleepFailedDates.push(checkpoint.nextDate)
    }
  }
  const status: GarminSyncState['status'] = !importAllowed
    ? 'UNAVAILABLE'
    : connection.status === 'ERROR' ||
        connection.status === 'EXPIRED' ||
        currentRun?.errorCode === 'NOT_CONNECTED' ||
        currentRun?.errorCode === 'ACCOUNT_MISMATCH' ||
        currentRun?.errorCode === 'ACCOUNT_UNVERIFIABLE'
      ? 'ACTION_REQUIRED'
      : providerPauseUntil && providerPauseUntil > observedAt
        ? 'PAUSED'
        : cursor?.leaseExpiresAt && cursor.leaseExpiresAt > observedAt
          ? 'SYNCING'
          : cursor?.nextAttemptAt && cursor.nextAttemptAt > observedAt
            ? 'PAUSED'
            : currentRun?.status === 'FAILED'
              ? currentRun.recordsWritten > 0
                ? 'PARTIAL_FAILURE'
                : 'ERROR'
              : cursor && !checkpoint
                ? 'ERROR'
                : checkpoint?.nextDate || sleepRetryDates.length > 0
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
    errorCode: safeSyncErrorCode(currentRun?.errorCode),
    sleepRetryDates,
    sleepFailedDates,
    recentRuns,
  }
}

type Dependencies = {
  now?: () => Date
  importDay?: typeof importGarminHealthDate
  zoneForDay?: typeof healthZoneForDay
}

/** A leased request processes a bounded chunk. Another request resumes the saved day. */
export async function runGarminHealthSync(
  owner: OwnerContext,
  browserTimezone: string,
  dependencies: Dependencies = {},
): Promise<GarminSyncState> {
  const userId = ownerId(owner)
  if (!isGarminImportAllowed()) throw new GarminHealthSyncUnavailableError('APPROVAL_REQUIRED')
  const now = dependencies.now ?? (() => new Date())
  const started = now()
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: {
      id: true,
      status: true,
      externalAccountId: true,
      credential: { select: { connectionId: true } },
    },
  })
  if (
    !connection?.credential ||
    !connection.externalAccountId ||
    connection.status === 'ERROR' ||
    connection.status === 'EXPIRED'
  )
    throw new GarminHealthSyncUnavailableError('NOT_CONNECTED')
  const pauseUntil = await getGarminProviderPauseUntil(owner)
  if (pauseUntil && pauseUntil > started) throw new GarminHealthSyncUnavailableError('PAUSED')
  const profile = await prisma.athleteProfile.findUnique({
    where: { userId },
    select: { preferredTimezone: true },
  })
  const fallbackTimezone = validTimezone(profile?.preferredTimezone)
    ? profile.preferredTimezone
    : browserTimezone
  if (!validTimezone(fallbackTimezone)) throw new GarminHealthImportError('INVALID_DATE')
  const cursorKey = { connectionId: connection.id, dataType: 'HEALTH' }
  const importCursors = await prisma.syncCursor.findMany({
    where: {
      userId,
      connectionId: connection.id,
      dataType: { in: ['GARMIN_IMPORT_DAILY_SUMMARY', 'GARMIN_IMPORT_SLEEP'] },
    },
    select: { cursorOrCheckpoint: true },
  })
  const initialCoverageEnds = importCursors.flatMap((cursor) => {
    const value = cursor.cursorOrCheckpoint
    return value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'endDate' in value &&
      typeof value.endDate === 'string' &&
      z.iso.date().safeParse(value.endDate).success
      ? [value.endDate]
      : []
  })
  const today = localDay(started, fallbackTimezone)
  const initial = healthWindow(today, initialCoverageEnds.length === 2, fallbackTimezone)
  if (initialCoverageEnds.length === 2) {
    const firstMissing = addDays(initialCoverageEnds.sort()[0], 1)
    const overlap = addDays(today, -6)
    const oldest = earliestGarminHistoryDate(today)
    initial.windowStart =
      firstMissing < overlap ? (firstMissing < oldest ? oldest : firstMissing) : overlap
    initial.nextDate = initial.windowStart
  }
  await prisma.syncCursor.upsert({
    where: { connectionId_dataType: cursorKey },
    create: {
      userId,
      ...cursorKey,
      cursorOrCheckpoint: initial,
    },
    update: {},
  })
  const completedCursor = await prisma.syncCursor.findUnique({
    where: { connectionId_dataType: cursorKey },
    select: { cursorOrCheckpoint: true, lastSyncedAt: true },
  })
  const completedCheckpoint = checkpointSchema.safeParse(completedCursor?.cursorOrCheckpoint)
  if (
    completedCheckpoint.success &&
    completedCheckpoint.data.nextDate === null &&
    completedCheckpoint.data.sleepRetryDates.length === 0 &&
    completedCheckpoint.data.windowEnd === localDay(started, fallbackTimezone) &&
    completedCursor?.lastSyncedAt &&
    started.getTime() - completedCursor.lastSyncedAt.getTime() < COMPLETED_COOLDOWN_MS
  )
    return getGarminHealthSyncState(owner, now())
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
    const state = await getGarminHealthSyncState(owner, now())
    throw new GarminHealthSyncUnavailableError(state.status === 'PAUSED' ? 'PAUSED' : 'BUSY')
  }
  let run: { id: string } | null = null
  let providerLeaseToken: string | null = null
  let processed = 0
  const session: GarminHealthSession = {}
  try {
    providerLeaseToken = await claimGarminProviderLease(owner, connection.id, started)
    if (!providerLeaseToken) throw new GarminHealthSyncUnavailableError('BUSY')
    await prisma.syncRun.updateMany({
      where: {
        userId,
        connectionId: connection.id,
        jobType: 'GARMIN_HEALTH',
        status: 'RUNNING',
        startedAt: { lt: new Date(started.getTime() - LEASE_MS) },
      },
      data: { status: 'FAILED', finishedAt: started, errorCode: 'INTERRUPTED' },
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
            jobType: 'GARMIN_HEALTH',
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
      throw new GarminHealthImportError('UNAVAILABLE')
    }
    const today = localDay(started, fallbackTimezone)
    let checkpoint = eligibleHealthCheckpoint(parsed.data, today, fallbackTimezone)
    if (checkpoint.nextDate === null && checkpoint.sleepRetryDates.length === 0) {
      checkpoint = nextHealthWindow(checkpoint, today, fallbackTimezone)
    }
    if (checkpoint !== parsed.data) {
      const saved = await prisma.syncCursor.updateMany({
        where: { userId, ...cursorKey, leaseToken: token, leaseExpiresAt: { gt: now() } },
        data: { cursorOrCheckpoint: checkpoint as Prisma.InputJsonValue },
      })
      if (saved.count !== 1) throw new GarminHealthImportError('UNAVAILABLE')
    }
    const previousRun = await prisma.syncRun.findFirst({
      where: { userId, connectionId: connection.id, jobType: 'GARMIN_HEALTH' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, status: true },
    })
    run = await prisma.syncRun.create({
      data: { userId, connectionId: connection.id, jobType: 'GARMIN_HEALTH', status: 'RUNNING' },
    })
    let sleepFailure: GarminHealthImportErrorCode | null = null
    const sleepIssues = new Map<string, GarminHealthImportErrorCode>()
    let sleepCircuitOpen = false
    const attemptedSleepRetries = new Set<string>()
    let retryAttempts = 0
    for (let i = 0; i < MAX_DAYS_PER_REQUEST; i++) {
      if (now().getTime() - started.getTime() >= RUN_BUDGET_MS) break
      const retryDate =
        !sleepCircuitOpen && (checkpoint.nextDate === null || retryAttempts < 2)
          ? checkpoint.sleepRetryDates.find((date) => !attemptedSleepRetries.has(date))
          : undefined
      const retrySleep = retryDate !== undefined
      const date = retryDate ?? checkpoint.nextDate
      if (!date) break
      if (retrySleep) retryAttempts++
      const zones = await (dependencies.zoneForDay ?? healthZoneForDay)(
        owner,
        date,
        checkpoint.fallbackTimezone,
        validTimezone(profile?.preferredTimezone) ? 'PROFILE_INFERRED' : 'BROWSER_INFERRED',
      )
      let batchEndDate: string | undefined
      if (!retrySleep && !session.batch) {
        const lastAvailable = addDays(date, MAX_DAYS_PER_REQUEST - i - 1)
        batchEndDate = lastAvailable < checkpoint.windowEnd ? lastAvailable : checkpoint.windowEnd
      }
      const result = await (dependencies.importDay ?? importGarminHealthDate)(
        owner,
        date,
        zones.summary,
        {
          sleepTimezone: zones.sleep,
          selectionTimezone: checkpoint.fallbackTimezone,
          earliestAllowedDate: checkpoint.windowStart,
          now: now(),
          requestTimeoutMs: 10_000,
          session,
          skipFetchedSince: previousRun?.status === 'FAILED' ? previousRun.startedAt : undefined,
          summaryTimezoneBasis: zones.summaryBasis,
          sleepTimezoneBasis: zones.sleepBasis,
          sources: retrySleep ? 'SLEEP_ONLY' : sleepCircuitOpen ? 'SUMMARY_ONLY' : 'BOTH',
          batchEndDate,
        },
      )
      if (result.status === 'PARTIAL') {
        if (!result.errorCode.startsWith('SLEEP_'))
          throw new GarminHealthImportError(result.errorCode)
        sleepIssues.set(date, result.errorCode)
        attemptedSleepRetries.add(date)
        if (
          result.errorCode !== 'SLEEP_INVALID_RESPONSE' &&
          result.errorCode !== 'SLEEP_DATE_MISMATCH'
        ) {
          sleepFailure = result.errorCode
          sleepCircuitOpen = true
        }
      } else if (result.status === 'SUCCEEDED') {
        sleepIssues.delete(date)
      }
      checkpoint = advanceHealthCheckpoint(checkpoint, date, result.status, retrySleep)
      if (!retrySleep || result.status === 'SUCCEEDED') processed++
      const complete = checkpoint.nextDate === null && checkpoint.sleepRetryDates.length === 0
      const committed = await prisma.syncCursor.updateMany({
        where: { userId, ...cursorKey, leaseToken: token, leaseExpiresAt: { gt: now() } },
        data: {
          cursorOrCheckpoint: checkpoint as Prisma.InputJsonValue,
          lastSyncedAt: complete ? now() : undefined,
          nextAttemptAt: null,
          consecutiveFailures: sleepFailure ? undefined : 0,
        },
      })
      if (committed.count !== 1) throw new GarminHealthImportError('UNAVAILABLE')
    }
    if (sleepFailure) throw new GarminHealthImportError(sleepFailure)
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: now(),
        recordsSeen: processed,
        recordsWritten: processed,
        errorCode:
          [...sleepIssues].find(([date]) => checkpoint.sleepFailedDates.includes(date))?.[1] ??
          null,
        checkpointSummary: {
          windowStart: checkpoint.windowStart,
          windowEnd: checkpoint.windowEnd,
          complete: checkpoint.nextDate === null && checkpoint.sleepRetryDates.length === 0,
          recoveredApiErrorCodes: session.recoveredApiErrorCodes?.slice(0, 3) ?? [],
        },
      },
    })
  } catch (error) {
    if (!run) throw error
    const code = error instanceof GarminHealthImportError ? error.code : 'UNAVAILABLE'
    const current = await prisma.syncCursor.findUniqueOrThrow({
      where: { connectionId_dataType: cursorKey },
    })
    const failures = current.consecutiveFailures + 1
    const retryAt =
      code === 'NOT_CONNECTED' || code === 'ACCOUNT_MISMATCH' || code === 'ACCOUNT_UNVERIFIABLE'
        ? null
        : new Date(now().getTime() + Math.min(3_600_000, 60_000 * 2 ** Math.min(failures - 1, 6)))
    await prisma.syncCursor.updateMany({
      where: { userId, ...cursorKey, leaseToken: token },
      data: { nextAttemptAt: retryAt, consecutiveFailures: failures },
    })
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: now(),
        recordsSeen: processed,
        recordsWritten: processed,
        errorCode: code,
        errorSafeMessage: code,
        checkpointSummary: session.recoveredApiErrorCodes?.length
          ? { recoveredApiErrorCodes: session.recoveredApiErrorCodes.slice(0, 3) }
          : undefined,
      },
    })
  } finally {
    if (providerLeaseToken)
      await releaseGarminProviderLease(owner, connection.id, providerLeaseToken)
    await prisma.syncCursor.updateMany({
      where: { userId, ...cursorKey, leaseToken: token },
      data: { leaseToken: null, leaseExpiresAt: null },
    })
  }
  return getGarminHealthSyncState(owner, now())
}
