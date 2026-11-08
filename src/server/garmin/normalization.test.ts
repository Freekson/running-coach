import { Encoder, Profile, type FileIdMesg, type LapMesg, type SessionMesg } from '@garmin/fitsdk'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/db/client', () => ({ getPrismaClient: vi.fn() }))

import {
  activityUpsertKey,
  isCrossProviderDuplicateCandidate,
  paceSecondsPerKm,
  canonicalActivitySchema,
  type ActivitySource,
} from '@/server/activity/normalization'
import { getOwnerContext } from '@/server/authorization/ownership'
import {
  garminActivitySource,
  normalizeGarminDailySummary,
  normalizeGarminSleep,
} from './normalization'

const ownerAId = '00000000-0000-4000-8000-000000000001'
const ownerBId = '00000000-0000-4000-8000-000000000002'
const ownerA = getOwnerContext({ id: ownerAId, role: 'USER', email: null })
const ownerB = getOwnerContext({ id: ownerBId, role: 'USER', email: null })

const activity = {
  activityId: 321,
  activityUUID: 'synthetic-uuid',
  activityTypeDTO: { typeKey: 'running' },
  timeZoneUnitDTO: { timeZone: 'America/New_York' },
  summaryDTO: {
    startTimeGMT: '2026-11-01 06:30:00',
    startTimeLocal: '2026-11-01 01:30:00',
    distance: 5000,
    duration: 1800,
    elapsedDuration: 1900,
    movingDuration: 1750,
    averageSpeed: 2.78,
    averageHR: 145,
    maxHR: 172,
    averageRunningCadenceInStepsPerMinute: 166,
    elevationGain: 42,
  },
}

function fitWithLap({
  startTime = '2026-11-01T06:30:00Z',
  sessionDistance = 5000,
  elapsedSeconds = 1900,
  lapElapsedSeconds = elapsedSeconds,
  lapStartOffsetMs = 0,
  lapDistance = sessionDistance,
  includeLap = true,
}: {
  startTime?: string
  sessionDistance?: number | null
  elapsedSeconds?: number
  lapElapsedSeconds?: number
  lapStartOffsetMs?: number
  lapDistance?: number | null
  includeLap?: boolean
} = {}): Buffer {
  const encoder = new Encoder()
  const sessionStart = new Date(startTime)
  const sessionEnd = new Date(sessionStart.getTime() + Math.round(elapsedSeconds * 1000))
  const lapStart = new Date(sessionStart.getTime() + lapStartOffsetMs)
  const lapEnd = new Date(lapStart.getTime() + Math.round(elapsedSeconds * 1000))
  const fileId: FileIdMesg = {
    type: 'activity',
    manufacturer: 'development',
    product: 1,
    timeCreated: sessionStart,
  }
  const lap: LapMesg = {
    startTime: lapStart,
    timestamp: lapEnd,
    totalElapsedTime: lapElapsedSeconds,
    ...(lapDistance === null ? {} : { totalDistance: lapDistance }),
    avgHeartRate: 140,
  }
  const session: SessionMesg = {
    startTime: sessionStart,
    timestamp: sessionEnd,
    totalElapsedTime: elapsedSeconds,
    ...(sessionDistance === null ? {} : { totalDistance: sessionDistance }),
  }
  encoder.onMesg(Profile.MesgNum.FILE_ID, fileId)
  if (includeLap) encoder.onMesg(Profile.MesgNum.LAP, lap)
  encoder.onMesg(Profile.MesgNum.SESSION, session)
  return Buffer.from(encoder.close())
}

function fitWithTwoSessions(): Buffer {
  const encoder = new Encoder()
  const fileId: FileIdMesg = {
    type: 'activity',
    manufacturer: 'development',
    product: 1,
    timeCreated: new Date('2026-11-01T06:30:00Z'),
  }
  encoder.onMesg(Profile.MesgNum.FILE_ID, fileId)
  for (const [index, distance] of [2000, 3000].entries()) {
    const startTime = new Date(Date.parse('2026-11-01T06:30:00Z') + index * 600_000)
    const timestamp = new Date(startTime.getTime() + 600_000)
    const lap: LapMesg = {
      startTime,
      timestamp,
      totalElapsedTime: 600,
      totalDistance: distance,
    }
    const session: SessionMesg = {
      startTime,
      timestamp,
      totalElapsedTime: 600,
      totalDistance: distance,
    }
    encoder.onMesg(Profile.MesgNum.LAP, lap)
    encoder.onMesg(Profile.MesgNum.SESSION, session)
  }
  return Buffer.from(encoder.close())
}

