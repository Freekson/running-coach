import { expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  advanceHealthCheckpoint,
  eligibleHealthCheckpoint,
  healthWindow,
  localDay,
  nextHealthWindow,
} from './health-sync'

it('builds inclusive 30-day initial and seven-day recent calendar windows', () => {
  expect(healthWindow('2026-11-09', false, 'Asia/Tokyo')).toMatchObject({
    mode: 'INITIAL',
    windowStart: '2026-10-11',
    windowEnd: '2026-11-09',
    nextDate: '2026-10-11',
  })
  expect(healthWindow('2026-11-09', true, 'Asia/Tokyo')).toMatchObject({
    mode: 'RECENT',
    windowStart: '2026-11-03',
    windowEnd: '2026-11-09',
  })
})

it('catches up missed days before returning to the recent overlap', () => {
  const completed = { ...healthWindow('2026-10-30', false, 'UTC'), nextDate: null }
  const catchup = nextHealthWindow(completed, '2026-11-09', 'UTC')
  expect(catchup).toMatchObject({ windowStart: '2026-10-31', windowEnd: '2026-11-09' })
  const later = nextHealthWindow({ ...catchup, nextDate: null }, '2026-11-10', 'UTC')
  expect(later).toMatchObject({ windowStart: '2026-11-04', windowEnd: '2026-11-10' })
})

it('continues from the oldest importable date after an absence longer than a month', () => {
  const completed = { ...healthWindow('2026-09-20', false, 'UTC'), nextDate: null }
  expect(nextHealthWindow(completed, '2026-11-09', 'UTC')).toMatchObject({
    windowStart: '2026-10-11',
    windowEnd: '2026-11-09',
  })
})

it('drops expired retry dates and resumes every still eligible date after a long pause', () => {
  const stale = {
    ...healthWindow('2026-11-09', false, 'UTC'),
    nextDate: '2026-10-15',
    sleepRetryDates: ['2026-10-11', '2026-10-13'],
    sleepFailedDates: ['2026-10-11'],
  }
  expect(eligibleHealthCheckpoint(stale, '2026-11-20', 'UTC')).toMatchObject({
    windowStart: '2026-10-22',
    nextDate: '2026-10-22',
    sleepRetryDates: [],
    sleepFailedDates: [],
  })
  expect(eligibleHealthCheckpoint(stale, '2026-12-15', 'UTC')).toMatchObject({
    windowStart: '2026-11-16',
    windowEnd: '2026-12-15',
    nextDate: '2026-11-16',
    sleepRetryDates: [],
    sleepFailedDates: [],
  })
})

it('uses IANA day boundaries across UTC midnight and the DST fall-back hour', () => {
  expect(localDay(new Date('2026-11-08T15:30:00Z'), 'Asia/Tokyo')).toBe('2026-11-09')
  expect(localDay(new Date('2026-11-01T05:30:00Z'), 'America/New_York')).toBe('2026-11-01')
  expect(localDay(new Date('2026-11-01T06:30:00Z'), 'America/New_York')).toBe('2026-11-01')
  expect(localDay(new Date('2026-11-01T03:30:00Z'), 'America/New_York')).toBe('2026-10-31')
})

it('continues summary history after a sleep failure and clears deferred sleep on a later retry', () => {
  let checkpoint = healthWindow('2026-11-09', false, 'UTC')
  for (let index = 0; index < 30; index++) {
    const date = checkpoint.nextDate!
    checkpoint = advanceHealthCheckpoint(
      checkpoint,
      date,
      index === 0 ? 'PARTIAL' : 'SUMMARY_ONLY',
      false,
    )
  }
  expect(checkpoint.nextDate).toBeNull()
  expect(checkpoint.sleepRetryDates).toHaveLength(30)
  expect(checkpoint.sleepRetryDates[0]).toBe('2026-10-11')
  expect(checkpoint.sleepRetryDates.at(-1)).toBe('2026-11-09')
  expect(checkpoint.sleepFailedDates).toEqual(['2026-10-11'])
  for (const date of [...checkpoint.sleepRetryDates]) {
    checkpoint = advanceHealthCheckpoint(checkpoint, date, 'SUCCEEDED', true)
  }
  expect(checkpoint.sleepRetryDates).toEqual([])
  expect(checkpoint.sleepFailedDates).toEqual([])
  expect(checkpoint.nextDate).toBeNull()
})

it('preserves a failed sleep retry while keeping the next summary date available', () => {
  let checkpoint = healthWindow('2026-11-09', true, 'UTC')
  checkpoint = advanceHealthCheckpoint(checkpoint, '2026-11-03', 'PARTIAL', false)
  expect(checkpoint).toMatchObject({
    nextDate: '2026-11-04',
    sleepRetryDates: ['2026-11-03'],
    sleepFailedDates: ['2026-11-03'],
  })
  checkpoint = advanceHealthCheckpoint(checkpoint, '2026-11-03', 'PARTIAL', true)
  expect(checkpoint).toMatchObject({
    nextDate: '2026-11-04',
    sleepRetryDates: ['2026-11-03'],
    sleepFailedDates: ['2026-11-03'],
  })
})

it('resolves a later sleep retry without losing an earlier malformed date', () => {
  let checkpoint = healthWindow('2026-11-09', true, 'UTC')
  checkpoint = advanceHealthCheckpoint(checkpoint, '2026-11-03', 'PARTIAL', false)
  checkpoint = advanceHealthCheckpoint(checkpoint, '2026-11-04', 'PARTIAL', false)
  checkpoint = advanceHealthCheckpoint(checkpoint, '2026-11-04', 'SUCCEEDED', true)
  expect(checkpoint).toMatchObject({
    nextDate: '2026-11-05',
    sleepRetryDates: ['2026-11-03'],
    sleepFailedDates: ['2026-11-03'],
  })
})
