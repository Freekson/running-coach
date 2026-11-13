import type { ActivityHistoryRow } from './activity-history'
import { addHealthDays, healthLocalDay } from './health-history'

export type DashboardWeek = {
  start: string
  end: string
  sessions: number
  distanceMeters: number | null
  durationMs: number | null
  avgHrBpm: number | null
  missingDistance: boolean
  missingDuration: boolean
}
export type DashboardActivityOverview = { weeks: DashboardWeek[]; timezone: string }

export function dashboardWeekStart(date: string): string {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
  return addHealthDays(date, -((weekday + 6) % 7))
}

/** Calendar grouping only; authorization and duplicate filtering belong to activity reads. */
export function buildDashboardWeeks(
  rows: Pick<
    ActivityHistoryRow,
    'startedAt' | 'sport' | 'distanceMeters' | 'timerMs' | 'movingMs' | 'elapsedMs' | 'avgHrBpm'
  >[],
  asOfInstant: string,
  timezone: string,
): DashboardWeek[] {
  const current = dashboardWeekStart(healthLocalDay(asOfInstant, timezone))
  return Array.from({ length: 8 }, (_, index) => {
    const start = addHealthDays(current, (index - 7) * 7)
    const end = addHealthDays(start, 6)
    const activities = rows.filter((row) => {
      const day = healthLocalDay(row.startedAt, timezone)
      return (
        row.sport === 'RUNNING' &&
        Date.parse(row.startedAt) <= Date.parse(asOfInstant) &&
        day >= start &&
        day <= end
      )
    })
    const distances = activities.flatMap((row) =>
      row.distanceMeters === null ? [] : [row.distanceMeters],
    )
    const durations = activities.flatMap((row) => {
      const value = row.timerMs ?? row.movingMs ?? row.elapsedMs
      return value === null ? [] : [value]
    })
    let weightedHr = 0
    let hrDuration = 0
    for (const row of activities) {
      const duration = row.timerMs ?? row.movingMs ?? row.elapsedMs
      if (duration !== null && duration > 0 && row.avgHrBpm !== null && row.avgHrBpm > 0) {
        weightedHr += row.avgHrBpm * duration
        hrDuration += duration
      }
    }
    return {
      start,
      end,
      sessions: activities.length,
      distanceMeters: distances.length ? distances.reduce((sum, value) => sum + value, 0) : null,
      durationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) : null,
      avgHrBpm: hrDuration ? Math.round(weightedHr / hrDuration) : null,
      missingDistance: distances.length < activities.length,
      missingDuration: durations.length < activities.length,
    }
  })
}

export function dashboardDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`))
}

export function dashboardGreeting(
  instant: string,
  timezone: string,
  name: string | undefined,
): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: timezone,
    }).format(new Date(instant)),
  )
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const firstName = name?.trim().split(/\s+/)[0]
  return `${greeting}${firstName ? `, ${firstName}` : ''}`
}
