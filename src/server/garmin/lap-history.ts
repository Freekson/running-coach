import 'server-only'

import { randomUUID } from 'node:crypto'
import type { Activity, Prisma, SyncCursor } from '@prisma/client'
import type { GarminLapImportState } from '@/lib/garmin-import-state'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { replaceGarminActivityLaps, InvalidActivityImportError } from '@/server/activity/import'
import { getPrismaClient } from '@/server/db/client'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'
import { assertProviderApiKeySnapshotCurrent } from '@/server/provider/vault'
import {
  ACTIVITY_HISTORY_CURSOR,
  ACTIVITY_RECENT_CURSOR,
  activityHistoryCheckpointSchema,
} from './activity-history'
import { GarminImportError, openGarminActivitySession } from './activity-import'
import { GarminDataImportError } from './data-import-error'
import { allowGarminImport, getGarminImportBlock } from './import-rate-limit'
import { normalizeFitLaps } from './normalization'
import { requestFit } from './personal-api-poc'
import { claimGarminProviderLease, releaseGarminProviderLease } from './provider-lease'
import { processGarminStreamWork } from './stream-coordinator'

export const ACTIVITY_LAPS_CURSOR = 'GARMIN_IMPORT_ACTIVITY_LAPS'
const LEASE_MS = 100_000
const BUDGET_MS = 22_000
type Checkpoint = {
  version: 1
  startDate: string
  endDate: string
  timezone: string
  generation: number
}
type Cursor = Pick<SyncCursor, 'leaseExpiresAt' | 'nextAttemptAt' | 'lastSyncedAt'>
export type ActivityLapDependencies = {
  now?: () => Date
  openLapSession?: typeof openGarminActivitySession
  downloadFit?: typeof requestFit
  maxActivitiesPerRun?: number
}

async function historyScope(owner: OwnerContext, connectionId: string, accountId: string) {
  const prisma = await getPrismaClient()
  const cursors = await prisma.syncCursor.findMany({
    where: {
      userId: ownerId(owner),
      connectionId,
      dataType: { in: [ACTIVITY_HISTORY_CURSOR, ACTIVITY_RECENT_CURSOR] },
    },
  })
  const history = activityHistoryCheckpointSchema.safeParse(
    cursors.find((row) => row.dataType === ACTIVITY_HISTORY_CURSOR)?.cursorOrCheckpoint,
  )
  if (!history.success) throw new GarminDataImportError('NOT_READY')
  const recent = activityHistoryCheckpointSchema.safeParse(
    cursors.find((row) => row.dataType === ACTIVITY_RECENT_CURSOR)?.cursorOrCheckpoint,
  )
  const cp: Checkpoint = {
    version: 1,
    startDate: history.data.startDate,
    endDate:
      recent.success && recent.data.endDate > history.data.endDate
        ? recent.data.endDate
        : history.data.endDate,
    timezone: history.data.timezone,
    generation: history.data.generation,
  }
  // PostgreSQL resolves athlete-local boundaries, including DST, before any work is selected.
  const [bounds] = await prisma.$queryRaw<{ start: Date; end: Date }[]>`
    SELECT ${cp.startDate}::date::timestamp AT TIME ZONE ${cp.timezone} AS "start",
      (${cp.endDate}::date + 1)::timestamp AT TIME ZONE ${cp.timezone} AS "end"
  `
  const where: Prisma.ActivityWhereInput = {
    userId: ownerId(owner),
    sourceProvider: 'GARMIN',
    garminAccountId: accountId,
    externalActivityId: { not: null },
    startedAt: { gte: bounds.start, lt: bounds.end },
  }
  return {
    cp,
    where,
    // Recent sync can be paused independently; imported history is sufficient for FIT work.
    ready: history.data.nextDate === null,
  }
}

