import 'server-only'

import { randomUUID } from 'node:crypto'
import type { Prisma, SyncCursor } from '@prisma/client'
import { z } from 'zod'
import { earliestGarminHistoryDate, garminHistoryWindowDays } from '@/lib/garmin-import-window'
import type { GarminImportStreamState } from '@/lib/garmin-import-state'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'
import { assertProviderApiKeySnapshotCurrent } from '@/server/provider/vault'
import { GarminImportError, importGarminActivityPage } from './activity-import'
import { GarminDataImportError } from './data-import-error'
import { localDay } from './health-sync'
import { allowGarminImport, getGarminImportBlock } from './import-rate-limit'
import { claimGarminProviderLease, releaseGarminProviderLease } from './provider-lease'
import { processGarminStreamWork } from './stream-coordinator'

export const ACTIVITY_HISTORY_CURSOR = 'GARMIN_IMPORT_ACTIVITIES'
export const ACTIVITY_RECENT_CURSOR = 'GARMIN_IMPORT_ACTIVITIES_RECENT'
const MAX_IDS = 100_000
const MAX_IMPORTED_IDS = 100_000
const idList = z.array(z.string().max(32).regex(/^\d+$/)).max(MAX_IDS)
const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone })
      return true
    } catch {
      return false
    }
  })
export const activityHistoryCheckpointSchema = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    generation: z.number().int().positive(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    timezone: timezoneSchema,
    nextDate: z.iso.date().nullable(),
    offset: z.number().int().min(0).max(MAX_IDS),
    pagesFetched: z.number().int().nonnegative(),
    activityCount: z.number().int().nonnegative(),
    importedIds: z.array(idList.element).max(MAX_IMPORTED_IDS),
    rangeIds: idList,
    passIds: idList,
    previousPassIds: idList.nullable(),
    verificationPass: z.number().int().min(0).max(4),
  })
  .refine(
    (value) =>
      garminHistoryWindowDays(value.startDate, value.endDate) !== null &&
      (value.nextDate === null ||
        (value.nextDate >= value.startDate && value.nextDate <= value.endDate)) &&
      value.activityCount === value.importedIds.length &&
      [value.importedIds, value.rangeIds, value.passIds, value.previousPassIds ?? []].every(
        (ids) => new Set(ids).size === ids.length,
      ),
  )
  .transform((checkpoint) => ({
    ...checkpoint,
    version: 2 as const,
    // Old offsets address a 30-day range, so resume the expanded remaining range at zero.
    ...(checkpoint.version === 1
      ? {
          offset: 0,
          rangeIds: [],
          passIds: [],
          previousPassIds: null,
          verificationPass: 0,
        }
      : {}),
  }))
export type ActivityHistoryCheckpoint = z.infer<typeof activityHistoryCheckpointSchema>

function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

export function activityHistoryWindow(today: string, timezone: string): ActivityHistoryCheckpoint {
  const endDate = addDays(today, -1)
  return newWindow(earliestGarminHistoryDate(endDate), endDate, timezone, 1)
}

function newWindow(
  startDate: string,
  endDate: string,
  timezone: string,
  generation: number,
): ActivityHistoryCheckpoint {
  return activityHistoryCheckpointSchema.parse({
    version: 2,
    generation,
    startDate,
    endDate,
    timezone,
    nextDate: endDate,
    offset: 0,
    pagesFetched: 0,
    activityCount: 0,
    importedIds: [],
    rangeIds: [],
    passIds: [],
    previousPassIds: null,
    verificationPass: 0,
  })
}

export function activityHistoryRange(checkpoint: ActivityHistoryCheckpoint) {
  if (!checkpoint.nextDate) return null
  return {
    start: checkpoint.startDate,
    end: checkpoint.nextDate,
  }
}

/** The remaining history needs an empty page and two consecutive matching full ID traversals.
 * This handles provider caps, overlapping pages and bounded dataset churn without trusting totals.
 */
