import 'server-only'

import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { ownerId, ownedWhere, type OwnerContext } from '@/server/authorization/ownership'
import type { HistoricalWorkout } from './content'
import { PlanConflictError } from './transaction'

// Shared persistence for explicit plan approval and a human-approved calendar move.
// The caller validates the operation in the same serializable transaction.
export async function appendApprovedRevision(
  tx: Prisma.TransactionClient,
  owner: OwnerContext,
  input: {
    planId: string
    goalId: string
    draftId: string
    parent: { id: string; revisionNumber: number } | null
    snapshot: Prisma.InputJsonValue
    workouts: HistoricalWorkout[]
    knownIds: Set<string>
  },
) {
  const userId = ownerId(owner)
  const revisionId = randomUUID()
  const changed = await tx.trainingPlan.updateMany({
    where: ownedWhere(owner, { id: input.planId, currentRevisionId: input.parent?.id ?? null }),
    data: { currentRevisionId: revisionId },
  })
  if (changed.count !== 1) throw new PlanConflictError()
  await tx.planDraft.update({ where: { id: input.draftId }, data: { planId: input.planId } })
  const revision = await tx.planRevision.create({
    data: {
      id: revisionId,
      userId,
      goalId: input.goalId,
      planId: input.planId,
      sourceDraftId: input.draftId,
      parentRevisionId: input.parent?.id ?? null,
      revisionNumber: (input.parent?.revisionNumber ?? 0) + 1,
      snapshot: input.snapshot,
    },
  })
  const newWorkouts = input.workouts.filter((w) => !input.knownIds.has(w.workoutId))
  if (newWorkouts.length)
    await tx.plannedWorkout.createMany({
      data: newWorkouts.map((w) => ({ id: w.workoutId, userId, planId: input.planId })),
    })
  if (input.workouts.length)
    await tx.planRevisionWorkout.createMany({
      data: input.workouts.map((w) => ({
        userId,
        planId: input.planId,
        revisionId,
        workoutId: w.workoutId,
        scheduledDate: new Date(`${w.scheduledDate}T00:00:00Z`),
        timezone: w.timezone,
        definition: w.definition,
        cancelled: w.cancelled,
      })),
    })
  await tx.planDraft.update({
    where: { id: input.draftId },
    data: { state: 'APPROVED', version: { increment: 1 } },
  })
  return revision
}
