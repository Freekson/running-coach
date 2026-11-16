import 'server-only'

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { estimateWorkout } from '@/lib/workout-estimate'
import type { ImportError, PlanImportResult } from '@/lib/plan-import'
import { planImportCommandSchema } from '@/lib/plan-import'
import type { ExchangeRequest, ExchangeResponse } from '@/schemas/plan-exchange.v1'
import { parsePlanResponseJson } from './package'
import { importError, invalidImport, schemaImportErrors } from './repair'
import { reviewTrainingLoad, type LoadWorkout } from './training-load'

export const IMPORT_WORK_LIMITS = {
  expandedStepsPerWorkout: 10000,
  expandedStepsTotal: 100000,
} as const

/** Explicit operations preserve omitted commitments. Do not use RUN-33 replacement semantics here. */
export function resolveResponseWorkouts(
  request: ExchangeRequest,
  response: ExchangeResponse,
): LoadWorkout[] {
  const schedule = new Map<string, LoadWorkout>()
  if (request.mode === 'refresh') {
    request.currentApprovedRevision.workouts.forEach((w, index) => {
      if (!w.cancelled && !w.completedAt && w.outcome !== 'missed' && w.outcome !== 'completed')
        schedule.set(w.workoutId, { ...w, path: ['currentApprovedRevision', 'workouts', index] })
    })
  }
  const entries = response.mode === 'initial' ? response.workouts : response.operations
  entries.forEach((w, index) => {
    if ('operation' in w && w.operation === 'cancel') schedule.delete(w.workoutId)
    else if ('scheduledDate' in w)
      schedule.set(w.workoutId, {
        ...w,
        path: [response.mode === 'initial' ? 'workouts' : 'operations', index],
      })
  })
  return [...schedule.values()]
    .filter(
      (w) =>
        w.scheduledDate >= response.detailWindow.startDate &&
        w.scheduledDate <= response.detailWindow.endDate,
    )
    .sort(
      (a, b) =>
        a.scheduledDate.localeCompare(b.scheduledDate) || a.workoutId.localeCompare(b.workoutId),
    )
}

/** Shared manual/BYOK pipeline. The caller must authorize and recheck live state. No persistence. */
export function validatePlanResponse(
  request: ExchangeRequest,
  text: string,
  review: Pick<
    z.infer<typeof planImportCommandSchema>,
    'acknowledgedWarningIds' | 'warningRationale'
  > = { acknowledgedWarningIds: [] },
  evaluatedOn = request.athleteLocalDate,
): PlanImportResult {
  let response: ExchangeResponse
  try {
    response = parsePlanResponseJson(text, request)
  } catch (error) {
    if (error instanceof z.ZodError) return invalidImport(schemaImportErrors(error))
    throw error
  }
  const workouts = resolveResponseWorkouts(request, response)
  const errors: ImportError[] = []
  const lockedIds = new Set(
    request.mode === 'refresh'
      ? request.currentApprovedRevision.workouts
          .filter((w) => w.lockedAt || w.completedAt)
          .map((w) => w.workoutId)
      : [],
  )
  let importedExpandedSteps = 0
  for (const workout of workouts) {
    const estimate = estimateWorkout(workout.definition)
    // Only definitions submitted in this response are subject to new import
    // limits. Retained approved definitions cannot be repaired by the generator.
    if (workout.path[0] !== 'currentApprovedRevision') {
      importedExpandedSteps += estimate.stepCount
      if (estimate.stepCount > IMPORT_WORK_LIMITS.expandedStepsPerWorkout)
        errors.push(
          importError(
            'step_limit',
            [...workout.path, 'definition', 'steps'],
            `Expected at most ${IMPORT_WORK_LIMITS.expandedStepsPerWorkout} expanded steps per workout`,
          ),
        )
    }
    const max = request.draft.constraints.maxSessionMinutes
    // Existing protected commitments cannot be rewritten to match newer draft
    // preferences. Keep the contract's preservation exception for these entries.
    const preservedLock =
      workout.path[0] === 'currentApprovedRevision' && lockedIds.has(workout.workoutId)
    if (!preservedLock && max !== null && estimate.durationSeconds.max > max * 60)
      errors.push(
        importError(
          'max_duration',
          [...workout.path, 'definition', 'steps'],
          `Expected prescribed session duration at most ${max * 60} seconds, including pace-based estimates`,
        ),
      )
  }
  if (importedExpandedSteps > IMPORT_WORK_LIMITS.expandedStepsTotal)
    errors.push(
      importError(
        'step_limit',
        [],
        `Expected at most ${IMPORT_WORK_LIMITS.expandedStepsTotal} expanded steps across created and updated workouts`,
      ),
    )
  if (errors.length) return invalidImport(errors)
  const load = reviewTrainingLoad(request, response, workouts, evaluatedOn)
  // Mixed sports still obey duration/structure limits and appear in the uncertainty review.
  for (const workout of workouts) {
    const estimate = estimateWorkout(workout.definition)
    if (
      request.draft.constraints.maxSessionMinutes !== null &&
      estimate.durationSeconds.incomplete
    ) {
      const id = createHash('sha256')
        .update(
          JSON.stringify({
            requestId: request.requestId,
            response,
            evaluatedOn,
            method: load.methodVersion,
            workoutId: workout.workoutId,
            code: 'duration_unknown',
          }),
        )
        .digest('hex')
        .slice(0, 24)
      load.warnings.push({
        id,
        severity: 'warning',
        code: 'duration_unknown',
        confidence: 'low',
        path: [...workout.path, 'definition', 'steps'],
        workoutIds: [workout.workoutId],
        message:
          'Distance-only or manual-lap steps do not establish an upper session duration. Review against the selected maximum; no pace or baseline has been invented.',
        evidence: {
          proposed: estimate.durationSeconds.min,
          observed: request.draft.constraints.maxSessionMinutes * 60,
          unit: 's',
          window: response.detailWindow,
        },
      })
    }
  }
  const acknowledged = new Set(review.acknowledgedWarningIds)
  const acknowledgedWarningIds = load.warnings
    .filter((w) => acknowledged.has(w.id))
    .map((w) => w.id)
  const unacknowledgedWarningIds = load.warnings
    .filter((w) => !acknowledged.has(w.id))
    .map((w) => w.id)
  return {
    valid: true,
    errors: [],
    repairPrompt: null,
    preview: {
      requestId: request.requestId,
      draftVersion: request.draft.version,
      baseRevisionId:
        request.mode === 'refresh' ? request.currentApprovedRevision.revisionId : null,
      response,
      ...load,
      review: {
        acknowledgedWarningIds,
        unacknowledgedWarningIds,
        warningRationale: review.warningRationale ?? null,
        readyForExplicitApproval: unacknowledgedWarningIds.length === 0,
        requiresExplicitApproval: true,
        approved: false,
        published: false,
      },
    },
  }
}
