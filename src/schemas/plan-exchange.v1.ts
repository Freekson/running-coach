import { z } from 'zod'
import { goalInputSchema, localDateSchema } from '@/lib/goals'
import { planConstraintsSchema, timezoneSchema } from '@/lib/plan-constraints'
import { dateWindowSchema, macroPlanSchema, planUuidSchema } from './plan-content.v1'
import { trainingContextSchema } from './training-context.v1'
import { workoutDefinitionSchema } from './workout-definition.v1'

export const EXCHANGE_SCHEMA_VERSION = 1
export const EXCHANGE_LIMITS = {
  requestBytes: 262144,
  responseBytes: 131072,
  workouts: 100,
} as const
export const exchangeWorkoutSchema = z.strictObject({
  workoutId: planUuidSchema,
  scheduledDate: localDateSchema,
  definition: workoutDefinitionSchema,
})
export const approvedCommitmentSchema = exchangeWorkoutSchema.extend({
  timezone: timezoneSchema,
  cancelled: z.boolean(),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  lockedAt: z.iso.datetime({ offset: true }).nullable(),
  // RUN-33 stores completion/lock facts; it does not yet persist missed status
  // or an Activity link. Never manufacture either from a missing Activity.
  outcome: z.enum(['completed', 'missed', 'unknown']),
  activityId: planUuidSchema.nullable(),
})
export const approvedRevisionSchema = z.strictObject({
  planId: planUuidSchema,
  revisionId: planUuidSchema,
  revisionNumber: z.number().int().positive(),
  macroPlan: macroPlanSchema,
  detailWindow: dateWindowSchema,
  workouts: z.array(approvedCommitmentSchema).max(200),
  commitmentsCoverage: z.enum(['complete', 'partial']),
  omittedHistoricalCommitments: z.number().int().nonnegative().optional(),
  narrativePolicy: z.literal('withheld').optional(),
})
const requestFields = {
  schemaVersion: z.literal(EXCHANGE_SCHEMA_VERSION),
  requestId: planUuidSchema,
  generatedAt: z.iso.datetime({ offset: true }),
  athleteLocalDate: localDateSchema,
  timezone: timezoneSchema,
  goal: goalInputSchema,
  measurementSystem: z.enum(['METRIC', 'IMPERIAL']).optional(),
  draft: z.strictObject({
    draftId: planUuidSchema,
    version: z.number().int().nonnegative(),
    constraints: planConstraintsSchema,
  }),
  allowedDetailWindow: dateWindowSchema,
  lockedDates: z.array(localDateSchema).max(28),
  trainingContext: trainingContextSchema,
  consent: z.strictObject({
    recordedActivityMetrics: z.boolean(),
    activityHeartRate: z.boolean(),
    recordedLaps: z.boolean(),
    athleteReport: z.boolean(),
    limitationsOrFatigue: z.boolean(),
    recovery: z.boolean(),
  }),
}
export const initialRequestSchema = z.strictObject({ ...requestFields, mode: z.literal('initial') })
export const refreshRequestSchema = z.strictObject({
  ...requestFields,
  mode: z.literal('refresh'),
  currentApprovedRevision: approvedRevisionSchema,
  allowedWorkoutIds: z.array(planUuidSchema).max(EXCHANGE_LIMITS.workouts),
  allowedCreateWorkoutIds: z.array(planUuidSchema).max(EXCHANGE_LIMITS.workouts),
})
export const exchangeRequestSchema = z
  .discriminatedUnion('mode', [initialRequestSchema, refreshRequestSchema])
  .superRefine((request, ctx) => {
    if (
      !timezoneSchema.safeParse(request.timezone).success ||
      !z.iso.datetime({ offset: true }).safeParse(request.generatedAt).success
    )
      return
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message })
    const window = request.allowedDetailWindow
    const length = days(window.endDate) - days(window.startDate) + 1
    if (length < 14 || length > 28 || window.startDate <= request.athleteLocalDate)
      issue(['allowedDetailWindow'], 'Detail window must be 14–28 future local days')
    if (
      request.timezone !== request.draft.constraints.timezone ||
      request.timezone !== request.trainingContext.recentTrainingSummary.timezone ||
      request.timezone !== request.trainingContext.activityHistoryCoverage.timezone
    )
      issue(['timezone'], 'All request calendar boundaries must use the athlete timezone')
    if (localDateAt(request.generatedAt, request.timezone) !== request.athleteLocalDate)
      issue(['athleteLocalDate'], 'Local date must match generation instant and timezone')
    const context = request.trainingContext
    if (
      !request.consent.recordedActivityMetrics &&
      (context.recentRunSamples.length ||
        context.lastRecordedRunAt !== null ||
        context.daysSinceLastRecordedRun.value !== null ||
        context.recentTrainingSummary.weeks.some((week) =>
          [
            week.distance,
            week.completedSessions,
            week.duration,
            ...(week.movingDuration ? [week.movingDuration] : []),
            week.longestRun,
            week.daysWithoutRecordedRuns,
          ].some((metric) => metric.value !== null),
        ) ||
        context.recentTrainingSummary.rollingTotals.some((total) =>
          [
            total.distance,
            total.completedSessions,
            total.duration,
            ...(total.movingDuration ? [total.movingDuration] : []),
          ].some((metric) => metric.value !== null),
        ) ||
        context.recentTrainingSummary.recentToOlderDistanceRatio.value !== null)
    )
      issue(['trainingContext'], 'Recorded activity metrics were not selected')
    for (const field of [
      'eligibleRuns',
      'truncatedRuns',
      'excludedDuplicateCandidates',
      'truncatedLaps',
    ] as const) {
      if (!request.consent.recordedActivityMetrics && context.selection[field] !== 0)
        issue(
          ['trainingContext', 'selection', field],
          'Activity selection counts were not selected',
        )
    }
    if (!request.consent.recordedLaps && context.selection.truncatedLaps !== 0)
      issue(
        ['trainingContext', 'selection', 'truncatedLaps'],
        'Lap selection counts were not selected',
      )
    if (!request.consent.athleteReport && context.athleteReport)
      issue(['trainingContext', 'athleteReport'], 'Athlete report was not selected')
    if (!request.consent.limitationsOrFatigue && context.athleteReport?.limitationsOrFatigue)
      issue(
        ['trainingContext', 'athleteReport', 'limitationsOrFatigue'],
        'Limitations were not selected',
      )
    if (!request.consent.recovery && context.recoveryContext)
      issue(['trainingContext', 'recoveryContext'], 'Recovery was not selected')
    context.recentRunSamples.forEach((run, index) => {
      if (
        !request.consent.activityHeartRate &&
        [run.averageHr, run.maxHr, ...(run.lapSamples ?? []).map((lap) => lap.averageHr)].some(
          (metric) => metric.value !== null,
        )
      )
        issue(['trainingContext', 'recentRunSamples', index], 'Activity HR was not selected')
      if (!request.consent.recordedLaps && run.lapSamples !== null)
        issue(
          ['trainingContext', 'recentRunSamples', index, 'lapSamples'],
          'Laps were not selected',
        )
    })
    if (request.mode === 'refresh') {
      if (
        request.currentApprovedRevision.workouts.some(
          (workout) => !timezoneSchema.safeParse(workout.timezone).success,
        )
      )
        return
      if (context.lifecycle.firstPlanForAthlete || context.lifecycle.firstWorkoutInPlan)
        issue(['trainingContext', 'lifecycle'], 'Refresh must refer to an existing approved plan')
      const prior = new Map(
        request.currentApprovedRevision.workouts.map((workout) => [workout.workoutId, workout]),
      )
      if (prior.size !== request.currentApprovedRevision.workouts.length)
        issue(['currentApprovedRevision', 'workouts'], 'Commitment IDs must be unique')
      const allAllowed = [...request.allowedWorkoutIds, ...request.allowedCreateWorkoutIds]
      if (new Set(allAllowed).size !== allAllowed.length)
        issue(['allowedWorkoutIds'], 'Allowed operation IDs must be unique and disjoint')
      request.allowedWorkoutIds.forEach((id, index) => {
        const workout = prior.get(id)
        if (
          !workout ||
          protectedWorkout(workout, request) ||
          workout.cancelled ||
          workout.scheduledDate < window.startDate ||
          workout.scheduledDate > window.endDate
        )
          issue(
            ['allowedWorkoutIds', index],
            'Only editable approved workouts in the allowed future window may be changed',
          )
      })
      if (request.allowedCreateWorkoutIds.some((id) => prior.has(id)))
        issue(['allowedCreateWorkoutIds'], 'New identities must not refer to approved workouts')
    }
  })
