import 'server-only'

import { z } from 'zod'
import { importCanonicalActivity, type LapImportStatus } from '@/server/activity/import'
import type { CanonicalActivity } from '@/server/activity/normalization'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import {
  apiKeySchema,
  readProviderApiKeySnapshot,
  recordProviderApiKeyAccess,
} from '@/server/provider/vault'
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
      | 'RATE_LIMITED'
      | 'STORAGE_UNAVAILABLE',
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
}

function assertStatus(status: string | number, expected: number): void {
  if (status === expected) return
  if (status === 429) throw new GarminImportError('RATE_LIMITED')
  throw new GarminImportError(status === 401 || status === 403 ? 'ACCESS_DENIED' : 'UNAVAILABLE')
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
  ownerId(owner)
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
  const credential = await readProviderApiKeySnapshot(owner, 'GARMIN')
  const key = apiKeySchema.parse(credential.key)
  const fetcher = dependencies.fetcher ?? fetch
  const pause =
    dependencies.pause ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const tokenResponse = await requestJson(
    fetcher,
    '/personalapitoken-service/personal-api/personal-api-key/token',
    `ApiKey ${key}`,
    'POST',
    'token',
  )
  if (tokenResponse.status === 401) {
    await recordProviderApiKeyAccess(owner, 'GARMIN', credential.nonce, 'REJECTED')
    throw new GarminImportError('INVALID_KEY')
  }
  assertStatus(tokenResponse.status, 200)
  if (typeof tokenResponse.value !== 'string' || !tokenResponse.value)
    throw new GarminImportError('INVALID_RESPONSE')
  const authorization = `Bearer ${tokenResponse.value}`
  await pause(MIN_GAP_MS)
  const query = new URLSearchParams({
    start: String(start),
    limit: String(MAX_ACTIVITIES + 1),
    startDate: parsedDate,
    endDate: parsedDate,
  })
  const search = await requestJson(
    fetcher,
    `/activitylist-service/activities/search/activities?${query}`,
    authorization,
  )
  assertStatus(search.status, 200)
  const parsedSearch = searchSchema.safeParse(search.value)
  if (!parsedSearch.success) throw new GarminImportError('INVALID_RESPONSE')
  await recordProviderApiKeyAccess(owner, 'GARMIN', credential.nonce, 'VERIFIED')
  const listed = Array.isArray(parsedSearch.data) ? parsedSearch.data : parsedSearch.data.activities
  const ids = listed.slice(0, MAX_ACTIVITIES).map((record) => String(record.activityId))
  if (new Set(ids).size !== ids.length) throw new GarminImportError('INVALID_RESPONSE')
  const imported: { id: string; lapImportStatus: LapImportStatus }[] = []
  for (const id of ids) {
    await pause(MIN_GAP_MS)
    const detail = await requestJson(fetcher, `/activity-service/activity/${id}`, authorization)
    assertStatus(detail.status, 200)
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
    await pause(MIN_GAP_MS)
    const fit = await requestFit(fetcher, `/download-service/files/activity/${id}`, authorization)
    const fitRateLimited = fit.status === 429
    if (fit.status === 401 || fit.status === 403) throw new GarminImportError('ACCESS_DENIED')
    let normalized = jsonActivity
    if (fit.status === 200 && fit.bytes) {
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
      imported.push(await importCanonicalActivity(owner, normalized, { sourceObservedAt }))
    } catch {
      throw new GarminImportError('STORAGE_UNAVAILABLE')
    }
    if (fitRateLimited) throw new GarminImportError('RATE_LIMITED')
  }
  const hasMore = listed.length > MAX_ACTIVITIES
  return {
    imported,
    hasMore,
    nextStart: hasMore && start + MAX_ACTIVITIES <= 300 ? start + MAX_ACTIVITIES : null,
  }
}
