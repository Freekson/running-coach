import { config } from 'dotenv'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
config({ path: '.env', override: false })

import { requestJson } from './personal-api-poc'

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function fieldType(value: unknown): string {
  return value === undefined ? 'missing' : value === null ? 'null' : typeof value
}

function validProfileId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

describe.skipIf(process.env.GARMIN_IDENTITY_POC !== '1')('Garmin account identity live PoC', () => {
  it('reports only field paths and types in at most three read-only requests', async () => {
    const key = process.env.GARMIN_API_KEY
    if (!key) throw new Error('Set GARMIN_API_KEY in the saved repository-root .env file')
    const date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    let requestCount = 0
    const token = await requestJson(
      fetch,
      '/personalapitoken-service/personal-api/personal-api-key/token',
      `ApiKey ${key}`,
      'POST',
      'token',
    )
    requestCount++
    const report: Record<string, unknown> = { tokenStatus: token.status }
    if (token.status === 200 && typeof token.value === 'string' && token.value) {
      const bearer = `Bearer ${token.value}`
      const legacy = await requestJson(
        fetch,
        `/usersummary-service/usersummary/daily?calendarDate=${date}`,
        bearer,
      )
      requestCount++
      const legacyRecord = object(legacy.value)
      const legacyId = legacyRecord?.userProfileId
      report.legacy = {
        status: legacy.status,
        rootType: Array.isArray(legacy.value) ? 'array' : fieldType(legacy.value),
        userProfileId: fieldType(legacyId),
        validPositiveSafeInteger: validProfileId(legacyId),
        calendarDate: fieldType(legacyRecord?.calendarDate),
      }
      if (legacy.status !== 401 && legacy.status !== 429) {
        const range = await requestJson(
          fetch,
          `/usersummary-service/v2/dailysummaries?startDate=${date}&endDate=${date}`,
          bearer,
        )
        requestCount++
        const rangeRoot = object(range.value)
        const rangeRows = Array.isArray(rangeRoot?.data) ? rangeRoot.data : null
        const first = object(rangeRows?.[0])
        const rangeId = first?.userProfileId
        report.v2 = {
          status: range.status,
          rootType: fieldType(range.value),
          dataType: rangeRows ? 'array' : fieldType(rangeRoot?.data),
          firstRecordType: fieldType(rangeRows?.[0]),
          firstRecordUserProfileId: fieldType(rangeId),
          firstRecordCalendarDate: fieldType(first?.calendarDate),
          idsMatch:
            validProfileId(legacyId) && validProfileId(rangeId) ? legacyId === rangeId : null,
        }
      }
    }
    report.requestCount = requestCount
    process.stdout.write(`${JSON.stringify(report)}\n`)
    expect(requestCount).toBeLessThanOrEqual(3)
  }, 35_000)
})