const responseFields = {
  schemaVersion: z.literal(EXCHANGE_SCHEMA_VERSION),
  requestId: planUuidSchema,
  draftVersion: z.number().int().nonnegative(),
  macroPlan: macroPlanSchema,
  detailWindow: dateWindowSchema,
  warnings: z.array(z.string().min(1).max(1000)).max(20).optional(),
}
export const workoutOperationSchema = z.discriminatedUnion('operation', [
  exchangeWorkoutSchema.extend({ operation: z.literal('create') }),
  exchangeWorkoutSchema.extend({ operation: z.literal('update') }),
  z.strictObject({ operation: z.literal('cancel'), workoutId: planUuidSchema }),
])
export const exchangeResponseSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...responseFields,
    mode: z.literal('initial'),
    workouts: z.array(exchangeWorkoutSchema).max(EXCHANGE_LIMITS.workouts),
  }),
  z.strictObject({
    ...responseFields,
    mode: z.literal('refresh'),
    baseRevisionId: planUuidSchema,
    baseRevisionNumber: z.number().int().positive(),
    operations: z.array(workoutOperationSchema).max(EXCHANGE_LIMITS.workouts),
  }),
])
export type ExchangeRequest = z.infer<typeof exchangeRequestSchema>
export type ExchangeResponse = z.infer<typeof exchangeResponseSchema>
export type ApprovedCommitment = z.infer<typeof approvedCommitmentSchema>

