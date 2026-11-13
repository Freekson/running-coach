import 'server-only'
import type { GarminImportStreamState } from '@/lib/garmin-import-state'
import type { GarminSyncState } from '@/lib/garmin-sync-state'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { getGarminImportState, runGarminDataImport } from './data-import'
import { GarminDataImportError } from './data-import-error'
import { getGarminImportBlock } from './import-rate-limit'

const empty: GarminSyncState = {
  status: 'IDLE',
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextAttemptAt: null,
  window: null,
  nextDate: null,
  processed: 0,
  errorCode: null,
}
const terminal = new Set([
  'NOT_CONNECTED',
  'INVALID_KEY',
  'ACCESS_DENIED',
  'ACCOUNT_MISMATCH',
  'ACCOUNT_UNVERIFIABLE',
  'INVALID_CHECKPOINT',
])

/** Training tracks the recent summary/lap streams, independently of the legacy backfill cursor. */
function streamState(history: GarminImportStreamState, now: Date): GarminSyncState {
  if (history.summaryStatus !== 'completed')
    return { ...empty, status: 'ACTION_REQUIRED', errorCode: 'INITIAL_IMPORT_REQUIRED' }
  const recent = history.recentSync
  const laps = history.laps
  const summaryComplete = recent?.status === 'completed'
  const lapWork =
    summaryComplete &&
    laps &&
    (laps.pending > 0 || laps.failed > 0 || laps.status === 'running' || laps.retryable > 0)
  const active = lapWork ? laps : recent
  const retryAt =
    active &&
    'retryAfter' in active &&
    active.retryAfter &&
    Date.parse(active.retryAfter) > now.getTime()
      ? active.retryAfter
      : null
  const code = active?.errorCode ?? null
  const status: GarminSyncState['status'] =
    active?.status === 'running'
      ? 'SYNCING'
      : retryAt
        ? 'PAUSED'
        : code && terminal.has(code)
          ? 'ACTION_REQUIRED'
          : code || (lapWork && laps.failed > 0)
            ? 'PARTIAL_FAILURE'
            : !recent
              ? 'IDLE'
              : summaryComplete && !lapWork
                ? 'SUCCESS'
                : 'PARTIAL'
  return {
    ...empty,
    status,
    errorCode: code,
    nextAttemptAt: retryAt,
    lastSuccessAt: summaryComplete ? recent.lastSyncAt : history.lastSyncAt,
    window:
      recent?.startDate && recent.endDate ? { start: recent.startDate, end: recent.endDate } : null,
    nextDate: recent?.nextDate ?? null,
    processed: recent?.activityCount ?? 0,
  }
}

type TrainingSyncSnapshot = {
  state: GarminSyncState
  history: GarminImportStreamState | null
}

async function readTrainingSync(owner: OwnerContext, now: Date): Promise<TrainingSyncSnapshot> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: {
      status: true,
      externalAccountId: true,
      credential: { select: { connectionId: true } },
    },
  })
  if (!connection?.credential)
    return { state: { ...empty, status: 'NOT_CONNECTED' }, history: null }
  if (!connection.externalAccountId || connection.status !== 'CONNECTED')
    return {
      state: {
        ...empty,
        status: 'ACTION_REQUIRED',
        errorCode:
          connection.status === 'CONNECTED' ? 'ACCOUNT_VERIFICATION_REQUIRED' : 'INVALID_KEY',
      },
      history: null,
    }
  const history = (await getGarminImportState(owner, now)).find(
    (stream) => stream.streamId === 'activities',
  )
  if (!history)
    return {
      state: { ...empty, status: 'ACTION_REQUIRED', errorCode: 'INITIAL_IMPORT_REQUIRED' },
      history: null,
    }
  const state = streamState(history, now)
  if (state.status === 'ACTION_REQUIRED' || state.status === 'SYNCING') return { state, history }
  const block = await getGarminImportBlock(owner, now)
  if (block && (!state.nextAttemptAt || block.retryAt.getTime() > Date.parse(state.nextAttemptAt)))
    return {
      state: {
        ...state,
        status: 'PAUSED',
        errorCode: block.code,
        nextAttemptAt: block.retryAt.toISOString(),
      },
      history,
    }
  return { state, history }
}

export async function getTrainingSyncState(
  owner: OwnerContext,
  now = new Date(),
): Promise<GarminSyncState> {
  return (await readTrainingSync(owner, now)).state
}

function lapAction(
  history: GarminImportStreamState | null | undefined,
  now: Date,
): 'sync' | 'retry' | null {
  const laps = history?.laps
  if (
    history?.recentSync?.status !== 'completed' ||
    !laps ||
    (laps.retryAfter && Date.parse(laps.retryAfter) > now.getTime())
  )
    return null
  return laps.pending > 0 ? 'sync' : laps.retryable > 0 ? 'retry' : null
}

type Dependencies = { now?: () => Date; runImport?: typeof runGarminDataImport }
// Leave ten seconds of the route's 60-second limit for response/DB work.
const REQUEST_WORK_BUDGET_MS = 50_000
const FIT_BATCH_BUDGET_MS = 22_000

export async function runTrainingSync(
  owner: OwnerContext,
  browserTimezone: string,
  dependencies: Dependencies = {},
): Promise<GarminSyncState> {
  ownerId(owner)
  const clock = dependencies.now ?? (() => new Date())
  const started = clock().getTime()
  const { state, history } = await readTrainingSync(owner, clock())
  if (state.status === 'PAUSED') return state
  if (state.status === 'SYNCING') throw new GarminDataImportError('BUSY')
  if (state.status === 'ACTION_REQUIRED' || state.status === 'NOT_CONNECTED') return state
  const run = dependencies.runImport ?? runGarminDataImport
  const checkedAt = Date.parse(history?.recentSync?.lastSyncAt ?? '')
  // Resume a recently checked window before spending another request on the same summaries.
  // Refresh summaries after five minutes so a large FIT backlog cannot hide new workouts.
  const continuation =
    checkedAt <= started && started - checkedAt < 5 * 60_000 ? lapAction(history, clock()) : null
  let action = continuation
  if (!action) {
    const streams = await run(owner, {
      streamId: 'activities',
      stage: 'summaries',
      action: 'sync',
      browserTimezone,
    })
    if (started + REQUEST_WORK_BUDGET_MS - clock().getTime() >= FIT_BATCH_BUDGET_MS)
      action = lapAction(
        streams.find((stream) => stream.streamId === 'activities'),
        clock(),
      )
  }
  if (action) {
    try {
      await run(owner, {
        streamId: 'activities',
        stage: 'laps',
        action,
        browserTimezone,
      })
    } catch (error) {
      // New summaries are already saved; keep them visible when another bounded lap request must wait.
      if (
        !(error instanceof GarminDataImportError) ||
        !['BUSY', 'RATE_LIMITED'].includes(error.code)
      )
        throw error
    }
  }
  return getTrainingSyncState(owner, clock())
}
