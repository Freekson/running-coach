import 'server-only'

import type { PlanConstraints } from '@/lib/plan-constraints'
import type { PlanRefreshPreview, RefreshDiff } from '@/lib/plan-import'
import type { ExchangeResponse } from '@/schemas/plan-exchange.v1'
import {
  macroPlanSchema,
  scheduledPlanWorkoutSchema,
  type PlanContent,
} from '@/schemas/plan-content.v1'
import { localToday, mergePlanWorkouts, validatePlanContent, PlanValidationError } from '../content'
import type { StoredCommitment } from './refresh-context'

/** Use complete persisted definitions, never the privacy projection in an AI request. */
export function buildImportProposal(
  rows: StoredCommitment[],
  response: ExchangeResponse,
  constraints: PlanConstraints,
  now: Date,
  approvedMacro?: unknown,
  targetDate: string | null = null,
) {
  const previous = rows.map((row) => ({
    ...scheduledPlanWorkoutSchema.parse({
      workoutId: row.workoutId,
      scheduledDate: row.scheduledDate.toISOString().slice(0, 10),
      definition: row.definition,
      cancelled: row.cancelled,
    }),
    timezone: row.timezone,
  }))
  const schedule = new Map(previous.map((w) => [w.workoutId, w]))
  if (response.mode === 'initial') {
    for (const w of response.workouts)
      schedule.set(w.workoutId, { ...w, cancelled: false, timezone: constraints.timezone })
  } else {
    const protectedIds = new Set(
      rows
        .filter((row) => row.workout.completedAt || row.workout.lockedAt)
        .map((row) => row.workoutId),
    )
    for (const entry of response.operations) {
      const old = schedule.get(entry.workoutId)
      if (
        old &&
        (protectedIds.has(old.workoutId) || old.scheduledDate <= localToday(old.timezone, now))
      )
        throw new PlanValidationError('Past, completed or locked workouts cannot be changed')
      if (entry.operation === 'cancel') {
        if (!old) throw new Error('Validated cancellation must reference a persisted workout')
        schedule.set(entry.workoutId, { ...old, cancelled: true })
      } else {
        schedule.set(entry.workoutId, {
          workoutId: entry.workoutId,
          scheduledDate: entry.scheduledDate,
          definition: entry.definition,
          cancelled: false,
          timezone: old?.timezone ?? constraints.timezone,
        })
      }
    }
  }
  const inWindow = (w: { scheduledDate: string }) =>
    w.scheduledDate >= response.detailWindow.startDate &&
    w.scheduledDate <= response.detailWindow.endDate
  const content: PlanContent = {
    schemaVersion: 1,
    // RUN-38 refreshes near-term detail. Withheld labels must never replace the saved strategy.
    macroPlan:
      response.mode === 'refresh' ? macroPlanSchema.parse(approvedMacro) : response.macroPlan,
    detailWindow: response.detailWindow,
    // Tombstones already survive the merge; do not make accumulated cancellations
    // consume the bounded detail-content capacity on later refreshes.
    workouts: [...schedule.values()]
      .filter((w) => inWindow(w) && !w.cancelled)
      .map((w) => ({
        workoutId: w.workoutId,
        scheduledDate: w.scheduledDate,
        definition: w.definition,
        cancelled: w.cancelled,
      })),
  }
  validatePlanContent(content, constraints, targetDate)
  const workouts = mergePlanWorkouts(
    previous,
    content,
    constraints,
    rows.map((w) => ({ id: w.workoutId, ...w.workout })),
    now,
  )
  const old = new Map(previous.map((w) => [w.workoutId, w]))
  const changes: RefreshDiff[] = workouts
    .filter((w) => inWindow(w) || (old.has(w.workoutId) && inWindow(old.get(w.workoutId)!)))
    .map((after) => {
      const before = old.get(after.workoutId) ?? null
      const kind: RefreshDiff['kind'] = !before
        ? 'created'
        : JSON.stringify(before) === JSON.stringify(after)
          ? 'unchanged'
          : !before.cancelled && after.cancelled
            ? 'canceled'
            : 'changed'
      return { workoutId: after.workoutId, kind, before, after }
    })
    .sort(
      (a, b) =>
        a.after.scheduledDate.localeCompare(b.after.scheduledDate) ||
        a.workoutId.localeCompare(b.workoutId),
    )
  const refresh: PlanRefreshPreview = {
    macroPlan: content.macroPlan,
    changes,
    schedule: workouts.filter(inWindow),
    retainedOutsideWindow: workouts.filter((w) => !inWindow(w)).length,
  }
  return { content, workouts, refresh }
}
