import { beforeEach, expect, it, vi } from 'vitest'

const {
  readProviderApiKeySnapshot,
  requestJson,
  saveGarminHealthObservation,
  pauseGarminProviderUntil,
  reserveGarminHealthAttempt,
  getHealthSourceCoverage,
  isVerifiedCurrentUser,
} = vi.hoisted(() => ({
  readProviderApiKeySnapshot: vi.fn(async () => ({
    key: 'synthetic-key-long-enough',
    nonce: new Uint8Array([1]),
    accountId: '123456',
  })),
  requestJson: vi.fn(),
  saveGarminHealthObservation: vi.fn(async (...args: unknown[]) => {
    void args
  }),
  pauseGarminProviderUntil: vi.fn<(...args: [unknown, Date, Uint8Array]) => Promise<void>>(
    async () => {},
  ),
  reserveGarminHealthAttempt: vi.fn(async () => BigInt(7)),
  getHealthSourceCoverage: vi.fn<
    () => Promise<{
      summaryFetchedAt: Date | null
      sleepFetchedAt: Date | null
    } | null>
  >(async () => null),
  isVerifiedCurrentUser: vi.fn(() => true),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser }))
vi.mock('@/server/provider/vault', () => ({
  apiKeySchema: { parse: (value: string) => value },
  readProviderApiKeySnapshot,
  recordProviderApiKeyAccess: vi.fn(async () => {}),
}))
vi.mock('@/server/health/history', () => ({ saveGarminHealthObservation, getHealthSourceCoverage }))
vi.mock('./personal-api-poc', () => ({ requestJson }))
vi.mock('./import-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./import-rate-limit')>()),
  pauseGarminProviderUntil,
  reserveGarminHealthAttempt,
}))
vi.mock('./sync-policy', () => ({ isGarminImportAllowed: () => true }))
vi.mock('./account-identity', () => ({
  GarminAccountIdentityError: class GarminAccountIdentityError extends Error {},
  verifyGarminBearerAccount: vi.fn(async () => '123456'),
}))

import { getOwnerContext } from '@/server/authorization/ownership'
import { importGarminHealthDate } from './health-import'
import { verifyGarminBearerAccount } from './account-identity'

const owner = getOwnerContext({
  id: '00000000-0000-4000-8000-000000000001',
  role: 'USER',
  email: null,
})
const now = new Date('2026-11-08T12:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyGarminBearerAccount).mockResolvedValue('123456')
  requestJson.mockReset()
  getHealthSourceCoverage.mockResolvedValue(null)
})

it('rejects a changed Garmin account before persisting either health source', async () => {
  vi.mocked(verifyGarminBearerAccount).mockResolvedValueOnce('999999')
  requestJson.mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', { now, pause: async () => {} }),
  ).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' })
  expect(saveGarminHealthObservation).not.toHaveBeenCalled()
})

it('accepts the oldest date in the inclusive 30-day initial window', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({ status: 204, value: null })
  await expect(
    importGarminHealthDate(owner, '2026-10-10', 'UTC', { now, pause: async () => {} }),
  ).resolves.toMatchObject({ status: 'SUCCEEDED' })
  await expect(
    importGarminHealthDate(owner, '2026-10-09', 'UTC', { now, pause: async () => {} }),
  ).rejects.toMatchObject({ code: 'INVALID_DATE' })
})

it('validates a travel day against the selected window zone, not the source zone', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({ status: 204, value: null })
  await expect(
    importGarminHealthDate(owner, '2026-11-09', 'America/New_York', {
      now: new Date('2026-11-08T15:30:00Z'),
      selectionTimezone: 'Asia/Tokyo',
      pause: async () => {},
    }),
  ).resolves.toMatchObject({ status: 'SUCCEEDED' })
  expect(requestJson).toHaveBeenCalledTimes(3)
})

it('reuses one token for two dates in the same bounded session', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({ status: 204, value: null })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({ status: 204, value: null })
  const session = {}
  await importGarminHealthDate(owner, '2026-11-07', 'UTC', { now, pause: async () => {}, session })
  await importGarminHealthDate(owner, '2026-11-08', 'UTC', { now, pause: async () => {}, session })
  expect(requestJson).toHaveBeenCalledTimes(5)
  expect(requestJson.mock.calls.filter((call) => String(call[1]).includes('/token'))).toHaveLength(
    1,
  )
})

it('refreshes a rejected bearer token once and retries the same summary', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'first-token' })
    .mockResolvedValueOnce({ status: 401 })
    .mockResolvedValueOnce({ status: 200, value: 'second-token' })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({ status: 204, value: null })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', {
      now,
      pause: async () => {},
    }),
  ).resolves.toMatchObject({ status: 'SUCCEEDED' })
  expect(requestJson).toHaveBeenCalledTimes(5)
  expect(requestJson.mock.calls.filter((call) => String(call[1]).includes('/token'))).toHaveLength(
    2,
  )
})

