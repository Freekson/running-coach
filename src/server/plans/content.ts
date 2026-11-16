import 'server-only'

import { calendarToday as localToday } from '@/lib/training-calendar'
import { planConstraintsSchema, type PlanConstraints } from '@/lib/plan-constraints'
import { workoutDefinitionSchema } from '@/schemas/workout-definition.v1'
import type { PlanContent, ScheduledPlanWorkout } from '@/schemas/plan-content.v1'
export {
  planContentSchema,
  planUuidSchema,
  scheduledPlanWorkoutSchema,
} from '@/schemas/plan-content.v1'
export type { PlanContent, ScheduledPlanWorkout } from '@/schemas/plan-content.v1'

export class PlanValidationError extends Error {}

function dayNumber(date: string) {
  return Date.parse(`${date}T00:00:00Z`) / 86400000
}

export { localToday }

export function constraintsFromDraft(draft: {
  sessionsPerWeek: number
  availableWeekdays: number[]
  maxSessionMinutes: number | null
  startDate: Date | null
  timezone: string
}) {
  return planConstraintsSchema.parse({
    sessionsPerWeek: draft.sessionsPerWeek,
    availableWeekdays: draft.availableWeekdays,
    maxSessionMinutes: draft.maxSessionMinutes,
    timezone: draft.timezone,
    startDate: draft.startDate?.toISOString().slice(0, 10) ?? null,
  })
}

export function validatePlanContent(
  content: PlanContent,
  constraints: PlanConstraints,
  targetDate: string | null,
) {
  const { macroPlan: macro, detailWindow: window } = content
  const fail = (message: string): never => {
    throw new PlanValidationError(message)
  }
  if (macro.endDate < macro.startDate) fail('Macro period must be ordered')
  if (constraints.startDate && macro.startDate !== constraints.startDate)
    fail('Macro period must start at the draft start date')
  if (targetDate && macro.endDate !== targetDate)
    fail('Macro strategy must cover the goal through its target date')
  let next = dayNumber(macro.startDate)
  for (const phase of macro.phases) {
    if (dayNumber(phase.startDate) !== next || phase.endDate < phase.startDate)
      fail('Macro phases must cover the full period without gaps or overlap')
    next = dayNumber(phase.endDate) + 1
  }
  if (next !== dayNumber(macro.endDate) + 1) fail('Macro phases must cover the full goal period')
  const length = dayNumber(window.endDate) - dayNumber(window.startDate) + 1
  if (length < 14 || length > 28) fail('Detail window must span 14 to 28 calendar days')
  if (window.startDate < macro.startDate || window.endDate > macro.endDate)
    fail('Detail window must be within the macro period')
  const ids = new Set<string>()
  for (const workout of content.workouts) {
    if (ids.has(workout.workoutId)) fail('Workout IDs must be unique')
    ids.add(workout.workoutId)
    if (workout.scheduledDate < window.startDate || workout.scheduledDate > window.endDate)
      fail('Detailed workouts must be within the detail window')
  }
}

export type HistoricalWorkout = ScheduledPlanWorkout & { timezone: string }
export type WorkoutLock = { id: string; completedAt: Date | null; lockedAt: Date | null }

function sameWorkout(a: HistoricalWorkout, b: HistoricalWorkout) {
  // Parsed schema property order is deterministic, independent of JSONB key order.
  return (
    a.scheduledDate === b.scheduledDate &&
    a.timezone === b.timezone &&
    a.cancelled === b.cancelled &&
    JSON.stringify(workoutDefinitionSchema.parse(a.definition)) ===
      JSON.stringify(workoutDefinitionSchema.parse(b.definition))
  )
}

// A refresh replaces only its future window; omitted future sessions become explicit cancellations.
export function mergePlanWorkouts(
  previous: HistoricalWorkout[],
  incoming: PlanContent,
  constraints: PlanConstraints,
  locks: WorkoutLock[],
  now: Date,
): HistoricalWorkout[] {
  const isPast = (workout: HistoricalWorkout) =>
    workout.scheduledDate <= localToday(workout.timezone, now)
  const fail = (): never => {
    throw new PlanValidationError('Past, completed or locked workouts cannot be changed')
  }
  const lockIds = new Set(locks.filter((w) => w.completedAt || w.lockedAt).map((w) => w.id))
  const completedIds = new Set(locks.filter((w) => w.completedAt).map((w) => w.id))
  const prior = new Map(previous.map((w) => [w.workoutId, w]))
  const result = new Map(prior)
  for (const old of previous) {
    if (
      old.scheduledDate >= incoming.detailWindow.startDate &&
      old.scheduledDate <= incoming.detailWindow.endDate &&
      !isPast(old) &&
      !lockIds.has(old.workoutId)
    )
      result.set(old.workoutId, { ...old, cancelled: true })
  }
  for (const w of incoming.workouts) {
    const old = prior.get(w.workoutId)
    // Existing identities keep their explicit session timezone through refresh.
    // New sessions inherit the draft timezone; calendar moves change a session zone.
    const next = { ...w, timezone: old?.timezone ?? constraints.timezone }
    if (old && (isPast(old) || lockIds.has(w.workoutId))) {
      if (!sameWorkout(old, next)) fail()
    } else if (w.scheduledDate <= localToday(next.timezone, now)) fail()
    result.set(w.workoutId, next)
  }
  // Retained sessions also belong to the new snapshot. A shorter horizon must
  // not leave an active future prescription outside its approved macro period.
  for (const workout of result.values()) {
    if (
      !workout.cancelled &&
      !isPast(workout) &&
      !completedIds.has(workout.workoutId) &&
      (workout.scheduledDate < incoming.macroPlan.startDate ||
        workout.scheduledDate > incoming.macroPlan.endDate)
    ) {
      throw new PlanValidationError('Retained future workouts must be within the macro period')
    }
  }
  // Omitting protected sessions is preservation, not deletion.
  return [...result.values()].sort(
    (a, b) =>
      a.scheduledDate.localeCompare(b.scheduledDate) || a.workoutId.localeCompare(b.workoutId),
  )
}