function days(date: string) {
  return Date.parse(date + 'T00:00:00Z') / 86400000
}
function localDateAt(instant: string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant))
  const part = (type: string) => parts.find((item) => item.type === type)?.value
  return part('year') + '-' + part('month') + '-' + part('day')
}
function protectedWorkout(workout: ApprovedCommitment, request: ExchangeRequest) {
  return Boolean(
    workout.completedAt ||
    workout.lockedAt ||
    workout.outcome === 'completed' ||
    workout.outcome === 'missed' ||
    workout.scheduledDate <= localDateAt(request.generatedAt, workout.timezone) ||
    request.lockedDates.includes(workout.scheduledDate),
  )
}

/** Correlation and calendar checks complement JSON Schema; this never saves or approves. */
export function responseSchemaForRequest(input: unknown) {
  const request = exchangeRequestSchema.parse(input)
  return exchangeResponseSchema.superRefine((response, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message })
    if (response.requestId !== request.requestId)
      issue(['requestId'], 'Response belongs to a different request')
    if (response.mode !== request.mode) issue(['mode'], 'Response mode must match request')
    if (response.draftVersion !== request.draft.version)
      issue(['draftVersion'], 'Stale draft version')
    if (JSON.stringify(response.detailWindow) !== JSON.stringify(request.allowedDetailWindow))
      issue(['detailWindow'], 'Response must use the allowed detail window')
    const macro = response.macroPlan
    if (macro.endDate < macro.startDate)
      issue(['macroPlan', 'endDate'], 'Macro period must be ordered')
    if (
      request.draft.constraints.startDate &&
      macro.startDate !== request.draft.constraints.startDate
    )
      issue(['macroPlan', 'startDate'], 'Macro period must match draft start')
    if (request.goal.targetDate && macro.endDate !== request.goal.targetDate)
      issue(['macroPlan', 'endDate'], 'Macro period must cover the goal date')
    let next = days(macro.startDate)
    macro.phases.forEach((phase, index) => {
      if (days(phase.startDate) !== next || phase.endDate < phase.startDate)
        issue(['macroPlan', 'phases', index], 'Phases must be ordered without gaps or overlap')
      next = days(phase.endDate) + 1
    })
    if (next !== days(macro.endDate) + 1)
      issue(['macroPlan', 'phases'], 'Phases must cover the entire macro period')
    if (
      response.detailWindow.startDate < macro.startDate ||
      response.detailWindow.endDate > macro.endDate
    )
      issue(['detailWindow'], 'Detail window must be inside the macro period')
    const ids = new Set<string>()
    const entries = response.mode === 'initial' ? response.workouts : response.operations
    const key = response.mode === 'initial' ? 'workouts' : 'operations'
    entries.forEach((entry, index) => {
      if (ids.has(entry.workoutId))
        issue([key, index, 'workoutId'], 'Only one operation per workout')
      ids.add(entry.workoutId)
      if ('scheduledDate' in entry) {
        if (
          entry.scheduledDate < request.allowedDetailWindow.startDate ||
          entry.scheduledDate > request.allowedDetailWindow.endDate ||
          entry.scheduledDate <= request.athleteLocalDate ||
          request.lockedDates.includes(entry.scheduledDate)
        )
          issue(
            [key, index, 'scheduledDate'],
            'Workout must be on an editable future date in the allowed window',
          )
      }
    })
    if (response.mode === 'refresh' && request.mode === 'refresh') {
      if (response.baseRevisionId !== request.currentApprovedRevision.revisionId)
        issue(['baseRevisionId'], 'Stale approved revision')
      if (response.baseRevisionNumber !== request.currentApprovedRevision.revisionNumber)
        issue(['baseRevisionNumber'], 'Stale approved revision number')
      response.operations.forEach((entry, index) => {
        const allowed =
          entry.operation === 'create' ? request.allowedCreateWorkoutIds : request.allowedWorkoutIds
        if (!allowed.includes(entry.workoutId))
          issue(
            ['operations', index, 'workoutId'],
            'Workout identity is not allowed for this operation',
          )
      })
    }
    // Include retained approved commitments when enforcing the new schedule.
    const approved = new Map(
      request.mode === 'refresh'
        ? request.currentApprovedRevision.workouts.map((workout) => [workout.workoutId, workout])
        : [],
    )
    const schedule = new Map<string, z.infer<typeof exchangeWorkoutSchema>>()
    for (const workout of approved.values())
      if (!workout.cancelled) schedule.set(workout.workoutId, workout)
    for (const entry of entries) {
      if ('operation' in entry && entry.operation === 'cancel') schedule.delete(entry.workoutId)
      else if ('scheduledDate' in entry) schedule.set(entry.workoutId, entry)
    }
    const counts = new Map<number, number>()
    const futureWeeks = new Set<number>()
    const todayDay = new Date(request.athleteLocalDate + 'T00:00:00Z').getUTCDay()
    const currentWeek = days(request.athleteLocalDate) - ((todayDay + 6) % 7)
    for (const workout of schedule.values()) {
      const prior = approved.get(workout.workoutId)
      const completed = Boolean(prior?.completedAt || prior?.outcome === 'completed')
      const isRetainedProtected = prior !== undefined && protectedWorkout(prior, request)
      const past =
        workout.scheduledDate <=
        (prior ? localDateAt(request.generatedAt, prior.timezone) : request.athleteLocalDate)
      const day = new Date(workout.scheduledDate + 'T00:00:00Z').getUTCDay()
      const monday = days(workout.scheduledDate) - ((day + 6) % 7)
      // Count commitments once by stable workout ID, including completed and
      // protected current-week sessions. Activity samples are separate evidence.
      if (prior?.outcome !== 'missed' && monday >= currentWeek) {
        counts.set(monday, (counts.get(monday) ?? 0) + 1)
        if (workout.scheduledDate > request.athleteLocalDate) futureWeeks.add(monday)
      }
      // RUN-33 preserves completed/past history outside the macro period, but an
      // unfinished future prescription must fit even when it cannot be edited.
      if (
        !past &&
        !completed &&
        (workout.scheduledDate < macro.startDate || workout.scheduledDate > macro.endDate)
      )
        issue([key], 'Retained future commitments must fit the macro period')
      if (isRetainedProtected) continue
      if (!request.draft.constraints.availableWeekdays.includes(day))
        issue([key], 'Workout falls on an unavailable weekday')
      const max = request.draft.constraints.maxSessionMinutes
      if (max !== null && knownDuration(workout.definition.steps) > max * 60)
        issue([key], 'Workout exceeds maximum session duration')
    }
    // Past-only weeks cannot be repaired by this refresh; enforce capacity in
    // weeks that still contain future commitments or proposed workouts.
    if (
      [...counts].some(
        ([week, count]) =>
          futureWeeks.has(week) && count > request.draft.constraints.sessionsPerWeek,
      )
    )
      issue([key], 'Schedule exceeds sessions per calendar week')
  })
}
function knownDuration(nodes: z.infer<typeof workoutDefinitionSchema>['steps']): number {
  return nodes.reduce(
    (sum, node) =>
      sum +
      (node.type === 'repeat'
        ? node.count * knownDuration(node.steps)
        : node.termination.type === 'time'
          ? node.termination.durationSeconds
          : 0),
    0,
  )
}