it('retries only sleep after a summary was saved in the interrupted run', async () => {
  getHealthSourceCoverage.mockResolvedValueOnce({
    summaryFetchedAt: new Date('2026-11-08T12:10:00Z'),
    sleepFetchedAt: null,
  })
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 204, value: null })
  await importGarminHealthDate(owner, '2026-11-07', 'UTC', {
    now,
    pause: async () => {},
    skipFetchedSince: new Date('2026-11-08T12:00:00Z'),
  })
  expect(requestJson).toHaveBeenCalledTimes(2)
  expect(requestJson.mock.calls[1][1]).toContain('/sleep-service/')
  expect(saveGarminHealthObservation).toHaveBeenCalledOnce()
  expect(saveGarminHealthObservation.mock.calls[0][1]).toBe('sleep')
})

it('imports only verified resting HR and sleep with an athlete-local day and source zone', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: { data: [{ calendarDate: '2026-11-07', heartRate: { restingValue: 53 } }] },
    })
    .mockResolvedValueOnce({
      status: 200,
      value: { calendarDate: '2026-11-07', sleepTimeSeconds: 3600 },
    })
  await importGarminHealthDate(owner, '2026-11-07', 'America/New_York', {
    now,
    pause: async () => {},
  })
  expect(saveGarminHealthObservation).toHaveBeenCalledTimes(2)
  expect(reserveGarminHealthAttempt).toHaveBeenCalledOnce()
  expect(reserveGarminHealthAttempt).toHaveBeenCalledWith(owner, new Uint8Array([1]), '123456')
  expect(saveGarminHealthObservation.mock.calls.map((call) => call[8])).toEqual([
    BigInt(7),
    BigInt(7),
  ])
  expect(saveGarminHealthObservation.mock.calls[0][4]).toMatchObject({
    restingHrBpm: 53,
    hrvMs: null,
    bodyBattery: null,
    steps: null,
    sourceTimezone: 'America/New_York',
  })
  expect(saveGarminHealthObservation.mock.calls[1][4]).toMatchObject({
    sleepDurationMs: 3_600_000,
    restingHrBpm: null,
  })
})

it('records no data as missing and rejects a mismatched provider day', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({ status: 204, value: null })
  await importGarminHealthDate(owner, '2026-11-07', 'America/New_York', {
    now,
    pause: async () => {},
  })
  expect(saveGarminHealthObservation.mock.calls.map((call) => call[4])).toEqual([null, null])
  vi.clearAllMocks()
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: { data: [{ calendarDate: '2026-11-06', heartRate: { restingValue: 53 } }] },
    })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', { now, pause: async () => {} }),
  ).rejects.toMatchObject({
    code: 'SUMMARY_DATE_MISMATCH',
    diagnosticCode: 'SUMMARY_DATE_MISMATCH',
  })
  expect(saveGarminHealthObservation).not.toHaveBeenCalled()
})

it('counts a bare empty daily response as checked during a failed-date retry', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: [] })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', {
      now,
      pause: async () => {},
      sources: 'SUMMARY_ONLY',
    }),
  ).resolves.toMatchObject({ status: 'SUMMARY_ONLY' })
  expect(saveGarminHealthObservation).toHaveBeenCalledOnce()
  expect(saveGarminHealthObservation.mock.calls[0].slice(1, 5)).toEqual([
    'summary',
    '2026-11-07',
    'UTC',
    null,
  ])
})

it('keeps a nonempty malformed single-day summary unresolved', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: { data: [null] } })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', { now, pause: async () => {} }),
  ).rejects.toMatchObject({
    code: 'SUMMARY_INVALID_RESPONSE',
    diagnosticCode: 'SUMMARY_INVALID_RECORD',
  })
  expect(saveGarminHealthObservation).not.toHaveBeenCalled()
  expect(requestJson).toHaveBeenCalledTimes(2)
})

it('stops a daily range that exceeds its bounded response limit without failing a date', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 'TOO_LARGE' })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', {
      now,
      pause: async () => {},
      sources: 'SUMMARY_ONLY',
      earliestAllowedDate: '2026-11-06',
      batchStartDate: '2026-11-06',
    }),
  ).rejects.toMatchObject({ code: 'SUMMARY_TOO_LARGE' })
  expect(saveGarminHealthObservation).not.toHaveBeenCalled()
  expect(requestJson.mock.calls[1][6]).toBe(4 * 1024 * 1024)
})

it.each([
  [null, 'SUMMARY_EMPTY_BODY'],
  [{ data: null }, 'SUMMARY_NULL_DATA'],
  [{ unexpected: [] }, 'SUMMARY_INVALID_ENVELOPE'],
])('classifies an unresolved daily response without persisting it', async (payload, reason) => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: payload })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', { now, pause: async () => {} }),
  ).rejects.toMatchObject({ code: 'SUMMARY_INVALID_RESPONSE', diagnosticCode: reason })
  expect(saveGarminHealthObservation).not.toHaveBeenCalled()
})