describe('Garmin activity normalization', () => {
  it('converts verified units, preserves provenance and optional FIT laps', () => {
    const source: ActivitySource = garminActivitySource
    const result = source.normalizeActivity(ownerA, activity, { sourceFile: fitWithLap() })
    expect(result.source).toEqual({
      userId: ownerAId,
      provider: 'GARMIN',
      externalActivityId: '321',
      externalActivityUuid: 'synthetic-uuid',
      recordType: 'API_ACTIVITY',
    })
    expect(result).toMatchObject({
      startedAt: '2026-11-01T06:30:00.000Z',
      sportType: 'RUNNING',
      sourceSportType: 'running',
      gpsAssetRef: null,
      distanceMeters: 5000,
      totalMs: 1_800_000,
      elapsedMs: 1_900_000,
      movingMs: 1_750_000,
      avgSpeedMps: 2.78,
      cadenceStepsPerMinute: 166,
      elevationGainMeters: 42,
      elevationLossMeters: null,
    })
    expect(result.laps).toMatchObject([
      {
        lapIndex: 0,
        distanceMeters: 5000,
        elapsedMs: 1_900_000,
        movingMs: null,
        avgHrBpm: 140,
        sourceRecordType: 'FIT_LAP',
      },
    ])
    expect(garminActivitySource.normalizeActivity(ownerA, activity).laps).toBeNull()
    expect(paceSecondsPerKm(5000, 1_800_000)).toBe(360)
  })

  it('keeps missing metrics null and rejects malformed or conflicting times', () => {
    const sparse = garminActivitySource.normalizeActivity(ownerA, {
      activityId: 'sparse',
      activityTypeDTO: { typeKey: 'running' },
      summaryDTO: { startTimeGMT: '2026-11-01 06:30:00' },
    })
    expect(sparse.distanceMeters).toBeNull()
    expect(sparse.avgHrBpm).toBeNull()
    expect(sparse.cadenceStepsPerMinute).toBeNull()
    expect(sparse.sourceTimezone).toBeNull()
    expect(sparse.gpsAssetRef).toBeNull()
    expect(() =>
      garminActivitySource.normalizeActivity(ownerA, {
        ...activity,
        summaryDTO: { ...activity.summaryDTO, duration: -1 },
      }),
    ).toThrow()
    expect(() =>
      garminActivitySource.normalizeActivity(ownerA, {
        ...activity,
        summaryDTO: { ...activity.summaryDTO, startTimeLocal: '2026-11-01 02:30:00' },
      }),
    ).toThrow()
    expect(() =>
      garminActivitySource.normalizeActivity(ownerA, {
        ...activity,
        summaryDTO: { ...activity.summaryDTO, startTimeGMT: '2026-02-30 06:30:00' },
      }),
    ).toThrow()
    expect(() => garminActivitySource.normalizeActivity({ userId: ownerAId }, activity)).toThrow(
      'Verified owner context required',
    )
  })

  it('rounds fractional seconds to integer milliseconds', () => {
    const result = garminActivitySource.normalizeActivity(
      ownerA,
      {
        ...activity,
        summaryDTO: {
          ...activity.summaryDTO,
          duration: 1.001,
          elapsedDuration: 1.001,
        },
      },
      { sourceFile: fitWithLap({ elapsedSeconds: 1.001 }) },
    )
    expect(result.totalMs).toBe(1001)
    expect(result.elapsedMs).toBe(1001)
    expect(result.laps?.[0].elapsedMs).toBe(1001)
    expect(
      normalizeGarminSleep(ownerA, 'UTC', {
        calendarDate: '2026-11-01',
        sleepTimeSeconds: 1.001,
      }).sleepDurationMs,
    ).toBe(1001)
  })

  it('checks local wall time at its supplied precision during the repeated DST hour', () => {
    for (const startTimeGMT of ['2026-11-01 05:30:00.500', '2026-11-01 06:30:00.500']) {
      const result = garminActivitySource.normalizeActivity(ownerA, {
        ...activity,
        summaryDTO: { ...activity.summaryDTO, startTimeGMT },
      })
      expect(result.startedAt).toBe(`${startTimeGMT.replace(' ', 'T')}Z`)
    }
    expect(
      garminActivitySource.normalizeActivity(ownerA, {
        ...activity,
        summaryDTO: {
          ...activity.summaryDTO,
          startTimeGMT: '2026-11-01 06:30:00.500',
          startTimeLocal: '2026-11-01 01:30:00.5',
        },
      }).startedAt,
    ).toBe('2026-11-01T06:30:00.500Z')
    expect(() =>
      garminActivitySource.normalizeActivity(ownerA, {
        ...activity,
        summaryDTO: {
          ...activity.summaryDTO,
          startTimeGMT: '2026-11-01 06:30:00.500',
          startTimeLocal: '2026-11-01 01:30:00.4',
        },
      }),
    ).toThrow('Garmin local time does not match source time zone')
  })

  it('rejects mismatched FIT sessions but keeps activities when optional distance evidence is absent', () => {
    expect(() =>
      garminActivitySource.normalizeActivity(ownerA, activity, {
        sourceFile: fitWithLap({ startTime: '2026-11-02T06:30:00Z' }),
      }),
    ).toThrow('FIT session does not match Garmin activity')
    expect(() =>
      garminActivitySource.normalizeActivity(ownerA, activity, {
        sourceFile: fitWithLap({ sessionDistance: 8000 }),
      }),
    ).toThrow('FIT session does not match Garmin activity')
    expect(() =>
      garminActivitySource.normalizeActivity(ownerA, activity, {
        sourceFile: fitWithLap({ elapsedSeconds: 300 }),
      }),
    ).toThrow('FIT session does not match Garmin activity')
    const noJsonDistance = garminActivitySource.normalizeActivity(
      ownerA,
      { ...activity, summaryDTO: { ...activity.summaryDTO, distance: null } },
      { sourceFile: fitWithLap() },
    )
    expect(noJsonDistance.laps).toBeNull()
    const noSessionDistance = garminActivitySource.normalizeActivity(ownerA, activity, {
      sourceFile: fitWithLap({ sessionDistance: null }),
    })
    expect(noSessionDistance.laps).toBeNull()
    expect(
      garminActivitySource.normalizeActivity(ownerA, activity, {
        sourceFile: fitWithLap({ includeLap: false }),
      }).laps,
    ).toBeNull()
  })

  it('checks summed distance across multiple FIT sessions before attaching laps', () => {
    const result = garminActivitySource.normalizeActivity(
      ownerA,
      { ...activity, summaryDTO: { ...activity.summaryDTO, elapsedDuration: 1200 } },
      { sourceFile: fitWithTwoSessions() },
    )
    expect(result.laps?.map((lap) => lap.distanceMeters)).toEqual([2000, 3000])
  })

  it('rejects laps outside the matched session or exceeding its distance', () => {
    expect(() =>
      garminActivitySource.normalizeActivity(ownerA, activity, {
        sourceFile: fitWithLap({ lapStartOffsetMs: 3_600_000 }),
      }),
    ).toThrow('FIT lap is outside its session')
    expect(() =>
      garminActivitySource.normalizeActivity(ownerA, activity, {
        sourceFile: fitWithLap({ lapDistance: 7000 }),
      }),
    ).toThrow('FIT laps exceed session distance')
    expect(() =>
      garminActivitySource.normalizeActivity(ownerA, activity, {
        sourceFile: fitWithLap({ lapElapsedSeconds: 300 }),
      }),
    ).toThrow('FIT lap duration does not match its timestamps')
  })
})

