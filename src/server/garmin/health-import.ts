import 'server-only'

import { z } from 'zod'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getHealthSourceCoverage, saveGarminHealthObservation } from '@/server/health/history'
import type { HealthTimezoneBasis } from '@/lib/health-history'
import { CredentialUnavailableError } from '@/server/provider/credential-crypto'
import {
  apiKeySchema,
  readProviderApiKeySnapshot,
  recordProviderApiKeyAccess,
} from '@/server/provider/vault'
import {
  boundedGarminRetryAt,
  pauseGarminProviderUntil,
  reserveGarminHealthAttempt,
} from './import-rate-limit'
import { normalizeGarminDailySummary, normalizeGarminSleep } from './normalization'
import { GarminAccountIdentityError, verifyGarminBearerAccount } from './account-identity'
import { requestJson } from './personal-api-poc'
import { isGarminImportAllowed } from './sync-policy'

const dateSchema = z.iso.date()
const timezoneSchema = z
  .string()
  .min(1)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone })
      return true
    } catch {
      return false
    }
  })
const dailyResponseSchema = z.object({ data: z.array(z.unknown()).max(60) })
const emptySleepCore = [
  'calendarDate',
  'sleepTimeSeconds',
  'sleepStartTimestampGMT',
  'sleepStartTimestampLocal',
  'sleepEndTimestampGMT',
  'sleepEndTimestampLocal',
] as const
const emptySleepMeasurements = [
  'id',
  'deepSleepSeconds',
  'lightSleepSeconds',
  'remSleepSeconds',
  'awakeSleepSeconds',
  'napTimeSeconds',
  'sleepScores',
] as const

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function verifiedEmptySingleSleep(value: unknown): boolean {
  const payload = record(value)
  return Boolean(
    payload &&
    emptySleepCore.every((key) => key in payload && payload[key] === null) &&
    emptySleepMeasurements.every((key) => payload[key] == null) &&
    Object.entries(payload).every(([key, item]) => {
      if (item == null) return true
      if (key === 'deviceRemCapable' || key === 'retro') return typeof item === 'boolean'
      if (key === 'sleepNeed' || key === 'nextSleepNeed') return record(item) !== null
      return false
    }),
  )
}

function rangeRows(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  const payload = record(value)
  if (!payload) return null
  if (Array.isArray(payload.data)) return payload.data
  const arrays = Object.values(payload).filter(Array.isArray)
  return arrays.length === 1 ? arrays[0] : null
}

function rangeRecords(
  owner: OwnerContext,
  source: 'SUMMARY' | 'SLEEP',
  value: unknown,
  start: string,
  end: string,
): Map<string, unknown> {
  const result = new Map<string, unknown>()
  const rows = rangeRows(value)
  if (!rows || rows.length > 60) return result
  const grouped = new Map<string, unknown[]>()
  for (const row of rows) {
    const date = record(row)?.calendarDate
    if (!dateSchema.safeParse(date).success || typeof date !== 'string') continue
    if (date < start || date > end) continue
    grouped.set(date, [...(grouped.get(date) ?? []), row])
  }
  for (const [date, candidates] of grouped) {
    if (candidates.length !== 1) continue
    const candidate = candidates[0]
    try {
      if (source === 'SUMMARY') normalizeGarminDailySummary(owner, 'UTC', candidate)
      else {
        const sleep = normalizeGarminSleep(owner, 'UTC', candidate)
        if (sleep.sleepDurationMs === null) continue
      }
      result.set(date, candidate)
    } catch {
      // The explicitly dated single-day endpoint resolves this date later.
    }
  }
  return result
}

export type GarminHealthImportErrorCode =
  | 'INVALID_DATE'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'NOT_CONNECTED'
  | 'ACCOUNT_MISMATCH'
  | 'ACCOUNT_UNVERIFIABLE'
  | `${'SUMMARY' | 'SLEEP'}_${'TIMEOUT' | 'NETWORK' | 'INVALID_RESPONSE' | 'DATE_MISMATCH'}`
  | `${'SUMMARY' | 'SLEEP'}_HTTP_${number}`

export class GarminHealthImportError extends Error {
  constructor(readonly code: GarminHealthImportErrorCode) {
    super('Garmin health import unavailable')
  }
}

