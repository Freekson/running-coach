import 'server-only'

import { apiKeySchema, readProviderApiKey } from '@/server/provider/vault'
import type { OwnerContext } from '@/server/authorization/ownership'
import { inspectFitDownload, type FitProbeReport } from './fit-probe'

const BASE_URL = 'https://personal.connectapi.garmin.com'
const TIMEOUT_MS = 8_000
const MAX_JSON_BYTES = 512 * 1024
const MAX_ZIP_BYTES = 8 * 1024 * 1024
const MIN_GAP_MS = 1_000

export type GarminProbeResult = {
  endpoint: string
  status: number | 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_JSON' | 'TOO_LARGE'
  fields?: string[]
}

export type GarminProbeReport = {
  sampleDateUtc: string
  results: GarminProbeResult[]
  note: 'Field names and JSON types only; units and timezone semantics require separate verification.'
}

type ProbeDependencies = {
  fetcher?: typeof fetch
  pause?: (milliseconds: number) => Promise<void>
  now?: Date
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

function fieldShape(value: unknown): string[] {
  const fields: string[] = []
  function visit(current: unknown, path: string, depth: number) {
    if (fields.length >= 80 || depth > 3) return
    if (Array.isArray(current)) {
      fields.push(`${path || '$'}: array`)
      if (current.length) visit(current[0], `${path || '$'}[]`, depth + 1)
      return
    }
    if (current !== null && typeof current === 'object') {
      if (path) fields.push(`${path}: object`)
      for (const [key, item] of Object.entries(current)) {
        if (fields.length >= 80) break
        // Dynamic object keys could contain IDs or user-entered text.
        const safeKey = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ? key : '[key]'
        visit(item, path ? `${path}.${safeKey}` : safeKey, depth + 1)
      }
      return
    }
    fields.push(`${path || '$'}: ${current === null ? 'null' : typeof current}`)
  }
  visit(value, '', 0)
  return fields
}

async function boundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new Error('TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  return (await boundedBytes(response, maxBytes)).toString('utf8')
}

async function boundedJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await boundedText(response, MAX_JSON_BYTES)) as unknown
  } catch {
    throw new Error('INVALID_JSON')
  }
}

function activityIdFrom(value: unknown): string | null {
  const activities = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && 'activities' in value
      ? value.activities
      : null
  if (!Array.isArray(activities) || !activities.length) return null
  const first: unknown = activities[0]
  if (!first || typeof first !== 'object' || !('activityId' in first)) return null
  const id = first.activityId
  return (typeof id === 'number' || typeof id === 'string') && /^\d+$/.test(String(id))
    ? String(id)
    : null
}

export async function requestJson(
  fetcher: typeof fetch,
  path: string,
  authorization: string,
  method: 'GET' | 'POST' = 'GET',
  responseKind: 'json' | 'token' = 'json',
  timeoutMs = TIMEOUT_MS,
): Promise<{ status: GarminProbeResult['status']; value?: unknown; retryAfterMs?: number }> {
  try {
    const response = await fetcher(new URL(path, BASE_URL), {
      method,
      headers: {
        Authorization: authorization,
        Accept: responseKind === 'token' ? '*/*' : 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      redirect: 'error',
    })
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after')
      const seconds = retryAfter === null ? NaN : Number(retryAfter)
      const date = retryAfter === null ? NaN : Date.parse(retryAfter)
      const retryAfterMs =
        response.status === 429
          ? Number.isFinite(seconds) && seconds >= 0
            ? seconds * 1000
            : Number.isFinite(date)
              ? Math.max(0, date - Date.now())
              : undefined
          : undefined
      await response.body?.cancel()
      return { status: response.status, retryAfterMs }
    }
    try {
      return {
        status: response.status,
        value:
          responseKind === 'token'
            ? (await boundedText(response, 16 * 1024)).trim()
            : await boundedJson(response),
      }
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
        return { status: 'TIMEOUT' }
      return {
        status:
          error instanceof Error && error.message === 'TOO_LARGE' ? 'TOO_LARGE' : 'INVALID_JSON',
      }
    }
  } catch (error) {
    return {
      status:
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? 'TIMEOUT'
          : 'NETWORK_ERROR',
    }
  }
}