/** Read-only progress: GET never seeds work or contacts the provider. */
export async function getActivityLapState(
  owner: OwnerContext,
  connectionId: string,
  accountId: string,
  cursor: Cursor | undefined,
  ready: boolean,
  pause: Date | null,
  errorCode: string | null,
  now: Date,
): Promise<GarminLapImportState> {
  const prisma = await getPrismaClient()
  const { where } = await historyScope(owner, connectionId, accountId)
  const [groups, retryable, totalLaps] = await Promise.all([
    prisma.activity.groupBy({
      by: ['fitImportState'],
      where,
      _count: true,
      _max: { fitCheckedAt: true },
      _min: { fitNextAttemptAt: true },
    }),
    prisma.activity.count({
      where: {
        ...where,
        fitImportState: 'FAILED',
        OR: [{ fitNextAttemptAt: null }, { fitNextAttemptAt: { lte: now } }],
      },
    }),
    prisma.activityLap.count({ where: { userId: ownerId(owner), activity: where } }),
  ])
  const count = (state: string) =>
    groups.find((group) => group.fitImportState === state)?._count ?? 0
  const complete = count('COMPLETE')
  const failed = count('FAILED')
  const unavailable = count('UNAVAILABLE')
  const pending = count('PENDING') + count('RUNNING')
  const eligible = complete + failed + unavailable + pending
  const retry = [
    cursor?.nextAttemptAt,
    pause,
    ...(pending || retryable > 0
      ? []
      : groups
          .filter((group) => group.fitImportState === 'FAILED')
          .map((group) => group._min.fitNextAttemptAt)),
  ]
    .filter((date): date is Date => Boolean(date && date > now))
    .sort((a, b) => b.getTime() - a.getTime())[0]
  const lastSync = [cursor?.lastSyncedAt, ...groups.map((group) => group._max.fitCheckedAt)]
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => b.getTime() - a.getTime())[0]
  const settled = pending === 0 && failed === 0
  return {
    status: !ready
      ? 'paused'
      : cursor?.leaseExpiresAt && cursor.leaseExpiresAt > now
        ? 'running'
        : settled && (cursor || eligible > 0)
          ? unavailable
            ? 'completed_with_warnings'
            : 'completed'
          : retry
            ? 'waiting_retry'
            : cursor
              ? 'paused'
              : 'not_started',
    eligible,
    processed: complete + failed + unavailable,
    complete,
    failed,
    unavailable,
    pending,
    retryable,
    totalLaps,
    retryAfter: settled ? null : (retry?.toISOString() ?? null),
    lastSyncAt: lastSync?.toISOString() ?? null,
    errorCode: ready ? errorCode : (errorCode ?? 'NOT_CONNECTED'),
  }
}

function terminal(code: string) {
  return [
    'NOT_CONNECTED',
    'INVALID_KEY',
    'ACCESS_DENIED',
    'ACCOUNT_MISMATCH',
    'ACCOUNT_UNVERIFIABLE',
  ].includes(code)
}

function safeCode(error: unknown): string {
  return error instanceof GarminImportError || error instanceof GarminDataImportError
    ? error.code
    : error instanceof CredentialUnavailableError
      ? 'NOT_CONNECTED'
      : 'UNAVAILABLE'
}