export function advanceActivityHistory(
  checkpoint: ActivityHistoryCheckpoint,
  pageIds: string[],
  importedIds: string[],
): ActivityHistoryCheckpoint {
  const range = activityHistoryRange(checkpoint)
  if (!range) throw new GarminDataImportError('INVALID_CHECKPOINT')
  const rangeIds = [...new Set([...checkpoint.rangeIds, ...importedIds])].sort()
  const allIds = [...new Set([...checkpoint.importedIds, ...importedIds])].sort()
  const passIds = [...new Set([...checkpoint.passIds, ...pageIds])].sort()
  if (
    rangeIds.length > MAX_IDS ||
    allIds.length > MAX_IMPORTED_IDS ||
    passIds.length > MAX_IDS ||
    checkpoint.offset + pageIds.length > MAX_IDS
  )
    throw new GarminImportError('INVALID_RESPONSE')
  const next = {
    ...checkpoint,
    importedIds: allIds,
    activityCount: allIds.length,
    rangeIds,
    passIds,
    pagesFetched: checkpoint.pagesFetched + 1,
  }
  if (pageIds.length) return { ...next, offset: checkpoint.offset + pageIds.length }
  if (
    checkpoint.previousPassIds === null ||
    JSON.stringify(checkpoint.previousPassIds) !== JSON.stringify(passIds)
  ) {
    if (checkpoint.verificationPass >= 4) throw new GarminImportError('INVALID_RESPONSE')
    return {
      ...next,
      previousPassIds: passIds,
      passIds: [],
      offset: 0,
      verificationPass: checkpoint.verificationPass + 1,
    }
  }
  return {
    ...next,
    rangeIds: [],
    passIds: [],
    previousPassIds: null,
    offset: 0,
    verificationPass: 0,
    nextDate: range.start === checkpoint.startDate ? null : addDays(range.start, -1),
  }
}

export function activityHistoryState(
  cursor:
    | Pick<SyncCursor, 'cursorOrCheckpoint' | 'leaseExpiresAt' | 'nextAttemptAt' | 'lastSyncedAt'>
    | undefined,
  connectionReady: boolean,
  pause: Date | null,
  errorCode: string | null,
  now: Date,
): GarminImportStreamState {
  const empty: GarminImportStreamState = {
    streamId: 'activities',
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
    pagesFetched: 0,
    activityCount: 0,
  }
  if (!cursor) return empty
  const parsed = activityHistoryCheckpointSchema.safeParse(cursor.cursorOrCheckpoint)
  if (!parsed.success) return { ...empty, status: 'paused', errorCode: 'INVALID_CHECKPOINT' }
  const cp = parsed.data
  const totalDays = garminHistoryWindowDays(cp.startDate, cp.endDate)!
  const retry = [cursor.nextAttemptAt, pause]
    .filter((date): date is Date => Boolean(date && date > now))
    .sort((a, b) => b.getTime() - a.getTime())[0]
  const completed = cp.nextDate === null
  return {
    ...empty,
    status: !connectionReady
      ? 'paused'
      : completed
        ? 'completed'
        : cursor.leaseExpiresAt && cursor.leaseExpiresAt > now
          ? 'running'
          : retry
            ? 'waiting_retry'
            : 'paused',
    startDate: cp.startDate,
    endDate: cp.endDate,
    nextDate: cp.nextDate,
    generation: cp.generation,
    lastCheckedDate:
      cp.nextDate === cp.endDate ? null : cp.nextDate ? addDays(cp.nextDate, 1) : cp.startDate,
    totalDays,
    checkedDays: cp.nextDate
      ? totalDays - garminHistoryWindowDays(cp.startDate, cp.nextDate)!
      : totalDays,
    retryAfter: completed ? null : (retry?.toISOString() ?? null),
    lastSyncAt: cursor.lastSyncedAt?.toISOString() ?? null,
    errorCode: connectionReady ? errorCode : 'NOT_CONNECTED',
    activityCount: cp.activityCount,
    pagesFetched: cp.pagesFetched,
    currentRange: activityHistoryRange(cp),
  }
}

export type ActivityHistoryDependencies = {
  now?: () => Date
  importActivityPage?: typeof importGarminActivityPage
  maxPagesPerRun?: number
}

