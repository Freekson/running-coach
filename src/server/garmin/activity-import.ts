import 'server-only'

import { z } from 'zod'
import {
  canSkipFitDownload,
  importCanonicalActivity,
  type LapImportStatus,
} from '@/server/activity/import'
import type { CanonicalActivity } from '@/server/activity/normalization'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import {
  apiKeySchema,
  assertProviderApiKeySnapshotCurrent,
  readProviderApiKeySnapshot,
  recordProviderApiKeyAccess,
} from '@/server/provider/vault'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'
import { pauseGarminProviderUntil } from './import-rate-limit'
import {
  FitActivityIdentityError,
  FitLapUnavailableError,
  garminActivitySource,
} from './normalization'
import { requestFit, requestJson } from './personal-api-poc'

const activityIdSchema = z.union([
  z.number().int().nonnegative().safe(),
  z.string().max(32).regex(/^\d+$/),
])
const searchSchema = z.union([
  z.array(z.object({ activityId: activityIdSchema })),
  z.object({ activities: z.array(z.object({ activityId: activityIdSchema })) }),
])
const detailIdentitySchema = z.object({ activityId: activityIdSchema })
const importDateSchema = z.iso.date()
const MAX_ACTIVITIES = 3
const MIN_GAP_MS = 1_000

export class GarminImportError extends Error {
  constructor(
    readonly code:
      | 'INVALID_DATE'
      | 'UNAVAILABLE'
      | 'INVALID_RESPONSE'
      | 'IDENTITY_MISMATCH'
      | 'INVALID_KEY'
      | 'ACCESS_DENIED'
      | 'TOKEN_REJECTED'
      | 'RATE_LIMITED'
      | 'TIMEOUT'
      | 'NETWORK_ERROR'
      | 'STORAGE_UNAVAILABLE',
    readonly retryAfterMs?: number,
    readonly persistedCount = 0,
  ) {
    super('Garmin activity import could not be completed')
  }
}

type Dependencies = {
  start?: number
  fetcher?: typeof fetch
  pause?: (milliseconds: number) => Promise<void>
  now?: Date
  observedAt?: () => Date
  requestTimeoutMs?: number
  pacingMs?: number
  deadlineAt?: number
  timeNow?: () => number
}

type Window = {
  startDate: string
  endDate: string
  start: number
  pageSize?: 1 | 2 | 3
  refreshLaps?: boolean
}

function providerRetryAt(delayMs?: number): Date {
  const delay = delayMs !== undefined && Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 60_000
  return new Date(Math.min(8_640_000_000_000_000, Date.now() + delay))
}

