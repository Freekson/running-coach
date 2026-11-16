import 'server-only'

import type { PlannedWorkout, PlanRevisionWorkout } from '@prisma/client'
import { addHealthDays, healthLocalDay } from '@/lib/health-history'
import { macroPlanSchema } from '@/schemas/plan-content.v1'
import { workoutDefinitionSchema, type WorkoutNode } from '@/schemas/workout-definition.v1'
import { PlanStateError, RefreshGoalConflictError } from '../transaction'
import { workoutCompletionAt, type WorkoutCompletion } from '../completion'

/** Refresh preserves the approved macro horizon; a different goal needs a new plan. */
export function assertRefreshGoalHorizon(approvedMacro: unknown, targetDate: string | null) {
  const macro = macroPlanSchema.parse(approvedMacro)
  if (targetDate && macro.endDate !== targetDate) throw new RefreshGoalConflictError()
}

export type StoredCommitment = Pick<
  PlanRevisionWorkout,
  'workoutId' | 'scheduledDate' | 'timezone' | 'definition' | 'cancelled'
> & {
  workout: WorkoutCompletion & Pick<PlannedWorkout, 'lockedAt'>
}

// Source narrative has no field-level consent provenance. Export structural facts
// only; personal reports can be supplied through the current consent controls.
export function projectMacroPlan(input: unknown) {
  const macro = macroPlanSchema.parse(input)
  return {
    startDate: macro.startDate,
    endDate: macro.endDate,
    strategy: 'Approved plan narrative withheld for privacy. Phase dates are retained.',
    phases: macro.phases.map((phase, index) => ({
      startDate: phase.startDate,
      endDate: phase.endDate,
      label: `Phase ${index + 1}`,
      notes: '',
    })),
  }
}

function projectNodes(nodes: WorkoutNode[]): WorkoutNode[] {
  return nodes.map((node) =>
    node.type === 'repeat'
      ? { type: 'repeat', count: node.count, steps: projectNodes(node.steps) }
      : { type: 'step', termination: node.termination, target: node.target },
  )
}

export function projectCommitment(row: StoredCommitment, includeActivityLink: boolean) {
  const definition = workoutDefinitionSchema.parse(row.definition)
  const completedAt = workoutCompletionAt(row.workout)
  return {
    workoutId: row.workoutId,
    scheduledDate: row.scheduledDate.toISOString().slice(0, 10),
    timezone: row.timezone,
    definition: { ...definition, name: 'Approved workout', steps: projectNodes(definition.steps) },
    cancelled: row.cancelled,
    completedAt: completedAt?.toISOString() ?? null,
    lockedAt: row.workout.lockedAt?.toISOString() ?? null,
    activityId: includeActivityLink ? row.workout.completedActivityId : null,
    outcome: completedAt ? ('completed' as const) : ('unknown' as const),
  }
}

export function selectRefreshCommitments(
  rows: StoredCommitment[],
  window: { startDate: string; endDate: string },
  timezone: string,
  now: Date,
) {
  const today = healthLocalDay(now.toISOString(), timezone)
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay()
  const monday = addHealthDays(today, -((weekday + 6) % 7))
  const required: StoredCommitment[] = []
  const history: StoredCommitment[] = []
  for (const row of rows) {
    const date = row.scheduledDate.toISOString().slice(0, 10)
    // Keep window locks/completions, current-week capacity and active future
    // commitments. Unprotected cancellations cannot consume required capacity.
    const needed =
      (date >= window.startDate &&
        date <= window.endDate &&
        (!row.cancelled || row.workout.lockedAt !== null || row.workout.completedAt !== null)) ||
      (!row.cancelled && (date >= monday || date > healthLocalDay(now.toISOString(), row.timezone)))
    if (needed) required.push(row)
    else history.push(row)
  }
  if (required.length > 200) throw new PlanStateError()
  history.sort(
    (a, b) =>
      b.scheduledDate.getTime() - a.scheduledDate.getTime() ||
      a.workoutId.localeCompare(b.workoutId),
  )
  return { required, history: history.slice(0, Math.min(20, 200 - required.length)) }
}
