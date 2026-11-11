import { expect, it, vi } from 'vitest'
import { earliestGarminHistoryDate, GARMIN_HISTORY_YEARS } from '@/lib/garmin-import-window'

vi.mock('server-only', () => ({}))

import {
  GARMIN_DAILY_BATCH_DAYS,
  GARMIN_SLEEP_BATCH_DAYS,
  addCalendarDays,
  historicalWindow,
  inclusiveDays,
  seedHistoricalCoverage,
  isTerminalGarminImportError,
} from './data-import'

it('uses the configured calendar years and latest completed local day', () => {
  const normal = historicalWindow('2026-11-10', 'Asia/Tokyo')
  expect(normal).toMatchObject({
    startDate: `${2026 - GARMIN_HISTORY_YEARS}-11-10`,
    endDate: '2026-11-09',
    nextDate: '2026-11-09',
    generation: 1,
    failedDates: [],
    timezone: 'Asia/Tokyo',
  })
  const leap = historicalWindow('2024-03-01', 'UTC')
  expect(leap).toMatchObject({
    startDate: earliestGarminHistoryDate('2024-02-29', GARMIN_HISTORY_YEARS),
    endDate: '2024-02-29',
  })
})

it('keeps provider-specific window sizes within observed API limits', () => {
  expect(GARMIN_DAILY_BATCH_DAYS).toBe(365)
  expect(GARMIN_SLEEP_BATCH_DAYS).toBe(30)
})

it.each([0, 30, 32])('seeds %i verified dates without declaring historical completion', (count) => {
  const fresh = historicalWindow('2026-11-10', 'UTC')
  const dates = Array.from({ length: count }, (_, index) => addCalendarDays(fresh.endDate, -index))
  const seeded = seedHistoricalCoverage(fresh, dates)
  expect(seeded.nextDate).toBe(addCalendarDays(fresh.endDate, -count))
  expect(seeded.nextDate).not.toBeNull()
  expect(seeded.lastCheckedDate).toBe(count ? fresh.endDate : null)
})

it('stops at a gap and does not infer completion even when all dates have rows', () => {
  const fresh = historicalWindow('2026-11-10', 'UTC')
  expect(
    seedHistoricalCoverage(fresh, [fresh.endDate, addCalendarDays(fresh.endDate, -2)]).nextDate,
  ).toBe(addCalendarDays(fresh.endDate, -1))
  const all = Array.from({ length: inclusiveDays(fresh.startDate, fresh.endDate) }, (_, index) =>
    addCalendarDays(fresh.endDate, -index),
  )
  expect(seedHistoricalCoverage(fresh, all).nextDate).toBe(fresh.startDate)
})

it('stops for account or permission failures while retrying transient Garmin errors', () => {
  expect(isTerminalGarminImportError('ACCOUNT_MISMATCH')).toBe(true)
  expect(isTerminalGarminImportError('SLEEP_HTTP_403')).toBe(true)
  expect(isTerminalGarminImportError('SUMMARY_HTTP_401')).toBe(true)
  expect(isTerminalGarminImportError('SLEEP_HTTP_503')).toBe(false)
  expect(isTerminalGarminImportError('SLEEP_TIMEOUT')).toBe(false)
})