async function assertStatus(
  owner: OwnerContext,
  nonce: Uint8Array,
  response: { status: string | number; retryAfterMs?: number },
  expected: number,
): Promise<void> {
  if (response.status === expected) return
  if (response.status === 429) {
    await pauseGarminProviderUntil(owner, providerRetryAt(response.retryAfterMs), nonce)
    throw new GarminImportError('RATE_LIMITED', response.retryAfterMs)
  }
  if (response.status === 'TIMEOUT') throw new GarminImportError('TIMEOUT')
  if (response.status === 'NETWORK_ERROR') throw new GarminImportError('NETWORK_ERROR')
  throw new GarminImportError(
    response.status === 401
      ? 'TOKEN_REJECTED'
      : response.status === 403
        ? 'ACCESS_DENIED'
        : 'UNAVAILABLE',
  )
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** One recent calendar day, at most three activities, with no pagination or durable sync state. */
export async function importGarminActivitiesForDate(
  owner: OwnerContext,
  date: string,
  dependencies: Dependencies = {},
) {
  const parsedDate = importDateSchema.parse(date)
  const start = z
    .number()
    .int()
    .min(0)
    .max(300)
    .parse(dependencies.start ?? 0)
  const now = dependencies.now ?? new Date()
  const selected = Date.parse(`${parsedDate}T00:00:00.000Z`)
  const today = Date.parse(`${isoDay(now)}T00:00:00.000Z`)
  // Garmin search dates are local calendar dates; UTC can differ by one day.
  if (selected > today + 86_400_000 || selected < today - 8 * 86_400_000)
    throw new GarminImportError('INVALID_DATE')
  return importGarminActivityPage(
    owner,
    { startDate: parsedDate, endDate: parsedDate, start, refreshLaps: true },
    dependencies,
  )
}

/** A single small search page. The caller owns the durable checkpoint and run budget. */
export async function importGarminActivityPage(
  owner: OwnerContext,
  window: Window,
  dependencies: Dependencies = {},
) {
  ownerId(owner)
  const startDate = importDateSchema.parse(window.startDate)
  const endDate = importDateSchema.parse(window.endDate)
  const start = z.number().int().min(0).max(10_000).parse(window.start)
  const maxActivities = window.pageSize ?? MAX_ACTIVITIES
  if (startDate > endDate) throw new GarminImportError('INVALID_DATE')
  const credential = await readProviderApiKeySnapshot(owner, 'GARMIN')
  const key = apiKeySchema.parse(credential.key)
  const fetcher = dependencies.fetcher ?? fetch
  const timeoutMs = z
    .number()
    .int()
    .min(3_000)
    .max(8_000)
    .parse(dependencies.requestTimeoutMs ?? 8_000)
  const pacingMs = z
    .number()
    .int()
    .min(1_000)
    .max(2_000)
    .parse(dependencies.pacingMs ?? MIN_GAP_MS)
  const pause =
    dependencies.pause ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const remainingMs = () =>
    dependencies.deadlineAt === undefined
      ? timeoutMs
      : dependencies.deadlineAt - (dependencies.timeNow?.() ?? Date.now())
  const requestLimit = () => {
    const remaining = Math.floor(Math.min(timeoutMs, remainingMs()))
    if (remaining <= 0) throw new GarminImportError('TIMEOUT')
    return remaining
  }
  const paced = async () => {
    if (dependencies.deadlineAt !== undefined && remainingMs() <= pacingMs)
      throw new GarminImportError('TIMEOUT')
    await pause(pacingMs)
  }
  const tokenResponse = await requestJson(
    fetcher,
    '/personalapitoken-service/personal-api/personal-api-key/token',
    `ApiKey ${key}`,
    'POST',
    'token',
    requestLimit(),
  )
  if (tokenResponse.status === 401) {
    await recordProviderApiKeyAccess(owner, 'GARMIN', credential.nonce, 'REJECTED')
    throw new GarminImportError('INVALID_KEY')
  }
  await assertStatus(owner, credential.nonce, tokenResponse, 200)
  if (typeof tokenResponse.value !== 'string' || !tokenResponse.value)
    throw new GarminImportError('INVALID_RESPONSE')
  const authorization = `Bearer ${tokenResponse.value}`
  await paced()
  const query = new URLSearchParams({
    start: String(start),
    limit: String(maxActivities + 1),
    startDate,
    endDate,
  })
  const search = await requestJson(
    fetcher,
    `/activitylist-service/activities/search/activities?${query}`,
    authorization,
    'GET',
    'json',
    requestLimit(),
  )
  await assertStatus(owner, credential.nonce, search, 200)
  const parsedSearch = searchSchema.safeParse(search.value)
  if (!parsedSearch.success) throw new GarminImportError('INVALID_RESPONSE')
  await recordProviderApiKeyAccess(owner, 'GARMIN', credential.nonce, 'VERIFIED')
  const listed = Array.isArray(parsedSearch.data) ? parsedSearch.data : parsedSearch.data.activities
  const ids = listed.slice(0, maxActivities).map((record) => String(record.activityId))
  if (new Set(ids).size !== ids.length) throw new GarminImportError('INVALID_RESPONSE')
  const imported: { id: string; lapImportStatus: LapImportStatus }[] = []
  // A later activity can resume at the next offset; leave enough time for its detail and FIT.
  const nextActivityBudgetMs = 2 * timeoutMs + 2 * pacingMs + 1_000
  try {
    for (const id of ids) {
      if (
        imported.length > 0 &&
        dependencies.deadlineAt !== undefined &&
        remainingMs() < nextActivityBudgetMs
      )
        break
      await paced()
      const detail = await requestJson(
        fetcher,
        `/activity-service/activity/${id}`,
        authorization,
        'GET',
        'json',
        requestLimit(),
      )
      await assertStatus(owner, credential.nonce, detail, 200)
      const sourceObservedAt = dependencies.observedAt?.() ?? new Date()
      const identity = detailIdentitySchema.safeParse(detail.value)
      if (!identity.success || String(identity.data.activityId) !== id)
        throw new GarminImportError('IDENTITY_MISMATCH')
      // Validate JSON before requesting FIT, so no malformed detail is ever persisted.
      let jsonActivity: CanonicalActivity
      try {
        jsonActivity = garminActivitySource.normalizeActivity(owner, detail.value)
      } catch {
        throw new GarminImportError('INVALID_RESPONSE')
      }
      const skipFit = await canSkipFitDownload(owner, jsonActivity, {
        refresh: window.refreshLaps === true,
        observedAt: sourceObservedAt,
      })
      const fit = skipFit
        ? { status: 204 as const }
        : await (async () => {
            await paced()
            return requestFit(
              fetcher,
              `/download-service/files/activity/${id}`,
              authorization,
              requestLimit(),
            )
          })()
      const fitRateLimited = fit.status === 429
      if (fit.status === 401) throw new GarminImportError('TOKEN_REJECTED')
      if (fit.status === 403) throw new GarminImportError('ACCESS_DENIED')
      let normalized = jsonActivity
      if (fit.status === 200) {
        if (!fit.bytes) throw new GarminImportError('INVALID_RESPONSE')
        try {
          normalized = garminActivitySource.normalizeActivity(owner, detail.value, {
            sourceFile: fit.bytes,
          })
        } catch (error) {
          if (error instanceof FitActivityIdentityError)
            throw new GarminImportError('IDENTITY_MISMATCH')
          if (error instanceof FitLapUnavailableError) normalized = jsonActivity
          else throw new GarminImportError('INVALID_RESPONSE')
        }
      }
      try {
        imported.push(
          await importCanonicalActivity(owner, normalized, {
            sourceObservedAt,
            fitCheckedAt:
              !skipFit && (fit.status === 200 || fit.status === 204 || fit.status === 404)
                ? sourceObservedAt
                : undefined,
            beforeWrite: (tx) =>
              assertProviderApiKeySnapshotCurrent(tx, owner, 'GARMIN', credential.nonce),
          }),
        )
      } catch (error) {
        if (error instanceof CredentialUnavailableError) throw new GarminImportError('UNAVAILABLE')
        throw new GarminImportError('STORAGE_UNAVAILABLE')
      }
      if (fitRateLimited) {
        await pauseGarminProviderUntil(owner, providerRetryAt(fit.retryAfterMs), credential.nonce)
        throw new GarminImportError('RATE_LIMITED', fit.retryAfterMs)
      }
      if (fit.status !== 200 && fit.status !== 204 && fit.status !== 404)
        throw new GarminImportError(
          fit.status === 'TIMEOUT' || fit.status === 408
            ? 'TIMEOUT'
            : fit.status === 'NETWORK_ERROR'
              ? 'NETWORK_ERROR'
              : fit.status === 'TOO_LARGE' ||
                  fit.status === 'INVALID_JSON' ||
                  (typeof fit.status === 'number' && fit.status >= 400 && fit.status < 500)
                ? 'INVALID_RESPONSE'
                : 'UNAVAILABLE',
        )
    }
  } catch (error) {
    if (error instanceof GarminImportError)
      throw new GarminImportError(error.code, error.retryAfterMs, imported.length)
    throw error
  }
  const hasMore = listed.length > imported.length
  return {
    imported,
    providerIds: ids.slice(0, imported.length),
    hasMore,
    nextStart: hasMore && start + imported.length <= 10_000 ? start + imported.length : null,
  }
}
