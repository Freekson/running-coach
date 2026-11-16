import 'server-only'

import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { goalInputSchema } from '@/lib/goals'
import { healthLocalDay } from '@/lib/health-history'
import { planImportCommandSchema, type ImportError, type PlanImportResult } from '@/lib/plan-import'
import { exchangeRequestSchema } from '@/schemas/plan-exchange.v1'
import {
  ownedWhere,
  ownerId,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'
import { constraintsFromDraft, PlanValidationError } from '../content'
import {
  planTransaction,
  requireDraft,
  PlanConflictError,
  PlanStateError,
  RefreshGoalConflictError,
} from '../transaction'
import { assertExchangeCurrent } from './package'
import { importError, invalidImport, schemaImportErrors } from './repair'
import { validatePlanResponse } from './validation'
import { buildImportProposal } from './proposal'
import { assertRefreshGoalHorizon } from './refresh-context'

/** One serializable read view. Validation never writes drafts, revisions, outboxes or provider state. */
export async function previewPlanImport(
  owner: OwnerContext,
  command: unknown,
  text: string,
  transaction?: Prisma.TransactionClient,
): Promise<PlanImportResult> {
  ownerId(owner)
  const parsed = planImportCommandSchema.safeParse(command)
  if (!parsed.success) return invalidImport(schemaImportErrors(parsed.error), false)
  const input = parsed.data
  try {
    const inspect = async (tx: Prisma.TransactionClient): Promise<PlanImportResult> => {
      const issued = await tx.planExchangeRequest.findFirst({
        where: ownedWhere(owner, {
          id: input.requestId,
          draftId: input.draftId,
          goalId: input.goalId,
        }),
      })
      if (!issued) throw new OwnedResourceNotFoundError()
      const latest = await tx.planExchangeRequest.findFirst({
        where: ownedWhere(owner, { draftId: input.draftId }),
        orderBy: { issuanceSequence: 'desc' },
        select: { id: true },
      })
      if (latest?.id !== issued.id) throw new PlanConflictError()
      const request = exchangeRequestSchema.parse(issued.snapshot)
      if (
        request.mode === 'refresh' &&
        request.currentApprovedRevision.narrativePolicy !== 'withheld'
      )
        throw new PlanConflictError()
      const draft = await requireDraft(tx, owner, input.draftId)
      if (draft.goalId !== input.goalId || draft.state === 'APPROVED') throw new PlanConflictError()
      const goal = await tx.goal.findFirst({
        where: ownedWhere(owner, { id: input.goalId, archived: false }),
      })
      if (!goal) throw new OwnedResourceNotFoundError()
      const currentGoal = goalInputSchema.parse({
        name: goal.name,
        type: goal.type,
        distanceMeters: goal.distanceMeters?.toNumber() ?? null,
        targetTimeSeconds: goal.targetTimeSeconds,
        targetCount: goal.targetCount,
        measurementWindow: goal.measurementWindow,
        surface: goal.surface,
        elevationGainM: goal.elevationGainM,
        targetDate: goal.targetDate?.toISOString().slice(0, 10) ?? null,
      })
      const plan = draft.planId
        ? await tx.trainingPlan.findFirst({
            where: ownedWhere(owner, { id: draft.planId, goalId: input.goalId }),
          })
        : null
      if (draft.planId && !plan) throw new OwnedResourceNotFoundError()
      const base = plan?.currentRevisionId
        ? await tx.planRevision.findFirst({
            where: ownedWhere(owner, {
              id: plan.currentRevisionId,
              planId: plan.id,
              goalId: input.goalId,
            }),
          })
        : null
      if (draft.baseRevisionId !== (base?.id ?? null) || (plan?.currentRevisionId && !base))
        throw new PlanConflictError()
      if (base)
        assertRefreshGoalHorizon(
          z.object({ macroPlan: z.unknown() }).parse(base.snapshot).macroPlan,
          currentGoal.targetDate,
        )
      if (
        JSON.stringify(currentGoal) !== JSON.stringify(request.goal) ||
        JSON.stringify(constraintsFromDraft(draft)) !== JSON.stringify(request.draft.constraints)
      )
        throw new PlanConflictError()
      try {
        assertExchangeCurrent(request, {
          requestId: latest.id,
          draftId: draft.id,
          draftVersion: draft.version,
          revisionId: base?.id ?? null,
          revisionNumber: base?.revisionNumber ?? null,
        })
      } catch (error) {
        if (error instanceof z.ZodError) throw new PlanConflictError()
        throw error
      }
      if (
        issued.schemaVersion !== request.schemaVersion ||
        issued.draftVersion !== request.draft.version ||
        request.requestId !== issued.id
      )
        throw new PlanConflictError()
      const now = new Date()
      const today = healthLocalDay(now.toISOString(), request.timezone)
      if (request.allowedDetailWindow.startDate <= today) throw new PlanConflictError()
      const rows = base
        ? await tx.planRevisionWorkout.findMany({
            where: ownedWhere(owner, { revisionId: base.id, planId: base.planId }),
            include: { workout: true },
          })
        : []
      const prior = new Map(rows.map((w) => [w.workoutId, w]))
      // Completion affects retained sessions as well as explicit operations.
      // Reject stale evidence before building workload warnings or accepting
      // acknowledgements, even when the response omits the completed workout.
      if (
        request.mode === 'refresh' &&
        request.currentApprovedRevision.workouts.some((snapshot) => {
          const current = prior.get(snapshot.workoutId)
          return (
            !current ||
            (current.workout.completedAt?.getTime() ?? null) !==
              (snapshot.completedAt ? Date.parse(snapshot.completedAt) : null)
          )
        })
      )
        throw new PlanConflictError()
      const result = validatePlanResponse(request, text, input, today)
      if (!result.valid) return result
      const response = result.preview.response
      const errors: ImportError[] = []
      const entries = response.mode === 'initial' ? response.workouts : response.operations
      const key = response.mode === 'initial' ? 'workouts' : 'operations'
      const lockedDates = new Set(
        rows
          .filter((w) => w.workout.completedAt || w.workout.lockedAt)
          .map((w) => w.scheduledDate.toISOString().slice(0, 10)),
      )
      for (const [index, entry] of entries.entries()) {
        const old = prior.get(entry.workoutId)
        if (
          old &&
          (old.workout.completedAt ||
            old.workout.lockedAt ||
            old.scheduledDate.toISOString().slice(0, 10) <=
              healthLocalDay(now.toISOString(), old.timezone))
        )
          errors.push(
            importError(
              'locked_workout',
              [key, index, 'workoutId'],
              'Preserve past, completed and locked workouts; export a fresh request',
              'This workout is no longer editable',
            ),
          )
        if (
          'scheduledDate' in entry &&
          (entry.scheduledDate <=
            healthLocalDay(now.toISOString(), old?.timezone ?? request.timezone) ||
            lockedDates.has(entry.scheduledDate))
        )
          errors.push(
            importError(
              'invalid_date',
              [key, index, 'scheduledDate'],
              'Use an unlocked future local date from a fresh request',
            ),
          )
      }
      const newIds = entries
        .filter((w) => !('operation' in w) || w.operation === 'create')
        .map((w) => w.workoutId)
      if (newIds.length && (await tx.plannedWorkout.count({ where: { id: { in: newIds } } })))
        errors.push(
          importError(
            'workout_identity',
            [key],
            'Use new workout identities belonging to this request only',
          ),
        )
      if (errors.length) return invalidImport(errors, false)
      const proposal = buildImportProposal(
        rows,
        response,
        request.draft.constraints,
        now,
        base ? z.object({ macroPlan: z.unknown() }).parse(base.snapshot).macroPlan : undefined,
        currentGoal.targetDate,
      )
      if (response.mode === 'refresh') result.preview.refresh = proposal.refresh
      return result
    }
    return await (transaction ? inspect(transaction) : planTransaction(inspect))
  } catch (error) {
    if (error instanceof OwnedResourceNotFoundError)
      return invalidImport(
        [
          importError(
            'request_unavailable',
            ['requestId'],
            'Select an issued request for your own selected goal and draft',
          ),
        ],
        false,
      )
    if (error instanceof RefreshGoalConflictError)
      return invalidImport(
        [importError('goal_horizon_changed', ['goal', 'targetDate'], error.message)],
        false,
      )
    if (error instanceof PlanConflictError || error instanceof PlanStateError)
      return invalidImport(
        [
          importError(
            'stale_request',
            ['requestId'],
            'Reload the draft and export a fresh request; the plan, constraints or request changed',
          ),
        ],
        false,
      )
    if (error instanceof PlanValidationError)
      return invalidImport(
        [
          importError(
            'revision_conflict',
            [],
            'Preserve completed and locked history and export a fresh request',
          ),
        ],
        false,
      )
    if (error instanceof z.ZodError)
      return invalidImport(
        [
          importError(
            'snapshot_unavailable',
            ['requestId'],
            'Export a fresh supported request snapshot',
          ),
        ],
        false,
      )
    throw error
  }
}
