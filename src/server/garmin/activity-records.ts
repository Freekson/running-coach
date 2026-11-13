import 'server-only'
import type { SessionMesg } from '@garmin/fitsdk'
import {
  activityChartsSchema,
  activitySampleSeries,
  type ActivitySample,
  type ActivityCharts,
} from '@/lib/activity-detail'
import { decodeFitDownload } from './fit-probe'
import { FitActivityIdentityError } from './normalization'

function number(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null
}
type Identity = {
  startedAt: string
  distanceMeters: number | null
  elapsedMs: number | null
  sport: string
}

/** FIT SDK scales SI metrics; positions remain semicircles. Decode in memory without persistence. */
export function normalizeActivityRecords(
  bytes: Buffer,
  identity: Identity,
  deadlineAt?: number,
): ActivityCharts {
  const { messages } = decodeFitDownload(bytes, deadlineAt)
  const sessions = messages.sessionMesgs ?? []
  if (messages.fileIdMesgs?.[0]?.type !== 'activity' || !sessions.length)
    throw new FitActivityIdentityError()
  const knownSports: Record<string, string> = {
    running: 'RUNNING',
    cycling: 'CYCLING',
    swimming: 'SWIMMING',
    walking: 'WALKING',
  }
  const recordedSport = sessions.length === 1 ? knownSports[sessions[0].sport ?? ''] : undefined
  if (recordedSport && identity.sport !== 'OTHER' && recordedSport !== identity.sport)
    throw new FitActivityIdentityError()
  const bounds = sessions.map((session) => {
    const start = session.startTime instanceof Date ? session.startTime.getTime() : NaN
    const elapsed = number(session.totalElapsedTime)
    if (!Number.isFinite(start) || elapsed === null) throw new FitActivityIdentityError()
    return { start, end: start + elapsed * 1000, distance: number(session.totalDistance) }
  })
  const start = Math.min(...bounds.map((bound) => bound.start))
  const end = Math.max(...bounds.map((bound) => bound.end))
  const distance = bounds.every((bound) => bound.distance !== null)
    ? bounds.reduce((sum, bound) => sum + (bound.distance ?? 0), 0)
    : null
  if (
    Math.abs(start - Date.parse(identity.startedAt)) > 120_000 ||
    (distance !== null &&
      identity.distanceMeters !== null &&
      Math.abs(distance - identity.distanceMeters) >
        Math.max(100, distance * 0.02, identity.distanceMeters * 0.02)) ||
    (identity.elapsedMs !== null &&
      Math.abs(end - start - identity.elapsedMs) > Math.max(60_000, identity.elapsedMs * 0.05))
  )
    throw new FitActivityIdentityError()
  const samples: ActivitySample[] = []
  const running = identity.sport === 'RUNNING'
  for (const record of messages.recordMesgs ?? []) {
    const timestamp = record.timestamp instanceof Date ? record.timestamp.getTime() : NaN
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) continue
    const lat = number(record.positionLat, -2147483648, 2147483647)
    const lon = number(record.positionLong, -2147483648, 2147483647)
    const latitude = lat === null ? null : number((lat * 180) / 2147483648, -90, 90)
    const longitude = lon === null ? null : number((lon * 180) / 2147483648, -180, 180)
    const cadence = number(record.cadence, 0, 254)
    samples.push({
      timeSeconds: (timestamp - start) / 1000,
      distanceMeters: number(record.distance),
      heartRateBpm: number(record.heartRate, 1, 254),
      speedMps: number(record.enhancedSpeed ?? record.speed, 0, 200),
      powerWatts: number(record.power, 0, 65534),
      cadence:
        cadence === null
          ? null
          : (cadence + (number(record.fractionalCadence, 0, 1) ?? 0)) * (running ? 2 : 1),
      elevationMeters: number(record.enhancedAltitude ?? record.altitude, -500, 15000),
      latitude: longitude === null ? null : latitude,
      longitude: latitude === null ? null : longitude,
    })
  }
  samples.sort((a, b) => a.timeSeconds - b.timeSeconds)
  // Coalesce complementary measurements; conflicts keep the first valid value, including zero.
  // Coordinates are already normalized as complete pairs, so different GPS fixes are never mixed.
  const fields = [
    'distanceMeters',
    'heartRateBpm',
    'speedMps',
    'powerWatts',
    'cadence',
    'elevationMeters',
    'latitude',
    'longitude',
  ] as const
  const ordered: ActivitySample[] = []
  for (const sample of samples) {
    const previous = ordered.at(-1)
    if (!previous || previous.timeSeconds !== sample.timeSeconds) {
      ordered.push(sample)
      continue
    }
    for (const field of fields) {
      if (previous[field] === null) previous[field] = sample[field]
    }
  }
  const intervals = ordered
    .slice(1)
    .map((sample, index) => sample.timeSeconds - ordered[index].timeSeconds)
    .sort((a, b) => a - b)
  const sampleIntervalSeconds = intervals.length
    ? intervals[Math.floor(intervals.length / 2)]
    : null
  const gap = Math.max(30, (sampleIntervalSeconds ?? 1) * 4)
  let previousIndex = 0
  const reduced =
    ordered.length > 4000
      ? Array.from({ length: 4000 }, (_, index) => {
          const sourceIndex = Math.floor((index * (ordered.length - 1)) / 3999)
          const sample = ordered[sourceIndex]
          const previous = ordered[previousIndex]
          const breaks = new Set<(typeof activitySampleSeries)[number]>()
          for (let cursor = previousIndex + 1; cursor <= sourceIndex; cursor++) {
            const skipped = ordered[cursor]
            if (skipped.timeSeconds - ordered[cursor - 1].timeSeconds > gap)
              activitySampleSeries.forEach((series) => breaks.add(series))
            for (const series of activitySampleSeries) {
              if (series === 'position') {
                if (
                  previous.latitude !== null &&
                  sample.latitude !== null &&
                  skipped.latitude === null
                )
                  breaks.add(series)
              } else if (
                (previous[series] !== null || sample[series] !== null) &&
                (skipped[series] === null ||
                  (running && series === 'speedMps' && skipped[series] === 0))
              ) {
                breaks.add(series)
              }
            }
          }
          previousIndex = sourceIndex
          return breaks.size ? { ...sample, breakBefore: [...breaks] } : sample
        })
      : ordered
  const session: SessionMesg | undefined = sessions.length === 1 ? sessions[0] : undefined
  const validateZones = (values: unknown): number[] => {
    if (!Array.isArray(values) || !values.length || values.length > 10) return []
    const durations = values.map((value) => number(value))
    return durations.every((value): value is number => value !== null) &&
      durations.reduce((sum, value) => sum + value, 0) <= ((end - start) / 1000) * 1.05 + 5
      ? durations
      : []
  }
  let zones = validateZones(session?.timeInHrZone)
  if (session && !zones.some((duration) => duration > 0)) {
    // A separate time_in_zone message must explicitly reference this session, never a lap.
    const index = session.messageIndex ?? 0
    const candidates = (messages.timeInZoneMesgs ?? []).filter(
      (message) => message.referenceMesg === 'session' && message.referenceIndex === index,
    )
    if (candidates.length === 1) zones = validateZones(candidates[0].timeInHrZone)
  }
  return activityChartsSchema.parse({
    startedAt: new Date(start).toISOString(),
    samples: reduced,
    sourceSampleCount: ordered.length,
    sampleIntervalSeconds,
    cadenceUnit: running ? 'spm' : 'rpm',
    session: {
      avgPowerWatts: number(session?.avgPower),
      maxPowerWatts: number(session?.maxPower),
      aerobicTrainingEffect: number(session?.totalTrainingEffect, 0, 5),
      anaerobicTrainingEffect: number(session?.totalAnaerobicTrainingEffect, 0, 5),
      avgTemperatureCelsius: number(session?.avgTemperature, -100, 100),
      heartRateZoneSeconds: zones,
    },
  })
}