describe('identity and duplicate candidates', () => {
  const first = garminActivitySource.normalizeActivity(ownerA, activity)
  it('scopes upsert identity by user and provider', () => {
    const otherOwner = garminActivitySource.normalizeActivity(ownerB, activity)
    expect(activityUpsertKey(first.source)).not.toBe(activityUpsertKey(otherOwner.source))
    expect(activityUpsertKey({ ...first.source, provider: 'INTERVALS' })).not.toBe(
      activityUpsertKey(first.source),
    )
    expect(activityUpsertKey({ ...first.source, externalActivityId: null })).toBeNull()
    const manual = canonicalActivitySchema.parse({
      ...first,
      source: {
        userId: ownerAId,
        provider: 'MANUAL',
        externalActivityId: null,
        externalActivityUuid: null,
        recordType: 'MANUAL_ENTRY',
      },
      sourceSportType: null,
      laps: null,
    })
    expect(manual.source.provider).toBe('MANUAL')
    expect(activityUpsertKey(manual.source)).toBeNull()
    expect(
      canonicalActivitySchema.parse({ ...manual, gpsAssetRef: 'private/activity-gps' }).gpsAssetRef,
    ).toBe('private/activity-gps')
    expect(() => canonicalActivitySchema.parse({ ...manual, sportType: 'Run' })).toThrow()
  })

  it('flags only plausible cross-provider records for human review', () => {
    const second = canonicalActivitySchema.parse({
      ...first,
      source: { ...first.source, provider: 'INTERVALS' },
      sourceSportType: 'Run',
      startedAt: '2026-11-01T06:31:00.000Z',
    })
    expect(isCrossProviderDuplicateCandidate(first, second)).toBe(true)
    expect(isCrossProviderDuplicateCandidate(first, { ...second, elapsedMs: null })).toBe(true)
    expect(
      isCrossProviderDuplicateCandidate(first, {
        ...second,
        elapsedMs: null,
        distanceMeters: 6000,
      }),
    ).toBe(false)
    expect(
      isCrossProviderDuplicateCandidate(first, {
        ...second,
        source: { ...second.source, userId: ownerBId },
      }),
    ).toBe(false)
    expect(isCrossProviderDuplicateCandidate(first, { ...second, distanceMeters: 6000 })).toBe(
      false,
    )
    expect(
      isCrossProviderDuplicateCandidate(first, {
        ...second,
        startedAt: '2026-11-01T07:00:00.000Z',
      }),
    ).toBe(false)
    expect(isCrossProviderDuplicateCandidate(first, { ...first })).toBe(false)
    expect(isCrossProviderDuplicateCandidate(first, { ...second, sportType: 'OTHER' })).toBe(false)
    const unknown = garminActivitySource.normalizeActivity(ownerA, {
      ...activity,
      activityTypeDTO: { typeKey: 'unverified_sport' },
    })
    expect(unknown.sportType).toBe('OTHER')
    expect(unknown.sourceSportType).toBe('unverified_sport')
    expect(paceSecondsPerKm(0, 1000)).toBeNull()
    expect(paceSecondsPerKm(null, 1000)).toBeNull()
  })
})

