import { z } from 'zod'
import type { ActivityHistoryRow } from './activity-history'

const metric = z.number().finite().nonnegative().nullable()
export const activitySampleSeries = [
  'speedMps',
  'heartRateBpm',
  'powerWatts',
  'cadence',
  'elevationMeters',
  'position',
] as const
export const activitySampleSchema = z.strictObject({
  timeSeconds: z.number().finite().nonnegative(),
  distanceMeters: metric,
  heartRateBpm: metric,
  speedMps: metric,
  powerWatts: metric,
  cadence: metric,
  elevationMeters: z.number().finite().nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  breakBefore: z.array(z.enum(activitySampleSeries)).max(activitySampleSeries.length).optional(),
})
export const activityChartsSchema = z.strictObject({
  startedAt: z.iso.datetime(),
  samples: z.array(activitySampleSchema).max(4000),
  sourceSampleCount: z.number().int().min(0).max(100_000),
  sampleIntervalSeconds: metric,
  cadenceUnit: z.enum(['spm', 'rpm']),
  session: z.strictObject({
    avgPowerWatts: metric,
    maxPowerWatts: metric,
    aerobicTrainingEffect: metric,
    anaerobicTrainingEffect: metric,
    avgTemperatureCelsius: z.number().finite().nullable(),
    // FIT zone array indexes are preserved; no inferred thresholds or classifications.
    heartRateZoneSeconds: z.array(z.number().finite().nonnegative()).max(10),
  }),
})
export type ActivitySample = z.infer<typeof activitySampleSchema>
export type ActivityCharts = z.infer<typeof activityChartsSchema>

/** Display spacing can be larger than the original recording interval after sampling. */
export function activitySampleGapSeconds(samples: ActivitySample[]): number {
  const intervals = samples
    .slice(1)
    .map((sample, index) => sample.timeSeconds - samples[index].timeSeconds)
    .filter((interval) => interval > 0)
    .sort((a, b) => a - b)
  return Math.max(30, (intervals[Math.floor(intervals.length / 2)] ?? 1) * 4)
}
export type ActivityDetailLap = {
  index: number
  startedAt: string | null
  distanceMeters: number | null
  timerMs: number | null
  movingMs: number | null
  elapsedMs: number | null
  avgSpeedMps: number | null
  avgHrBpm: number | null
  maxHrBpm: number | null
  avgPowerWatts: number | null
  maxPowerWatts: number | null
  cadenceCyclesPerMinute: number | null
  cadenceStepsPerMinute: number | null
  elevationGainMeters: number | null
}
export type ActivityDetail = ActivityHistoryRow & {
  externalActivityId: string | null
  externalActivityUuid: string | null
  sourceTimezone: string | null
  maxHrBpm: number | null
  cadenceStepsPerMinute: number | null
  elevationGainMeters: number | null
  elevationLossMeters: number | null
  calories: number | null
  lapImportStatus: string
  fitAvailability: 'AVAILABLE' | 'NOT_CONNECTED' | 'UNSUPPORTED'
  laps: ActivityDetailLap[]
}
export function activityDuration(milliseconds: number | null): string {
  if (milliseconds === null) return '—'
  const seconds = Math.round(milliseconds / 1000)
  return `${seconds >= 3600 ? `${Math.floor(seconds / 3600)}:` : ''}${seconds >= 3600 ? String(Math.floor(seconds / 60) % 60).padStart(2, '0') : Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export const activityChartErrors: Record<string, string> = {
  AUTH_REQUIRED: 'Your session expired. Sign in again to load detailed charts.',
  TOKEN_REJECTED: 'The Garmin session expired. Please retry the download.',
  NOT_CONNECTED:
    'Connect Garmin in Settings to load detailed charts. Saved summary and laps remain available.',
  UNSUPPORTED: 'Detailed FIT charts are not available for this activity source.',
  NOT_FOUND: 'This activity is no longer available.',
  RATE_LIMITED: 'Garmin requests are paused. Try again after the cooldown.',
  BUSY: 'Another Garmin request is running. Please try again shortly.',
  ACCOUNT_MISMATCH:
    'The Garmin account does not match this activity. Check your connection in Settings.',
  ACCOUNT_UNVERIFIABLE: 'The Garmin account could not be verified. Please try again later.',
  INVALID_KEY: 'Garmin rejected the saved key. Replace it in Settings.',
  ACCESS_DENIED: 'Garmin did not allow this download. Check your connection in Settings.',
  CREDENTIAL_CHANGED: 'Your Garmin connection changed. Reload the page before trying again.',
  UNAVAILABLE:
    'Detailed charts are unavailable right now. Saved summary and laps remain available.',
  FIT_UNAVAILABLE: 'Garmin has no downloadable FIT file for this activity.',
  FIT_TOO_LARGE: 'This FIT file exceeds the supported size limit.',
  INVALID_FIT: 'The FIT file could not be safely decoded.',
  IDENTITY_MISMATCH: 'The FIT file does not match this activity.',
  NETWORK_ERROR: 'Garmin could not be reached. Please try again.',
  TIMEOUT: 'The Garmin request timed out. Please try again.',
}

export function activityDetailBackLink(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !(value === '/app/training' || value.startsWith('/app/training?'))
  )
    return '/app/training'
  return value
}
