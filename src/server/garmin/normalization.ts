import 'server-only'

import { z } from 'zod'
import { recordedActivitySurface } from '@/server/activity/surface'
import {
  canonicalActivitySchema,
  canonicalLapSchema,
  type ActivitySource,
  type ActivityNormalizationOptions,
  type CanonicalLap,
} from '@/server/activity/normalization'
import {
  dailyHealthObservationSchema,
  type DailyHealthObservation,
} from '@/server/health/normalization'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { decodeFitDownload } from './fit-probe'

const optionalMetric = z.number().finite().nonnegative().nullish()
const optionalCount = z.number().int().nonnegative().nullish()
const utcWallTime = z.string().regex(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,3})?$/)
const zoneName = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value })
      return true
    } catch {
      return false
    }
  }, 'Invalid IANA time zone')

const garminActivitySchema = z.object({
  activityId: z.union([z.string().trim().min(1), z.number().int().nonnegative().safe()]),
  activityUUID: z
    .union([
      z.string().trim().min(1),
      z.object({ uuid: z.uuid() }).transform((value) => value.uuid),
    ])
    .nullish(),
  activityName: z.string().trim().max(200).nullish(),
  activityTypeDTO: z.object({ typeKey: z.string().trim().min(1) }),
  timeZoneUnitDTO: z.object({ timeZone: zoneName }).nullish(),
  summaryDTO: z.object({
    startTimeGMT: utcWallTime,
    startTimeLocal: utcWallTime.nullish(),
    distance: optionalMetric,
    duration: optionalMetric,
    elapsedDuration: optionalMetric,
    movingDuration: optionalMetric,
    averageSpeed: optionalMetric,
    averageHR: optionalCount,
    maxHR: optionalCount,
    averageRunningCadenceInStepsPerMinute: optionalMetric,
    elevationGain: optionalMetric,
    elevationLoss: optionalMetric,
    calories: z.number().int().min(0).max(2_147_483_647).nullish(),
  }),
})

const dailySummarySchema = z.object({
  calendarDate: z.iso.date(),
  heartRate: z.object({ restingValue: optionalCount }).nullish(),
})

const sleepSchema = z.object({
  calendarDate: z.iso.date(),
  sleepTimeSeconds: optionalMetric,
  lightSleepSeconds: optionalMetric,
  deepSleepSeconds: optionalMetric,
  remSleepSeconds: optionalMetric,
  awakeSleepSeconds: optionalMetric,
  sleepScores: z
    .object({ overall: z.object({ value: z.number().int().min(0).max(100).nullish() }).nullish() })
    .nullish(),
  sleepStartTimestampGMT: z.number().int().nullish(),
  sleepStartTimestampLocal: z.number().int().nullish(),
  sleepEndTimestampGMT: z.number().int().nullish(),
  sleepEndTimestampLocal: z.number().int().nullish(),
})

function epochMs(value: number): string {
  if (!Number.isSafeInteger(value) || value < Date.UTC(2000, 0, 1) || value > Date.UTC(2100, 0, 1))
    throw new Error('Invalid Garmin epoch-millisecond timestamp')
  return new Date(value).toISOString()
}

function utcInstant(wallTime: string): string {
  const iso = `${wallTime.replace(' ', 'T')}Z`
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== iso.slice(0, 19))
    throw new Error('Invalid Garmin UTC wall time')
  return date.toISOString()
}

function localWallEpoch(instant: string, zone: string): number {
  const date = new Date(instant)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const field = (name: string) => Number(parts.find((part) => part.type === name)?.value)
  return Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
    date.getUTCMilliseconds(),
  )
}

function validateLocalWall(instant: string, local: string, zone: string): void {
  const localAsUtc = utcInstant(local)
  const fractionalDigits = local.match(/\.(\d{1,3})$/)?.[1].length ?? 0
  const precisionMs = 10 ** (3 - fractionalDigits)
  if (
    Math.floor(localWallEpoch(instant, zone) / precisionMs) !==
    Math.floor(Date.parse(localAsUtc) / precisionMs)
  )
    throw new Error('Garmin local time does not match source time zone')
}

