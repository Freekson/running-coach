export type HealthTimezoneBasis =
  | 'ACTIVITY_INFERRED'
  | 'PROFILE_INFERRED'
  | 'BROWSER_INFERRED'
  | 'STORED_INFERRED'
  | 'REQUEST_INFERRED'

export type HealthTrendRow = {
  date: string
  restingHrBpm: number | null
  sleepDurationMs: number | null
  sleepStartedAt?: string | null
  sleepEndedAt?: string | null
  sleepTimezone?: string | null
  sleepScore?: number | null
  sleepLightMs?: number | null
  sleepDeepMs?: number | null
  sleepRemMs?: number | null
  sleepAwakeMs?: number | null
  summaryChecked?: boolean
  sleepChecked?: boolean
}

export type HealthPeriod = 7 | 30 | 90 | 365 | 'ALL'
export type HealthDayPoint = HealthTrendRow

export function addHealthDays(date: string, count: number): string {
  const result = new Date(Date.parse(`${date}T00:00:00.000Z`) + count * 86_400_000)
  return result.toISOString().slice(0, 10)
}

export function healthLocalDay(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant))
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function buildHealthPeriod(rows: HealthTrendRow[], period: HealthPeriod, today: string) {
  const firstStoredDate = rows.reduce<string | null>(
    (first, row) => (row.date <= today && (!first || row.date < first) ? row.date : first),
    null,
  )
  const startDate = period === 'ALL' ? (firstStoredDate ?? today) : addHealthDays(today, 1 - period)
  const days =
    Math.round(
      (Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) /
        86_400_000,
    ) + 1
  const byDate = new Map(rows.map((row) => [row.date, row]))
  const points: HealthDayPoint[] = Array.from({ length: days }, (_, index) => {
    const date = addHealthDays(startDate, index)
    const row = byDate.get(date)
    return {
      date,
      restingHrBpm: row?.restingHrBpm ?? null,
      sleepDurationMs: row?.sleepDurationMs ?? null,
      sleepStartedAt: row?.sleepStartedAt ?? null,
      sleepEndedAt: row?.sleepEndedAt ?? null,
      sleepTimezone: row?.sleepTimezone ?? null,
      sleepScore: row?.sleepScore ?? null,
      sleepLightMs: row?.sleepLightMs ?? null,
      sleepDeepMs: row?.sleepDeepMs ?? null,
      sleepRemMs: row?.sleepRemMs ?? null,
      sleepAwakeMs: row?.sleepAwakeMs ?? null,
      summaryChecked: row?.summaryChecked ?? false,
      sleepChecked: row?.sleepChecked ?? false,
    }
  })
  const average = (values: (number | null)[], allowZero = false) => {
    const available = values.filter(
      (value): value is number =>
        value !== null && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0),
    )
    return {
      value:
        available.length >= 3
          ? available.reduce((sum, value) => sum + value, 0) / available.length
          : null,
      count: available.length,
    }
  }
  return {
    startDate,
    endDate: today,
    points,
    restingHrAverage: average(points.map((point) => point.restingHrBpm)),
    sleepAverage: average(points.map((point) => point.sleepDurationMs)),
    sleepScoreAverage: average(
      points.map((point) => point.sleepScore ?? null),
      true,
    ),
  }
}