it('treats a 204 sleep response as checked with no data', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({ status: 204, value: null })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', { now, pause: async () => {} }),
  ).resolves.toMatchObject({ status: 'SUCCEEDED' })
  expect(saveGarminHealthObservation).toHaveBeenCalledTimes(2)
  expect(saveGarminHealthObservation.mock.calls[1][1]).toBe('sleep')
  expect(saveGarminHealthObservation.mock.calls[1][4]).toBeNull()
})

it('checks an empty single-day sleep response with Garmin sleep-need metadata', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({
      status: 200,
      value: {
        calendarDate: null,
        sleepTimeSeconds: null,
        sleepStartTimestampGMT: null,
        sleepStartTimestampLocal: null,
        sleepEndTimestampGMT: null,
        sleepEndTimestampLocal: null,
        lightSleepSeconds: null,
        deepSleepSeconds: null,
        remSleepSeconds: null,
        awakeSleepSeconds: null,
        sleepScores: null,
        deviceRemCapable: true,
        retro: false,
        sleepNeed: { suggestedSleepSeconds: 28_800 },
        nextSleepNeed: {},
      },
    })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', { now, pause: async () => {} }),
  ).resolves.toMatchObject({ status: 'SUCCEEDED' })
  expect(saveGarminHealthObservation).toHaveBeenCalledTimes(2)
  expect(saveGarminHealthObservation.mock.calls[1][1]).toBe('sleep')
  expect(saveGarminHealthObservation.mock.calls[1][4]).toBeNull()
})

it.each([
  ['a JSON null', null],
  ['a dated record without duration', { calendarDate: '2026-11-07', sleepTimeSeconds: null }],
  [
    'an all-null record with a populated sleep timeline',
    {
      calendarDate: null,
      sleepTimeSeconds: null,
      sleepStartTimestampGMT: null,
      sleepStartTimestampLocal: null,
      sleepEndTimestampGMT: null,
      sleepEndTimestampLocal: null,
      sleepLevels: [{ level: 'deep' }],
    },
  ],
  [
    'an empty core with an unexpected non-null field',
    {
      calendarDate: null,
      sleepTimeSeconds: null,
      sleepStartTimestampGMT: null,
      sleepStartTimestampLocal: null,
      sleepEndTimestampGMT: null,
      sleepEndTimestampLocal: null,
      unmeasurableSleepSeconds: 120,
    },
  ],
])('keeps %s unresolved rather than marking sleep checked', async (_description, payload) => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({ status: 200, value: payload })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', { now, pause: async () => {} }),
  ).resolves.toMatchObject({ status: 'PARTIAL', errorCode: 'SLEEP_INVALID_RESPONSE' })
  expect(saveGarminHealthObservation).toHaveBeenCalledTimes(1)
})

it.each([
  ['TIMEOUT', 'SLEEP_TIMEOUT'],
  ['NETWORK_ERROR', 'SLEEP_NETWORK'],
  [404, 'SLEEP_HTTP_404'],
  [503, 'SLEEP_HTTP_503'],
  ['INVALID_JSON', 'SLEEP_INVALID_RESPONSE'],
])('keeps the saved summary and classifies a sleep %s failure as %s', async (status, code) => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: { data: [{ calendarDate: '2026-11-07', heartRate: { restingValue: 55 } }] },
    })
    .mockResolvedValueOnce({ status })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', { now, pause: async () => {} }),
  ).resolves.toMatchObject({ status: 'PARTIAL', errorCode: code })
  expect(saveGarminHealthObservation).toHaveBeenCalledTimes(1)
  expect(saveGarminHealthObservation.mock.calls[0][1]).toBe('summary')
})

it('does not mark a malformed sleep object as a valid empty response', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({ status: 200, value: {} })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', { now, pause: async () => {} }),
  ).resolves.toMatchObject({ status: 'PARTIAL', errorCode: 'SLEEP_INVALID_RESPONSE' })
  expect(saveGarminHealthObservation).toHaveBeenCalledTimes(1)
})

it('fetches only sleep for a deferred date and does not redownload its summary', async () => {
  getHealthSourceCoverage.mockResolvedValueOnce({
    summaryFetchedAt: new Date('2026-11-08T12:00:00Z'),
    sleepFetchedAt: null,
  })
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: { calendarDate: '2026-11-07', sleepTimeSeconds: 25_200 },
    })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', {
      now,
      pause: async () => {},
      sources: 'SLEEP_ONLY',
    }),
  ).resolves.toMatchObject({ status: 'SUCCEEDED' })
  expect(requestJson).toHaveBeenCalledTimes(2)
  expect(requestJson.mock.calls[1][1]).toContain('/sleep-service/')
  expect(saveGarminHealthObservation).toHaveBeenCalledOnce()
  expect(saveGarminHealthObservation.mock.calls[0][1]).toBe('sleep')
})