function toMilliseconds(seconds: number | null | undefined): number | null {
  if (seconds == null) return null
  const milliseconds = seconds * 1000
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > Number.MAX_SAFE_INTEGER)
    throw new Error('Invalid Garmin duration')
  return Math.round(milliseconds)
}

export class FitActivityIdentityError extends Error {}

export class FitLapUnavailableError extends Error {}

// FIT summary timestamps are write times, including for summary-first exports.
// https://forums.garmin.com/developer/fit-sdk/b/news-announcements/posts/important-fit-activity-file-message-change
function fitSummaryBounds(start: unknown, elapsedSeconds: unknown) {
  if (!(start instanceof Date) || !Number.isFinite(start.getTime())) return null
  const elapsed = optionalMetric.safeParse(elapsedSeconds)
  if (!elapsed.success || elapsed.data == null) return null
  const elapsedMs = toMilliseconds(elapsed.data)
  if (elapsedMs === null) return null
  const startMs = start.getTime()
  const endMs = startMs + elapsedMs
  if (!Number.isFinite(new Date(endMs).getTime())) return null
  return { startMs, endMs, elapsedMs }
}

export function normalizeFitLaps(
  bytes: Buffer,
  activityStartedAt: string,
  activityDistanceMeters: number | null,
  activityElapsedMs: number | null,
  options: {
    allowMissingDistance?: boolean
    deadlineAt?: number
    allowConfirmedEmpty?: boolean
  } = {},
): CanonicalLap[] | null {
  const { messages } = decodeFitDownload(bytes, options.deadlineAt)
  const sessions = messages.sessionMesgs ?? []
  const fileType = messages.fileIdMesgs?.[0]?.type
  if (fileType !== 'activity' || sessions.length === 0)
    throw new FitActivityIdentityError('Cannot verify FIT activity identity')
  if (activityDistanceMeters === null && !options.allowMissingDistance) return null
  const bounds: {
    startMs: number
    endMs: number
    distanceMeters: number | null
    confirmedNoLaps: boolean
  }[] = []
  let firstStart = Number.POSITIVE_INFINITY
  let lastEnd = Number.NEGATIVE_INFINITY
  let fitDistance = 0
  let hasFitDistance = true
  for (const session of sessions) {
    const duration = fitSummaryBounds(session.startTime, session.totalElapsedTime)
    const distance = session.totalDistance
    if (
      !duration ||
      (distance !== undefined &&
        (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0))
    )
      throw new FitActivityIdentityError('Cannot verify FIT activity identity')
    if (distance === undefined && !options.allowMissingDistance) return null
    if (distance === undefined) hasFitDistance = false
    const { startMs, endMs } = duration
    bounds.push({
      startMs,
      endMs,
      distanceMeters: distance ?? null,
      confirmedNoLaps: session.numLaps === 0,
    })
    firstStart = Math.min(firstStart, startMs)
    lastEnd = Math.max(lastEnd, endMs)
    fitDistance += distance ?? 0
  }
  const fitElapsedMs = lastEnd - firstStart
  if (
    Math.abs(firstStart - Date.parse(activityStartedAt)) > 120_000 ||
    (hasFitDistance &&
      activityDistanceMeters !== null &&
      Math.abs(fitDistance - activityDistanceMeters) >
        Math.max(100, Math.max(fitDistance, activityDistanceMeters) * 0.02)) ||
    (activityElapsedMs !== null &&
      Math.abs(fitElapsedMs - activityElapsedMs) >
        Math.max(60_000, Math.max(fitElapsedMs, activityElapsedMs) * 0.05))
  )
    throw new FitActivityIdentityError('FIT session does not match Garmin activity')
  const laps = messages.lapMesgs ?? []
  if (laps.length > 10_000) throw new FitLapUnavailableError('Too many FIT laps')
  if (laps.length === 0)
    return options.allowConfirmedEmpty && sessions.every((session) => session.numLaps === 0)
      ? []
      : null
  const parsedLaps = laps
    .map((lap, index) => {
      const duration = fitSummaryBounds(lap.startTime, lap.totalElapsedTime)
      if (!duration) throw new FitLapUnavailableError('Invalid FIT lap bounds or duration')
      const { startMs, endMs, elapsedMs } = duration
      const containsLap = (session: (typeof bounds)[number]) =>
        startMs >= session.startMs - 2_000 && endMs <= session.endMs + 2_000
      let sessionIndex = bounds.findIndex(
        (session) => !session.confirmedNoLaps && containsLap(session),
      )
      if (sessionIndex < 0) sessionIndex = bounds.findIndex(containsLap)
      if (sessionIndex < 0) throw new FitLapUnavailableError('FIT lap is outside its session')
      const distance = optionalMetric.safeParse(lap.totalDistance)
      const heartRate = optionalCount.safeParse(lap.avgHeartRate)
      const speed = optionalMetric.safeParse(lap.enhancedAvgSpeed ?? lap.avgSpeed)
      if (!distance.success || !heartRate.success || !speed.success)
        throw new FitLapUnavailableError('Invalid FIT lap metrics')
      const distanceMeters = distance.data ?? null
      return {
        startMs,
        endMs,
        sessionIndex,
        distanceMeters,
        canonical: canonicalLapSchema.parse({
          lapIndex: index,
          startedAt: new Date(startMs).toISOString(),
          ...normalizeLapMetrics(lap, new Date(endMs), elapsedMs),
          distanceMeters,
          elapsedMs,
          movingMs: null,
          avgHrBpm: heartRate.data ?? null,
          avgSpeedMps: speed.data ?? null,
          cadenceStepsPerMinute: null,
          sourceRecordType: 'FIT_LAP',
        }),
      }
    })
    .sort((a, b) => a.startMs - b.startMs || a.canonical.lapIndex - b.canonical.lapIndex)
  const distanceBySession = bounds.map(() => 0)
  const elapsedBySession = bounds.map(() => 0)
  const lapCountBySession = bounds.map(() => 0)
  let previousEnd = Number.NEGATIVE_INFINITY
  for (const lap of parsedLaps) {
    if (lap.startMs < previousEnd - 2_000) throw new FitLapUnavailableError('Overlapping FIT laps')
    previousEnd = Math.max(previousEnd, lap.endMs)
    elapsedBySession[lap.sessionIndex] += lap.endMs - lap.startMs
    lapCountBySession[lap.sessionIndex]++
    if (lap.distanceMeters !== null) {
      const total = distanceBySession[lap.sessionIndex] + lap.distanceMeters
      const sessionDistance = bounds[lap.sessionIndex].distanceMeters
      if (
        sessionDistance !== null &&
        total > sessionDistance + Math.max(100, sessionDistance * 0.02)
      )
        throw new FitLapUnavailableError('FIT laps exceed session distance')
      distanceBySession[lap.sessionIndex] = total
    }
  }
  for (const [index, session] of bounds.entries()) {
    if (session.confirmedNoLaps) {
      if (lapCountBySession[index] > 0)
        throw new FitLapUnavailableError('FIT lap count does not match its session')
      continue
    }
    if (
      Math.abs(elapsedBySession[index] - (session.endMs - session.startMs)) >
      Math.max(2_000, parsedLaps.length * 2)
    )
      throw new FitLapUnavailableError('FIT laps do not cover session duration')
  }
  return parsedLaps.map((lap, index) => ({ ...lap.canonical, lapIndex: index }))
}

