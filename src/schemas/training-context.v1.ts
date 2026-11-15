import { z } from 'zod'
import { localDateSchema, goalSurfaceSchema } from '@/lib/goals'
import { timezoneSchema } from '@/lib/plan-constraints'
import { addHealthDays, healthLocalDay } from '@/lib/health-history'
import { dateWindowSchema, planUuidSchema } from './plan-content.v1'

export const EVIDENCE_LIMITS = { weeks: 12, runs: 20, lapsPerRun: 8, totalLaps: 40 } as const
const nonnegative = z.number().nonnegative()
export const provenanceSchema = z.strictObject({
  source: z.enum(['GARMIN', 'INTERVALS', 'MANUAL', 'FILE', 'ATHLETE', 'DERIVED']),
  observedAt: z.iso.datetime({ offset: true }),
  period: dateWindowSchema,
  quality: z.enum(['recorded', 'reported', 'derived', 'partial', 'unavailable', 'inconsistent']),
})
export const metricSchema = z
  .strictObject({
    value: nonnegative.nullable(),
    unit: z.enum(['m', 's', 'm/s', 's/km', 'bpm', 'ms', 'steps/min', 'sessions', 'days', 'ratio']),
    provenance: provenanceSchema,
  })
  .superRefine((metric, ctx) => {
    if (
      (metric.value === null) !==
      ['unavailable', 'inconsistent'].includes(metric.provenance.quality)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Unavailable/inconsistent metrics must be null; available metrics need a value',
      })
  })