/** Durable per-activity work uses the same provider lease, limiter and bounded coordinator as summaries. */
export async function runActivityLapHistory(
  owner: OwnerContext,
  options: { action: 'import' | 'resume' | 'retry' | 'reimport' | 'sync'; browserTimezone: string },
  dependencies: ActivityLapDependencies = {},
): Promise<void> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const clock = dependencies.now ?? (() => new Date())
  const now = clock()
  const deadline = now.getTime() + BUDGET_MS
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: {
      id: true,
      externalAccountId: true,
      status: true,
      credential: { select: { nonce: true } },
    },
  })
  if (!connection?.credential || !connection.externalAccountId || connection.status !== 'CONNECTED')
    throw new GarminDataImportError('NOT_CONNECTED')
  const accountId = connection.externalAccountId
  const nonce = connection.credential.nonce
  const providerToken = await claimGarminProviderLease(owner, connection.id, now)
  if (!providerToken) throw new GarminDataImportError('BUSY')
  const key = { userId, connectionId: connection.id, dataType: ACTIVITY_LAPS_CURSOR }
  const token = randomUUID()
  let runId: string | undefined
  let active: Activity | undefined
  let originalState = 'PENDING'
  let processed = 0
  let written = 0
  let backoffFailures = 0
  let pendingFailure: string | null = null
  const guard = async (tx: Prisma.TransactionClient, stream = true) => {
    await assertProviderApiKeySnapshotCurrent(tx, owner, 'GARMIN', nonce, accountId)
    const provider = await tx.syncCursor.updateMany({
      where: {
        userId,
        connectionId: connection.id,
        dataType: 'GARMIN_REQUESTS',
        leaseToken: providerToken,
        leaseExpiresAt: { gt: clock() },
      },
      data: { leaseToken: providerToken },
    })
    if (provider.count !== 1) throw new GarminDataImportError('BUSY')
    if (stream) {
      const lease = await tx.syncCursor.updateMany({
        where: { ...key, leaseToken: token, leaseExpiresAt: { gt: clock() } },
        data: { leaseToken: token },
      })
      if (lease.count !== 1) throw new GarminDataImportError('BUSY')
    }
  }
  try {
    const { cp, where, ready } = await historyScope(owner, connection.id, accountId)
    if (!ready) throw new GarminDataImportError('NOT_READY')
    const existing = await prisma.syncCursor.findFirst({ where: key })
    backoffFailures = existing?.consecutiveFailures ?? 0
    if (existing?.leaseExpiresAt && existing.leaseExpiresAt > now)
      throw new GarminDataImportError('BUSY')
    if (existing?.nextAttemptAt && existing.nextAttemptAt > now)
      throw new GarminDataImportError('RATE_LIMITED')
    if (!(await allowGarminImport(owner))) throw new GarminDataImportError('RATE_LIMITED')
    const run = await prisma.$transaction(async (tx) => {
      await guard(tx, false)
      await tx.syncCursor.upsert({
        where: {
          connectionId_dataType: { connectionId: connection.id, dataType: ACTIVITY_LAPS_CURSOR },
        },
        create: {
          ...key,
          cursorOrCheckpoint: cp,
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        },
        update: {
          cursorOrCheckpoint: cp,
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          nextAttemptAt: null,
        },
      })
      // A crashed invocation leaves at most one RUNNING row. Only the new fenced owner can reclaim it.
      await tx.activity.updateMany({
        where: { ...where, fitImportState: 'RUNNING' },
        data: { fitImportState: 'PENDING' },
      })
      await tx.syncRun.updateMany({
        where: {
          userId,
          connectionId: connection.id,
          jobType: ACTIVITY_LAPS_CURSOR,
          status: 'RUNNING',
        },
        data: { status: 'FAILED', finishedAt: clock(), errorCode: 'INTERRUPTED' },
      })
      return tx.syncRun.create({
        data: {
          userId,
          connectionId: connection.id,
          jobType: ACTIVITY_LAPS_CURSOR,
          status: 'RUNNING',
        },
      })
    })
    runId = run.id
    const jobs = await prisma.activity.findMany({
      where: {
        ...where,
        fitImportState: options.action === 'retry' ? 'FAILED' : 'PENDING',
        OR: [{ fitNextAttemptAt: null }, { fitNextAttemptAt: { lte: now } }],
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
      take: Math.min(10, Math.max(1, dependencies.maxActivitiesPerRun ?? 10)),
    })
    let session: Awaited<ReturnType<typeof openGarminActivitySession>> | undefined
    await processGarminStreamWork({
      checkpoint: cp,
      maxSteps: jobs.length,
      next: (_cp, index) => jobs[index] ?? null,
      execute: async (checkpoint, job) => {
        await prisma.$transaction(async (tx) => {
          await guard(tx)
        })
        session ??= await (dependencies.openLapSession ?? openGarminActivitySession)(owner, {
          expectedAccountId: accountId,
          deadlineAt: deadline,
          timeNow: () => clock().getTime(),
        })
        if (
          !Buffer.from(session.credential.nonce).equals(Buffer.from(nonce)) ||
          session.verifiedAccountId !== accountId
        )
          throw new GarminImportError('ACCOUNT_MISMATCH')
        originalState = job.fitImportState
        active = await prisma.$transaction(async (tx) => {
          await guard(tx)
          const claimed = await tx.activity.updateMany({
            where: {
              ...where,
              id: job.id,
              fitImportState: originalState,
              updatedAt: job.updatedAt,
            },
            data: { fitImportState: 'RUNNING', fitImportAttempts: { increment: 1 } },
          })
          if (claimed.count !== 1) throw new GarminDataImportError('BUSY')
          return tx.activity.findFirstOrThrow({ where: { ...where, id: job.id } })
        })
        await session.paced()
        const response = await (dependencies.downloadFit ?? requestFit)(
          session.fetcher,
          `/download-service/files/activity/${encodeURIComponent(active.externalActivityId!)}`,
          session.authorization,
          session.requestLimit(),
        )
        if (response.status === 404 || response.status === 204 || response.status === 'TOO_LARGE') {
          await finishUnavailable(
            response.status === 'TOO_LARGE' ? 'FIT_TOO_LARGE' : 'FIT_UNAVAILABLE',
          )
        } else {
          await session.assertStatus(response)
          if (!response.bytes) throw new Error('Missing FIT bytes')
          let laps
          try {
            laps = normalizeFitLaps(
              response.bytes,
              active.startedAt.toISOString(),
              active.distanceMeters?.toNumber() ?? null,
              active.elapsedMs === null ? null : Number(active.elapsedMs),
              {
                allowMissingDistance: true,
                allowConfirmedEmpty: true,
                deadlineAt: Date.now() + Math.max(1, Math.min(5_000, deadline - clock().getTime())),
              },
            )
          } catch {
            throw new GarminImportError('INVALID_RESPONSE')
          }
          if (laps === null) await finishUnavailable('FIT_LAPS_UNAVAILABLE')
          else {
            try {
              await prisma.$transaction(async (tx) => {
                await guard(tx)
                await replaceGarminActivityLaps(tx, owner, active!, laps, clock())
              })
            } catch (error) {
              if (error instanceof InvalidActivityImportError && laps.length === 0)
                await finishUnavailable('FIT_EMPTY_RETAINED')
              else throw error
            }
            written++
          }
        }
        active = undefined
        return { checkpoint, written: true }
      },
      recover: (checkpoint, _job, error) => {
        const code = safeCode(error)
        if (
          terminal(code) ||
          code === 'RATE_LIMITED' ||
          code === 'TOKEN_REJECTED' ||
          code === 'BUSY' ||
          !active
        )
          return null
        // Save performs the async recovery; a bad item does not prevent the next item.
        pendingFailure = code === 'UNAVAILABLE' ? 'FIT_DOWNLOAD_FAILED' : code
        return { checkpoint, written: false }
      },
      save: async () => {
        await prisma.$transaction(async (tx) => {
          await guard(tx)
          if (active && pendingFailure) {
            const saved = await tx.activity.updateMany({
              where: {
                ...where,
                id: active.id,
                fitImportState: 'RUNNING',
                updatedAt: active.updatedAt,
              },
              data: {
                fitImportState: 'FAILED',
                fitImportErrorCode: pendingFailure,
                fitNextAttemptAt: new Date(
                  clock().getTime() +
                    Math.min(3_600_000, 60_000 * 2 ** Math.min(active.fitImportAttempts - 1, 6)),
                ),
              },
            })
            if (saved.count !== 1) throw new GarminDataImportError('BUSY')
          }
          await tx.syncCursor.updateMany({
            where: { ...key, leaseToken: token },
            data: { lastSyncedAt: clock(), nextAttemptAt: null, consecutiveFailures: 0 },
          })
        })
        active = undefined
        pendingFailure = null
        backoffFailures = 0
        processed++
      },
      shouldStop: () => clock().getTime() >= deadline - 2_000,
    })
    await prisma.syncRun.updateMany({
      where: { userId, id: runId, status: 'RUNNING' },
      data: {
        status: 'SUCCEEDED',
        finishedAt: clock(),
        recordsSeen: processed,
        recordsWritten: written,
      },
    })

    async function finishUnavailable(code: string) {
      await prisma.$transaction(async (tx) => {
        await guard(tx)
        const changed = await tx.activity.updateMany({
          where: {
            ...where,
            id: active!.id,
            fitImportState: 'RUNNING',
            updatedAt: active!.updatedAt,
          },
          data: {
            fitImportState: 'UNAVAILABLE',
            fitImportErrorCode: code,
            fitNextAttemptAt: null,
            fitCheckedAt: clock(),
          },
        })
        if (changed.count !== 1) throw new GarminDataImportError('BUSY')
      })
    }
  } catch (error) {
    if (!runId) throw error
    const code = safeCode(error)
    const block = terminal(code) ? null : await getGarminImportBlock(owner)
    const retryAt = terminal(code)
      ? null
      : new Date(
          Math.max(
            clock().getTime() + Math.min(3_600_000, 60_000 * 2 ** Math.min(backoffFailures, 6)),
            block?.retryAt.getTime() ?? 0,
          ),
        )
    // Fencing prevents an expired invocation from resetting a newer worker's item/cursor.
    try {
      await prisma.$transaction(async (tx) => {
        await guard(tx)
        if (active)
          await tx.activity.updateMany({
            where: {
              userId,
              id: active.id,
              garminAccountId: accountId,
              fitImportState: 'RUNNING',
              updatedAt: active.updatedAt,
            },
            data: { fitImportState: originalState, fitNextAttemptAt: retryAt },
          })
        await tx.syncCursor.updateMany({
          where: { ...key, leaseToken: token },
          data: { nextAttemptAt: retryAt, consecutiveFailures: { increment: 1 } },
        })
      })
    } catch {
      /* Credential rotation or an expired lease leaves recovery to the next fenced invocation. */
    }
    await prisma.syncRun.updateMany({
      where: { userId, id: runId, status: 'RUNNING' },
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
      where: { ...key, leaseToken: token },
      data: { leaseToken: null, leaseExpiresAt: null },
    })
    await releaseGarminProviderLease(owner, connection.id, providerToken)
  }
}
