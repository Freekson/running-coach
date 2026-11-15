import 'server-only'

import { z } from 'zod'
import { Prisma, type PlanDraft } from '@prisma/client'
import { planConstraintsSchema, planConstraintDefaults } from '@/lib/plan-constraints'
import { getPrismaClient } from '@/server/db/client'
import {
  ownedIdWhere,
  ownedWhere,
  ownerId,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'
import { constraintsFromDraft, planUuidSchema } from './content'
import { planTransaction, requireDraft, requireDraftVersion } from './transaction'

export const createPlanDraftSchema = z.strictObject({
  goalId: planUuidSchema,
  constraints: planConstraintsSchema.optional(),
})

export async function getPlanConstraintDefaults(owner: OwnerContext) {
  const where = ownedWhere(owner, {})
  const prisma = await getPrismaClient()
  return planConstraintDefaults(
    await prisma.athleteProfile.findUnique({
      where,
      select: {
        defaultTrainingDaysPerWeek: true,
        defaultAvailableWeekdays: true,
        preferredTimezone: true,
      },
    }),
  )
}

export async function createPlanDraft(owner: OwnerContext, input: unknown) {
  const userId = ownerId(owner)
  const parsed = createPlanDraftSchema.parse(input)
  const constraints = parsed.constraints ?? (await getPlanConstraintDefaults(owner))
  // The composite FK also enforces goal ownership if the goal changes concurrently.
  return planTransaction(async (tx) => {
    if (
      !(await tx.goal.findFirst({
        where: ownedIdWhere(owner, parsed.goalId),
        select: { id: true },
      }))
    )
      throw new OwnedResourceNotFoundError()
    return tx.planDraft.create({
      data: {
        userId,
        goalId: parsed.goalId,
        ...constraints,
        startDate: constraints.startDate ? new Date(`${constraints.startDate}T00:00:00Z`) : null,
      },
    })
  })
}

export async function getPlanDraft(owner: OwnerContext, id: string) {
  const where = ownedIdWhere(owner, planUuidSchema.parse(id))
  const prisma = await getPrismaClient()
  const draft = await prisma.planDraft.findFirst({ where })
  if (!draft) throw new OwnedResourceNotFoundError()
  return serializeDraft(draft)
}

function serializeDraft(draft: PlanDraft) {
  return {
    id: draft.id,
    goalId: draft.goalId,
    state: draft.state,
    version: draft.version,
    planId: draft.planId,
    baseRevisionId: draft.baseRevisionId,
    content: draft.content,
    constraints: constraintsFromDraft(draft),
  }
}

export async function updatePlanDraftConstraints(
  owner: OwnerContext,
  id: string,
  input: unknown,
  expectedVersion: number,
) {
  const where = ownedIdWhere(owner, planUuidSchema.parse(id))
  const constraints = planConstraintsSchema.parse(input)
  z.number().int().nonnegative().parse(expectedVersion)
  return planTransaction(async (tx) => {
    const draft = await requireDraft(tx, owner, id)
    requireDraftVersion(draft, expectedVersion)
    return serializeDraft(
      await tx.planDraft.update({
        where: { id: where.id, userId: where.userId, version: draft.version },
        data: {
          ...constraints,
          startDate: constraints.startDate ? new Date(`${constraints.startDate}T00:00:00Z`) : null,
          state: 'DRAFT',
          content: Prisma.DbNull,
          validatedGoalUpdatedAt: null,
          version: { increment: 1 },
        },
      }),
    )
  })
}
