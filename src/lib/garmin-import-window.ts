export const GARMIN_HISTORY_YEARS = 3
// A separate safety ceiling keeps saved windows readable when the product limit changes.
const MAX_SUPPORTED_HISTORY_YEARS = 20
export const GARMIN_MAX_HISTORY_DAYS = MAX_SUPPORTED_HISTORY_YEARS * 366

/** First date in an inclusive configured calendar-year window ending on the given date. */
export function earliestGarminHistoryDate(endDate: string, years = GARMIN_HISTORY_YEARS): string {
  if (!Number.isInteger(years) || years < 1 || years > MAX_SUPPORTED_HISTORY_YEARS)
    throw new RangeError('Unsupported Garmin history duration')
  const end = new Date(`${endDate}T00:00:00.000Z`)
  const anniversary = new Date(
    Date.UTC(end.getUTCFullYear() - years, end.getUTCMonth(), end.getUTCDate()),
  )
  if (anniversary.getUTCMonth() !== end.getUTCMonth()) anniversary.setUTCDate(0)
  anniversary.setUTCDate(anniversary.getUTCDate() + 1)
  return anniversary.toISOString().slice(0, 10)
}

export function garminHistoryWindowDays(startDate: string, endDate: string): number | null {
  const start = Date.parse(`${startDate}T00:00:00.000Z`)
  const end = Date.parse(`${endDate}T00:00:00.000Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null
  const days = Math.round((end - start) / 86_400_000) + 1
  return days <= GARMIN_MAX_HISTORY_DAYS ? days : null
}