it('fetches only summaries while sleep is deferred for later dates', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
  await expect(
    importGarminHealthDate(owner, '2026-11-08', 'UTC', {
      now,
      pause: async () => {},
      sources: 'SUMMARY_ONLY',
    }),
  ).resolves.toMatchObject({ status: 'SUMMARY_ONLY' })
  expect(requestJson).toHaveBeenCalledTimes(2)
  expect(saveGarminHealthObservation).toHaveBeenCalledOnce()
  expect(saveGarminHealthObservation.mock.calls[0][1]).toBe('summary')
})

it('retains valid sleep when the inferred source zone differs from Garmin local time', async () => {
  const summary = {
    status: 200,
    value: { data: [{ calendarDate: '2026-11-07', heartRate: { restingValue: 53 } }] },
  }
  const sleep = {
    status: 200,
    value: {
      calendarDate: '2026-11-07',
      sleepTimeSeconds: 3600,
      sleepStartTimestampGMT: Date.parse('2026-11-07T12:00:00Z'),
      sleepStartTimestampLocal: Date.parse('2026-11-07T21:00:00Z'),
    },
  }
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce(summary)
    .mockResolvedValueOnce(sleep)
  const result = await importGarminHealthDate(owner, '2026-11-07', 'America/New_York', {
    now,
    pause: async () => {},
  })
  expect(result).toMatchObject({ status: 'SUCCEEDED', sourceTimezone: 'America/New_York' })
  expect(saveGarminHealthObservation).toHaveBeenCalledTimes(2)
  expect(saveGarminHealthObservation.mock.calls[0][4]).toMatchObject({
    sourceTimezone: 'America/New_York',
  })
  expect(saveGarminHealthObservation.mock.calls[1][4]).toMatchObject({
    sleepDurationMs: 3_600_000,
    sleepStartedAt: '2026-11-07T12:00:00.000Z',
    sourceTimezone: 'America/New_York',
  })
})

it('accepts local today east of UTC but rejects a future local day', async () => {
  const tokyoMorning = new Date('2026-11-08T15:30:00Z')
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({ status: 204, value: null })
  await expect(
    importGarminHealthDate(owner, '2026-11-09', 'Asia/Tokyo', {
      now: tokyoMorning,
      pause: async () => {},
    }),
  ).resolves.toMatchObject({ status: 'SUCCEEDED' })
  await expect(
    importGarminHealthDate(owner, '2026-11-10', 'Asia/Tokyo', {
      now: tokyoMorning,
      pause: async () => {},
    }),
  ).rejects.toMatchObject({ code: 'INVALID_DATE' })
})

it('reports a saved summary as partial when sleep returns 429', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({ status: 429, retryAfterMs: 300_000 })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', { now, pause: async () => {} }),
  ).resolves.toMatchObject({ status: 'PARTIAL', errorCode: 'RATE_LIMITED' })
  expect(saveGarminHealthObservation).toHaveBeenCalledTimes(1)
  expect(pauseGarminProviderUntil).toHaveBeenCalledOnce()
})

it('clamps an extreme provider retry delay before persisting the pause', async () => {
  requestJson.mockResolvedValueOnce({ status: 429, retryAfterMs: 1e20 })
  const before = Date.now()
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', { now, pause: async () => {} }),
  ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  expect(pauseGarminProviderUntil).toHaveBeenCalledOnce()
  const until = pauseGarminProviderUntil.mock.calls[0][1]
  expect(until).toBeInstanceOf(Date)
  expect(until.getTime()).toBeGreaterThanOrEqual(before + 30 * 86_400_000)
  expect(until.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000)
})

it('uses one summary range, one sleep range and one token for a complete two-day batch', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: {
        data: [
          { calendarDate: '2026-11-07', heartRate: { restingValue: 52 } },
          { calendarDate: '2026-11-08', heartRate: { restingValue: null } },
        ],
      },
    })
    .mockResolvedValueOnce({
      status: 200,
      value: [
        { calendarDate: '2026-11-07', sleepTimeSeconds: 24_000 },
        { calendarDate: '2026-11-08', sleepTimeSeconds: 25_000 },
      ],
    })
  const session = {}
  await importGarminHealthDate(owner, '2026-11-07', 'UTC', {
    now,
    pause: async () => {},
    session,
    batchEndDate: '2026-11-08',
  })
  await importGarminHealthDate(owner, '2026-11-08', 'UTC', {
    now,
    pause: async () => {},
    session,
  })
  expect(requestJson).toHaveBeenCalledTimes(3)
  expect(requestJson.mock.calls[1][1]).toContain('startDate=2026-11-07&endDate=2026-11-08')
  expect(requestJson.mock.calls[2][1]).toContain('dailySleepSummariesByDate')
  expect(saveGarminHealthObservation).toHaveBeenCalledTimes(4)
  expect(saveGarminHealthObservation.mock.calls[2][4]).toMatchObject({ restingHrBpm: null })
})