export async function runActivityHistory(
  owner: OwnerContext,
  options: { action: 'import' | 'resume' | 'retry' | 'reimport' | 'sync'; browserTimezone: string },
  dependencies: ActivityHistoryDependencies = {},
): Promise<void> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: {
      id: true,
      externalAccountId: true,
      status: true,
      credential: { select: { connectionId: true, nonce: true } },
    },
  })
  if (!connection?.credential || !connection.externalAccountId || connection.status !== 'CONNECTED')
    throw new GarminDataImportError('NOT_CONNECTED')
  const accountId = connection.externalAccountId
  const credentialNonce = connection.credential.nonce
  const clock = dependencies.now ?? (() => new Date())
  const now = clock()
  const providerToken = await claimGarminProviderLease(owner, connection.id, now)
  if (!providerToken) throw new GarminDataImportError('BUSY')
  const dataType = options.action === 'sync' ? ACTIVITY_RECENT_CURSOR : ACTIVITY_HISTORY_CURSOR
  const cursorKey = { userId, connectionId: connection.id, dataType }
  const token = randomUUID()
  let runId: string | null = null
  let processed = 0
  let written = 0
  try {
    const history = await prisma.syncCursor.findFirst({
      where: { userId, connectionId: connection.id, dataType: ACTIVITY_HISTORY_CURSOR },
    })
    const historyCheckpoint = activityHistoryCheckpointSchema.safeParse(history?.cursorOrCheckpoint)
    if (
      options.action === 'sync' &&
      (!historyCheckpoint.success || historyCheckpoint.data.nextDate !== null)
    )
      throw new GarminDataImportError('NOT_READY')
    const profile = await prisma.athleteProfile.findUnique({
      where: { userId },
      select: { preferredTimezone: true },
    })
    const parsedTimezone = timezoneSchema.safeParse(
      profile?.preferredTimezone ?? options.browserTimezone,
    )
    if (!parsedTimezone.success) throw new GarminDataImportError('INVALID_TIMEZONE')
    const timezone = parsedTimezone.data
    const cursor =
      dataType === ACTIVITY_HISTORY_CURSOR
        ? history
        : await prisma.syncCursor.findFirst({ where: cursorKey })
    const parsed = activityHistoryCheckpointSchema.safeParse(cursor?.cursorOrCheckpoint)
    if (cursor && !parsed.success) throw new GarminDataImportError('INVALID_CHECKPOINT')
    if (!cursor && options.action !== 'import' && options.action !== 'sync')
      throw new GarminDataImportError('NOT_STARTED')
    if (cursor?.leaseExpiresAt && cursor.leaseExpiresAt > now)
      throw new GarminDataImportError('BUSY')
    if (cursor?.nextAttemptAt && cursor.nextAttemptAt > now)
      throw new GarminDataImportError('RATE_LIMITED')
    let checkpoint = parsed.success
      ? parsed.data
      : activityHistoryWindow(localDay(now, timezone), timezone)
    if (options.action === 'reimport')
      checkpoint = {
        ...activityHistoryWindow(localDay(now, timezone), timezone),
        generation: checkpoint.generation + 1,
      }
    if (options.action === 'sync' && (!parsed.success || checkpoint.nextDate === null)) {
      const today = localDay(now, timezone)
      const previousEnd = parsed.success
        ? parsed.data.endDate
        : historyCheckpoint.success
          ? historyCheckpoint.data.endDate
          : today
      const earliest = earliestGarminHistoryDate(today)
      const overlap = addDays(previousEnd, -6)
      checkpoint = newWindow(
        overlap < earliest ? earliest : overlap,
        today,
        timezone,
        parsed.success ? parsed.data.generation + 1 : 1,
      )
    }
    if (checkpoint.nextDate === null) return
    if (!(await allowGarminImport(owner))) throw new GarminDataImportError('RATE_LIMITED')
    const run = await prisma.$transaction(async (tx) => {
      // Lock the connection before the provider lease, matching credential rotation's lock order.
      await assertProviderApiKeySnapshotCurrent(tx, owner, 'GARMIN', credentialNonce, accountId)
      const active = await tx.syncCursor.updateMany({
        where: {
          userId,
          connectionId: connection.id,
          dataType: 'GARMIN_REQUESTS',
          leaseToken: providerToken,
          leaseExpiresAt: { gt: clock() },
        },
        data: { leaseToken: providerToken },
      })
      if (active.count !== 1) throw new GarminDataImportError('BUSY')
      await tx.syncCursor.upsert({
        where: { connectionId_dataType: { connectionId: connection.id, dataType } },
        create: {
          ...cursorKey,
          cursorOrCheckpoint: checkpoint,
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + 100_000),
        },
        update: {
          cursorOrCheckpoint: checkpoint,
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + 100_000),
          nextAttemptAt: null,
        },
      })
      await tx.syncRun.updateMany({
        where: {
          userId,
          connectionId: connection.id,
          jobType: dataType,
          status: 'RUNNING',
          startedAt: { lt: new Date(now.getTime() - 100_000) },
        },
        data: { status: 'FAILED', finishedAt: clock(), errorCode: 'INTERRUPTED' },
      })
      return tx.syncRun.create({
        data: { userId, connectionId: connection.id, jobType: dataType, status: 'RUNNING' },
      })
    })
    runId = run.id
    const session = {}
    const guardLease = async (tx: Prisma.TransactionClient) => {
      const active = await tx.syncCursor.findFirst({
        where: {
          userId,
          connectionId: connection.id,
          dataType: 'GARMIN_REQUESTS',
          leaseToken: providerToken,
          leaseExpiresAt: { gt: clock() },
        },
        select: { id: true },
      })
      if (!active) throw new GarminDataImportError('BUSY')
    }
    let beforeCheckpoint: ((tx: Prisma.TransactionClient) => Promise<void>) | undefined
    await processGarminStreamWork({
      checkpoint,
      maxSteps: Math.min(3, Math.max(1, dependencies.maxPagesPerRun ?? 3)),
      next: (cp) => activityHistoryRange(cp),
      execute: async (cp, range) => {
        await guardLease(prisma)
        const page = await (dependencies.importActivityPage ?? importGarminActivityPage)(
          owner,
          {
            startDate: addDays(range.start, -2),
            endDate: addDays(range.end, 2),
            start: cp.offset,
            pageSize: 1000,
            summariesOnly: { timezone: cp.timezone, startDate: range.start, endDate: range.end },
          },
          {
            identitySession: session,
            expectedAccountId: accountId,
            beforeSummaryWrite: guardLease,
            deadlineAt: now.getTime() + 22_000,
            timeNow: () => clock().getTime(),
            observedAt: clock,
          },
        )
        if (!('pageIds' in page) || !page.pageIds || !('beforeCheckpoint' in page))
          throw new GarminImportError('INVALID_RESPONSE')
        beforeCheckpoint = page.beforeCheckpoint
        processed += page.pageIds.length
        written += page.imported.length
        return {
          checkpoint: advanceActivityHistory(cp, page.pageIds, page.providerIds),
          written: page.imported.length > 0,
        }
      },
      recover: () => null,
      save: async (step) => {
        await prisma.$transaction(async (tx) => {
          await guardLease(tx)
          await beforeCheckpoint?.(tx)
          const saved = await tx.syncCursor.updateMany({
            where: { ...cursorKey, leaseToken: token, leaseExpiresAt: { gt: clock() } },
            data: {
              cursorOrCheckpoint: step.checkpoint,
              lastSyncedAt: clock(),
              nextAttemptAt: null,
              consecutiveFailures: 0,
            },
          })
          if (saved.count !== 1) throw new GarminDataImportError('BUSY')
        })
      },
      shouldStop: () => clock().getTime() - now.getTime() >= 22_000,
    })
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
      error instanceof GarminImportError || error instanceof GarminDataImportError
        ? error.code
        : error instanceof CredentialUnavailableError
          ? 'NOT_CONNECTED'
          : 'UNAVAILABLE'
    const terminal = [
      'NOT_CONNECTED',
      'INVALID_KEY',
      'ACCESS_DENIED',
      'ACCOUNT_MISMATCH',
      'ACCOUNT_UNVERIFIABLE',
      'INVALID_CHECKPOINT',
    ].includes(code)
    const block = terminal ? null : await getGarminImportBlock(owner)
    const current = await prisma.syncCursor.findFirst({
      where: cursorKey,
      select: { consecutiveFailures: true },
    })
    const backoff = new Date(
      clock().getTime() +
        Math.min(3_600_000, 60_000 * 2 ** Math.min(current?.consecutiveFailures ?? 0, 6)),
    )
    await prisma.syncCursor.updateMany({
      where: { ...cursorKey, leaseToken: token },
      data: {
        nextAttemptAt: terminal ? null : block && block.retryAt > backoff ? block.retryAt : backoff,
        consecutiveFailures: { increment: 1 },
      },
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
    await prisma.syncCursor.updateMany({
      where: { ...cursorKey, leaseToken: token },
      data: { leaseToken: null, leaseExpiresAt: null },
    })
    await releaseGarminProviderLease(owner, connection.id, providerToken)
  }
}
