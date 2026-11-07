export type WeightReading = {
  id: string
  measuredAt: string
  measuredOn: string | null
  createdAt: string
  valueKg: number
}

export type ChartPeriod = '7D' | '30D' | '90D' | '1Y' | 'ALL'
export const chartPeriods: ChartPeriod[] = ['7D', '30D', '90D', '1Y', 'ALL']
export const chartPeriodCookie = 'running-coach-weight-chart-period'

export type ChartPoint = {
  id: string
  date: string
  valueKg: number
  averageStart?: string
  averageEnd?: string
}

const periodDays: Partial<Record<ChartPeriod, number>> = {
  '7D': 7,
  '30D': 30,
  '90D': 90,
  '1Y': 365,
}

export function localDateKey(value: string | Date) {
  const date = typeof value === 'string' ? new Date(value) : value
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function readingDateKey(reading: WeightReading) {
  return reading.measuredOn ?? localDateKey(reading.measuredAt)
}

function localDay(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function sortWeightReadings(readings: WeightReading[]) {
  return [...readings].sort(
    (a, b) =>
      b.measuredAt.localeCompare(a.measuredAt) ||
      b.createdAt.localeCompare(a.createdAt) ||
      b.id.localeCompare(a.id),
  )
}

export function buildWeightChart(readings: WeightReading[], period: ChartPeriod, now: Date) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const start = new Date(today)
  if (periodDays[period]) start.setDate(start.getDate() - (periodDays[period]! - 1))
  const startDate = localDateKey(start)
  const endDate = localDateKey(today)
  const selected = sortWeightReadings(readings).filter((reading) => {
    const date = readingDateKey(reading)
    return date <= endDate && (period === 'ALL' || date >= startDate)
  })
  const dates = new Set<string>()
  const daily = selected
    .filter((reading) => {
      const date = readingDateKey(reading)
      if (dates.has(date)) return false
      dates.add(date)
      return true
    })
    .sort((a, b) => readingDateKey(a).localeCompare(readingDateKey(b)))

  const weekly = period === '1Y' || period === 'ALL' || (period === '90D' && daily.length > 60)
  const points: ChartPoint[] = weekly
    ? Array.from(
        selected.reduce((groups, reading) => {
          const measured = localDay(readingDateKey(reading))
          const monday = new Date(measured)
          monday.setDate(measured.getDate() - ((measured.getDay() + 6) % 7))
          const key = localDateKey(monday)
          const group = groups.get(key) ?? []
          group.push(reading)
          groups.set(key, group)
          return groups
        }, new Map<string, WeightReading[]>()),
      )
        .sort(([firstWeek], [secondWeek]) => firstWeek.localeCompare(secondWeek))
        .map(([weekStart, group]) => {
          const weekEnd = localDay(weekStart)
          weekEnd.setDate(weekEnd.getDate() + 6)
          const averageStart = period === 'ALL' || weekStart > startDate ? weekStart : startDate
          const averageEnd = localDateKey(weekEnd) > endDate ? endDate : localDateKey(weekEnd)
          return {
            id: weekStart,
            date: averageEnd,
            valueKg: group.reduce((sum, reading) => sum + reading.valueKg, 0) / group.length,
            averageStart,
            averageEnd,
          }
        })
    : daily.map((reading) => ({
        id: reading.id,
        date: readingDateKey(reading),
        valueKg: reading.valueKg,
      }))

  return {
    points,
    weekly,
    startDate: period === 'ALL' ? (daily[0] ? readingDateKey(daily[0]) : endDate) : startDate,
    endDate,
    changeKg: points.length > 1 ? points.at(-1)!.valueKg - points[0].valueKg : null,
  }
}