it('uses single-day sleep reads when the sleep range request fails', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: {
        data: [
          { calendarDate: '2026-11-07', heartRate: { restingValue: 52 } },
          { calendarDate: '2026-11-08', heartRate: { restingValue: 53 } },
        ],
      },
    })
    .mockResolvedValueOnce({ status: 503 })
    .mockResolvedValueOnce({
      status: 200,
      value: { calendarDate: '2026-11-07', sleepTimeSeconds: 24_000 },
    })
    .mockResolvedValueOnce({
      status: 200,
      value: { calendarDate: '2026-11-08', sleepTimeSeconds: 25_000 },
    })
  const session = {}
  const first = await importGarminHealthDate(owner, '2026-11-07', 'UTC', {
    now,
    pause: async () => {},
    session,
    batchEndDate: '2026-11-08',
  })
  const second = await importGarminHealthDate(owner, '2026-11-08', 'UTC', {
    now,
    pause: async () => {},
    session,
  })
  expect([first.status, second.status]).toEqual(['SUCCEEDED', 'SUCCEEDED'])
  expect(requestJson).toHaveBeenCalledTimes(5)
  expect(requestJson.mock.calls[3][1]).toContain('/dailySleep?date=2026-11-07')
  expect(requestJson.mock.calls[4][1]).toContain('/dailySleep?date=2026-11-08')
  expect(saveGarminHealthObservation).toHaveBeenCalledTimes(4)
  expect(session).toMatchObject({ recoveredApiErrorCodes: ['SLEEP_HTTP_503'] })
})

it('does not bypass a provider pause after the sleep range is rate limited', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: { data: [{ calendarDate: '2026-11-07', heartRate: { restingValue: 52 } }] },
    })
    .mockResolvedValueOnce({ status: 429, retryAfterMs: 60_000 })
  const result = await importGarminHealthDate(owner, '2026-11-07', 'UTC', {
    now,
    pause: async () => {},
    batchEndDate: '2026-11-07',
  })
  expect(result).toMatchObject({ status: 'PARTIAL', errorCode: 'RATE_LIMITED' })
  expect(requestJson).toHaveBeenCalledTimes(3)
  expect(saveGarminHealthObservation).toHaveBeenCalledOnce()
  expect(pauseGarminProviderUntil).toHaveBeenCalledOnce()
})

it('falls back only for malformed summary and undated sleep records', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: {
        data: [
          { calendarDate: '2026-11-07', heartRate: { restingValue: 52 } },
          { calendarDate: '2026-11-08', heartRate: { restingValue: 'bad' } },
        ],
      },
    })
    .mockResolvedValueOnce({
      status: 200,
      value: [
        { calendarDate: '2026-11-07', sleepTimeSeconds: 24_000 },
        {
          calendarDate: null,
          sleepTimeSeconds: null,
          nextSleepNeed: { calendarDate: '2026-11-08' },
        },
      ],
    })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({
      status: 200,
      value: {
        calendarDate: null,
        sleepTimeSeconds: null,
        sleepStartTimestampGMT: null,
        sleepStartTimestampLocal: null,
        sleepEndTimestampGMT: null,
        sleepEndTimestampLocal: null,
        deepSleepSeconds: null,
      },
    })
  const session = {}
  await importGarminHealthDate(owner, '2026-11-07', 'UTC', {
    now,
    pause: async () => {},
    session,
    batchEndDate: '2026-11-08',
  })
  const second = await importGarminHealthDate(owner, '2026-11-08', 'UTC', {
    now,
    pause: async () => {},
    session,
  })
  expect(second.status).toBe('SUCCEEDED')
  expect(requestJson).toHaveBeenCalledTimes(5)
  expect(requestJson.mock.calls[3][1]).toContain('startDate=2026-11-08&endDate=2026-11-08')
  expect(requestJson.mock.calls[4][1]).toContain('/dailySleep?date=2026-11-08')
  expect(saveGarminHealthObservation.mock.calls.slice(2).map((call) => call[4])).toEqual([
    null,
    null,
  ])
})

it('counts a bare empty single-day summary after a partial batch as checked', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: { data: [{ calendarDate: '2026-11-07', heartRate: { restingValue: 52 } }] },
    })
    .mockResolvedValueOnce({
      status: 200,
      value: [
        { calendarDate: '2026-11-07', sleepTimeSeconds: 24_000 },
        { calendarDate: '2026-11-08', sleepTimeSeconds: 25_000 },
      ],
    })
    .mockResolvedValueOnce({ status: 200, value: [] })
  const session = {}
  await importGarminHealthDate(owner, '2026-11-07', 'UTC', {
    now,
    pause: async () => {},
    session,
    batchEndDate: '2026-11-08',
  })
  await importGarminHealthDate(owner, '2026-11-08', 'UTC', {
    now,
    pause: async () => {},
    session,
  })
  expect(requestJson).toHaveBeenCalledTimes(4)
  expect(saveGarminHealthObservation.mock.calls[2][4]).toBeNull()
  expect(saveGarminHealthObservation.mock.calls[3][4]).toMatchObject({
    sleepDurationMs: 25_000_000,
  })
})

