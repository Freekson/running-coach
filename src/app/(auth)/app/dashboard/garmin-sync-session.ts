import {
  incrementalResultSchema,
  incrementalSnapshotSchema,
  incrementalStreamIds,
  type IncrementalStreamId,
  type IncrementalSyncResult,
  type IncrementalSyncSnapshot,
} from '@/lib/garmin-incremental-sync'
import {
  garminRetryAtFromHeader,
  nextGarminRateLimitRetryAt,
  waitForRetry,
} from '@/lib/garmin-retry'

const endpoint = '/api/integrations/garmin/incremental-sync'
const eligible = (stream: IncrementalSyncResult) =>
  !['INITIAL_IMPORT_REQUIRED', 'NOT_CONNECTED', 'CONNECTION_ERROR'].includes(stream.reason ?? '')
const active = (state: IncrementalSyncSnapshot) =>
  state.busy || state.streams.some((stream) => stream.status === 'syncing')

export type DashboardSyncProgress = {
  activeId: IncrementalStreamId | null
  queued: IncrementalStreamId[]
  waitingUntil: string | null
}
export type DashboardSyncAttempt = { startedAt: number; result: IncrementalSyncResult }
export type DashboardSyncHistory = {
  connectionKey: string
  attempts: Partial<Record<IncrementalStreamId, DashboardSyncAttempt>>
}
class SessionRequestError extends Error {
  constructor(readonly terminal: boolean) {
    super('Garmin request unavailable')
  }
}

/** A persisted old success cannot confirm a failed attempt from the current session. */
export function preserveDashboardSyncFailures(
  snapshot: IncrementalSyncSnapshot,
  failures: Iterable<IncrementalSyncResult>,
  startedAt: number,
): IncrementalSyncSnapshot {
  if (snapshot.connection !== 'connected') return snapshot
  const failed = new Map([...failures].map((result) => [result.streamId, result]))
  if (!failed.size) return snapshot
  return {
    ...snapshot,
    streams: snapshot.streams.map((stream) => {
      const failure = failed.get(stream.streamId)
      if (!failure || !['idle', 'completed'].includes(stream.status)) return stream
      const successAt = Date.parse(stream.lastSuccessAt ?? '')
      const previousSuccessAt = failure.lastSuccessAt
        ? Date.parse(failure.lastSuccessAt)
        : -Infinity
      if (stream.status === 'completed' && successAt >= startedAt && successAt > previousSuccessAt)
        return stream
      const retryAt =
        stream.retryAt &&
        (!failure.retryAt || Date.parse(stream.retryAt) > Date.parse(failure.retryAt))
          ? stream.retryAt
          : failure.retryAt
      return { ...failure, retryAt }
    }),
  }
}

function preserveAttempts(
  snapshot: IncrementalSyncSnapshot,
  attempts: Iterable<DashboardSyncAttempt | undefined>,
): IncrementalSyncSnapshot {
  let current = snapshot
  for (const attempt of attempts) {
    if (attempt?.result.status === 'failed')
      current = preserveDashboardSyncFailures(current, [attempt.result], attempt.startedAt)
  }
  return current
}

/** Keep each stream's original recovery boundary across independent targeted retries. */
export function preserveDashboardSyncHistory(
  snapshot: IncrementalSyncSnapshot,
  history: DashboardSyncHistory | null,
): IncrementalSyncSnapshot {
  return history && snapshot.connectionKey === history.connectionKey
    ? preserveAttempts(snapshot, Object.values(history.attempts))
    : snapshot
}

