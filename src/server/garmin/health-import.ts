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
import { projectGarminHealth } from './provider-projection'

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
const dailyRowsSchema = z.array(z.unknown()).max(365)
const dailyResponseSchema = z
  .union([z.object({ data: dailyRowsSchema }), dailyRowsSchema])
  .transform((value) => (Array.isArray(value) ? value : value.data))
// The verified 365-day response exceeded the shared 512 KiB JSON probe limit.
const dailySummaryMaxJsonBytes = 4 * 1024 * 1024
const summaryFallbackDays = 30
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

// Garmin omits the top-level date when a day contains naps but no night sleep.
// Range responses include dates on each nap, which are sufficient only when
// every nap belongs to the same day and no night-sleep data is present.
function datedNapOnlySleep(value: unknown): string | null {
  const payload = record(value)
  if (!payload || !emptySleepCore.every((key) => key in payload && payload[key] === null))
    return null
  if (emptySleepMeasurements.some((key) => key !== 'napTimeSeconds' && payload[key] != null))
    return null
  const total = payload.napTimeSeconds
  const naps = payload.dailyNapDTOS
  if (
    typeof total !== 'number' ||
    !Number.isFinite(total) ||
    total <= 0 ||
    total > 86_400 ||
    !Array.isArray(naps) ||
    naps.length === 0 ||
    naps.length > 20
  )
    return null
  const firstDate = record(naps[0])?.calendarDate
  if (typeof firstDate !== 'string' || !dateSchema.safeParse(firstDate).success) return null
  if (
    !naps.every((nap) => record(nap)?.calendarDate === firstDate) ||
    !Object.entries(payload).every(([key, item]) => {
      if (item == null) return true
      if (key === 'napTimeSeconds' || key === 'dailyNapDTOS') return true
      if (key === 'deviceRemCapable' || key === 'retro') return typeof item === 'boolean'
      if (key === 'sleepNeed' || key === 'nextSleepNeed') return record(item) !== null
      return false
    })
  )
    return null
  return firstDate
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
  if (!rows || rows.length > 365) return result
  if (rows.length === 0) {
    // An entirely empty, successful range is explicit checked-empty coverage.
    // Missing dates in a partially populated range remain unresolved.
    for (let day = start; day <= end; day = addDays(day, 1)) result.set(day, null)
    return result
  }
  const grouped = new Map<string, unknown[]>()
  for (const row of rows) {
    const topLevelDate = record(row)?.calendarDate
    const date =
      typeof topLevelDate === 'string' && dateSchema.safeParse(topLevelDate).success
        ? topLevelDate
        : source === 'SLEEP'
          ? datedNapOnlySleep(row)
          : null
    if (!date) continue
    if (date < start || date > end) continue
    grouped.set(date, [...(grouped.get(date) ?? []), row])
  }
  for (const [date, candidates] of grouped) {
    if (candidates.length !== 1) continue
    const candidate = candidates[0]
    try {
      if (source === 'SUMMARY') normalizeGarminDailySummary(owner, 'UTC', candidate)
      else if (datedNapOnlySleep(candidate) !== date) {
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
  | 'SUMMARY_INVALID_JSON'
  | `${'SUMMARY' | 'SLEEP'}_TOO_LARGE`
  | `${'SUMMARY' | 'SLEEP'}_HTTP_${number}`

export type GarminSummaryDiagnosticCode =
  | 'SUMMARY_EMPTY_BODY'
  | 'SUMMARY_NULL_DATA'
  | 'SUMMARY_INVALID_ENVELOPE'
  | 'SUMMARY_MULTIPLE_RECORDS'
  | 'SUMMARY_INVALID_RECORD'
  | 'SUMMARY_DATE_MISMATCH'

export class GarminHealthImportError extends Error {
  constructor(
    readonly code: GarminHealthImportErrorCode,
    readonly diagnosticCode: GarminSummaryDiagnosticCode | null = null,
  ) {
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
  batchStartDate?: string
  earliestAllowedDate?: string
  recheckFetchedSleep?: boolean
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
  summaryFallback?: {
    start: string
    end: string
    summaries: Map<string, unknown>
    fetchedAt: Date
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
  const earliestAllowedDate = dependencies.earliestAllowedDate ?? addDays(today, -29)
  if (date > today || date < earliestAllowedDate) throw new GarminHealthImportError('INVALID_DATE')
  const batchStart = dependencies.batchStartDate ?? date
  const batchEnd = dependencies.batchEndDate ?? date
  const batchLimit = dependencies.sources === 'SUMMARY_ONLY' ? 365 : 30
  if (
    (dependencies.batchStartDate || dependencies.batchEndDate) &&
    (!dateSchema.safeParse(batchStart).success ||
      !dateSchema.safeParse(batchEnd).success ||
      batchStart > date ||
      batchEnd < date ||
      batchStart < earliestAllowedDate ||
      batchEnd > today ||
      batchEnd > addDays(batchStart, batchLimit - 1))
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
    (dependencies.sources === 'SLEEP_ONLY' &&
      !dependencies.recheckFetchedSleep &&
      coverage?.sleepFetchedAt != null)
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
      source === 'SUMMARY' ? dailySummaryMaxJsonBytes : undefined,
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
        source === 'SUMMARY' ? dailySummaryMaxJsonBytes : undefined,
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
    if (response.status === 'TOO_LARGE') throw new GarminHealthImportError(`${source}_TOO_LARGE`)
    if (response.status === 'INVALID_JSON')
      throw new GarminHealthImportError(
        source === 'SUMMARY' ? 'SUMMARY_INVALID_JSON' : 'SLEEP_INVALID_RESPONSE',
      )
    if (response.status !== 200 && !(source === 'SLEEP' && response.status === 204))
      throw new GarminHealthImportError(`${source}_HTTP_${response.status}`)
    if (source === 'SLEEP' && response.status === 200 && response.value == null)
      throw new GarminHealthImportError('SLEEP_INVALID_RESPONSE')
    return response.value
  }
  if (
    (dependencies.batchEndDate || dependencies.batchStartDate) &&
    (!session.batch || date < session.batch.start || date > session.batch.end)
  ) {
    const start = batchStart
    const end = batchEnd
    const summaryPayload =
      dependencies.sources === 'SLEEP_ONLY'
        ? null
        : await read(
            `/usersummary-service/v2/dailysummaries?startDate=${start}&endDate=${end}`,
            'SUMMARY',
          )
    const summaryFetchedAt = new Date()
    const summaries =
      summaryPayload === null
        ? new Map<string, unknown>()
        : rangeRecords(owner, 'SUMMARY', summaryPayload, start, end)
    let sleeps = new Map<string, unknown>()
    let sleepFetchedAt: Date | null = null
    let sleepError: GarminHealthImportErrorCode | null = null
    if (dependencies.sources !== 'SUMMARY_ONLY') {
      try {
        const sleepPayload = await read(
          `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${start}&endDate=${end}`,
          'SLEEP',
        )
        sleepFetchedAt = new Date()
        sleeps = rangeRecords(owner, 'SLEEP', sleepPayload, start, end)
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
      start,
      end,
      summaries,
      sleeps,
      summaryFetchedAt,
      sleepFetchedAt,
      sleepError,
    }
  }
  if (!skipSummary) {
    if (
      dependencies.sources === 'SUMMARY_ONLY' &&
      dependencies.earliestAllowedDate &&
      !session.batch?.summaries.has(date) &&
      (!session.summaryFallback ||
        date < session.summaryFallback.start ||
        date > session.summaryFallback.end)
    ) {
      const start =
        addDays(date, -(summaryFallbackDays - 1)) < dependencies.earliestAllowedDate
          ? dependencies.earliestAllowedDate
          : addDays(date, -(summaryFallbackDays - 1))
      const payload = await read(
        `/usersummary-service/v2/dailysummaries?startDate=${start}&endDate=${date}`,
        'SUMMARY',
      )
      session.summaryFallback = {
        start,
        end: date,
        summaries: rangeRecords(owner, 'SUMMARY', payload, start, date),
        fetchedAt: new Date(),
      }
    }
    const inBatch = session.batch?.summaries.has(date) ?? false
    const inFallback = session.summaryFallback?.summaries.has(date) ?? false
    const cached = inBatch
      ? session.batch?.summaries.get(date)
      : session.summaryFallback?.summaries.get(date)
    const summaryPayload = cached
      ? { data: [cached] }
      : inBatch || inFallback
        ? { data: [] }
        : await read(
            `/usersummary-service/v2/dailysummaries?startDate=${date}&endDate=${date}`,
            'SUMMARY',
          )
    const summaryFetchedAt = inBatch
      ? session.batch!.summaryFetchedAt
      : inFallback
        ? session.summaryFallback!.fetchedAt
        : new Date()
    if (session.verifiedAccountId !== credential.accountId)
      throw new GarminHealthImportError('UNAVAILABLE')
    const summaryResponse = dailyResponseSchema.safeParse(summaryPayload)
    if (!summaryResponse.success) {
      const diagnosticCode =
        summaryPayload === null
          ? 'SUMMARY_EMPTY_BODY'
          : record(summaryPayload)?.data === null
            ? 'SUMMARY_NULL_DATA'
            : 'SUMMARY_INVALID_ENVELOPE'
      throw new GarminHealthImportError('SUMMARY_INVALID_RESPONSE', diagnosticCode)
    }
    const summaries = summaryResponse.data
    if (summaries.length > 1)
      throw new GarminHealthImportError('SUMMARY_INVALID_RESPONSE', 'SUMMARY_MULTIPLE_RECORDS')
    let summary: ReturnType<typeof normalizeGarminDailySummary> | null = null
    try {
      summary =
        summaries.length === 0
          ? null
          : normalizeGarminDailySummary(owner, sourceTimezone, summaries[0])
    } catch {
      throw new GarminHealthImportError('SUMMARY_INVALID_RESPONSE', 'SUMMARY_INVALID_RECORD')
    }
    if (summary && summary.localDate !== date)
      throw new GarminHealthImportError('SUMMARY_DATE_MISMATCH', 'SUMMARY_DATE_MISMATCH')
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
      summaries.length ? projectGarminHealth('summary', summaries[0]) : null,
    )
  }
  try {
    if (!skipSleep) {
      if (session.batch?.sleepError) throw new GarminHealthImportError(session.batch.sleepError)
      const cached = session.batch?.sleeps.get(date)
      const sleepResponse = session.batch?.sleeps.has(date)
        ? cached
        : await read(`/sleep-service/sleep/dailySleep?date=${date}`, 'SLEEP')
      const sleepFetchedAt = session.batch?.sleeps.has(date)
        ? session.batch.sleepFetchedAt!
        : new Date()
      if (session.verifiedAccountId !== credential.accountId)
        throw new GarminHealthImportError('UNAVAILABLE')
      let sleep: ReturnType<typeof normalizeGarminSleep> | null = null
      const napOnly = datedNapOnlySleep(sleepResponse) === date
      try {
        sleep =
          sleepResponse == null || napOnly || (!cached && verifiedEmptySingleSleep(sleepResponse))
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
        sleep || napOnly ? projectGarminHealth('sleep', sleepResponse) : null,
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
