import 'server-only'

import {
  incrementalStreamIds,
  type IncrementalStreamId,
  type IncrementalSyncResult,
  type IncrementalSyncSnapshot,
} from '@/lib/garmin-incremental-sync'
import type { GarminSyncState } from '@/lib/garmin-sync-state'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { getGarminImportState, runGarminDataImport } from './data-import'
import { GarminDataImportError } from './data-import-error'
import { getGarminHealthSyncState, GarminHealthSyncUnavailableError } from './health-sync'
import { getGarminImportBlock } from './import-rate-limit'

function rateLimited(code: string | null | undefined): boolean {
  return ['RATE_LIMITED', 'APP_RATE_LIMITED', 'PROVIDER_PAUSED', 'PAUSED'].includes(code ?? '')
}

function requiresAttention(code: string | null | undefined): boolean {
  return (
    [
      'NOT_CONNECTED',
      'INVALID_KEY',
      'ACCESS_DENIED',
      'ACCOUNT_MISMATCH',
      'ACCOUNT_UNVERIFIABLE',
      'ACCOUNT_VERIFICATION_REQUIRED',
      'INVALID_CHECKPOINT',
    ].includes(code ?? '') || /^(?:SLEEP|SUMMARY)_HTTP_40[13]$/.test(code ?? '')
  )
}

function empty(streamId: IncrementalStreamId): IncrementalSyncResult {
  return { streamId, status: 'idle', reason: null, lastSuccessAt: null, retryAt: null }
}

function healthResult(
  streamId: IncrementalStreamId,
  state: GarminSyncState,
): IncrementalSyncResult {
  const result = {
    ...empty(streamId),
    lastSuccessAt: state.lastSuccessAt,
    retryAt: state.nextAttemptAt,
    progressKey: [
      state.window?.start,
      state.window?.end,
      state.nextDate,
      state.processed,
      state.sleepRetryDates?.length,
      state.sleepFailedDates?.length,
    ].join('|'),
  }
  if (state.status === 'SYNCING') return { ...result, status: 'syncing' }
  if (state.status === 'ACTION_REQUIRED' || requiresAttention(state.errorCode))
    return { ...result, status: 'failed', reason: 'CONNECTION_ERROR' }
  if (
    state.status === 'PAUSED' &&
    !state.errorCode &&
    state.lastSuccessAt &&
    state.window &&
    state.nextDate === null &&
    !state.sleepRetryDates?.length
  )
    return { ...result, status: 'completed' }
  if (state.status === 'PAUSED')
    return {
      ...result,
      status: rateLimited(state.errorCode) ? 'rate_limited' : 'failed',
      reason: 'BACKOFF',
    }
  if (
    ['ERROR', 'PARTIAL_FAILURE', 'ACTION_REQUIRED', 'UNAVAILABLE', 'NOT_CONNECTED'].includes(
      state.status,
    )
  )
    return { ...result, status: 'failed', reason: 'SYNC_FAILED' }
  if (state.status === 'SUCCESS') return { ...result, status: 'completed' }
  if (state.status === 'PARTIAL') return { ...result, status: 'skipped', reason: 'REQUEST_BUDGET' }
  return result
}