function normalizeLapMetrics(
  lap: import('@garmin/fitsdk').LapMesg,
  end: Date,
  elapsedMs: number | null,
) {
  const timerMs = toMilliseconds(optionalMetric.parse(lap.totalTimerTime))
  if (timerMs !== null && elapsedMs !== null && timerMs > elapsedMs + 2_000)
    throw new FitLapUnavailableError('FIT timer exceeds elapsed duration')
  const cadence = optionalMetric.parse(lap.avgCadence)
  const fractional = optionalMetric.parse(lap.avgFractionalCadence)
  return {
    endedAt: end.toISOString(),
    timerMs,
    maxHrBpm: optionalCount.parse(lap.maxHeartRate) ?? null,
    cadenceCyclesPerMinute: cadence == null ? null : cadence + (fractional ?? 0),
    avgPowerWatts: optionalMetric.parse(lap.avgPower) ?? null,
    maxPowerWatts: optionalMetric.parse(lap.maxPower) ?? null,
    maxSpeedMps: optionalMetric.parse(lap.enhancedMaxSpeed ?? lap.maxSpeed) ?? null,
    elevationGainMeters: optionalMetric.parse(lap.totalAscent) ?? null,
    elevationLossMeters: optionalMetric.parse(lap.totalDescent) ?? null,
  }
}

