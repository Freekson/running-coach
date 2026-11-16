import 'server-only'

import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { healthLocalDay } from '@/lib/health-history'
import { publicationStatusSchema } from '@/lib/workout-publication'
import {
  revisionPublicationSchema,
  sendRevisionPublicationSchema,
  type RevisionPublicationPreview,
} from '@/lib/plan-publication'
import { planUuidSchema, scheduledPlanWorkoutSchema } from '@/schemas/plan-content.v1'
import {
  ownerId,
  ownedWhere,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'
import { createIntervalsPublicationService } from '@/server/intervals/publication'
import {
  confirmedPublicationPayload,
  publicationOperation,
} from '@/server/intervals/publication-baseline'
import {
  approvedWorkoutSchema,
  publicationPayloadSchema,
  PublicationError,
  type ApprovedWorkoutReader,
} from '@/server/intervals/publication-contract'
import { planTransaction, PlanConflictError } from './transaction'

/** Lock the current-revision pointer for the outbox's supplied transaction. */
export const readApprovedPlanWorkout: ApprovedWorkoutReader = async (tx, owner, workoutId) => {
  const userId = ownerId(owner)
  const id = planUuidSchema.parse(workoutId)
  const plans = await tx.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM training_plans p
    JOIN planned_workouts w ON w.plan_id = p.id AND w.user_id = p.user_id
    WHERE w.id = ${id}::uuid AND p.user_id = ${userId}::uuid
    FOR UPDATE OF p
  `
  if (!plans.length) return null
  const plan = await tx.trainingPlan.findFirst({ where: ownedWhere(owner, { id: plans[0].id }) })
  if (!plan?.currentRevisionId) return null
  const row = await tx.planRevisionWorkout.findFirst({
    where: ownedWhere(owner, {
      planId: plan.id,
      revisionId: plan.currentRevisionId,
      workoutId: id,
    }),
    include: { workout: true },
  })
  if (!row) return null
  return approvedWorkoutSchema.parse({
    userId,
    localWorkoutId: row.workoutId,
    revisionId: plan.currentRevisionId,
    approved: true,
    cancelled: row.cancelled,
    locked:
      !!row.workout.completedAt ||
      !!row.workout.lockedAt ||
      row.scheduledDate.toISOString().slice(0, 10) <=
        healthLocalDay(new Date().toISOString(), row.timezone),
    workout: row.definition,
    schedule: { localDate: row.scheduledDate.toISOString().slice(0, 10), timeZone: row.timezone },
  })
}

const publication = createIntervalsPublicationService(readApprovedPlanWorkout)

function asWorkout(payload: z.infer<typeof publicationPayloadSchema>) {
  return {
    ...scheduledPlanWorkoutSchema.parse({
      workoutId: payload.localWorkoutId,
      scheduledDate: payload.schedule.localDate,
      definition: payload.workout,
      cancelled: payload.cancelled,
    }),
    timezone: payload.schedule.timeZone,
  }
}

async function inspect(
  tx: Prisma.TransactionClient,
  owner: OwnerContext,
  input: z.infer<typeof revisionPublicationSchema>,
): Promise<RevisionPublicationPreview> {
  const plan = await tx.trainingPlan.findFirst({ where: ownedWhere(owner, { id: input.planId }) })
  if (!plan) throw new OwnedResourceNotFoundError()
  if (plan.currentRevisionId !== input.expectedRevisionId) throw new PlanConflictError()
  const rows = await tx.planRevisionWorkout.findMany({
    where: ownedWhere(owner, { planId: plan.id, revisionId: input.expectedRevisionId }),
    include: { workout: true },
    orderBy: [{ scheduledDate: 'asc' }, { workoutId: 'asc' }],
  })
  const receipts = await tx.workoutPublication.findMany({
    where: ownedWhere(owner, {
      provider: 'INTERVALS' as const,
      localWorkoutId: { in: rows.map((row) => row.workoutId) },
    }),
  })
  const prior = new Map(receipts.map((receipt) => [receipt.localWorkoutId, receipt]))
  const changes: RevisionPublicationPreview['changes'] = []
  for (const row of rows) {
    const receipt = prior.get(row.workoutId)
    const needsRecovery =
      !!receipt && !!(receipt.status === 'UNCERTAIN' || receipt.pendingWrite || receipt.leaseToken)
    const protectedWorkout = !!(
      row.workout.completedAt ||
      row.workout.lockedAt ||
      row.scheduledDate.toISOString().slice(0, 10) <=
        healthLocalDay(new Date().toISOString(), row.timezone)
    )
    // An earlier uncertain effect still needs reconciliation after the local
    // workout becomes protected. Dispatch rechecks protection before any write.
    if (protectedWorkout && !needsRecovery) continue
    if (row.cancelled && !receipt) continue
    const after = {
      ...scheduledPlanWorkoutSchema.parse({
        workoutId: row.workoutId,
        scheduledDate: row.scheduledDate.toISOString().slice(0, 10),
        definition: row.definition,
        cancelled: row.cancelled,
      }),
      timezone: row.timezone,
    }
    const baseline = receipt ? confirmedPublicationPayload(receipt) : null
    const before = baseline ? asWorkout(baseline) : null
    const baselineStatus = baseline
      ? ('confirmed' as const)
      : receipt
        ? ('unknown' as const)
        : ('not_published' as const)
    const same = JSON.stringify(before) === JSON.stringify(after)
    if (
      same &&
      receipt &&
      !receipt.pendingWrite &&
      !receipt.leaseToken &&
      ['PUBLISHED', 'CANCELLED'].includes(receipt.status)
    )
      continue
    const payload = publicationPayloadSchema.parse({
      localWorkoutId: row.workoutId,
      revisionId: input.expectedRevisionId,
      approved: true,
      cancelled: row.cancelled,
      locked: false,
      workout: row.definition,
      schedule: { localDate: after.scheduledDate, timeZone: row.timezone },
    })
    const operation = publicationOperation(payload, baseline, receipt ?? null)
    // Bind confirmation to the exact local outbox baseline, never a client-supplied diff.
    const reviewToken = createHash('sha256')
      .update(
        JSON.stringify({
          input,
          before,
          after,
          publishRevision: receipt?.publishRevision ?? 0,
          status: receipt?.status ?? null,
          protectedWorkout,
          baselineStatus,
          remoteStateUncertain: needsRecovery,
        }),
      )
      .digest('hex')
    changes.push({
      workoutId: row.workoutId,
      kind: !before
        ? baselineStatus === 'unknown'
          ? 'changed'
          : 'created'
        : !before.cancelled && row.cancelled
          ? 'canceled'
          : same
            ? 'unchanged'
            : 'changed',
      before,
      after,
      operation,
      reviewToken,
      expectedPublishRevision: receipt?.publishRevision ?? 0,
      status: receipt ? publicationStatusSchema.parse(receipt.status) : null,
      baselineStatus,
      remoteStateUncertain: needsRecovery,
      ...(receipt && needsRecovery
        ? { recovery: { publicationId: receipt.id, publishRevision: receipt.publishRevision } }
        : {}),
      ...(protectedWorkout ? { recoveryOnly: true as const } : {}),
    })
  }
  return { planId: plan.id, revisionId: input.expectedRevisionId, changes }
}

/** Local outbox comparison only. Opening a preview never contacts a provider. */
export async function previewRevisionPublication(owner: OwnerContext, input: unknown) {
  ownerId(owner)
  const parsed = revisionPublicationSchema.parse(input)
  return planTransaction((tx) => inspect(tx, owner, parsed))
}

/** An explicit per-workout confirmation queues and dispatches through RUN-41. */
export async function sendRevisionPublication(owner: OwnerContext, input: unknown) {
  ownerId(owner)
  const parsed = sendRevisionPublicationSchema.parse(input)
  const preview = await previewRevisionPublication(owner, {
    planId: parsed.planId,
    expectedRevisionId: parsed.expectedRevisionId,
  })
  const change = preview.changes.find((entry) => entry.workoutId === parsed.workoutId)
  if (!change || change.reviewToken !== parsed.reviewToken) throw new PlanConflictError()
  // Reconcile the previous intent first. RUN-41 checks the current revision and
  // never replays an obsolete prescription while resolving an uncertain receipt.
  if (change.recovery) return publication.dispatch(owner, change.recovery)
  const receipt = await publication.queue(owner, {
    localWorkoutId: parsed.workoutId,
    expectedRevisionId: parsed.expectedRevisionId,
    expectedPublishRevision: change.expectedPublishRevision,
  })
  if (receipt.status === 'RUNNING') throw new PublicationError('BUSY')
  return publication.dispatch(owner, {
    publicationId: receipt.id,
    publishRevision: receipt.publishRevision,
  })
}