function metricIn(unit: z.infer<typeof metricSchema>['unit']) {
  return metricSchema.safeExtend({ unit: z.literal(unit) })
}
export const coverageSchema = z.strictObject({
  status: z.enum(['sufficient', 'partial', 'absent', 'unknown']),
  provider: z.literal('GARMIN'),
  timezone: timezoneSchema,
  window: dateWindowSchema.nullable(),
  lastManualSyncAt: z.iso.datetime({ offset: true }).nullable(),
  completeWindows: z.array(dateWindowSchema).max(100),
  failedWindows: z.array(dateWindowSchema).max(100),
  unfetchedWindows: z.array(dateWindowSchema).max(100),
  label: z.literal('recorded history only'),
})
export const lapSampleSchema = z.strictObject({
  lapIndex: z.number().int().nonnegative(),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  distance: metricIn('m'),
  elapsedTime: metricIn('s'),
  movingTime: metricIn('s'),
  averageSpeed: metricIn('m/s'),
  averagePace: metricIn('s/km'),
  averageHr: metricIn('bpm'),
  paceBasis: z.enum(['moving', 'elapsed', 'recorded_average_speed', 'unavailable']),
})
export const runSampleSchema = z.strictObject({
  activityId: planUuidSchema,
  sport: z.literal('RUNNING'),
  startedAt: z.iso.datetime({ offset: true }),
  localDate: localDateSchema,
  timezone: timezoneSchema,
  sourceTimezone: timezoneSchema.nullable(),
  source: provenanceSchema,
  distance: metricIn('m'),
  elapsedTime: metricIn('s'),
  movingTime: metricIn('s'),
  averageSpeed: metricIn('m/s'),
  averagePace: metricIn('s/km'),
  averageHr: metricIn('bpm'),
  maxHr: metricIn('bpm'),
  cadence: metricIn('steps/min'),
  elevationGain: metricIn('m'),
  elevationLoss: metricIn('m'),
  surface: goalSurfaceSchema.exclude(['ANY']).nullable(),
  paceBasis: z.enum(['moving', 'elapsed', 'recorded_average_speed', 'unavailable']),
  flags: z.array(z.enum(['inconsistent_times', 'missing_hr', 'average_speed_only'])).max(3),
  lapSamples: z.array(lapSampleSchema).max(EVIDENCE_LIMITS.lapsPerRun).nullable(),
})
const reportedProvenance = provenanceSchema.extend({
  source: z.literal('ATHLETE'),
  quality: z.literal('reported'),
})
const reportedTextSchema = z.strictObject({
  value: z.string().min(1).max(1000),
  provenance: reportedProvenance,
})
const raceResultSchema = z.strictObject({
  date: localDateSchema,
  distanceMeters: z.number().positive(),
  elapsedSeconds: z.number().positive(),
  kind: z.enum(['race', 'test', 'historical_pb']),
  provenance: reportedProvenance,
})
export const athleteReportSchema = z.strictObject({
  experience: z.enum(['new_runner', 'returning_runner', 'currently_training', 'unknown']),
  firstWorkoutEver: z.boolean().nullable(),
  provenance: reportedProvenance,
  previousExperience: reportedTextSchema.optional(),
  easyEffort: reportedTextSchema.optional(),
  raceOrTestResults: z.array(raceResultSchema).max(5).optional(),
  crossTraining: reportedTextSchema.optional(),
  preferredWorkoutTypes: reportedTextSchema.optional(),
  limitationsOrFatigue: reportedTextSchema.optional(),
})
export const trainingEvidenceSchema = z.strictObject({
  activityHistoryCoverage: coverageSchema,
  lastRecordedRunAt: z.iso.datetime({ offset: true }).nullable(),
  daysSinceLastRecordedRun: metricIn('days'),
  recentTrainingSummary: z.strictObject({
    sport: z.literal('RUNNING'),
    timezone: timezoneSchema,
    weeks: z
      .array(
        z.strictObject({
          window: dateWindowSchema,
          coverage: z.enum(['complete', 'partial', 'unavailable']),
          distance: metricIn('m'),
          completedSessions: metricIn('sessions'),
          duration: metricIn('s'),
          longestRun: metricIn('m'),
          daysWithoutRecordedRuns: metricIn('days'),
        }),
      )
      .length(EVIDENCE_LIMITS.weeks),
    rollingTotals: z
      .array(
        z.strictObject({
          weeks: z.union([z.literal(4), z.literal(8), z.literal(12)]),
          window: dateWindowSchema,
          distance: metricIn('m'),
          completedSessions: metricIn('sessions'),
          duration: metricIn('s'),
        }),
      )
      .length(3),
    recentToOlderDistanceRatio: metricIn('ratio'),
  }),
  recentRunSamples: z.array(runSampleSchema).max(EVIDENCE_LIMITS.runs),
  selection: z.strictObject({
    policy: z.literal(
      'v1: exclude unresolved duplicates; reserve longest and fastest evidenced run; then newest; timestamp/id tie-break',
    ),
    window: dateWindowSchema,
    eligibleRuns: z.number().int().nonnegative(),
    excludedDuplicateCandidates: z.number().int().nonnegative(),
    truncatedRuns: z.number().int().nonnegative(),
    truncatedLaps: z.number().int().nonnegative(),
  }),
})
export const trainingContextSchema = trainingEvidenceSchema
  .extend({
    schemaVersion: z.literal(1),
    lifecycle: z.strictObject({
      firstPlanForAthlete: z.boolean(),
      firstWorkoutInPlan: z.boolean(),
    }),
    athleteReport: athleteReportSchema.optional(),
    recoveryContext: z
      .strictObject({
        consentSelected: z.literal(true),
        timezone: timezoneSchema,
        coverage: coverageSchema,
        days: z
          .array(
            z.strictObject({
              date: localDateSchema,
              restingHr: metricIn('bpm'),
              hrv: metricIn('ms'),
              sleepDuration: metricIn('s'),
            }),
          )
          .max(28),
      })
      .optional(),
  })
  .superRefine((context, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message })
    const summary = context.recentTrainingSummary
    const window = context.selection.window
    // Length/format failures can continue into superRefine. Keep their typed
    // issues intact before calendar arithmetic or array indexing.
    if (
      summary.weeks.length !== 12 ||
      summary.rollingTotals.length !== 3 ||
      !localDateSchema.safeParse(window.startDate).success ||
      !localDateSchema.safeParse(window.endDate).success ||
      !timezoneSchema.safeParse(context.activityHistoryCoverage.timezone).success ||
      (context.activityHistoryCoverage.lastManualSyncAt !== null &&
        !z.iso
          .datetime({ offset: true })
          .safeParse(context.activityHistoryCoverage.lastManualSyncAt).success)
    )
      return
    if (addHealthDays(window.startDate, 83) !== window.endDate)
      issue(['selection', 'window'], 'Evidence window must span 84 complete local days')
    summary.weeks.forEach((week, index) => {
      const path = ['recentTrainingSummary', 'weeks', index]
      if (
        week.window.startDate !== addHealthDays(window.startDate, index * 7) ||
        week.window.endDate !== addHealthDays(window.startDate, index * 7 + 6)
      )
        issue([...path, 'window'], 'Weeks must be consecutive seven-day absolute windows')
      const metrics = [
        week.distance,
        week.completedSessions,
        week.duration,
        week.longestRun,
        week.daysWithoutRecordedRuns,
      ]
      if (week.coverage !== 'complete' && metrics.some((metric) => metric.value !== null))
        issue(path, 'Incomplete weeks cannot claim complete totals or observed zeros')
      if (week.coverage === 'complete') {
        const coverage = context.activityHistoryCoverage
        const covered =
          ['sufficient', 'partial'].includes(coverage.status) &&
          coverage.window !== null &&
          coverage.window.startDate <= week.window.startDate &&
          coverage.window.endDate >= week.window.endDate &&
          coverage.lastManualSyncAt !== null &&
          healthLocalDay(coverage.lastManualSyncAt, coverage.timezone) > week.window.endDate &&
          Array.from({ length: 7 }, (_, day) => addHealthDays(week.window.startDate, day)).every(
            (date) =>
              coverage.completeWindows.some(
                (period) => period.startDate <= date && date <= period.endDate,
              ),
          ) &&
          ![...coverage.failedWindows, ...coverage.unfetchedWindows].some(
            (gap) => gap.startDate <= week.window.endDate && gap.endDate >= week.window.startDate,
          )
        if (!covered)
          issue(
            [...path, 'coverage'],
            'Complete weeks require verified coverage without failed/unfetched dates',
          )
      }
    })
    const counts = [4, 8, 12]
    summary.rollingTotals.forEach((total, index) => {
      const weeks = summary.weeks.slice(-counts[index])
      if (
        total.weeks !== counts[index] ||
        total.window.startDate !== weeks[0].window.startDate ||
        total.window.endDate !== window.endDate
      )
        issue(
          ['recentTrainingSummary', 'rollingTotals', index],
          'Rolling totals must use the declared 4/8/12-week windows',
        )
      for (const key of ['distance', 'completedSessions', 'duration'] as const) {
        const values = weeks.map((week) => week[key].value)
        const sum = values.every((value) => value !== null)
          ? values.reduce<number>((n, value) => n + value!, 0)
          : null
        if (
          total[key].value === null
            ? sum !== null
            : sum === null || Math.abs(total[key].value - sum) > 0.001
        )
          issue(
            ['recentTrainingSummary', 'rollingTotals', index, key],
            'Totals must agree with covered weekly observations',
          )
      }
    })
    if (
      context.selection.eligibleRuns !==
      context.recentRunSamples.length + context.selection.truncatedRuns
    )
      issue(['selection'], 'Selection counts must match included and truncated runs')
    context.recentRunSamples.forEach((run, index) => {
      const path = ['recentRunSamples', index]
      if (
        !timezoneSchema.safeParse(run.timezone).success ||
        !z.iso.datetime({ offset: true }).safeParse(run.startedAt).success
      )
        return
      if (
        run.timezone !== summary.timezone ||
        run.localDate !== healthLocalDay(run.startedAt, run.timezone) ||
        run.localDate < window.startDate ||
        run.localDate > window.endDate
      )
        issue(path, 'Run date must match its instant/timezone and selection window')
      for (const [field, metric] of Object.entries(run)) {
        if (typeof metric === 'object' && metric !== null && 'provenance' in metric) {
          if (
            metric.provenance.period.startDate !== run.localDate ||
            metric.provenance.period.endDate !== run.localDate ||
            metric.provenance.observedAt !== run.source.observedAt
          )
            issue(
              [...path, field],
              'Run metrics must share the same recorded run period and source timestamp',
            )
        }
      }
      const elapsed = run.elapsedTime.value,
        moving = run.movingTime.value
      if (elapsed !== null && moving !== null && moving > elapsed && run.averagePace.value !== null)
        issue([...path, 'averagePace'], 'Inconsistent time measurements cannot establish pace')
      const speed = run.averageSpeed.value,
        pace = run.averagePace.value
      if (
        speed !== null &&
        pace !== null &&
        (speed <= 0 || Math.abs(pace - 1000 / speed) > 0.000001)
      )
        issue([...path, 'averagePace'], 'Pace must agree with speed from this run')
    })
    if (context.recoveryContext) {
      const recovery = context.recoveryContext
      if (recovery.timezone !== summary.timezone || recovery.coverage.timezone !== summary.timezone)
        issue(['recoveryContext', 'timezone'], 'Recovery must use the athlete timezone')
      if (new Set(recovery.days.map((day) => day.date)).size !== recovery.days.length)
        issue(['recoveryContext', 'days'], 'Recovery dates must be unique')
      recovery.days.forEach((day, index) => {
        if (
          !recovery.coverage.window ||
          day.date < recovery.coverage.window.startDate ||
          day.date > recovery.coverage.window.endDate
        )
          issue(
            ['recoveryContext', 'days', index, 'date'],
            'Recovery must stay within declared coverage',
          )
      })
    }
    const laps = context.recentRunSamples.reduce(
      (sum, run) => sum + (run.lapSamples?.length ?? 0),
      0,
    )
    if (laps > EVIDENCE_LIMITS.totalLaps)
      ctx.addIssue({
        code: 'custom',
        path: ['recentRunSamples'],
        message: 'At most 40 laps overall',
      })
    if (
      new Set(context.recentRunSamples.map((run) => run.activityId)).size !==
      context.recentRunSamples.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['recentRunSamples'],
        message: 'Activity IDs must be unique',
      })
  })
export type TrainingEvidence = z.infer<typeof trainingEvidenceSchema>
export type HistoryCoverage = z.infer<typeof coverageSchema>
export type EvidenceMetric = z.infer<typeof metricSchema>