it('checks missing historical summary dates with an explicitly empty shorter range', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: { data: [{ calendarDate: '2026-11-07', heartRate: { restingValue: 52 } }] },
    })
    .mockResolvedValueOnce({ status: 200, value: [] })
  const session = {}
  for (const date of ['2026-11-07', '2026-11-06', '2026-11-05']) {
    await expect(
      importGarminHealthDate(owner, date, 'UTC', {
        now,
        pause: async () => {},
        session,
        sources: 'SUMMARY_ONLY',
        earliestAllowedDate: '2026-11-05',
        batchStartDate: date === '2026-11-07' ? '2026-11-05' : undefined,
      }),
    ).resolves.toMatchObject({ status: 'SUMMARY_ONLY' })
  }
  expect(requestJson).toHaveBeenCalledTimes(3)
  expect(requestJson.mock.calls[2][1]).toContain('startDate=2026-11-05&endDate=2026-11-06')
  expect(saveGarminHealthObservation.mock.calls.map((call) => call[4])).toEqual([
    expect.objectContaining({ restingHrBpm: 52 }),
    null,
    null,
  ])
})

it('retries a failed historical date through a bounded empty range', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: [] })
  await expect(
    importGarminHealthDate(owner, '2026-11-06', 'UTC', {
      now,
      pause: async () => {},
      sources: 'SUMMARY_ONLY',
      earliestAllowedDate: '2026-11-05',
    }),
  ).resolves.toMatchObject({ status: 'SUMMARY_ONLY' })
  expect(requestJson.mock.calls[1][1]).toContain('startDate=2026-11-05&endDate=2026-11-06')
  expect(saveGarminHealthObservation.mock.calls[0][4]).toBeNull()
})

it('resolves duplicate sleep dates through the requested single-day endpoint', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: { data: [{ calendarDate: '2026-11-07', heartRate: { restingValue: 52 } }] },
    })
    .mockResolvedValueOnce({
      status: 200,
      value: [
        { calendarDate: '2026-11-07', sleepTimeSeconds: 24_000 },
        { calendarDate: '2026-11-07', sleepTimeSeconds: 25_000 },
      ],
    })
    .mockResolvedValueOnce({
      status: 200,
      value: {
        calendarDate: '2026-11-07',
        sleepTimeSeconds: 26_000,
      },
    })
  await importGarminHealthDate(owner, '2026-11-07', 'UTC', {
    now,
    pause: async () => {},
    batchEndDate: '2026-11-07',
  })
  expect(requestJson).toHaveBeenCalledTimes(4)
  expect(requestJson.mock.calls[3][1]).toContain('/dailySleep?date=2026-11-07')
  expect(saveGarminHealthObservation.mock.calls[1][4]).toMatchObject({
    sleepDurationMs: 26_000_000,
  })
})

it('does not replace a stored summary when an ambiguous batch date and its fallback fail', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: { data: [{ calendarDate: '2026-11-07', heartRate: { restingValue: 'bad' } }] },
    })
    .mockResolvedValueOnce({
      status: 200,
      value: [{ calendarDate: '2026-11-07', sleepTimeSeconds: 24_000 }],
    })
    .mockResolvedValueOnce({ status: 503 })
  await expect(
    importGarminHealthDate(owner, '2026-11-07', 'UTC', {
      now,
      pause: async () => {},
      batchEndDate: '2026-11-07',
    }),
  ).rejects.toMatchObject({ code: 'SUMMARY_HTTP_503' })
  expect(saveGarminHealthObservation).not.toHaveBeenCalled()
})

it('does not trust duplicate dates or a malformed single-day sleep response', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: {
        data: [
          { calendarDate: '2026-11-07', heartRate: { restingValue: 52 } },
          { calendarDate: '2026-11-07', heartRate: { restingValue: 53 } },
        ],
      },
    })
    .mockResolvedValueOnce({
      status: 200,
      value: [{ calendarDate: '2026-11-07', sleepTimeSeconds: 'bad' }],
    })
    .mockResolvedValueOnce({
      status: 200,
      value: { data: [{ calendarDate: '2026-11-07', heartRate: { restingValue: 54 } }] },
    })
    .mockResolvedValueOnce({
      status: 200,
      value: {
        calendarDate: null,
        sleepTimeSeconds: null,
        sleepStartTimestampGMT: null,
        sleepStartTimestampLocal: null,
        sleepEndTimestampGMT: null,
        sleepEndTimestampLocal: null,
        deepSleepSeconds: 300,
      },
    })
  const result = await importGarminHealthDate(owner, '2026-11-07', 'UTC', {
    now,
    pause: async () => {},
    batchEndDate: '2026-11-07',
  })
  expect(result).toMatchObject({ status: 'PARTIAL', errorCode: 'SLEEP_INVALID_RESPONSE' })
  expect(requestJson).toHaveBeenCalledTimes(5)
  expect(saveGarminHealthObservation).toHaveBeenCalledOnce()
  expect(saveGarminHealthObservation.mock.calls[0][4]).toMatchObject({ restingHrBpm: 54 })
})