type Dependencies = {
  fetcher?: typeof fetch
  pause?: (ms: number) => Promise<void>
  now?: Date
  sleepTimezone?: string
  selectionTimezone?: string
  requestTimeoutMs?: number
  session?: GarminHealthSession
  skipFetchedSince?: Date
  summaryTimezoneBasis?: HealthTimezoneBasis
  sleepTimezoneBasis?: HealthTimezoneBasis
  sources?: 'BOTH' | 'SUMMARY_ONLY' | 'SLEEP_ONLY'
  batchEndDate?: string
}

export type GarminHealthSession = {
  ownerId?: string
  credential?: Awaited<ReturnType<typeof readProviderApiKeySnapshot>>
  bearer?: string
  verifiedAccountId?: string
  recoveredApiErrorCodes?: GarminHealthImportErrorCode[]
  batch?: {
    start: string
    end: string
    summaries: Map<string, unknown>
    sleeps: Map<string, unknown>
    summaryFetchedAt: Date
    sleepFetchedAt: Date | null
    sleepError: GarminHealthImportErrorCode | null
  }
}

function localDay(now: Date, timezone: string): string {
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

/** Explicit, bounded one-day import; no health polling or activity checkpoint is created. */
export async function importGarminHealthDate(
  owner: OwnerContext,
  date: string,
  requestedTimezone: string,
  dependencies: Dependencies = {},
) {
  const userId = ownerId(owner)
  if (!isGarminImportAllowed()) throw new GarminHealthImportError('UNAVAILABLE')
  const parsedDate = dateSchema.safeParse(date)
  const parsedZone = timezoneSchema.safeParse(requestedTimezone)
  const parsedSleepZone = timezoneSchema.safeParse(dependencies.sleepTimezone ?? requestedTimezone)
  const parsedSelectionZone = timezoneSchema.safeParse(
    dependencies.selectionTimezone ?? requestedTimezone,
  )
  const now = dependencies.now ?? new Date()
  if (
    !parsedDate.success ||
    !parsedZone.success ||
    !parsedSleepZone.success ||
    !parsedSelectionZone.success
  )
    throw new GarminHealthImportError('INVALID_DATE')
  const sourceTimezone = parsedZone.data
  const sleepTimezone = parsedSleepZone.data
  const today = localDay(now, parsedSelectionZone.data)
  // Validate against the zone that selected the bounded window. A dated
  // activity can supply a different source zone on a travel day.
  if (date > today || date < addDays(today, -29)) throw new GarminHealthImportError('INVALID_DATE')
  if (
    dependencies.batchEndDate &&
    (!dateSchema.safeParse(dependencies.batchEndDate).success ||
      dependencies.batchEndDate < date ||
      dependencies.batchEndDate > today ||
      dependencies.batchEndDate > addDays(date, 9))
  )
    throw new GarminHealthImportError('INVALID_DATE')
  const session: GarminHealthSession = dependencies.session ?? {}
  if (session.ownerId && session.ownerId !== userId)
    throw new GarminHealthImportError('UNAVAILABLE')
  session.ownerId = userId
  let credential: Awaited<ReturnType<typeof readProviderApiKeySnapshot>>
  try {
    credential = session.credential ?? (await readProviderApiKeySnapshot(owner, 'GARMIN'))
    session.credential = credential
  } catch (error) {
    if (error instanceof CredentialUnavailableError)
      throw new GarminHealthImportError('NOT_CONNECTED')
    throw error
  }
  const key = apiKeySchema.parse(credential.key)
  if (!credential.accountId) throw new GarminHealthImportError('UNAVAILABLE')
  const coverage =
    dependencies.skipFetchedSince || dependencies.sources === 'SLEEP_ONLY'
      ? await getHealthSourceCoverage(owner, date, credential.accountId)
      : null
  const alreadyFetched = (value: Date | null | undefined) =>
    Boolean(value && dependencies.skipFetchedSince && value >= dependencies.skipFetchedSince)
  const skipSummary =
    dependencies.sources === 'SLEEP_ONLY' || alreadyFetched(coverage?.summaryFetchedAt)
  const skipSleep =
    dependencies.sources === 'SUMMARY_ONLY' ||
    alreadyFetched(coverage?.sleepFetchedAt) ||
    (dependencies.sources === 'SLEEP_ONLY' && coverage?.sleepFetchedAt != null)
  if (skipSummary && skipSleep)
    return {
      status:
        dependencies.sources === 'SUMMARY_ONLY'
          ? ('SUMMARY_ONLY' as const)
          : ('SUCCEEDED' as const),
      date,
      sourceTimezone,
    }
  const attemptSequence = await reserveGarminHealthAttempt(
    owner,
    credential.nonce,
    credential.accountId,
  )
  const fetcher = dependencies.fetcher ?? fetch
  const pause =
    dependencies.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const exchangeToken = async () => {
    const token = await requestJson(
      fetcher,
      '/personalapitoken-service/personal-api/personal-api-key/token',
      `ApiKey ${key}`,
      'POST',
      'token',
      dependencies.requestTimeoutMs,
    )
    if (token.status === 429) {
      await pauseGarminProviderUntil(
        owner,
        boundedGarminRetryAt(new Date(), token.retryAfterMs),
        credential.nonce,
      )
      throw new GarminHealthImportError('RATE_LIMITED')
    }
    if (token.status === 401) {
      await recordProviderApiKeyAccess(owner, 'GARMIN', credential.nonce, 'REJECTED')
      throw new GarminHealthImportError('NOT_CONNECTED')
    }
    if (token.status !== 200 || typeof token.value !== 'string' || !token.value)
      throw new GarminHealthImportError('UNAVAILABLE')
    const bearer = `Bearer ${token.value}`
    try {
      const accountId = await verifyGarminBearerAccount(bearer, {
        fetcher,
        now,
        timeoutMs: dependencies.requestTimeoutMs,
      })
      if (accountId !== credential.accountId) throw new GarminHealthImportError('ACCOUNT_MISMATCH')
      session.verifiedAccountId = accountId
      session.bearer = bearer
    } catch (error) {
      if (error instanceof GarminHealthImportError) throw error
      if (error instanceof GarminAccountIdentityError && error.code === 'RATE_LIMITED')
        throw new GarminHealthImportError('RATE_LIMITED')
      throw new GarminHealthImportError('ACCOUNT_UNVERIFIABLE')
    }
  }
  const read = async (path: string, source: 'SUMMARY' | 'SLEEP') => {
    await pause(1_000)
    if (!session.bearer) await exchangeToken()
    let response = await requestJson(
      fetcher,
      path,
      session.bearer!,
      'GET',
      'json',
      dependencies.requestTimeoutMs,
    )
    if (response.status === 401) {
      session.bearer = undefined
      await pause(1_000)
      await exchangeToken()
      response = await requestJson(
        fetcher,
        path,
        session.bearer!,
        'GET',
        'json',
        dependencies.requestTimeoutMs,
      )
    }
    if (response.status === 429) {
      await pauseGarminProviderUntil(
        owner,
        boundedGarminRetryAt(new Date(), response.retryAfterMs),
        credential.nonce,
      )
      throw new GarminHealthImportError('RATE_LIMITED')
    }
    if (response.status === 'TIMEOUT') throw new GarminHealthImportError(`${source}_TIMEOUT`)
    if (response.status === 'NETWORK_ERROR') throw new GarminHealthImportError(`${source}_NETWORK`)
    if (response.status === 'INVALID_JSON' || response.status === 'TOO_LARGE')
      throw new GarminHealthImportError(`${source}_INVALID_RESPONSE`)
    if (response.status !== 200 && !(source === 'SLEEP' && response.status === 204))
      throw new GarminHealthImportError(`${source}_HTTP_${response.status}`)
    if (source === 'SLEEP' && response.status === 200 && response.value == null)
      throw new GarminHealthImportError('SLEEP_INVALID_RESPONSE')
    return response.value
  }
  if (
    dependencies.batchEndDate &&
    dependencies.sources !== 'SLEEP_ONLY' &&
    (!session.batch || date < session.batch.start || date > session.batch.end)
  ) {
    const end = dependencies.batchEndDate
    const summaryPayload = await read(
      `/usersummary-service/v2/dailysummaries?startDate=${date}&endDate=${end}`,
      'SUMMARY',
    )
    const summaryFetchedAt = new Date()
    const summaries = rangeRecords(owner, 'SUMMARY', summaryPayload, date, end)
    let sleeps = new Map<string, unknown>()
    let sleepFetchedAt: Date | null = null
    let sleepError: GarminHealthImportErrorCode | null = null
    if (dependencies.sources !== 'SUMMARY_ONLY') {
      try {
        const sleepPayload = await read(
          `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${date}&endDate=${end}`,
          'SLEEP',
        )
        sleepFetchedAt = new Date()
        sleeps = rangeRecords(owner, 'SLEEP', sleepPayload, date, end)
      } catch (error) {
        if (!(error instanceof GarminHealthImportError)) throw error
        // A range failure leaves every date unresolved; the single-day endpoint
        // can still resolve them. A provider pause must stop further reads.
        if (error.code === 'RATE_LIMITED') sleepError = error.code
        else if (!session.recoveredApiErrorCodes?.includes(error.code)) {
          session.recoveredApiErrorCodes = [...(session.recoveredApiErrorCodes ?? []), error.code]
        }
      }
    }
    session.batch = {
      start: date,
      end,
      summaries,
      sleeps,
      summaryFetchedAt,
      sleepFetchedAt,
      sleepError,
    }
  }
  if (!skipSummary) {
    const cached = session.batch?.summaries.get(date)
    const summaryPayload = cached
      ? { data: [cached] }
      : await read(
          `/usersummary-service/v2/dailysummaries?startDate=${date}&endDate=${date}`,
          'SUMMARY',
        )
    const summaryFetchedAt = cached ? session.batch!.summaryFetchedAt : new Date()
    if (session.verifiedAccountId !== credential.accountId)
      throw new GarminHealthImportError('UNAVAILABLE')
    const summaryResponse = dailyResponseSchema.safeParse(summaryPayload)
    if (!summaryResponse.success) throw new GarminHealthImportError('SUMMARY_INVALID_RESPONSE')
    const summaries = summaryResponse.data.data
    if (summaries.length > 1) throw new GarminHealthImportError('SUMMARY_INVALID_RESPONSE')
    let summary: ReturnType<typeof normalizeGarminDailySummary> | null = null
    try {
      summary =
        summaries.length === 0
          ? null
          : normalizeGarminDailySummary(owner, sourceTimezone, summaries[0])
    } catch {
      throw new GarminHealthImportError('SUMMARY_INVALID_RESPONSE')
    }
    if (summary && summary.localDate !== date)
      throw new GarminHealthImportError('SUMMARY_DATE_MISMATCH')
    await saveGarminHealthObservation(
      owner,
      'summary',
      date,
      sourceTimezone,
      summary,
      credential.nonce,
      credential.accountId,
      summaryFetchedAt,
      attemptSequence,
      dependencies.summaryTimezoneBasis,
    )
  }
  try {
    if (!skipSleep) {
      if (session.batch?.sleepError) throw new GarminHealthImportError(session.batch.sleepError)
      const cached = session.batch?.sleeps.get(date)
      const sleepResponse =
        cached ?? (await read(`/sleep-service/sleep/dailySleep?date=${date}`, 'SLEEP'))
      const sleepFetchedAt = cached ? session.batch!.sleepFetchedAt! : new Date()
      if (session.verifiedAccountId !== credential.accountId)
        throw new GarminHealthImportError('UNAVAILABLE')
      let sleep: ReturnType<typeof normalizeGarminSleep> | null = null
      try {
        sleep =
          sleepResponse == null || (!cached && verifiedEmptySingleSleep(sleepResponse))
            ? null
            : normalizeGarminSleep(owner, sleepTimezone, sleepResponse)
        if (sleep && sleep.sleepDurationMs === null)
          throw new GarminHealthImportError('SLEEP_INVALID_RESPONSE')
      } catch {
        throw new GarminHealthImportError('SLEEP_INVALID_RESPONSE')
      }
      if (sleep && sleep.localDate !== date)
        throw new GarminHealthImportError('SLEEP_DATE_MISMATCH')
      await saveGarminHealthObservation(
        owner,
        'sleep',
        date,
        sleepTimezone,
        sleep,
        credential.nonce,
        credential.accountId,
        sleepFetchedAt,
        attemptSequence,
        dependencies.sleepTimezoneBasis,
      )
    }
  } catch (error) {
    return {
      status: 'PARTIAL' as const,
      date,
      sourceTimezone,
      errorCode: error instanceof GarminHealthImportError ? error.code : 'UNAVAILABLE',
    }
  }
  await recordProviderApiKeyAccess(owner, 'GARMIN', credential.nonce, 'VERIFIED')
  return {
    status:
      dependencies.sources === 'SUMMARY_ONLY' ? ('SUMMARY_ONLY' as const) : ('SUCCEEDED' as const),
    date,
    sourceTimezone,
  }
}
