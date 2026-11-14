import 'server-only'

import { Prisma, type Goal } from '@prisma/client'
import { z } from 'zod'
import { goalInputSchema, type GoalRecord } from '@/lib/goals'
import { getPrismaClient } from '@/server/db/client'
import { withGoalProgress } from './progress'
import { readGoalMutationReceipt, readGoalSnapshotMetadata } from './snapshot'
import type { GoalSnapshot } from '@/lib/goal-snapshot'
import { goalTransaction } from './transaction'
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

export async function listGoalsWithProgress(owner: OwnerContext, now = new Date()) {
  return withGoalProgress(owner, await listGoals(owner), now)
}

export async function getGoalsSnapshot(owner: OwnerContext): Promise<GoalSnapshot> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  return prisma.$transaction(
    async (tx) => {
      const metadata = await readGoalSnapshotMetadata(tx)
      const goals = await tx.goal.findMany({
        where: ownedWhere(owner, {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      const now = new Date(Number(BigInt(metadata.observedAt) / BigInt(1000)))
      return {
        ...metadata,
        ownerId: userId,
        goals: await withGoalProgress(owner, goals.map(serialize), now, tx),
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )
}

export class GoalReadOnlyError extends Error {
  constructor() {
    super('Achieved, completed and archived goals cannot be edited.')
  }
}

export async function getEditableGoal(owner: OwnerContext, id: string) {
  const [goal] = await withGoalProgress(owner, [await getGoal(owner, id)])
  if (goal.archived || goal.progress.achieved) throw new GoalReadOnlyError()
  return goal
}

export async function saveGoal(owner: OwnerContext, input: unknown, id?: string) {
  return (await saveGoalWithReceipt(owner, input, id)).value
}

export async function saveGoalWithReceipt(owner: OwnerContext, input: unknown, id?: string) {
  const userId = ownerId(owner)
  const goalId = z.uuid().optional().parse(id)
  const parsed = goalInputSchema.parse(input)
  const data = {
    ...parsed,
    targetDate: parsed.targetDate ? new Date(`${parsed.targetDate}T00:00:00Z`) : null,
  }
  const prisma = await getPrismaClient()
  return goalTransaction(prisma, async (tx) => {
    if (goalId !== undefined) {
      const current = await tx.goal.findFirst({ where: ownedIdWhere(owner, goalId) })
      if (!current) throw new OwnedResourceNotFoundError()
      const [goal] = await withGoalProgress(owner, [serialize(current)], new Date(), tx)
      if (goal.archived || goal.progress.achieved) throw new GoalReadOnlyError()
    }
    const saved =
      goalId === undefined
        ? await tx.goal.create({ data: { ...data, userId } })
        : await tx.goal.update({ where: { userId_id: { userId, id: goalId } }, data })
    const [goal] = await withGoalProgress(owner, [serialize(saved)], new Date(), tx)
    return { value: goal, receipt: await readGoalMutationReceipt(owner, tx) }
  })
}

export async function archiveGoal(owner: OwnerContext, id: string, archived: unknown) {
  return (await archiveGoalWithReceipt(owner, id, archived)).value
}

export async function archiveGoalWithReceipt(owner: OwnerContext, id: string, archived: unknown) {
  const where = ownedIdWhere(owner, z.uuid().parse(id))
  const data = { archived: z.boolean().parse(archived) }
  const prisma = await getPrismaClient()
  return goalTransaction(prisma, async (tx) => {
    if (!(await tx.goal.updateMany({ where, data })).count) throw new OwnedResourceNotFoundError()
    const saved = await tx.goal.findFirst({ where })
    if (!saved) throw new OwnedResourceNotFoundError()
    const [goal] = await withGoalProgress(owner, [serialize(saved)], new Date(), tx)
    return { value: goal, receipt: await readGoalMutationReceipt(owner, tx) }
  })
}

export class GoalInUseError extends Error {
  constructor() {
    super('This goal is used by a plan draft. Archive it instead.')
  }
}

export async function deleteGoal(owner: OwnerContext, id: string) {
  await deleteGoalWithReceipt(owner, id)
}

export async function deleteGoalWithReceipt(owner: OwnerContext, id: string) {
  const where = ownedIdWhere(owner, z.uuid().parse(id))
  const prisma = await getPrismaClient()
  try {
    return await goalTransaction(prisma, async (tx) => {
      if (!(await tx.goal.deleteMany({ where })).count) throw new OwnedResourceNotFoundError()
      return { value: null, receipt: await readGoalMutationReceipt(owner, tx) }
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003')
      throw new GoalInUseError()
    throw error
  }
}