export async function requestFit(
  fetcher: typeof fetch,
  path: string,
  authorization: string,
  timeoutMs = TIMEOUT_MS,
): Promise<{ status: GarminProbeResult['status']; bytes?: Buffer; retryAfterMs?: number }> {
  try {
    const response = await fetcher(new URL(path, BASE_URL), {
      method: 'GET',
      headers: { Authorization: authorization, Accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      redirect: 'error',
    })
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after')
      const seconds = retryAfter === null ? NaN : Number(retryAfter)
      const date = retryAfter === null ? NaN : Date.parse(retryAfter)
      const retryAfterMs =
        response.status === 429
          ? Number.isFinite(seconds) && seconds >= 0
            ? seconds * 1000
            : Number.isFinite(date)
              ? Math.max(0, date - Date.now())
              : undefined
          : undefined
      await response.body?.cancel()
      return { status: response.status, retryAfterMs }
    }
    try {
      return { status: response.status, bytes: await boundedBytes(response, MAX_ZIP_BYTES) }
    } catch (error) {
      return {
        status:
          error instanceof Error && error.message === 'TOO_LARGE'
            ? 'TOO_LARGE'
            : error instanceof Error &&
                (error.name === 'TimeoutError' || error.name === 'AbortError')
              ? 'TIMEOUT'
              : 'NETWORK_ERROR',
      }
    }
  } catch (error) {
    return {
      status:
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? 'TIMEOUT'
          : 'NETWORK_ERROR',
    }
  }
}

/** Isolated, read-only probe. Never returns raw Garmin records or credentials. */
export async function probeGarminPersonalApi(
  rawKey: string,
  dependencies: ProbeDependencies = {},
): Promise<GarminProbeReport> {
  const parsedKey = apiKeySchema.safeParse(rawKey)
  if (!parsedKey.success) throw new Error('Invalid Garmin API key')
  const key = parsedKey.data
  const fetcher = dependencies.fetcher ?? fetch
  const pause = dependencies.pause ?? wait
  const now = dependencies.now ?? new Date()
  const day = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const report: GarminProbeReport = {
    sampleDateUtc: day,
    results: [],
    note: 'Field names and JSON types only; units and timezone semantics require separate verification.',
  }
  const tokenResponse = await requestJson(
    fetcher,
    '/personalapitoken-service/personal-api/personal-api-key/token',
    `ApiKey ${key}`,
    'POST',
    'token',
  )
  report.results.push({ endpoint: 'token', status: tokenResponse.status })
  const token = tokenResponse.value
  if (typeof token !== 'string' || !token) return report
  const bearer = `Bearer ${token}`

  async function sample(endpoint: string, path: string): Promise<unknown> {
    await pause(MIN_GAP_MS)
    const response = await requestJson(fetcher, path, bearer)
    report.results.push({
      endpoint,
      status: response.status,
      ...(response.value === undefined ? {} : { fields: fieldShape(response.value) }),
    })
    return response.value
  }

  const search = new URLSearchParams({ start: '0', limit: '3', startDate: from, endDate: day })
  const activities = await sample(
    'activities',
    `/activitylist-service/activities/search/activities?${search}`,
  )
  if ([401, 429].includes(Number(report.results.at(-1)?.status))) return report
  const activityId = activityIdFrom(activities)
  if (activityId) {
    await sample('activity-detail', `/activity-service/activity/${activityId}`)
    if ([401, 429].includes(Number(report.results.at(-1)?.status))) return report
    // Exploratory path; support in Personal API is not established by the official client.
    await sample('activity-laps', `/activity-service/activity/${activityId}/laps`)
  }
  if ([401, 429].includes(Number(report.results.at(-1)?.status))) return report
  const queries: [string, string][] = [
    ['daily-summary', `/usersummary-service/v2/dailysummaries?startDate=${day}&endDate=${day}`],
    ['sleep', `/sleep-service/sleep/dailySleep?date=${day}`],
    ['hrv', `/hrv-service/hrv/${day}`],
    [
      'body-battery',
      `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${day}&endDate=${day}`,
    ],
  ]
  for (const [name, path] of queries) {
    await sample(name, path)
    if ([401, 429].includes(Number(report.results.at(-1)?.status))) break
  }
  return report
}

