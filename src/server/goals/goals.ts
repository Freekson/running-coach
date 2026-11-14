import 'server-only'

import { Prisma, type Goal } from '@prisma/client'
import { z } from 'zod'
import { goalInputSchema, type GoalRecord } from '@/lib/goals'
import { getPrismaClient } from '@/server/db/client'
import {
  ownedIdWhere,
  ownedWhere,
  ownerId,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'

function serialize(goal: Goal): GoalRecord {
  return {
    ...goalInputSchema.parse({
      name: goal.name,
      type: goal.type,
      distanceMeters: goal.distanceMeters?.toNumber() ?? null,
      targetTimeSeconds: goal.targetTimeSeconds,
      targetCount: goal.targetCount,
      measurementWindow: goal.measurementWindow,
      targetDate: goal.targetDate?.toISOString().slice(0, 10) ?? null,
      surface: goal.surface,
      elevationGainM: goal.elevationGainM,
    }),
    id: goal.id,
    archived: goal.archived,
  }
}

export async function listGoals(owner: OwnerContext): Promise<GoalRecord[]> {
  const where = ownedWhere(owner, {})
  const prisma = await getPrismaClient()
  return (
    await prisma.goal.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  ).map(serialize)
}

export async function getGoal(owner: OwnerContext, id: string): Promise<GoalRecord> {
  const where = ownedIdWhere(owner, z.uuid().parse(id))
  const prisma = await getPrismaClient()
  const goal = await prisma.goal.findFirst({ where })
  if (!goal) throw new OwnedResourceNotFoundError()
  return serialize(goal)
}

export async function saveGoal(owner: OwnerContext, input: unknown, id?: string) {
  const userId = ownerId(owner)
  const goalId = z.uuid().optional().parse(id)
  const parsed = goalInputSchema.parse(input)
  const data = {
    ...parsed,
    targetDate: parsed.targetDate ? new Date(`${parsed.targetDate}T00:00:00Z`) : null,
  }
  const prisma = await getPrismaClient()
  if (goalId === undefined)
    return serialize(await prisma.goal.create({ data: { ...data, userId } }))
  const where = ownedIdWhere(owner, goalId)
  const result = await prisma.goal.updateMany({ where, data })
  if (!result.count) throw new OwnedResourceNotFoundError()
  return getGoal(owner, goalId)
}

export async function archiveGoal(owner: OwnerContext, id: string, archived: unknown) {
  const where = ownedIdWhere(owner, z.uuid().parse(id))
  const data = { archived: z.boolean().parse(archived) }
  const prisma = await getPrismaClient()
  if (!(await prisma.goal.updateMany({ where, data })).count) throw new OwnedResourceNotFoundError()
}

export class GoalInUseError extends Error {
  constructor() {
    super('This goal is used by a plan draft. Archive it instead.')
  }
}

export async function deleteGoal(owner: OwnerContext, id: string) {
  const where = ownedIdWhere(owner, z.uuid().parse(id))
  const prisma = await getPrismaClient()
  try {
    if (!(await prisma.goal.deleteMany({ where })).count) throw new OwnedResourceNotFoundError()
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003')
      throw new GoalInUseError()
    throw error
  }
}
