import 'server-only'

import type { Activity, ActivityLap, Prisma } from '@prisma/client'
import { addHealthDays, healthLocalDay } from '@/lib/health-history'
import { timezoneSchema } from '@/lib/plan-constraints'
import { activityDayBoundary } from '@/server/activity/history'
import { recordedActivitySurface } from '@/server/activity/surface'
import { activityReadScope } from '@/server/activity/visibility'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import {
  coverageSchema,
  trainingEvidenceSchema,
  EVIDENCE_LIMITS,
  type EvidenceMetric,
  type HistoryCoverage,
  type TrainingEvidence,
} from '@/schemas/training-context.v1'

type Measurement = Pick<
  ActivityLap,
  'distanceMeters' | 'elapsedMs' | 'movingMs' | 'avgSpeedMps' | 'avgHrBpm'
>
export type EvidenceActivity = Pick<
  Activity,
  | 'id'
  | 'userId'
  | 'sportType'
  | 'sourceProvider'
  | 'sourceSportType'
  | 'surfaceType'
  | 'startedAt'
  | 'sourceTimezone'
  | 'sourceObservedAt'
  | 'importedAt'
  | 'distanceMeters'
  | 'elapsedMs'
  | 'movingMs'
  | 'avgSpeedMps'
  | 'avgHrBpm'
  | 'maxHrBpm'
  | 'cadence'
  | 'elevationGainMeters'
  | 'elevationLossMeters'
> & {
  duplicateCandidate: boolean
  laps: (Measurement & Pick<ActivityLap, 'lapIndex' | 'startedAt' | 'sourceRecordType'>)[]
  lapCount: number
}
type EvidenceOptions = {
  timezone: string
  now: Date
  coverage: HistoryCoverage
  includeHeartRate: boolean
  includeLaps: boolean
}
const number = (value: Prisma.Decimal | number | null): number | null => {
  const result = value === null ? null : Number(value)
  return result !== null && Number.isFinite(result) && result >= 0 ? result : null
}
const seconds = (value: bigint | null): number | null =>
  value !== null && value >= BigInt(0) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value) / 1000
    : null
function measures(row: Measurement) {
  const distance = number(row.distanceMeters)
  const elapsed = seconds(row.elapsedMs)
  const moving = seconds(row.movingMs)
  const inconsistent = elapsed !== null && moving !== null && moving > elapsed
  let speed: number | null = null
  let basis: TrainingEvidence['recentRunSamples'][number]['paceBasis'] = 'unavailable'
  if (!inconsistent) {
    if (distance !== null && distance > 0 && moving !== null && moving > 0) {
      speed = distance / moving
      basis = 'moving'
    } else if (distance !== null && distance > 0 && elapsed !== null && elapsed > 0) {
      speed = distance / elapsed
      basis = 'elapsed'
    } else if (number(row.avgSpeedMps) !== null && Number(row.avgSpeedMps) > 0) {
      speed = Number(row.avgSpeedMps)
      basis = 'recorded_average_speed'
    }
  }
  return {
    distance,
    elapsed,
    moving,
    inconsistent,
    speed,
    pace: speed !== null ? 1000 / speed : null,
    basis,
  }
}
function overlaps(
  a: { startDate: string; endDate: string },
  b: { startDate: string; endDate: string },
) {
  return a.startDate <= b.endDate && b.startDate <= a.endDate
}