export const garminActivitySource = {
  provider: 'GARMIN',
  normalizeActivity(owner: OwnerContext, payload: unknown, options?: ActivityNormalizationOptions) {
    const userId = ownerId(owner)
    const input = garminActivitySchema.parse(payload)
    const startedAt = utcInstant(input.summaryDTO.startTimeGMT)
    const timezone = input.timeZoneUnitDTO?.timeZone ?? null
    if (timezone && input.summaryDTO.startTimeLocal)
      validateLocalWall(startedAt, input.summaryDTO.startTimeLocal, timezone)
    return canonicalActivitySchema.parse({
      source: {
        userId,
        provider: 'GARMIN',
        externalActivityId: String(input.activityId),
        externalActivityUuid: input.activityUUID ?? null,
        recordType: 'API_ACTIVITY',
      },
      sportType: garminSport(input.activityTypeDTO.typeKey),
      sourceSportType: input.activityTypeDTO.typeKey,
      surfaceType: recordedActivitySurface({
        sportType: garminSport(input.activityTypeDTO.typeKey),
        sourceProvider: 'GARMIN',
        sourceSportType: input.activityTypeDTO.typeKey,
      }),
      startedAt,
      sourceTimezone: timezone,
      gpsAssetRef: null,
      distanceMeters: input.summaryDTO.distance ?? null,
      totalMs: toMilliseconds(input.summaryDTO.duration),
      elapsedMs: toMilliseconds(input.summaryDTO.elapsedDuration),
      movingMs: toMilliseconds(input.summaryDTO.movingDuration),
      avgSpeedMps: input.summaryDTO.averageSpeed ?? null,
      avgHrBpm: input.summaryDTO.averageHR ?? null,
      maxHrBpm: input.summaryDTO.maxHR ?? null,
      cadenceStepsPerMinute: input.summaryDTO.averageRunningCadenceInStepsPerMinute ?? null,
      elevationGainMeters: input.summaryDTO.elevationGain ?? null,
      elevationLossMeters: input.summaryDTO.elevationLoss ?? null,
      calories: input.summaryDTO.calories ?? null,
      activityTitle: input.activityName || null,
      laps:
        options?.sourceFile === undefined
          ? null
          : normalizeFitLaps(
              options.sourceFile,
              startedAt,
              input.summaryDTO.distance ?? null,
              toMilliseconds(input.summaryDTO.elapsedDuration),
            ),
    })
  },
} satisfies ActivitySource

function garminSport(type: string) {
  if (/(^|_)running$/.test(type)) return 'RUNNING'
  if (/(^|_)cycling$/.test(type)) return 'CYCLING'
  if (/(^|_)walking$/.test(type)) return 'WALKING'
  if (/(^|_)swimming$/.test(type)) return 'SWIMMING'
  return 'OTHER'
}