describe('Garmin health normalization', () => {
  it('normalizes daily summary and sleep separately at both sides of DST', () => {
    const summary = normalizeGarminDailySummary(ownerA, 'America/New_York', {
      calendarDate: '2026-11-01',
      heartRate: { restingValue: 52, restingHeartRate: 99 },
      hrvSummary: { lastNightAvg: 34 },
      bodyBattery: { unknown: 99 },
    })
    expect(summary.sourceRecordType).toBe('API_DAILY_SUMMARY')
    expect(summary.restingHrBpm).toBe(52)
    expect(summary.sleepDurationMs).toBeNull()
    expect(summary.hrvMs).toBeNull()
    expect(summary.bodyBattery).toBeNull()
    for (const [gmt, local] of [
      [Date.parse('2026-11-01T05:30:00Z'), Date.parse('2026-11-01T01:30:00Z')],
      [Date.parse('2026-11-01T06:30:00Z'), Date.parse('2026-11-01T01:30:00Z')],
    ]) {
      const sleep = normalizeGarminSleep(ownerA, 'America/New_York', {
        calendarDate: '2026-11-01',
        sleepTimeSeconds: 3600,
        sleepStartTimestampGMT: gmt,
        sleepStartTimestampLocal: local,
      })
      expect(sleep.sourceRecordType).toBe('API_SLEEP')
      expect(sleep.restingHrBpm).toBeNull()
      expect(sleep.sleepDurationMs).toBe(3_600_000)
      expect(sleep.sleepStartedAt).toBe(new Date(gmt).toISOString())
    }
  })

  it('retains measured sleep duration without inventing a UTC instant from a local-only timestamp', () => {
    const sleep = normalizeGarminSleep(ownerA, 'America/New_York', {
      calendarDate: '2026-11-01',
      sleepTimeSeconds: 3600,
      sleepStartTimestampLocal: Date.parse('2026-11-01T01:30:00Z'),
    })
    expect(sleep.sleepDurationMs).toBe(3_600_000)
    expect(sleep.sleepStartedAt).toBeNull()
  })

  it('does not invent values and rejects unverified timestamp forms', () => {
    const summary = { calendarDate: '2026-11-01' }
    expect(normalizeGarminDailySummary(ownerA, 'UTC', summary).restingHrBpm).toBeNull()
    expect(normalizeGarminSleep(ownerA, 'UTC', summary).sleepDurationMs).toBeNull()
    expect(() => normalizeGarminSleep({ userId: ownerAId }, 'UTC', summary)).toThrow(
      'Verified owner context required',
    )
    expect(() =>
      normalizeGarminSleep(ownerA, 'UTC', {
        calendarDate: '2026-11-01',
        sleepStartTimestampGMT: '2026-11-01T00:00:00Z',
      }),
    ).toThrow()
    expect(() =>
      normalizeGarminSleep(ownerA, 'UTC', {
        calendarDate: '2026-11-01',
        sleepStartTimestampLocal: 1234,
      }),
    ).toThrow()
    expect(() =>
      normalizeGarminSleep(ownerA, 'UTC', {
        calendarDate: '2026-11-01',
        sleepStartTimestampGMT: 1234,
      }),
    ).toThrow()
  })
})
