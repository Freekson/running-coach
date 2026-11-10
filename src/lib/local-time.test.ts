import { afterEach, expect, it } from 'vitest'
import { formatLocalDateTime, formatLocalDay, formatLocalTime } from './local-time'

const originalTimezone = process.env.TZ

afterEach(() => {
  if (originalTimezone === undefined) delete process.env.TZ
  else process.env.TZ = originalTimezone
})

it('uses the viewer timezone across a UTC calendar boundary', () => {
  process.env.TZ = 'Asia/Tokyo'
  expect(formatLocalDateTime('2026-11-09T23:30:00Z')).toBe('Nov 10, 2026, 08:30')
  expect(formatLocalTime('2026-11-09T23:30:00Z')).toBe('08:30')
  expect(formatLocalDay('2026-11-09T23:30:00Z')).toBe('Nov 10')

  process.env.TZ = 'America/Los_Angeles'
  expect(formatLocalDateTime('2026-11-09T23:30:00Z')).toBe('Nov 9, 2026, 15:30')
})

it('uses the browser timezone rules through daylight saving changes', () => {
  process.env.TZ = 'America/Los_Angeles'
  expect(formatLocalTime('2026-03-08T09:30:00Z')).toBe('01:30')
  expect(formatLocalTime('2026-03-08T10:30:00Z')).toBe('03:30')
  expect(formatLocalDateTime('malformed')).toBeNull()
})
