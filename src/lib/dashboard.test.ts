import { expect, it } from 'vitest'
import type { ActivityHistoryRow } from './activity-history'
import { buildDashboardWeeks, dashboardGreeting, dashboardWeekStart } from './dashboard'

const row = (patch: Partial<ActivityHistoryRow> = {}): ActivityHistoryRow => ({
  id: 'a',
  title: null,
  sport: 'RUNNING',
  sourceSport: null,
  provider: 'GARMIN',
  startedAt: '2026-11-09T01:00:00.000Z',
  distanceMeters: 5000,
  timerMs: 600_000,
  elapsedMs: null,
  movingMs: null,
  avgSpeedMps: null,
  avgHrBpm: 140,
  ...patch,
})

it('builds eight Monday–Sunday weeks across a year boundary in the athlete timezone', () => {
  expect(dashboardWeekStart('2027-01-01')).toBe('2026-12-28')
  const weeks = buildDashboardWeeks(
    [row({ startedAt: '2026-12-27T15:00:00Z' }), row({ startedAt: '2026-12-27T14:59:59Z' })],
    '2027-01-01T00:00:00Z',
    'Asia/Tokyo',
  )
  expect(weeks).toHaveLength(8)
  expect(weeks[7]).toMatchObject({ start: '2026-12-28', end: '2027-01-03', sessions: 1 })
  expect(weeks[6].sessions).toBe(1)
})

it('sums only completed running records and weights available HR by duration', () => {
  const current = buildDashboardWeeks(
    [
      row(),
      row({ timerMs: 1_800_000, avgHrBpm: 160 }),
      row({ avgHrBpm: null }),
      row({ sport: 'CYCLING' }),
      row({ startedAt: '2026-11-14T00:00:00Z' }),
    ],
    '2026-11-13T06:00:00Z',
    'UTC',
  )[7]
  expect(current).toMatchObject({
    sessions: 3,
    distanceMeters: 15000,
    durationMs: 3_000_000,
    avgHrBpm: 155,
  })
})

it('keeps missing metrics unavailable, preserves valid zero and discloses partial totals', () => {
  const missing = row({ distanceMeters: null, timerMs: null, avgHrBpm: null })
  expect(buildDashboardWeeks([missing], '2026-11-13T06:00:00Z', 'UTC')[7]).toMatchObject({
    sessions: 1,
    distanceMeters: null,
    durationMs: null,
    avgHrBpm: null,
    missingDistance: true,
  })
  expect(
    buildDashboardWeeks(
      [missing, row({ distanceMeters: 0, timerMs: 0 })],
      '2026-11-13T06:00:00Z',
      'UTC',
    )[7],
  ).toMatchObject({ distanceMeters: 0, durationMs: 0, avgHrBpm: null, missingDuration: true })
  expect(
    buildDashboardWeeks(
      [row({ timerMs: null, movingMs: 120_000 })],
      '2026-11-13T06:00:00Z',
      'UTC',
    )[7].durationMs,
  ).toBe(120_000)
})

it('groups correctly over a daylight-saving transition without fixed UTC day assumptions', () => {
  const weeks = buildDashboardWeeks(
    [row({ startedAt: '2026-11-02T04:59:59Z' }), row({ startedAt: '2026-11-02T05:00:00Z' })],
    '2026-11-03T06:00:00Z',
    'America/New_York',
  )
  expect(weeks[6].sessions).toBe(1)
  expect(weeks[7].sessions).toBe(1)
})

it('formats the greeting from the same captured instant and profile name', () => {
  expect(dashboardGreeting('2026-11-13T10:00:00Z', 'Asia/Tokyo', '  Test Runner  ')).toBe(
    'Good evening, Test',
  )
  expect(dashboardGreeting('2026-11-13T10:00:00Z', 'UTC', undefined)).toBe('Good morning')
  expect(dashboardGreeting('2026-11-13T14:00:00Z', 'UTC', 'Athlete')).toBe(
    'Good afternoon, Athlete',
  )
})