/** Pure mapping of trusted stored records; no provider calls, writes, or profile experience defaults. */
export function buildTrainingEvidence(
  owner: OwnerContext,
  records: readonly EvidenceActivity[],
  options: EvidenceOptions,
): TrainingEvidence {
  const userId = ownerId(owner)
  const timezone = timezoneSchema.parse(options.timezone)
  const coverage = coverageSchema.parse(options.coverage)
  if (coverage.timezone !== timezone)
    throw new Error('Coverage timezone must match observation timezone')
  const now = options.now.toISOString()
  const today = healthLocalDay(now, timezone)
  const endDate = addHealthDays(today, -1)
  const startDate = addHealthDays(endDate, -83)
  const window = { startDate, endDate }
  const datesById = new Map(
    records.map((row) => [row.id, healthLocalDay(row.startedAt.toISOString(), timezone)]),
  )
  const eligible = [
    ...new Map(
      records
        .filter(
          (row) =>
            row.userId === userId &&
            row.sportType === 'RUNNING' &&
            row.startedAt <= options.now &&
            !row.duplicateCandidate,
        )
        .map((row) => [row.id, row]),
    ).values(),
  ].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || a.id.localeCompare(b.id))
  const runs = eligible.filter((row) => {
    const date = datesById.get(row.id)!
    return date >= startDate && date <= endDate
  })
  const metric = (
    value: number | null,
    unit: EvidenceMetric['unit'],
    period: EvidenceMetric['provenance']['period'],
    source: EvidenceMetric['provenance']['source'] = 'DERIVED',
    observedAt = now,
    quality: EvidenceMetric['provenance']['quality'] = 'derived',
  ): EvidenceMetric => ({
    value,
    unit,
    provenance: { source, observedAt, period, quality: value === null ? 'unavailable' : quality },
  })
  const summarize = (period: { startDate: string; endDate: string }) => {
    const selected = runs.filter((row) => {
      const date = datesById.get(row.id)!
      return date >= period.startDate && date <= period.endDate
    })
    const dates = Array.from(
      {
        length:
          Math.round((Date.parse(period.endDate) - Date.parse(period.startDate)) / 86400000) + 1,
      },
      (_, index) => addHealthDays(period.startDate, index),
    )
    const duplicatesInPeriod = records.some(
      (row) =>
        row.userId === userId &&
        row.sportType === 'RUNNING' &&
        row.duplicateCandidate &&
        datesById.get(row.id)! >= period.startDate &&
        datesById.get(row.id)! <= period.endDate,
    )
    const complete =
      !duplicatesInPeriod &&
      ['sufficient', 'partial'].includes(coverage.status) &&
      coverage.window !== null &&
      coverage.window.startDate <= period.startDate &&
      coverage.window.endDate >= period.endDate &&
      coverage.lastManualSyncAt !== null &&
      healthLocalDay(coverage.lastManualSyncAt, timezone) > period.endDate &&
      dates.every((date) =>
        coverage.completeWindows.some(
          (covered) => date >= covered.startDate && date <= covered.endDate,
        ),
      ) &&
      ![...coverage.failedWindows, ...coverage.unfetchedWindows].some((gap) =>
        overlaps(gap, period),
      )
    const status: 'complete' | 'partial' | 'unavailable' = complete
      ? 'complete'
      : selected.length || duplicatesInPeriod
        ? 'partial'
        : 'unavailable'
    const sum = (values: (number | null)[]) =>
      complete && values.every((value) => value !== null)
        ? values.reduce<number>((total, value) => total + value!, 0)
        : null
    const distances = selected.map((row) => number(row.distanceMeters))
    const durations = selected.map((row) => {
      const m = measures(row)
      return m.inconsistent ? null : m.elapsed
    })
    const movingDurations = selected.map((row) => {
      const m = measures(row)
      return m.inconsistent ? null : m.moving
    })
    const sessionDays = new Set(selected.map((row) => datesById.get(row.id)!))
    return {
      window: period,
      coverage: status,
      distance: metric(sum(distances), 'm', period),
      completedSessions: metric(complete ? selected.length : null, 'sessions', period),
      // Duration is elapsed time throughout; moving time is kept separately per run.
      duration: metric(sum(durations), 's', period),
      movingDuration: metric(sum(movingDurations), 's', period),
      longestRun: metric(
        complete && selected.length > 0 && distances.every((d) => d !== null)
          ? Math.max(...distances.map((d) => d!))
          : null,
        'm',
        period,
      ),
      daysWithoutRecordedRuns: metric(
        complete ? dates.length - sessionDays.size : null,
        'days',
        period,
      ),
    }
  }
  const weeks = Array.from({ length: 12 }, (_, index) =>
    summarize({
      startDate: addHealthDays(startDate, index * 7),
      endDate: addHealthDays(startDate, index * 7 + 6),
    }),
  )
  const rollingTotals = ([4, 8, 12] as const).map((count) => {
    const summary = summarize({ startDate: addHealthDays(endDate, 1 - count * 7), endDate })
    return {
      weeks: count,
      window: summary.window,
      distance: summary.distance,
      completedSessions: summary.completedSessions,
      duration: summary.duration,
      movingDuration: summary.movingDuration,
    }
  })
  const recent = rollingTotals[0].distance.value
  const older = summarize({
    startDate: addHealthDays(endDate, -55),
    endDate: addHealthDays(endDate, -28),
  }).distance.value
  const longest = [...runs]
    .filter((row) => number(row.distanceMeters) !== null)
    .sort(
      (a, b) =>
        Number(b.distanceMeters) - Number(a.distanceMeters) || runs.indexOf(a) - runs.indexOf(b),
    )[0]
  // Fastest is a selection rule, never a diagnosis or inferred workout/threshold label.
  const fastest = [...runs]
    .filter((row) => measures(row).speed !== null && row.avgHrBpm !== null)
    .sort((a, b) => measures(b).speed! - measures(a).speed! || runs.indexOf(a) - runs.indexOf(b))[0]
  const selected = [
    ...new Map(
      [longest, fastest, ...runs].filter((row) => row !== undefined).map((row) => [row.id, row]),
    ).values(),
  ]
    .slice(0, EVIDENCE_LIMITS.runs)
    .sort((a, b) => runs.indexOf(a) - runs.indexOf(b))
  let lapBudget = EVIDENCE_LIMITS.totalLaps
  let truncatedLaps = 0
  const samples = selected.map((row): TrainingEvidence['recentRunSamples'][number] => {
    const date = healthLocalDay(row.startedAt.toISOString(), timezone)
    const period = { startDate: date, endDate: date }
    const observedAt = (row.sourceObservedAt ?? row.importedAt).toISOString()
    const m = measures(row)
    const field = (value: number | null, unit: EvidenceMetric['unit'], derived = false) =>
      metric(
        value,
        unit,
        period,
        derived ? 'DERIVED' : row.sourceProvider,
        observedAt,
        derived ? 'derived' : 'recorded',
      )
    const laps = options.includeLaps
      ? row.laps
          .filter((lap) => lap.sourceRecordType === 'FIT_LAP')
          .sort((a, b) => a.lapIndex - b.lapIndex)
          .slice(0, Math.min(lapBudget, EVIDENCE_LIMITS.lapsPerRun))
      : []
    lapBudget -= laps.length
    if (options.includeLaps) truncatedLaps += Math.max(0, row.lapCount - laps.length)
    return {
      activityId: row.id,
      sport: 'RUNNING',
      startedAt: row.startedAt.toISOString(),
      localDate: date,
      timezone,
      sourceTimezone: timezoneSchema.safeParse(row.sourceTimezone).success
        ? row.sourceTimezone
        : null,
      source: { source: row.sourceProvider, observedAt, period, quality: 'recorded' },
      distance: field(m.distance, 'm'),
      elapsedTime: field(m.elapsed, 's'),
      movingTime: field(m.moving, 's'),
      averageSpeed: field(m.speed, 'm/s', m.basis !== 'recorded_average_speed'),
      averagePace: field(m.pace, 's/km', true),
      averageHr: field(options.includeHeartRate ? number(row.avgHrBpm) : null, 'bpm'),
      maxHr: field(options.includeHeartRate ? number(row.maxHrBpm) : null, 'bpm'),
      cadence: field(number(row.cadence), 'steps/min'),
      elevationGain: field(number(row.elevationGainMeters), 'm'),
      elevationLoss: field(number(row.elevationLossMeters), 'm'),
      surface: recordedActivitySurface(row),
      paceBasis: m.basis,
      flags: [
        ...(m.inconsistent ? ['inconsistent_times' as const] : []),
        ...(options.includeHeartRate && row.avgHrBpm === null ? ['missing_hr' as const] : []),
        ...(m.basis === 'recorded_average_speed' ? ['average_speed_only' as const] : []),
      ],
      lapSamples:
        options.includeLaps && row.lapCount > 0
          ? laps.map((lap) => {
              const lm = measures(lap)
              return {
                lapIndex: lap.lapIndex,
                startedAt: lap.startedAt?.toISOString() ?? null,
                distance: field(lm.distance, 'm'),
                elapsedTime: field(lm.elapsed, 's'),
                movingTime: field(lm.moving, 's'),
                averageSpeed: field(lm.speed, 'm/s', lm.basis !== 'recorded_average_speed'),
                averagePace: field(lm.pace, 's/km', true),
                averageHr: field(options.includeHeartRate ? number(lap.avgHrBpm) : null, 'bpm'),
                paceBasis: lm.basis,
              }
            })
          : null,
    }
  })
  const last = eligible[0]?.startedAt.toISOString() ?? null
  return trainingEvidenceSchema.parse({
    activityHistoryCoverage: coverage,
    lastRecordedRunAt: last,
    daysSinceLastRecordedRun: metric(
      last === null
        ? null
        : Math.round((Date.parse(today) - Date.parse(healthLocalDay(last, timezone))) / 86400000),
      'days',
      window,
    ),
    recentTrainingSummary: {
      sport: 'RUNNING',
      timezone,
      weeks,
      rollingTotals,
      recentToOlderDistanceRatio: metric(
        recent !== null && older !== null && older > 0 ? recent / older : null,
        'ratio',
        { startDate: addHealthDays(endDate, -55), endDate },
      ),
    },
    recentRunSamples: samples,
    selection: {
      policy:
        'v1: exclude unresolved duplicates; reserve longest and fastest evidenced run; then newest; timestamp/id tie-break',
      window,
      eligibleRuns: runs.length,
      excludedDuplicateCandidates: new Set(
        records
          .filter(
            (row) =>
              row.userId === userId &&
              row.sportType === 'RUNNING' &&
              row.duplicateCandidate &&
              row.startedAt <= options.now &&
              healthLocalDay(row.startedAt.toISOString(), timezone) >= startDate &&
              healthLocalDay(row.startedAt.toISOString(), timezone) <= endDate,
          )
          .map((row) => row.id),
      ).size,
      truncatedRuns: runs.length - samples.length,
      truncatedLaps,
    },
  })
}