/** List summaries contain metrics directly; splitSummaries are never ordered laps. */
export function normalizeGarminActivitySummary(owner: OwnerContext, payload: unknown) {
  const row = z
    .object({
      activityId: garminActivitySchema.shape.activityId,
      activityUUID: garminActivitySchema.shape.activityUUID,
      activityType: z.object({ typeKey: z.string().trim().min(1) }),
      startTimeGMT: utcWallTime,
      startTimeLocal: utcWallTime.nullish(),
      beginTimestamp: z.number().int().safe().nullish(),
    })
    .passthrough()
    .parse(payload)
  if (
    row.beginTimestamp != null &&
    Math.abs(Date.parse(utcInstant(row.startTimeGMT)) - row.beginTimestamp) > 1000
  )
    throw new Error('Inconsistent Garmin activity timestamp')
  return garminActivitySource.normalizeActivity(owner, {
    activityId: row.activityId,
    activityUUID: row.activityUUID,
    activityName: row.activityName,
    activityTypeDTO: row.activityType,
    summaryDTO: row,
  })
}

function healthBase(owner: OwnerContext, sourceTimezone: string) {
  return {
    userId: ownerId(owner),
    sourceProvider: 'GARMIN' as const,
    sourceTimezone: zoneName.parse(sourceTimezone),
    sourceRecordId: null,
    restingHrBpm: null,
    hrvMs: null,
    sleepDurationMs: null,
    sleepStartedAt: null,
    sleepEndedAt: null,
    sleepLightMs: null,
    sleepDeepMs: null,
    sleepRemMs: null,
    sleepAwakeMs: null,
    sleepScore: null,
    steps: null,
    stress: null,
    bodyBattery: null,
  }
}

export function normalizeGarminDailySummary(
  owner: OwnerContext,
  sourceTimezone: string,
  dailySummary: unknown,
): DailyHealthObservation {
  const base = healthBase(owner, sourceTimezone)
  const summary = dailySummarySchema.parse(dailySummary)
  return dailyHealthObservationSchema.parse({
    ...base,
    sourceRecordType: 'API_DAILY_SUMMARY',
    localDate: summary.calendarDate,
    restingHrBpm: summary.heartRate?.restingValue || null,
  })
}

export function normalizeGarminSleep(
  owner: OwnerContext,
  sourceTimezone: string,
  sleep: unknown,
): DailyHealthObservation {
  const base = healthBase(owner, sourceTimezone)
  const sleepData = sleepSchema.parse(sleep)
  let sleepStartedAt: string | null = null
  if (sleepData.sleepStartTimestampGMT != null) {
    sleepStartedAt = epochMs(sleepData.sleepStartTimestampGMT)
    // The supplied IANA zone is inferred. The local clock cannot validate it
    // across travel, so only validate the local timestamp's numeric form.
    if (sleepData.sleepStartTimestampLocal != null) epochMs(sleepData.sleepStartTimestampLocal)
  } else if (sleepData.sleepStartTimestampLocal != null) {
    epochMs(sleepData.sleepStartTimestampLocal)
  }
  const sleepEndedAt =
    sleepData.sleepEndTimestampGMT == null ? null : epochMs(sleepData.sleepEndTimestampGMT)
  if (sleepData.sleepEndTimestampLocal != null) epochMs(sleepData.sleepEndTimestampLocal)
  if (sleepStartedAt && sleepEndedAt && sleepEndedAt < sleepStartedAt)
    throw new Error('Garmin sleep end precedes start')
  return dailyHealthObservationSchema.parse({
    ...base,
    sourceRecordType: 'API_SLEEP',
    localDate: sleepData.calendarDate,
    sleepDurationMs:
      sleepData.sleepTimeSeconds === 0 ? null : toMilliseconds(sleepData.sleepTimeSeconds),
    sleepStartedAt,
    sleepEndedAt,
    sleepLightMs: toMilliseconds(sleepData.lightSleepSeconds),
    sleepDeepMs: toMilliseconds(sleepData.deepSleepSeconds),
    sleepRemMs: toMilliseconds(sleepData.remSleepSeconds),
    sleepAwakeMs: toMilliseconds(sleepData.awakeSleepSeconds),
    sleepScore: sleepData.sleepScores?.overall?.value ?? null,
  })
}