/** Browser orchestration only: all provider work/checkpoints remain in RUN-76/RUN-26. */
export async function runDashboardGarminSync({
  signal,
  target,
  onState,
  onProgress,
  history = null,
  onAttempt,
}: {
  signal: AbortSignal
  target?: IncrementalStreamId
  onState: (state: IncrementalSyncSnapshot) => void
  onProgress: (progress: DashboardSyncProgress) => void
  history?: DashboardSyncHistory | null
  onAttempt?: (
    attempt: DashboardSyncAttempt,
    connectionKey: IncrementalSyncSnapshot['connectionKey'],
  ) => void
}): Promise<IncrementalSyncSnapshot> {
  const startedAt = Date.now()
  const unconfirmedFailures = new Map<IncrementalStreamId, DashboardSyncAttempt>()
  let inheritedHistory = false
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  async function read(
    queued: IncrementalStreamId[] = target ? [target] : [...incrementalStreamIds],
    expectedConnectionKey?: string | null,
  ): Promise<IncrementalSyncSnapshot> {
    let failures = 0
    let rateLimits = 0
    for (;;) {
      signal.throwIfAborted()
      try {
        const response = await fetch(endpoint, { cache: 'no-store', signal })
        if (response.status === 429) {
          const waitingUntil = nextGarminRateLimitRetryAt(
            Date.now(),
            ++rateLimits,
            garminRetryAtFromHeader(response.headers.get('Retry-After')),
          )
          onProgress({ activeId: null, queued, waitingUntil })
          await waitForRetry(waitingUntil, signal)
          continue
        }
        if (!response.ok)
          throw new SessionRequestError(response.status === 401 || response.status === 403)
        const parsed = incrementalSnapshotSchema.parse(await response.json())
        if (
          expectedConnectionKey &&
          parsed.connection === 'connected' &&
          parsed.connectionKey !== expectedConnectionKey
        )
          throw new SessionRequestError(true)
        if (!inheritedHistory) {
          if (history && parsed.connectionKey === history.connectionKey) {
            for (const attempt of Object.values(history.attempts)) {
              if (attempt?.result.status === 'failed')
                unconfirmedFailures.set(attempt.result.streamId, attempt)
            }
          }
          inheritedHistory = true
        }
        const state = preserveAttempts(parsed, unconfirmedFailures.values())
        signal.throwIfAborted()
        onState(state)
        return state
      } catch (error) {
        if (
          signal.aborted ||
          (error instanceof SessionRequestError && error.terminal) ||
          ++failures >= 3
        )
          throw error
        const waitingUntil = new Date(Date.now() + 1_000 * 2 ** (failures - 1)).toISOString()
        onProgress({ activeId: null, queued, waitingUntil })
        await waitForRetry(waitingUntil, signal)
      }
    }
  }
  let current = await read()
  const connectionKey = current.connectionKey
  const pending = new Set(
    (target ? [target] : [...incrementalStreamIds]).filter((id) =>
      eligible(current.streams.find((stream) => stream.streamId === id)!),
    ),
  )
  const initialSuccess = new Map(
    current.streams.map((stream) => [stream.streamId, stream.lastSuccessAt]),
  )
  const attempted = new Set<IncrementalStreamId>()
  const notBefore = new Map<IncrementalStreamId, number>()
  const failures = new Map<IncrementalStreamId, number>()
  const limits = new Map<IncrementalStreamId, number>()
  const stalls = new Map<IncrementalStreamId, { key: string | null | undefined; count: number }>()
  let observingBusy = Boolean(active(current))

  while (pending.size && current.connection === 'connected') {
    signal.throwIfAborted()
    for (const id of pending) {
      const stream = current.streams.find((entry) => entry.streamId === id)!
      if (
        !eligible(stream) ||
        ((attempted.has(id) || observingBusy) &&
          stream.status === 'completed' &&
          stream.lastSuccessAt &&
          Date.parse(stream.lastSuccessAt) >= startedAt &&
          stream.lastSuccessAt !== initialSuccess.get(id))
      )
        pending.delete(id)
    }
    if (!pending.size) break
    if (!active(current)) {
      for (const id of pending) {
        signal.throwIfAborted()
        const before = current.streams.find((stream) => stream.streamId === id)!
        const deadline = Math.max(notBefore.get(id) ?? 0, Date.parse(before.retryAt ?? '') || 0)
        if (deadline > Date.now()) continue
        onProgress({
          activeId: id,
          queued: [...pending].filter((entry) => entry !== id),
          waitingUntil: null,
        })
        attempted.add(id)
        let result: IncrementalSyncResult
        let transportFailure = false
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              streamId: id,
              browserTimezone,
              ...(connectionKey ? { connectionKey } : {}),
            }),
            signal,
          })
          if (response.status === 429)
            result = {
              ...before,
              status: 'rate_limited',
              reason: 'BACKOFF',
              retryAt: garminRetryAtFromHeader(response.headers.get('Retry-After')),
            }
          else {
            if (!response.ok)
              throw new SessionRequestError(response.status === 401 || response.status === 403)
            result = incrementalResultSchema.parse(await response.json())
          }
          if (result.streamId !== id) throw new Error('Unexpected stream')
        } catch (error) {
          if (signal.aborted || (error instanceof SessionRequestError && error.terminal))
            throw error
          transportFailure = true
          result = { ...before, status: 'failed', reason: 'SYNC_FAILED' }
        }
        signal.throwIfAborted()
        const attempt = { startedAt, result }
        if (result.status === 'failed') unconfirmedFailures.set(id, attempt)
        else if (result.status === 'completed') unconfirmedFailures.delete(id)
        onAttempt?.(attempt, connectionKey)
        current = {
          ...current,
          busy: result.status === 'syncing',
          streams: current.streams.map((stream) => (stream.streamId === id ? result : stream)),
        }
        onState(current)
        notBefore.delete(id)
        if (result.status === 'completed' || !eligible(result)) pending.delete(id)
        else if (result.status === 'syncing') {
          observingBusy = true
          break
        } else if (result.status === 'rate_limited') {
          const count = (limits.get(id) ?? 0) + 1
          limits.set(id, count)
          notBefore.set(
            id,
            Date.parse(nextGarminRateLimitRetryAt(Date.now(), count, result.retryAt)),
          )
        } else if (result.reason === 'REQUEST_BUDGET') {
          const previous = stalls.get(id)
          const count = previous && previous.key === result.progressKey ? previous.count + 1 : 0
          stalls.set(id, { key: result.progressKey, count })
          if (count >= 3) pending.delete(id)
          else notBefore.set(id, Date.now() + 1_000)
          limits.delete(id)
        } else if (result.status === 'failed') {
          const count = (failures.get(id) ?? 0) + 1
          failures.set(id, count)
          if (count >= 3 || (!transportFailure && !result.retryAt)) pending.delete(id)
          else
            notBefore.set(
              id,
              Math.max(
                Date.parse(result.retryAt ?? '') || 0,
                Date.now() + 1_000 * 2 ** (count - 1),
              ),
            )
        } else pending.delete(id)
      }
    } else observingBusy = true
    if (!pending.size) break
    const deadline = active(current)
      ? Date.now() + 5_000
      : Math.max(
          Date.now() + 1_000,
          Math.min(
            ...[...pending].map((id) =>
              Math.max(
                notBefore.get(id) ?? 0,
                Date.parse(
                  current.streams.find((stream) => stream.streamId === id)!.retryAt ?? '',
                ) || 0,
              ),
            ),
          ),
        )
    const waitingUntil = new Date(deadline).toISOString()
    onProgress({ activeId: null, queued: [...pending], waitingUntil })
    if (!(await waitForRetry(waitingUntil, signal))) signal.throwIfAborted()
    current = await read([...pending], connectionKey)
  }
  return current
}
