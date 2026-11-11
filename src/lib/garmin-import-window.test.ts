import { expect, it } from 'vitest'
import {
  earliestGarminHistoryDate,
  garminHistoryWindowDays,
  GARMIN_HISTORY_YEARS,
} from './garmin-import-window'

it('calculates calendar anniversaries independently of the configured default', () => {
  expect(earliestGarminHistoryDate('2024-02-29', 1)).toBe('2023-03-01')
  expect(earliestGarminHistoryDate('2024-02-29', 4)).toBe('2020-03-01')
  expect(garminHistoryWindowDays('2020-03-01', '2024-02-29')).toBe(1461)
  expect(earliestGarminHistoryDate('2024-02-29')).toBe(
    earliestGarminHistoryDate('2024-02-29', GARMIN_HISTORY_YEARS),
  )
})

it('accepts persisted windows beyond the current default but rejects unbounded ranges', () => {
  expect(garminHistoryWindowDays('2020-03-01', '2024-02-29')).toBe(1461)
  expect(garminHistoryWindowDays('1990-01-01', '2026-01-01')).toBeNull()
  expect(garminHistoryWindowDays('2026-01-02', '2026-01-01')).toBeNull()
  expect(() => earliestGarminHistoryDate('2026-01-01', 21)).toThrow(RangeError)
})
