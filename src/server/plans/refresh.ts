import 'server-only'

import type { ApprovedPlanChoice } from '@/lib/plan-refresh'
import { ownedWhere, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'

export async function listApprovedPlans(owner: OwnerContext): Promise<ApprovedPlanChoice[]> {
  const where = ownedWhere(owner, { currentRevisionId: { not: null }, goal: { archived: false } })
  const prisma = await getPrismaClient()
  const plans = await prisma.trainingPlan.findMany({
    where,
    include: { currentRevision: true, goal: { select: { name: true } } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
  })
  return plans.flatMap((plan) =>
    plan.currentRevision
      ? [
          {
            id: plan.id,
            goalId: plan.goalId,
            goalName: plan.goal.name,
            revisionId: plan.currentRevision.id,
            revisionNumber: plan.currentRevision.revisionNumber,
          },
        ]
      : [],
  )
}
