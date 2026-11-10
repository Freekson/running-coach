import 'server-only'

import { z } from 'zod'
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
  activityUUID: z.string().trim().min(1).nullish(),
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

function normalizeFitLaps(
  bytes: Buffer,
  activityStartedAt: string,
  activityDistanceMeters: number | null,
  activityElapsedMs: number | null,
): CanonicalLap[] | null {
  const { messages } = decodeFitDownload(bytes)
  const sessions = messages.sessionMesgs ?? []
  const fileType = messages.fileIdMesgs?.[0]?.type
  if (fileType !== 'activity' || sessions.length === 0)
    throw new FitActivityIdentityError('Cannot verify FIT activity identity')
  if (activityDistanceMeters === null) return null
  const bounds: { startMs: number; endMs: number; distanceMeters: number }[] = []
  let firstStart = Number.POSITIVE_INFINITY
  let lastEnd = Number.NEGATIVE_INFINITY
  let fitDistance = 0
  for (const session of sessions) {
    const start = session.startTime
    const end = session.timestamp
    const distance = session.totalDistance
    if (
      !(start instanceof Date) ||
      Number.isNaN(start.getTime()) ||
      !(end instanceof Date) ||
      Number.isNaN(end.getTime()) ||
      end.getTime() < start.getTime() ||
      (distance !== undefined &&
        (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0))
    )
      throw new FitActivityIdentityError('Cannot verify FIT activity identity')
    if (distance === undefined) return null
    const startMs = start.getTime()
    const endMs = end.getTime()
    bounds.push({ startMs, endMs, distanceMeters: distance })
    firstStart = Math.min(firstStart, startMs)
    lastEnd = Math.max(lastEnd, endMs)
    fitDistance += distance
  }
  const fitElapsedMs = lastEnd - firstStart
  if (
    Math.abs(firstStart - Date.parse(activityStartedAt)) > 120_000 ||
    Math.abs(fitDistance - activityDistanceMeters) >
      Math.max(100, Math.max(fitDistance, activityDistanceMeters) * 0.02) ||
    (activityElapsedMs !== null &&
      Math.abs(fitElapsedMs - activityElapsedMs) >
        Math.max(60_000, Math.max(fitElapsedMs, activityElapsedMs) * 0.05))
  )
    throw new FitActivityIdentityError('FIT session does not match Garmin activity')
  const laps = messages.lapMesgs ?? []
  if (laps.length === 0) return null
  const parsedLaps = laps
    .map((lap, index) => {
      const start = lap.startTime
      const end = lap.timestamp
      if (
        !(start instanceof Date) ||
        Number.isNaN(start.getTime()) ||
        !(end instanceof Date) ||
        Number.isNaN(end.getTime()) ||
        end.getTime() < start.getTime()
      )
        throw new FitLapUnavailableError('Invalid FIT lap bounds')
      const startMs = start.getTime()
      const endMs = end.getTime()
      const sessionIndex = bounds.findIndex(
        (session) => startMs >= session.startMs - 2_000 && endMs <= session.endMs + 2_000,
      )
      if (sessionIndex < 0) throw new FitLapUnavailableError('FIT lap is outside its session')
      const elapsed = optionalMetric.safeParse(lap.totalElapsedTime)
      if (
        !elapsed.success ||
        (elapsed.data != null && elapsed.data * 1000 > Number.MAX_SAFE_INTEGER)
      )
        throw new FitLapUnavailableError('Invalid FIT lap duration')
      const elapsedMs = toMilliseconds(elapsed.data)
      if (elapsedMs !== null && Math.abs(elapsedMs - (endMs - startMs)) > 2_000)
        throw new FitLapUnavailableError('FIT lap duration does not match its timestamps')
      const distance = optionalMetric.safeParse(lap.totalDistance)
      const heartRate = optionalCount.safeParse(lap.avgHeartRate)
      const speed = optionalMetric.safeParse(lap.avgSpeed)
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
          startedAt: start.toISOString(),
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
  let previousEnd = Number.NEGATIVE_INFINITY
  for (const lap of parsedLaps) {
    if (lap.startMs < previousEnd - 2_000) throw new FitLapUnavailableError('Overlapping FIT laps')
    previousEnd = Math.max(previousEnd, lap.endMs)
    if (lap.distanceMeters !== null) {
      const total = distanceBySession[lap.sessionIndex] + lap.distanceMeters
      const sessionDistance = bounds[lap.sessionIndex].distanceMeters
      if (total > sessionDistance + Math.max(100, sessionDistance * 0.02))
        throw new FitLapUnavailableError('FIT laps exceed session distance')
      distanceBySession[lap.sessionIndex] = total
    }
  }
  return parsedLaps.map((lap, index) => ({ ...lap.canonical, lapIndex: index }))
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
      sportType: input.activityTypeDTO.typeKey === 'running' ? 'RUNNING' : 'OTHER',
      sourceSportType: input.activityTypeDTO.typeKey,
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
