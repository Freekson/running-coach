import { expect, it } from 'vitest'
import {
  addHealthDays,
  buildHealthPeriod,
  healthLocalDay,
  type HealthTrendRow,
} from './health-history'

const rows: HealthTrendRow[] = [
  { date: '2026-11-03', restingHrBpm: 54, sleepDurationMs: 25_200_000 },
  { date: '2026-11-05', restingHrBpm: 52, sleepDurationMs: null },
  { date: '2026-11-09', restingHrBpm: 53, sleepDurationMs: 28_800_000 },
]

it('keeps missing dates as null gaps and averages only available valid readings', () => {
  const view = buildHealthPeriod(rows, 7, '2026-11-09')
  expect(view.startDate).toBe('2026-11-03')
  expect(view.points).toHaveLength(7)
  expect(view.points[1]).toMatchObject({
    date: '2026-11-04',
    restingHrBpm: null,
    sleepDurationMs: null,
    summaryChecked: false,
    sleepChecked: false,
  })
  expect(view.restingHrAverage).toEqual({ value: 53, count: 3 })
  expect(view.sleepAverage).toEqual({ value: null, count: 2 })
  expect(view.sleepScoreAverage).toEqual({ value: null, count: 0 })
})

it('averages measurements across the selected period instead of always using seven days', () => {
  const measurements: HealthTrendRow[] = [
    ...['2026-10-20', '2026-10-21', '2026-10-22'].map((date) => ({
      date,
      restingHrBpm: 70,
      sleepDurationMs: 8 * 3_600_000,
      sleepScore: 80,
    })),
    ...['2026-11-07', '2026-11-08', '2026-11-09'].map((date) => ({
      date,
      restingHrBpm: 50,
      sleepDurationMs: 6 * 3_600_000,
      sleepScore: 60,
    })),
  ]
  const week = buildHealthPeriod(measurements, 7, '2026-11-09')
  const month = buildHealthPeriod(measurements, 30, '2026-11-09')

  expect(week.restingHrAverage).toEqual({ value: 50, count: 3 })
  expect(week.sleepAverage).toEqual({ value: 6 * 3_600_000, count: 3 })
  expect(week.sleepScoreAverage).toEqual({ value: 60, count: 3 })
  expect(month.restingHrAverage).toEqual({ value: 60, count: 6 })
  expect(month.sleepAverage).toEqual({ value: 7 * 3_600_000, count: 6 })
  expect(month.sleepScoreAverage).toEqual({ value: 70, count: 6 })
})

it('uses inclusive 30- and 90-day windows across month and year boundaries', () => {
  expect(buildHealthPeriod(rows, 30, '2026-11-09').startDate).toBe('2026-10-11')
  const long = buildHealthPeriod(rows, 90, '2027-01-01')
  expect(long.startDate).toBe('2026-10-04')
  expect(long.points).toHaveLength(90)
  expect(long.points.at(-1)?.date).toBe('2027-01-01')
})

it('provides a full year and all stored dates while preserving days with no reading', () => {
  const historical: HealthTrendRow[] = [
    { date: '2025-08-01', restingHrBpm: 50, sleepDurationMs: 25_200_000 },
    { date: '2026-11-08', restingHrBpm: null, sleepDurationMs: 28_800_000 },
  ]
  const year = buildHealthPeriod(historical, 365, '2026-11-09')
  expect(year.startDate).toBe(addHealthDays('2026-11-09', -364))
  expect(year.points).toHaveLength(365)
  expect(year.points.some((point) => point.date === '2025-08-01')).toBe(false)

  const all = buildHealthPeriod(historical, 'ALL', '2026-11-09')
  expect(all.startDate).toBe('2025-08-01')
  expect(all.points[0].restingHrBpm).toBe(50)
  expect(all.points.find((point) => point.date === '2025-08-02')?.restingHrBpm).toBeNull()
  expect(all.points.at(-1)?.date).toBe('2026-11-09')
})

it('uses an IANA zone across local midnight and daylight-saving changes', () => {
  expect(healthLocalDay('2026-11-08T15:30:00Z', 'Asia/Tokyo')).toBe('2026-11-09')
  expect(healthLocalDay('2026-11-01T05:30:00Z', 'America/New_York')).toBe('2026-11-01')
  expect(healthLocalDay('2026-11-01T06:30:00Z', 'America/New_York')).toBe('2026-11-01')
})

it('counts a verified zero sleep score without filling missing dates', () => {
  const view = buildHealthPeriod(
    [
      { date: '2026-11-07', restingHrBpm: null, sleepDurationMs: null, sleepScore: 0 },
      { date: '2026-11-08', restingHrBpm: null, sleepDurationMs: null, sleepScore: 50 },
      { date: '2026-11-09', restingHrBpm: null, sleepDurationMs: null, sleepScore: 100 },
    ],
    7,
    '2026-11-09',
  )
  expect(view.sleepScoreAverage).toEqual({ value: 50, count: 3 })
})