it('retries only unresolved sleep after a failed single-day fallback', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: { data: [{ calendarDate: '2026-11-07', heartRate: { restingValue: 52 } }] },
    })
    .mockResolvedValueOnce({ status: 200, value: [{ calendarDate: null, sleepTimeSeconds: null }] })
    .mockResolvedValueOnce({ status: 503 })
    .mockResolvedValueOnce({
      status: 200,
      value: {
        calendarDate: '2026-11-07',
        sleepTimeSeconds: 24_000,
      },
    })
  const session = {}
  const first = await importGarminHealthDate(owner, '2026-11-07', 'UTC', {
    now,
    pause: async () => {},
    session,
    batchEndDate: '2026-11-07',
  })
  expect(first).toMatchObject({ status: 'PARTIAL', errorCode: 'SLEEP_HTTP_503' })
  getHealthSourceCoverage.mockResolvedValueOnce({
    summaryFetchedAt: new Date('2026-11-08T12:10:00Z'),
    sleepFetchedAt: null,
  })
  const second = await importGarminHealthDate(owner, '2026-11-07', 'UTC', {
    now,
    pause: async () => {},
    session,
    sources: 'SLEEP_ONLY',
  })
  expect(second.status).toBe('SUCCEEDED')
  expect(requestJson).toHaveBeenCalledTimes(5)
  expect(saveGarminHealthObservation.mock.calls.map((call) => call[1])).toEqual([
    'summary',
    'sleep',
  ])
})