/** Future authenticated callers use the RUN-21 encrypted, owner-scoped vault. */
export async function probeGarminForOwner(owner: OwnerContext): Promise<GarminProbeReport> {
  return probeGarminPersonalApi(await readProviderApiKey(owner, 'GARMIN'))
}

export type GarminContractProbeReport = {
  healthDateUtc: string
  olderActivityWindowUtc: { start: string; end: string }
  results: { endpoint: string; status: GarminProbeResult['status'] }[]
  fit?: FitProbeReport | { error: 'INVALID_OR_UNSUPPORTED_FIT' }
  restingHeartRate?: { heartRateFields: string[]; restingFieldType: string }
  sleepTimestamps?: {
    gmtType: string
    localType: string
    gmtLooksLikeEpochMilliseconds: boolean
    localMinusGmtLooksLikeTimezoneOffset: boolean
  }
  hrv?: { summaryFields: string[]; readingFields: string[]; lastNightAvgType: string }
  bodyBattery?: {
    descriptorFields: string[]
    sampleRowIsArray: boolean
    sampleElementTypes: string[]
    descriptorCountMatchesSampleWidth: boolean | null
  }
  historicalActivityPresent?: boolean
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function typeOf(value: unknown): string {
  return value === undefined ? 'missing' : value === null ? 'null' : typeof value
}

function safeFields(value: unknown): string[] {
  return Object.keys(objectOf(value) ?? {})
    .filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key))
    .slice(0, 80)
}

function firstActivity(value: unknown): Record<string, unknown> | null {
  const list = Array.isArray(value) ? value : objectOf(value)?.activities
  return Array.isArray(list) && list.length ? objectOf(list[0]) : null
}

