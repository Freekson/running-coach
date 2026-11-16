import { describe, expect, it } from 'vitest'
import {
  addCalendarDays,
  adjacentCalendarDate,
  calendarQuerySchema,
  calendarRange,
  calendarToday,
  calendarMinDate,
  calendarMaxDate,
  rescheduleWorkoutSchema,
} from './training-calendar'

describe('date-only calendar arithmetic', () => {
  it.each(['0000-01-01', '0099-01-15', '1899-12-31', '9999-12-31'])(
    'rejects unsupported calendar date %s before expanding a range',
    (date) => {
      expect(calendarQuerySchema.safeParse({ date, view: 'month' }).success).toBe(false)
      expect(() => calendarRange(date, 'month')).toThrow()
    },
  )
  it('bounds every month and week at supported year boundaries and clamps navigation', () => {
    for (const year of [1900, 2000, 2026, 2090, 9998]) {
      for (let month = 1; month <= 12; month++) {
        const date = `${year}-${String(month).padStart(2, '0')}-15`
        const range = calendarRange(date, 'month')
        expect(range.dates.length).toBeGreaterThanOrEqual(28)
        expect(range.dates.length).toBeLessThanOrEqual(42)
        expect(range.dates[0]).toBe(range.start)
        expect(range.dates.at(-1)).toBe(range.end)
        expect(calendarRange(date, 'week').dates).toHaveLength(7)
      }
    }
    for (const view of ['week', 'month'] as const) {
      expect(adjacentCalendarDate(calendarMinDate, view, -1)).toBe(calendarMinDate)
      expect(adjacentCalendarDate(calendarMaxDate, view, 1)).toBe(calendarMaxDate)
    }
  })
  it('uses Monday weeks across month and year boundaries', () => {
    expect(calendarRange('2027-01-03', 'week')).toEqual({
      start: '2026-12-28',
      end: '2027-01-03',
      dates: Array.from({ length: 7 }, (_, i) => addCalendarDays('2026-12-28', i)),
    })
    expect(calendarRange('2026-11-15', 'month')).toMatchObject({
      start: '2026-10-26',
      end: '2026-12-06',
    })
    expect(calendarRange('2028-02-13', 'month').dates).toContain('2028-02-29')
  })
  it('does not skip or repeat calendar dates across either DST transition', () => {
    for (const date of ['2026-03-08', '2026-11-01']) {
      expect(addCalendarDays(date, 1)).toBe(date === '2026-03-08' ? '2026-03-09' : '2026-11-02')
      expect(calendarRange(date, 'week').dates).toHaveLength(7)
    }
    expect(calendarToday('America/New_York', new Date('2026-03-08T04:59:00Z'))).toBe('2026-03-07')
    expect(calendarToday('America/New_York', new Date('2026-03-08T07:01:00Z'))).toBe('2026-03-08')
    expect(calendarToday('America/New_York', new Date('2026-11-01T05:30:00Z'))).toBe('2026-11-01')
    expect(calendarToday('America/New_York', new Date('2026-11-01T06:30:00Z'))).toBe('2026-11-01')
  })
  it('uses explicit zones across the international date line', () => {
    const instant = new Date('2026-11-15T01:00:00Z')
    expect(calendarToday('Pacific/Honolulu', instant)).toBe('2026-11-14')
    expect(calendarToday('Asia/Tokyo', instant)).toBe('2026-11-15')
  })
  it('navigates months from their first day without month-end overflow', () => {
    expect(adjacentCalendarDate('2026-01-31', 'month', 1)).toBe('2026-02-01')
    expect(adjacentCalendarDate('2026-01-01', 'month', -1)).toBe('2025-12-01')
    expect(adjacentCalendarDate('2026-03-08', 'week', 1)).toBe('2026-03-15')
  })
  it('rejects timestamps, impossible dates, invalid views, zones and injected owners', () => {
    expect(calendarQuerySchema.safeParse({ date: '2026-02-30' }).success).toBe(false)
    expect(calendarQuerySchema.safeParse({ date: '2026-11-01T00:00:00Z' }).success).toBe(false)
    expect(calendarQuerySchema.safeParse({ view: ['month'] }).success).toBe(false)
    const command = {
      planId: '00000000-0000-4000-8000-000000000001',
      expectedRevisionId: '00000000-0000-4000-8000-000000000002',
      workoutId: '00000000-0000-4000-8000-000000000003',
      scheduledDate: '2026-11-16',
      timezone: 'Asia/Tokyo',
    }
    expect(rescheduleWorkoutSchema.safeParse(command).success).toBe(true)
    expect(rescheduleWorkoutSchema.safeParse({ ...command, timezone: 'invalid' }).success).toBe(
      false,
    )
    expect(rescheduleWorkoutSchema.safeParse({ ...command, userId: 'other' }).success).toBe(false)
  })
})