it('refuses to reuse a batch session for another owner', async () => {
  const otherOwner = getOwnerContext({
    id: '00000000-0000-4000-8000-000000000002',
    role: 'USER',
    email: null,
  })
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({ status: 200, value: [] })
    .mockResolvedValueOnce({ status: 200, value: { data: [] } })
    .mockResolvedValueOnce({ status: 204, value: null })
  const session = {}
  await importGarminHealthDate(owner, '2026-11-07', 'UTC', {
    now,
    pause: async () => {},
    session,
    batchEndDate: '2026-11-07',
  })
  await expect(
    importGarminHealthDate(otherOwner, '2026-11-07', 'UTC', {
      now,
      pause: async () => {},
      session,
    }),
  ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  expect(requestJson).toHaveBeenCalledTimes(3)
})

it('uses one dated 365-day summary request and reuses its range for later dates', async () => {
  const start = '2025-11-09'
  const end = '2026-11-08'
  const dates = Array.from({ length: 365 }, (_, index) =>
    new Date(Date.parse(`${start}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10),
  )
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({
      status: 200,
      value: { data: dates.map((calendarDate) => ({ calendarDate })) },
    })
  const session = {}
  for (const date of [end, '2026-11-07']) {
    await importGarminHealthDate(owner, date, 'UTC', {
      now,
      pause: async () => {},
      session,
      sources: 'SUMMARY_ONLY',
      batchStartDate: start,
      earliestAllowedDate: start,
    })
  }
  expect(requestJson).toHaveBeenCalledTimes(2)
  expect(requestJson.mock.calls[1][1]).toContain(`startDate=${start}&endDate=${end}`)
  expect(saveGarminHealthObservation).toHaveBeenCalledTimes(2)
})

it('uses one 30-day sleep request and counts a fully empty range as checked', async () => {
  const start = '2026-10-10'
  const end = '2026-11-08'
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: [] })
  const session = {}
  for (const date of [end, '2026-11-07']) {
    await importGarminHealthDate(owner, date, 'UTC', {
      now,
      pause: async () => {},
      session,
      sources: 'SLEEP_ONLY',
      recheckFetchedSleep: true,
      batchStartDate: start,
      earliestAllowedDate: start,
    })
  }
  expect(requestJson).toHaveBeenCalledTimes(2)
  expect(requestJson.mock.calls[1][1]).toContain(`startDate=${start}&endDate=${end}`)
  expect(saveGarminHealthObservation.mock.calls.map((call) => [call[1], call[4]])).toEqual([
    ['sleep', null],
    ['sleep', null],
  ])
})

const napOnlySleep = {
  calendarDate: null,
  sleepTimeSeconds: null,
  sleepStartTimestampGMT: null,
  sleepStartTimestampLocal: null,
  sleepEndTimestampGMT: null,
  sleepEndTimestampLocal: null,
  napTimeSeconds: 1_800,
  dailyNapDTOS: [{ calendarDate: '2026-11-07', napTimeSec: 1_800 }],
  deviceRemCapable: true,
  retro: false,
  sleepNeed: {},
  nextSleepNeed: {},
}

it('checks a dated nap-only range row and retains its nap projection without inventing night sleep', async () => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: [napOnlySleep] })
  const result = await importGarminHealthDate(owner, '2026-11-07', 'UTC', {
    now,
    pause: async () => {},
    sources: 'SLEEP_ONLY',
    batchStartDate: '2026-11-07',
    recheckFetchedSleep: true,
  })
  expect(result.status).toBe('SUCCEEDED')
  expect(requestJson).toHaveBeenCalledTimes(2)
  expect(requestJson.mock.calls[1][1]).toContain('startDate=2026-11-07&endDate=2026-11-07')
  expect(saveGarminHealthObservation).toHaveBeenCalledOnce()
  expect(saveGarminHealthObservation.mock.calls[0][4]).toBeNull()
  expect(saveGarminHealthObservation.mock.calls[0][10]).toEqual({
    schemaVersion: 1,
    napTimeSeconds: 1_800,
  })
})

it.each([
  [
    'another day',
    { ...napOnlySleep, dailyNapDTOS: [{ calendarDate: '2026-11-06', napTimeSec: 1_800 }] },
  ],
  [
    'mixed days',
    {
      ...napOnlySleep,
      dailyNapDTOS: [
        { calendarDate: '2026-11-07', napTimeSec: 900 },
        { calendarDate: '2026-11-06', napTimeSec: 900 },
      ],
    },
  ],
  ['missing nap dates', { ...napOnlySleep, dailyNapDTOS: [{ napTimeSec: 1_800 }] }],
  ['night sleep fields', { ...napOnlySleep, deepSleepSeconds: 600 }],
])('keeps a nap-only range row with %s unresolved', async (_description, row) => {
  requestJson
    .mockResolvedValueOnce({ status: 200, value: 'synthetic-token' })
    .mockResolvedValueOnce({ status: 200, value: [row] })
    .mockResolvedValueOnce({ status: 200, value: { ...napOnlySleep, dailyNapDTOS: undefined } })
  const result = await importGarminHealthDate(owner, '2026-11-07', 'UTC', {
    now,
    pause: async () => {},
    sources: 'SLEEP_ONLY',
    batchStartDate: '2026-11-07',
    recheckFetchedSleep: true,
  })
  expect(result).toMatchObject({ status: 'PARTIAL', errorCode: 'SLEEP_INVALID_RESPONSE' })
  expect(requestJson).toHaveBeenCalledTimes(3)
  expect(saveGarminHealthObservation).not.toHaveBeenCalled()
})

it('counts bounded data/token requests and account checks for 30 initial and seven recent days', async () => {
  const add = (date: string, offset: number) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
  requestJson.mockImplementation(async (_fetcher: unknown, path: string) => {
    if (path.includes('/token')) return { status: 200, value: 'synthetic-token' }
    if (path.includes('/dailySleepSummariesByDate') || path.includes('/dailysummaries')) {
      const query = new URL(path, 'https://example.test').searchParams
      const start = query.get('startDate')!
      const end = query.get('endDate')!
      const count = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1
      const dates = Array.from({ length: count }, (_, index) => add(start, index))
      return path.includes('/dailySleepSummariesByDate')
        ? {
            status: 200,
            value: dates.map((calendarDate) => ({ calendarDate, sleepTimeSeconds: 24_000 })),
          }
        : {
            status: 200,
            value: {
              data: dates.map((calendarDate) => ({
                calendarDate,
                heartRate: { restingValue: 52 },
              })),
            },
          }
    }
    throw new Error('Unexpected single-day fallback')
  })
  for (let chunk = 0; chunk < 3; chunk++) {
    const start = add('2026-10-10', chunk * 10)
    const session = {}
    for (let index = 0; index < 10; index++)
      await importGarminHealthDate(owner, add(start, index), 'UTC', {
        now,
        pause: async () => {},
        session,
        batchEndDate: index === 0 ? add(start, 9) : undefined,
      })
  }
  expect(requestJson).toHaveBeenCalledTimes(9)
  expect(verifyGarminBearerAccount).toHaveBeenCalledTimes(3)
  expect(saveGarminHealthObservation).toHaveBeenCalledTimes(60)
  vi.clearAllMocks()
  requestJson.mockClear()
  const session = {}
  for (let index = 0; index < 7; index++)
    await importGarminHealthDate(owner, add('2026-11-02', index), 'UTC', {
      now,
      pause: async () => {},
      session,
      batchEndDate: index === 0 ? '2026-11-08' : undefined,
    })
  expect(requestJson).toHaveBeenCalledTimes(3)
  expect(verifyGarminBearerAccount).toHaveBeenCalledOnce()
  expect(saveGarminHealthObservation).toHaveBeenCalledTimes(14)
})