/** Reads persisted state only. Each stream retains its own checkpoint and retry state. */
export async function getGarminIncrementalSyncState(
  owner: OwnerContext,
  now = new Date(),
): Promise<IncrementalSyncSnapshot> {
  const userId = ownerId(owner)
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
  const connectionStatus = !connection?.credential
    ? 'disconnected'
    : connection.status === 'CONNECTED' && connection.externalAccountId
      ? 'connected'
      : 'error'
  if (connectionStatus !== 'connected')
    return {
      connection: connectionStatus,
      streams: incrementalStreamIds.map((id) => ({
        ...empty(id),
        status: 'skipped',
        reason: connectionStatus === 'disconnected' ? 'NOT_CONNECTED' : 'CONNECTION_ERROR',
      })),
    }
  if (!connection) throw new Error('Connection unavailable')
  const [history, daily, sleep, block, providerLease] = await Promise.all([
    getGarminImportState(owner, now),
    getGarminHealthSyncState(owner, now, 'daily_summary'),
    getGarminHealthSyncState(owner, now, 'sleep'),
    getGarminImportBlock(owner, now),
    prisma.syncCursor.findFirst({
      where: { userId, connectionId: connection.id, dataType: 'GARMIN_REQUESTS' },
      select: { leaseExpiresAt: true },
    }),
  ])
  const busy = Boolean(providerLease?.leaseExpiresAt && providerLease.leaseExpiresAt > now)
  const streams = incrementalStreamIds.map((id): IncrementalSyncResult => {
    const imported = history.find((entry) => entry.streamId === id)
    const ready =
      id === 'activities'
        ? imported?.summaryStatus === 'completed'
        : imported?.generation != null && imported.nextDate === null
    if (!ready) return { ...empty(id), status: 'skipped', reason: 'INITIAL_IMPORT_REQUIRED' }
    let result: IncrementalSyncResult
    if (id === 'activities') {
      const recent = imported?.recentSync
      result = {
        ...empty(id),
        lastSuccessAt: recent?.status === 'completed' ? recent.lastSyncAt : null,
        retryAt: recent?.retryAfter ?? null,
        progressKey: recent
          ? [
              recent.nextDate,
              recent.lastCheckedDate,
              recent.checkedDays,
              recent.pagesFetched,
              recent.activityCount,
            ].join('|')
          : null,
      }
      if (recent?.status === 'running') result = { ...result, status: 'syncing' }
      else if (requiresAttention(recent?.errorCode))
        result = { ...result, status: 'failed', reason: 'CONNECTION_ERROR' }
      else if (recent?.retryAfter && Date.parse(recent.retryAfter) > now.getTime())
        result = {
          ...result,
          status: rateLimited(recent.errorCode) ? 'rate_limited' : 'failed',
          reason: 'BACKOFF',
        }
      else if (recent?.errorCode) result = { ...result, status: 'failed', reason: 'SYNC_FAILED' }
      else if (recent?.status === 'completed') result = { ...result, status: 'completed' }
      else if (recent) result = { ...result, status: 'skipped', reason: 'REQUEST_BUDGET' }
    } else result = healthResult(id, id === 'daily_summary' ? daily : sleep)
    if (result.status === 'syncing' || result.reason === 'CONNECTION_ERROR') return result
    if (block)
      return {
        ...result,
        status: result.status === 'completed' ? 'completed' : 'rate_limited',
        reason: result.status === 'completed' ? null : 'BACKOFF',
        retryAt: block.retryAt.toISOString(),
      }
    return result
  })
  return { connection: 'connected', streams, busy, connectionKey: connection.id }
}

/** One bounded incremental stream per request; the caller sequences the three streams. */
export async function runGarminIncrementalSync(
  owner: OwnerContext,
  streamId: IncrementalStreamId,
  browserTimezone: string,
  expectedConnectionKey?: string,
): Promise<IncrementalSyncResult> {
  const snapshot = await getGarminIncrementalSyncState(owner)
  if (expectedConnectionKey && snapshot.connectionKey !== expectedConnectionKey)
    return { ...empty(streamId), status: 'skipped', reason: 'CONNECTION_ERROR' }
  const before = snapshot.streams.find((stream) => stream.streamId === streamId)!
  if (
    before.reason === 'INITIAL_IMPORT_REQUIRED' ||
    before.reason === 'NOT_CONNECTED' ||
    before.reason === 'CONNECTION_ERROR' ||
    before.status === 'syncing'
  )
    return before
  if (before.retryAt !== null && Date.parse(before.retryAt) > Date.now())
    return before.status === 'completed'
      ? { ...before, status: 'rate_limited', reason: 'BACKOFF' }
      : before
  if (snapshot.busy) return { ...before, status: 'syncing', reason: 'BUSY' }
  let failure: IncrementalSyncResult | null = null
  try {
    // Use RUN-76's registry; adapters retain all fetch, persistence and lease logic.
    await runGarminDataImport(owner, {
      streamId,
      action: 'sync',
      stage: 'summaries',
      browserTimezone,
    })
  } catch (error) {
    const code =
      error instanceof GarminDataImportError || error instanceof GarminHealthSyncUnavailableError
        ? error.code
        : null
    failure = {
      ...before,
      status:
        code === 'BUSY'
          ? 'syncing'
          : code === 'PAUSED' || code === 'RATE_LIMITED'
            ? 'rate_limited'
            : code === 'NOT_READY'
              ? 'skipped'
              : 'failed',
      reason:
        code === 'BUSY'
          ? 'BUSY'
          : code === 'PAUSED' || code === 'RATE_LIMITED'
            ? 'BACKOFF'
            : code === 'NOT_READY'
              ? 'INITIAL_IMPORT_REQUIRED'
              : 'SYNC_FAILED',
    }
  }
  const after = (await getGarminIncrementalSyncState(owner)).streams.find(
    (stream) => stream.streamId === streamId,
  )!
  return failure ? { ...failure, retryAt: after.retryAt } : after
}