const select = {
  id: true,
  userId: true,
  sportType: true,
  sourceProvider: true,
  sourceSportType: true,
  surfaceType: true,
  startedAt: true,
  sourceTimezone: true,
  sourceObservedAt: true,
  importedAt: true,
  distanceMeters: true,
  elapsedMs: true,
  movingMs: true,
  avgSpeedMps: true,
  avgHrBpm: true,
  maxHrBpm: true,
  cadence: true,
  elevationGainMeters: true,
  elevationLossMeters: true,
  duplicateCandidatesAsFirst: { select: { id: true } },
  duplicateCandidatesAsSecond: { select: { id: true } },
} satisfies Prisma.ActivitySelect

/** RUN-35 supplies consent and verified sync coverage; loading never initiates a Garmin sync. */
export async function readTrainingEvidence(
  owner: OwnerContext,
  options: EvidenceOptions,
  client?: Prisma.TransactionClient,
): Promise<TrainingEvidence> {
  const userId = ownerId(owner)
  const timezone = timezoneSchema.parse(options.timezone)
  coverageSchema.parse(options.coverage)
  const prisma = client ?? (await getPrismaClient())
  const scope = await activityReadScope(owner, prisma)
  const today = healthLocalDay(options.now.toISOString(), timezone)
  const where = { AND: [scope, { sportType: 'RUNNING', startedAt: { lte: options.now } }] }
  const [rows, last] = await Promise.all([
    prisma.activity.findMany({
      where: {
        AND: [
          where,
          { startedAt: { gte: activityDayBoundary(addHealthDays(today, -84), timezone) } },
        ],
      },
      select: {
        ...select,
        laps: options.includeLaps
          ? {
              where: { userId, sourceRecordType: 'FIT_LAP' },
              orderBy: { lapIndex: 'asc' },
              take: EVIDENCE_LIMITS.lapsPerRun,
              select: {
                lapIndex: true,
                startedAt: true,
                sourceRecordType: true,
                distanceMeters: true,
                elapsedMs: true,
                movingMs: true,
                avgSpeedMps: true,
                avgHrBpm: true,
              },
            }
          : false,
        _count: { select: { laps: { where: { userId, sourceRecordType: 'FIT_LAP' } } } },
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
    }),
    prisma.activity.findFirst({
      where: {
        AND: [
          where,
          {
            duplicateCandidatesAsFirst: { none: { userId } },
            duplicateCandidatesAsSecond: { none: { userId } },
          },
        ],
      },
      select,
      orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
    }),
  ])
  const records: EvidenceActivity[] = rows.map((row) => ({
    ...row,
    laps: row.laps ?? [],
    lapCount: row._count.laps,
    duplicateCandidate:
      row.duplicateCandidatesAsFirst.length > 0 || row.duplicateCandidatesAsSecond.length > 0,
  }))
  if (last && !records.some((row) => row.id === last.id))
    records.push({ ...last, laps: [], lapCount: 0, duplicateCandidate: false })
  return buildTrainingEvidence(owner, records, options)
}
