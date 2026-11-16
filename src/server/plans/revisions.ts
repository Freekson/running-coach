import 'server-only'

import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { goalInputSchema } from '@/lib/goals'
import { planConstraintsSchema } from '@/lib/plan-constraints'
import { getPrismaClient } from '@/server/db/client'
import {
  ownerId,
  ownedIdWhere,
  ownedWhere,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'
import {
  constraintsFromDraft,
  mergePlanWorkouts,
  planContentSchema,
  planUuidSchema,
  scheduledPlanWorkoutSchema,
  validatePlanContent,
} from './content'
import { appendApprovedRevision } from './snapshots'
import {
  planTransaction,
  requireDraft,
  requireDraftVersion,
  PlanConflictError,
  PlanStateError,
} from './transaction'

const draftCommandSchema = z.strictObject({
  draftId: planUuidSchema,
  expectedVersion: z.number().int().nonnegative(),
})
const approvalSchema = draftCommandSchema.extend({
  expectedRevisionId: planUuidSchema.nullable(),
  approve: z.literal(true),
})

async function requirePlan(tx: Prisma.TransactionClient, owner: OwnerContext, planId: string) {
  const plan = await tx.trainingPlan.findFirst({ where: ownedIdWhere(owner, planId) })
  if (!plan) throw new OwnedResourceNotFoundError()
  return plan
}

async function prepareApproval(
  tx: Prisma.TransactionClient,
  owner: OwnerContext,
  draft: Awaited<ReturnType<typeof requireDraft>>,
) {
  const goal = await tx.goal.findFirst({ where: ownedIdWhere(owner, draft.goalId) })
  if (!goal) throw new OwnedResourceNotFoundError()
  const constraints = constraintsFromDraft(draft)
  const content = planContentSchema.parse(draft.content)
  validatePlanContent(content, constraints, goal.targetDate?.toISOString().slice(0, 10) ?? null)
  const plan = draft.planId ? await requirePlan(tx, owner, draft.planId) : null
  if ((plan?.currentRevisionId ?? null) !== draft.baseRevisionId) throw new PlanConflictError()
  const base =
    plan && draft.baseRevisionId
      ? await tx.planRevision.findFirst({
          where: ownedWhere(owner, { id: draft.baseRevisionId, planId: plan.id }),
          include: { workouts: true },
        })
      : null
  if (draft.baseRevisionId && !base) throw new OwnedResourceNotFoundError()
  const previous = (base?.workouts ?? []).map((w) => ({
    ...scheduledPlanWorkoutSchema.parse({
      workoutId: w.workoutId,
      scheduledDate: w.scheduledDate.toISOString().slice(0, 10),
      definition: w.definition,
      cancelled: w.cancelled,
    }),
    timezone: w.timezone,
  }))
  const locks = plan
    ? await tx.plannedWorkout.findMany({ where: ownedWhere(owner, { planId: plan.id }) })
    : []
  // A proposed UUID can be new, or an existing logical workout in this plan only.
  const knownIds = new Set(locks.map((w) => w.id))
  const newIds = content.workouts.map((w) => w.workoutId).filter((id) => !knownIds.has(id))
  if (newIds.length && (await tx.plannedWorkout.count({ where: { id: { in: newIds } } })))
    throw new OwnedResourceNotFoundError()
  const workouts = mergePlanWorkouts(previous, content, constraints, locks, new Date())
  const goalSnapshot = goalInputSchema.parse({
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
  return { goal, goalSnapshot, constraints, content, plan, base, workouts, knownIds }
}

export async function saveGeneratedPlan(owner: OwnerContext, command: unknown, input: unknown) {
  ownerId(owner)
  const parsed = draftCommandSchema.parse(command)
  const content = planContentSchema.parse(input)
  return planTransaction(async (tx) => {
    const draft = await requireDraft(tx, owner, parsed.draftId)
    requireDraftVersion(draft, parsed.expectedVersion)
    return tx.planDraft.update({
      where: { id: draft.id },
      data: {
        content,
        state: 'GENERATED',
        validatedGoalUpdatedAt: null,
        version: { increment: 1 },
      },
    })
  })
}

export async function validateGeneratedPlan(owner: OwnerContext, command: unknown) {
  ownerId(owner)
  const parsed = draftCommandSchema.parse(command)
  return planTransaction(async (tx) => {
    const draft = await requireDraft(tx, owner, parsed.draftId)
    requireDraftVersion(draft, parsed.expectedVersion)
    if (draft.state !== 'GENERATED') throw new PlanStateError()
    const prepared = await prepareApproval(tx, owner, draft)
    return tx.planDraft.update({
      where: { id: draft.id },
      data: {
        state: 'VALIDATED',
        validatedGoalUpdatedAt: prepared.goal.updatedAt,
        version: { increment: 1 },
      },
    })
  })
}

export async function approvePlanDraft(
  owner: OwnerContext,
  command: unknown,
  transaction?: Prisma.TransactionClient,
) {
  const userId = ownerId(owner)
  const parsed = approvalSchema.parse(command)
  const approve = async (tx: Prisma.TransactionClient) => {
    const draft = await requireDraft(tx, owner, parsed.draftId)
    requireDraftVersion(draft, parsed.expectedVersion)
    if (draft.state !== 'VALIDATED') throw new PlanStateError()
    if (parsed.expectedRevisionId !== draft.baseRevisionId) throw new PlanConflictError()
    const p = await prepareApproval(tx, owner, draft)
    if (draft.validatedGoalUpdatedAt?.getTime() !== p.goal.updatedAt.getTime())
      throw new PlanConflictError()
    const plan =
      p.plan ?? (await tx.trainingPlan.create({ data: { userId, goalId: draft.goalId } }))
    return appendApprovedRevision(tx, owner, {
      planId: plan.id,
      goalId: draft.goalId,
      draftId: draft.id,
      parent: p.base,
      snapshot: {
        schemaVersion: 1,
        goal: p.goalSnapshot,
        constraints: p.constraints,
        macroPlan: p.content.macroPlan,
        detailWindow: p.content.detailWindow,
      },
      workouts: p.workouts,
      knownIds: p.knownIds,
    })
  }
  return transaction ? approve(transaction) : planTransaction(approve)
}

export async function createPlanRefreshDraft(owner: OwnerContext, input: unknown) {
  const userId = ownerId(owner)
  const parsed = z
    .strictObject({ planId: planUuidSchema, baseRevisionId: planUuidSchema })
    .parse(input)
  return planTransaction(async (tx) => {
    const plan = await requirePlan(tx, owner, parsed.planId)
    const base = await tx.planRevision.findFirst({
      where: ownedWhere(owner, { id: parsed.baseRevisionId, planId: plan.id }),
    })
    if (!base) throw new OwnedResourceNotFoundError()
    if (plan.currentRevisionId !== base.id) throw new PlanConflictError()
    const snapshot = z.object({ constraints: z.unknown() }).parse(base.snapshot)
    const constraints = planConstraintsSchema.parse(snapshot.constraints)
    return tx.planDraft.create({
      data: {
        userId,
        goalId: plan.goalId,
        planId: plan.id,
        baseRevisionId: base.id,
        ...constraints,
        startDate: constraints.startDate ? new Date(`${constraints.startDate}T00:00:00Z`) : null,
      },
    })
  })
}

export async function getPlanRevision(owner: OwnerContext, planId: string, revisionId: string) {
  const where = ownedWhere(owner, {
    planId: planUuidSchema.parse(planId),
    id: planUuidSchema.parse(revisionId),
  })
  const prisma = await getPrismaClient()
  const revision = await prisma.planRevision.findFirst({
    where,
    include: { workouts: { orderBy: [{ scheduledDate: 'asc' }, { workoutId: 'asc' }] } },
  })
  if (!revision) throw new OwnedResourceNotFoundError()
  return revision
}

export async function getTrainingPlan(owner: OwnerContext, planId: string) {
  const where = ownedIdWhere(owner, planUuidSchema.parse(planId))
  const prisma = await getPrismaClient()
  const plan = await prisma.trainingPlan.findFirst({ where, include: { currentRevision: true } })
  if (!plan) throw new OwnedResourceNotFoundError()
  return plan
}

export async function listPlanRevisions(owner: OwnerContext, planId: string) {
  const where = ownedWhere(owner, { planId: planUuidSchema.parse(planId) })
  const prisma = await getPrismaClient()
  if (!(await prisma.trainingPlan.findFirst({ where: ownedIdWhere(owner, planId) })))
    throw new OwnedResourceNotFoundError()
  return prisma.planRevision.findMany({ where, orderBy: { revisionNumber: 'desc' } })
}

export async function lockPlannedWorkout(owner: OwnerContext, input: unknown) {
  ownerId(owner)
  const parsed = z
    .strictObject({
      planId: planUuidSchema,
      expectedRevisionId: planUuidSchema,
      workoutId: planUuidSchema,
      completed: z.boolean(),
    })
    .parse(input)
  return planTransaction(async (tx) => {
    const plan = await requirePlan(tx, owner, parsed.planId)
    if (plan.currentRevisionId !== parsed.expectedRevisionId) throw new PlanConflictError()
    const member = await tx.planRevisionWorkout.findFirst({
      where: ownedWhere(owner, {
        planId: plan.id,
        revisionId: parsed.expectedRevisionId,
        workoutId: parsed.workoutId,
        cancelled: false,
      }),
    })
    if (!member) throw new OwnedResourceNotFoundError()
    // Touching the plan serializes locks/completion against approval's pointer update.
    await tx.trainingPlan.update({ where: { id: plan.id }, data: { updatedAt: new Date() } })
    const workout = await tx.plannedWorkout.findFirst({
      where: ownedIdWhere(owner, parsed.workoutId),
    })
    if (!workout) throw new OwnedResourceNotFoundError()
    const manualCompletionAt =
      (!workout.completionFromActivity ? (workout.completionAt ?? workout.completedAt) : null) ??
      new Date()
    return tx.plannedWorkout.update({
      where: { id: workout.id },
      data: {
        lockedAt: workout.lockedAt ?? new Date(),
        completedAt: workout.completedAt ?? (parsed.completed ? manualCompletionAt : null),
        ...(parsed.completed
          ? { completionAt: manualCompletionAt, completionFromActivity: false }
          : {}),
      },
    })
  })
}
