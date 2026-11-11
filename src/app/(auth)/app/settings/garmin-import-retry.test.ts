import { expect, it } from 'vitest'
import { nextGarminRateLimitRetryAt } from './garmin-import-retry'

const now = Date.parse('2026-11-10T12:00:00.000Z')

it('doubles the wait after repeated Garmin import rate limits and caps it at one hour', () => {
  expect(
    [1, 2, 3, 4, 8].map(
      (attempt) => Date.parse(nextGarminRateLimitRetryAt(now, attempt, null)) - now,
    ),
  ).toEqual([60_000, 120_000, 240_000, 480_000, 3_600_000])
})

it('never retries before the server-provided time', () => {
  const later = '2026-11-10T12:15:00.000Z'
  expect(nextGarminRateLimitRetryAt(now, 2, later)).toBe(later)
  expect(nextGarminRateLimitRetryAt(now, 2, '2026-11-10T12:01:00.000Z')).toBe(
    '2026-11-10T12:02:00.000Z',
  )
})