/** One bounded follow-up for FIT and canonical-model uncertainties. */
export async function probeGarminDataContracts(
  rawKey: string,
  dependencies: ProbeDependencies = {},
): Promise<GarminContractProbeReport> {
  const parsedKey = apiKeySchema.safeParse(rawKey)
  if (!parsedKey.success) throw new Error('Invalid Garmin API key')
  const fetcher = dependencies.fetcher ?? fetch
  const pause = dependencies.pause ?? wait
  const now = dependencies.now ?? new Date()
  const date = (daysAgo: number) =>
    new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const report: GarminContractProbeReport = {
    healthDateUtc: date(1),
    olderActivityWindowUtc: { start: date(120), end: date(60) },
    results: [],
  }
  const tokenResponse = await requestJson(
    fetcher,
    '/personalapitoken-service/personal-api/personal-api-key/token',
    `ApiKey ${parsedKey.data}`,
    'POST',
    'token',
  )
  report.results.push({ endpoint: 'token', status: tokenResponse.status })
  if (typeof tokenResponse.value !== 'string' || !tokenResponse.value) return report
  const bearer = `Bearer ${tokenResponse.value}`
  const stop = () => [401, 429].includes(Number(report.results.at(-1)?.status))

  async function read(endpoint: string, path: string): Promise<unknown> {
    await pause(MIN_GAP_MS)
    const response = await requestJson(fetcher, path, bearer)
    report.results.push({ endpoint, status: response.status })
    return response.value
  }

  const recentQuery = new URLSearchParams({
    start: '0',
    limit: '1',
    startDate: date(30),
    endDate: date(1),
  })
  const recent = firstActivity(
    await read(
      'recent-activity',
      `/activitylist-service/activities/search/activities?${recentQuery}`,
    ),
  )
  if (stop()) return report
  const id = activityIdFrom(recent ? [recent] : null)
  if (id) {
    await pause(MIN_GAP_MS)
    const response = await requestFit(fetcher, `/download-service/files/activity/${id}`, bearer)
    report.results.push({ endpoint: 'activity-fit', status: response.status })
    if (response.bytes) {
      const lapCount = recent?.lapCount
      try {
        report.fit = inspectFitDownload(
          response.bytes,
          typeof lapCount === 'number' && Number.isInteger(lapCount) ? lapCount : null,
        )
      } catch {
        report.fit = { error: 'INVALID_OR_UNSUPPORTED_FIT' }
      }
    }
    if (stop()) return report
  }

  const day = report.healthDateUtc
  const summary = objectOf(
    await read(
      'daily-summary',
      `/usersummary-service/v2/dailysummaries?startDate=${day}&endDate=${day}`,
    ),
  )
  if (stop()) return report
  const daySummary = Array.isArray(summary?.data) ? objectOf(summary.data[0]) : null
  const heartRate = daySummary?.heartRate
  report.restingHeartRate = {
    heartRateFields: safeFields(heartRate),
    restingFieldType: typeOf(objectOf(heartRate)?.restingValue),
  }

  const sleep = objectOf(await read('sleep', `/sleep-service/sleep/dailySleep?date=${day}`))
  if (stop()) return report
  const gmt = sleep?.sleepStartTimestampGMT
  const local = sleep?.sleepStartTimestampLocal
  report.sleepTimestamps = {
    gmtType: typeOf(gmt),
    localType: typeOf(local),
    gmtLooksLikeEpochMilliseconds:
      typeof gmt === 'number' &&
      Number.isInteger(gmt) &&
      gmt >= Date.UTC(2000, 0, 1) &&
      gmt <= now.getTime() + 24 * 60 * 60 * 1000,
    localMinusGmtLooksLikeTimezoneOffset:
      typeof gmt === 'number' &&
      typeof local === 'number' &&
      Number.isInteger(local - gmt) &&
      Math.abs(local - gmt) <= 14 * 60 * 60 * 1000 &&
      (local - gmt) % 60_000 === 0,
  }

  const hrv = objectOf(await read('hrv', `/hrv-service/hrv/${day}`))
  if (stop()) return report
  const hrvSummary = objectOf(hrv?.hrvSummary)
  const firstReading = Array.isArray(hrv?.hrvReadings) ? hrv.hrvReadings[0] : null
  report.hrv = {
    summaryFields: safeFields(hrvSummary),
    readingFields: safeFields(firstReading),
    lastNightAvgType: typeOf(hrvSummary?.lastNightAvg),
  }

  const body = await read(
    'body-battery',
    `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${day}&endDate=${day}`,
  )
  if (stop()) return report
  const bodyDay = Array.isArray(body) ? objectOf(body[0]) : null
  const descriptors = bodyDay?.bodyBatteryValueDescriptorDTOList
  const firstRow = Array.isArray(bodyDay?.bodyBatteryValuesArray)
    ? bodyDay.bodyBatteryValuesArray[0]
    : null
  report.bodyBattery = {
    descriptorFields: Array.isArray(descriptors) ? safeFields(descriptors[0]) : [],
    sampleRowIsArray: Array.isArray(firstRow),
    sampleElementTypes: Array.isArray(firstRow) ? firstRow.map(typeOf).slice(0, 20) : [],
    descriptorCountMatchesSampleWidth:
      Array.isArray(descriptors) && Array.isArray(firstRow)
        ? descriptors.length === firstRow.length
        : null,
  }

  const olderQuery = new URLSearchParams({
    start: '0',
    limit: '1',
    startDate: report.olderActivityWindowUtc.start,
    endDate: report.olderActivityWindowUtc.end,
    activityType: 'running',
  })
  const older = await read(
    'older-running-activity',
    `/activitylist-service/activities/search/activities?${olderQuery}`,
  )
  if (!stop()) report.historicalActivityPresent = firstActivity(older) !== null
  return report
}

/** The authenticated owner path reuses RUN-21; the local test may use a .env key. */
export async function probeGarminDataContractsForOwner(
  owner: OwnerContext,
): Promise<GarminContractProbeReport> {
  return probeGarminDataContracts(await readProviderApiKey(owner, 'GARMIN'))
}
