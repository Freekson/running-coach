import 'server-only'

import { z } from 'zod'
import { apiKeySchema } from '@/server/provider/vault'
import { requestJson, type GarminProbeResult } from './personal-api-poc'

type Status = GarminProbeResult['status']
type Endpoint = 'daily-summaries' | 'sleep-summaries'

export type RangeResult = {
  endpoint: Endpoint
  status: Status
  topLevelType?: 'array' | 'object' | 'null' | 'other'
  collection?: 'root' | 'data' | 'other-top-level-array' | 'unrecognized'
  recordCount?: number
  coveredDates?: string[]
  missingDates?: string[]
  outsideRangeCount?: number
  firstRecordFieldTypes?: Record<string, string>
}

export type HealthRangeProbeReport = {
  requestedDates: string[]
  tokenStatus: Status
  results: RangeResult[]
  requestCount: number
  note: 'Structural probe only; missing response rows are not proof of no health data.'
}

type Dependencies = {
  fetcher?: typeof fetch
  pause?: (milliseconds: number) => Promise<void>
  now?: Date
}

const dateSchema = z.iso.date()
const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

function addDays(date: string, count: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + count * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

function requestedDates(startDate: string, endDate: string, now: Date): string[] {
  if (!dateSchema.safeParse(startDate).success || !dateSchema.safeParse(endDate).success)
    throw new Error('Use valid ISO calendar dates')
  const span =
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000
  if (span !== 1 && span !== 2) throw new Error('Select exactly two or three consecutive days')
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)
  if (startDate < addDays(yesterday, -29) || endDate > yesterday)
    throw new Error('Select completed days within the last 30 UTC days')
  return Array.from({ length: span + 1 }, (_, index) => addDays(startDate, index))
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function fieldType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
}

function firstRecordFieldTypes(record: unknown): Record<string, string> | undefined {
  const fields = object(record)
  if (!fields) return undefined
  const shallow = Object.fromEntries(
    Object.entries(fields)
      .filter(([key]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 40)
      .map(([key, value]) => [key, fieldType(value)]),
  )
  const nested: Record<string, string> = {}
  for (const parent of ['heartRate', 'dailySleepDTO', 'sleepSummaryDTO']) {
    const value = object(fields[parent])
    if (!value) continue
    for (const key of [
      'calendarDate',
      'restingValue',
      'sleepTimeSeconds',
      'sleepStartTimestampGMT',
      'sleepStartTimestampLocal',
    ]) {
      if (key in value) nested[`${parent}.${key}`] = fieldType(value[key])
    }
  }
  return { ...shallow, ...nested }
}

function records(value: unknown): {
  collection: RangeResult['collection']
  rows: unknown[] | null
} {
  if (Array.isArray(value)) return { collection: 'root', rows: value }
  const root = object(value)
  if (!root) return { collection: 'unrecognized', rows: null }
  if (Array.isArray(root.data)) return { collection: 'data', rows: root.data }
  const arrays = Object.values(root).filter(Array.isArray)
  if (arrays.length === 1) return { collection: 'other-top-level-array', rows: arrays[0] }
  const dated = arrays.find((array) =>
    array.some((entry) => {
      const row = object(entry)
      return row && ('calendarDate' in row || 'date' in row || 'sleepDate' in row)
    }),
  )
  return dated
    ? { collection: 'other-top-level-array', rows: dated }
    : { collection: 'unrecognized', rows: null }
}

function summarize(
  endpoint: Endpoint,
  status: Status,
  value: unknown,
  dates: string[],
): RangeResult {
  const result: RangeResult = { endpoint, status }
  if (status !== 200 && status !== 204) return result
  result.topLevelType =
    value === null ? 'null' : Array.isArray(value) ? 'array' : object(value) ? 'object' : 'other'
  const collection = records(value)
  result.collection = collection.collection
  if (!collection.rows) return result
  result.recordCount = collection.rows.length
  result.firstRecordFieldTypes = firstRecordFieldTypes(collection.rows[0])
  const returnedDates = collection.rows
    .map((entry) => {
      const row = object(entry)
      const candidate =
        row?.calendarDate ??
        row?.date ??
        row?.sleepDate ??
        object(row?.dailySleepDTO)?.calendarDate ??
        object(row?.sleepSummaryDTO)?.calendarDate
      return typeof candidate === 'string' && dateSchema.safeParse(candidate).success
        ? candidate
        : null
    })
    .filter((date): date is string => date !== null)
  if (collection.rows.length > 0 && returnedDates.length !== collection.rows.length) return result
  result.coveredDates = dates.filter((date) => returnedDates.includes(date))
  result.missingDates = dates.filter((date) => !returnedDates.includes(date))
  result.outsideRangeCount = returnedDates.filter((date) => !dates.includes(date)).length
  return result
}

/** Isolated RUN-25 probe: one token exchange, at most two range GETs, no retries or persistence. */
export async function probeGarminHealthRange(
  rawKey: string,
  startDate: string,
  endDate: string,
  allowLive: boolean,
  dependencies: Dependencies = {},
): Promise<HealthRangeProbeReport> {
  if (!allowLive) throw new Error('Live Garmin range probe is disabled')
  const dates = requestedDates(startDate, endDate, dependencies.now ?? new Date())
  const parsedKey = apiKeySchema.safeParse(rawKey)
  if (!parsedKey.success) throw new Error('Invalid Garmin API key')
  const fetcher = dependencies.fetcher ?? fetch
  const pause = dependencies.pause ?? wait
  const token = await requestJson(
    fetcher,
    '/personalapitoken-service/personal-api/personal-api-key/token',
    `ApiKey ${parsedKey.data}`,
    'POST',
    'token',
    8_000,
  )
  const report: HealthRangeProbeReport = {
    requestedDates: dates,
    tokenStatus: token.status,
    results: [],
    requestCount: 1,
    note: 'Structural probe only; missing response rows are not proof of no health data.',
  }
  if (token.status !== 200 || typeof token.value !== 'string' || !token.value) return report
  const bearer = `Bearer ${token.value}`
  const queries: [Endpoint, string][] = [
    [
      'daily-summaries',
      `/usersummary-service/v2/dailysummaries?startDate=${startDate}&endDate=${endDate}`,
    ],
    [
      'sleep-summaries',
      `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${startDate}&endDate=${endDate}`,
    ],
  ]
  for (const [endpoint, path] of queries) {
    await pause(1_000)
    const response = await requestJson(fetcher, path, bearer, 'GET', 'json', 8_000)
    report.requestCount++
    report.results.push(summarize(endpoint, response.status, response.value, dates))
    if (response.status === 401 || response.status === 429) break
  }
  return report
}
