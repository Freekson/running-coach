import { describe, expect, it } from 'vitest'
import {
  activityHistoryQuerySchema,
  activityHistoryUrl,
  activityDistanceOptionsFor,
  defaultActivityHistoryQuery,
  formatActivityMetrics,
  type ActivityHistoryRow,
} from './activity-history'

const row: ActivityHistoryRow = {
  id: 'activity',
  title: null,
  sport: 'RUNNING',
  sourceSport: null,
  provider: 'GARMIN',
  startedAt: '2026-11-12T00:00:00Z',
  distanceMeters: 5000,
  timerMs: 1_800_000,
  movingMs: null,
  elapsedMs: 1_900_000,
  avgSpeedMps: null,
  avgHrBpm: 150,
}

describe('activity history query', () => {
  it('round-trips composed filters and pagination through a stable URL', () => {
    const query = activityHistoryQuerySchema.parse({
      q: ' Trail & road ',
      sport: 'RUNNING',
      provider: 'FILE',
      range: 'custom',
      from: '2026-11-01',
      to: '2026-11-12',
      minDistance: '5',
      sort: 'oldest',
      page: '3',
      pageSize: '25',
    })
    const params = new URL(activityHistoryUrl(query), 'https://example.test').searchParams
    expect(activityHistoryQuerySchema.parse(Object.fromEntries(params))).toEqual(query)
    expect(activityHistoryUrl(defaultActivityHistoryQuery)).toBe('/app/training')
  })
  it.each([
    { page: 0 },
    { pageSize: 10000 },
    { sort: 'raw-sql' },
    { range: 'custom', from: '2026-11-12', to: '2026-11-01' },
    { from: '2026-02-30' },
    { minDistance: -1 },
    { minDistance: '8.5' },
    { provider: 'unknown' },
    { q: ['user-a', 'user-b'] },
  ])('rejects invalid or unbounded query %j', (query) => {
    expect(activityHistoryQuerySchema.safeParse(query).success).toBe(false)
  })
  it('drops the retired heart-rate filter from query state', () => {
    const query = activityHistoryQuerySchema.parse({ withHr: '1' })
    expect(query).not.toHaveProperty('withHr')
    expect(activityHistoryUrl(query)).toBe('/app/training')
  })
  it('offers sport-specific distance presets and reserves race names for running', () => {
    expect(activityDistanceOptionsFor('RUNNING').some((option) => option.value === 'ultra')).toBe(
      true,
    )
    expect(activityDistanceOptionsFor('CYCLING').map((option) => option.label)).toContain('100 km+')
    expect(activityDistanceOptionsFor('SWIMMING').map((option) => option.label)).toContain('100 m+')
    for (const sport of ['', 'CYCLING', 'WALKING', 'SWIMMING', 'OTHER', 'ROWING']) {
      expect(
        activityDistanceOptionsFor(sport).some((option) => /marathon|ultra/i.test(option.label)),
      ).toBe(false)
    }
    expect(
      activityHistoryQuerySchema.safeParse({ sport: 'CYCLING', minDistance: 'ultra' }).success,
    ).toBe(false)
    expect(
      activityHistoryQuerySchema.safeParse({ sport: 'CYCLING', minDistance: '100' }).success,
    ).toBe(true)
    expect(
      activityHistoryQuerySchema.safeParse({ sport: 'SWIMMING', minDistance: '0.1' }).success,
    ).toBe(true)
  })
})
describe('activity row formatting', () => {
  it('distinguishes timer duration and running pace from speed for other sports', () => {
    expect(formatActivityMetrics(row, 'METRIC')).toMatchObject({
      distance: '5.00 km',
      duration: '30:00',
      durationKind: 'Timer time',
      paceOrSpeed: '6:00 /km',
      heartRate: '150 bpm',
    })
    expect(
      formatActivityMetrics({ ...row, sport: 'CYCLING', avgSpeedMps: 10 }, 'METRIC').paceOrSpeed,
    ).toBe('36.0 km/h')
    expect(
      formatActivityMetrics({ ...row, sport: 'WALKING', avgSpeedMps: 1 }, 'IMPERIAL').paceOrSpeed,
    ).toBe('2.2 mph')
    expect(
      formatActivityMetrics(
        { ...row, distanceMeters: 1609.344, avgSpeedMps: 1609.344 / 600 },
        'IMPERIAL',
      ),
    ).toMatchObject({ distance: '1.00 mi', paceOrSpeed: '10:00 /mi' })
  })
  it('keeps null metrics unavailable and labels moving/elapsed fallbacks', () => {
    const empty = {
      ...row,
      distanceMeters: null,
      timerMs: null,
      movingMs: null,
      elapsedMs: null,
      avgSpeedMps: null,
      avgHrBpm: null,
    }
    expect(formatActivityMetrics(empty, 'METRIC')).toMatchObject({
      distance: '—',
      duration: '—',
      paceOrSpeed: '—',
      heartRate: '—',
      durationKind: 'Time unavailable',
    })
    expect(formatActivityMetrics({ ...empty, movingMs: 3_661_000 }, 'METRIC')).toMatchObject({
      duration: '1:01:01',
      durationKind: 'Moving time',
    })
    expect(formatActivityMetrics({ ...empty, elapsedMs: 60_000 }, 'METRIC').durationKind).toBe(
      'Elapsed time',
    )
    expect(
      formatActivityMetrics(
        { ...row, distanceMeters: 0, timerMs: 0, avgSpeedMps: 0, avgHrBpm: 0 },
        'METRIC',
      ).paceOrSpeed,
    ).toBe('—')
  })
})
