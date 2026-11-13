import { z } from 'zod'
import type { MeasurementSystem } from './measurement-system'

export const activityTimezoneCookie = 'activity-history-timezone'
export const activityTimezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value })
      return true
    } catch {
      return false
    }
  })
const anyDistance = { value: '', label: 'Any distance' } as const
const runningDistances = [
  { value: '', label: 'Any distance' },
  { value: '1', label: '1 km+' },
  { value: '3', label: '3 km+' },
  { value: '5', label: '5 km+' },
  { value: '10', label: '10 km+' },
  { value: '21.0975', label: 'Half marathon (21.1 km+)' },
  { value: '42.195', label: 'Marathon (42.195 km+)' },
  { value: 'ultra', label: 'Ultra (>42.195 km)' },
] as const
const genericDistances = [
  anyDistance,
  ...[1, 3, 5, 10, 20, 50, 100].map((km) => ({ value: String(km), label: `${km} km+` })),
]
const cyclingDistances = [
  anyDistance,
  ...[5, 10, 20, 30, 50, 75, 100, 150, 200].map((km) => ({
    value: String(km),
    label: `${km} km+`,
  })),
]
const walkingDistances = [
  anyDistance,
  ...[1, 3, 5, 10, 15, 20, 30].map((km) => ({ value: String(km), label: `${km} km+` })),
]
const swimmingDistances = [
  anyDistance,
  ...[0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10].map((km) => ({
    value: String(km),
    label: km < 1 ? `${km * 1000} m+` : `${km} km+`,
  })),
]

export function activityDistanceOptionsFor(
  sport: string,
): readonly { value: string; label: string }[] {
  switch (sport) {
    case 'RUNNING':
      return runningDistances
    case 'CYCLING':
      return cyclingDistances
    case 'WALKING':
      return walkingDistances
    case 'SWIMMING':
      return swimmingDistances
    default:
      return genericDistances
  }
}

const optionalDate = z
  .union([
    z.literal(''),
    z.iso.date().refine((value) => value >= '1900-01-01' && value <= '9999-12-30'),
  ])
  .default('')
export const activityHistoryQuerySchema = z
  .object({
    q: z.string().trim().max(120).default(''),
    sport: z.string().trim().max(80).default(''),
    provider: z.enum(['', 'GARMIN', 'INTERVALS', 'MANUAL', 'FILE']).default(''),
    range: z.enum(['all', '7', '30', '90', '365', 'custom']).default('all'),
    from: optionalDate,
    to: optionalDate,
    minDistance: z.preprocess(
      (value) => (typeof value === 'number' ? String(value) : value),
      z
        .enum([
          '',
          '0.1',
          '0.25',
          '0.5',
          '1',
          '1.5',
          '2',
          '3',
          '5',
          '10',
          '15',
          '20',
          '21.0975',
          '30',
          '42.195',
          '50',
          '75',
          '100',
          '150',
          '200',
          'ultra',
        ])
        .default(''),
    ),
    sort: z.enum(['newest', 'oldest', 'distance']).default('newest'),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce
      .number()
      .pipe(z.union([z.literal(10), z.literal(25), z.literal(50)]))
      .default(10),
  })
  .refine((q) => q.range !== 'custom' || !q.from || !q.to || q.from <= q.to, {
    message: 'The start date must be on or before the end date.',
    path: ['to'],
  })
  .refine(
    (query) =>
      activityDistanceOptionsFor(query.sport).some((option) => option.value === query.minDistance),
    {
      message: 'Choose a minimum distance for the selected sport.',
      path: ['minDistance'],
    },
  )
export type ActivityHistoryQuery = z.infer<typeof activityHistoryQuerySchema>
export const defaultActivityHistoryQuery = activityHistoryQuerySchema.parse({})

export function activityHistoryUrl(query: ActivityHistoryQuery): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== defaultActivityHistoryQuery[key as keyof ActivityHistoryQuery])
      params.set(key, String(value))
  }
  return `/app/training${params.size ? `?${params}` : ''}`
}

export type ActivityHistoryRow = {
  id: string
  title: string | null
  sport: string
  sourceSport: string | null
  provider: string
  startedAt: string
  distanceMeters: number | null
  timerMs: number | null
  movingMs: number | null
  elapsedMs: number | null
  avgSpeedMps: number | null
  avgHrBpm: number | null
}
export type ActivityHistoryPage = {
  items: ActivityHistoryRow[]
  total: number
  importedCount: number
  page: number
  pageSize: number
  pageCount: number
  sports: string[]
  providers: string[]
  timezone: string
  dateBounds: { min: string; max: string }
  imported: boolean
  savedAt: string | null
}

export function activitySportLabel(sport: string, sourceSport?: string | null): string {
  const value = sport === 'OTHER' && sourceSport ? sourceSport : sport
  return value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}
export function activityProviderLabel(provider: string): string {
  return provider === 'INTERVALS' ? 'Intervals.icu' : activitySportLabel(provider)
}

export function formatActivityMetrics(
  row: Pick<
    ActivityHistoryRow,
    'sport' | 'distanceMeters' | 'timerMs' | 'movingMs' | 'elapsedMs' | 'avgSpeedMps' | 'avgHrBpm'
  >,
  system: MeasurementSystem,
) {
  const imperial = system === 'IMPERIAL'
  const metersPerUnit = imperial ? 1609.344 : 1000
  const durationMs = row.timerMs ?? row.movingMs ?? row.elapsedMs
  const durationKind =
    row.timerMs != null
      ? 'Timer time'
      : row.movingMs != null
        ? 'Moving time'
        : row.elapsedMs != null
          ? 'Elapsed time'
          : 'Time unavailable'
  const seconds = durationMs == null ? null : Math.round(durationMs / 1000)
  const duration =
    seconds == null
      ? '—'
      : `${seconds >= 3600 ? `${Math.floor(seconds / 3600)}:` : ''}${seconds >= 3600 ? String(Math.floor(seconds / 60) % 60).padStart(2, '0') : Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  const speed =
    row.avgSpeedMps != null && row.avgSpeedMps > 0
      ? row.avgSpeedMps
      : row.distanceMeters != null &&
          row.distanceMeters > 0 &&
          row.timerMs != null &&
          row.timerMs > 0
        ? row.distanceMeters / (row.timerMs / 1000)
        : null
  const paceSeconds = speed == null ? null : Math.round(metersPerUnit / speed)
  return {
    distance:
      row.distanceMeters == null
        ? '—'
        : `${(row.distanceMeters / metersPerUnit).toFixed(2)} ${imperial ? 'mi' : 'km'}`,
    duration,
    durationKind,
    paceOrSpeed:
      speed == null
        ? '—'
        : row.sport === 'RUNNING'
          ? `${Math.floor(paceSeconds! / 60)}:${String(paceSeconds! % 60).padStart(2, '0')} /${imperial ? 'mi' : 'km'}`
          : `${((speed * 3600) / metersPerUnit).toFixed(1)} ${imperial ? 'mph' : 'km/h'}`,
    heartRate: row.avgHrBpm != null && row.avgHrBpm > 0 ? `${row.avgHrBpm} bpm` : '—',
  }
}
