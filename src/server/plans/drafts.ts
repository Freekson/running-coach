import 'server-only'

import { z } from 'zod'
import { planConstraintsSchema, planConstraintDefaults } from '@/lib/plan-constraints'
import { getPrismaClient } from '@/server/db/client'
import {
  ownedIdWhere,
  ownedWhere,
  ownerId,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'

export const createPlanDraftSchema = z.strictObject({
  goalId: z.uuid(),
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
  const prisma = await getPrismaClient()
  // The composite FK also enforces goal ownership if the goal changes concurrently.
  return prisma.$transaction(async (tx) => {
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
  const where = ownedIdWhere(owner, z.uuid().parse(id))
  const prisma = await getPrismaClient()
  const draft = await prisma.planDraft.findFirst({ where })
  if (!draft) throw new OwnedResourceNotFoundError()
  return {
    id: draft.id,
    goalId: draft.goalId,
    constraints: planConstraintsSchema.parse({
      sessionsPerWeek: draft.sessionsPerWeek,
      availableWeekdays: draft.availableWeekdays,
      maxSessionMinutes: draft.maxSessionMinutes,
      startDate: draft.startDate?.toISOString().slice(0, 10) ?? null,
      timezone: draft.timezone,
    }),
  }
}

export async function updatePlanDraftConstraints(owner: OwnerContext, id: string, input: unknown) {
  const where = ownedIdWhere(owner, z.uuid().parse(id))
  const constraints = planConstraintsSchema.parse(input)
  const prisma = await getPrismaClient()
  const result = await prisma.planDraft.updateMany({
    where,
    data: {
      ...constraints,
      startDate: constraints.startDate ? new Date(`${constraints.startDate}T00:00:00Z`) : null,
    },
  })
  if (!result.count) throw new OwnedResourceNotFoundError()
  return getPlanDraft(owner, id)
}
