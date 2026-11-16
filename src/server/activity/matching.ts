import 'server-only'

import type { Prisma } from '@prisma/client'
import {
  matchActivitySchema,
  matchingQuerySchema,
  unlinkActivitySchema,
  type ActivityMatchingData,
} from '@/lib/activity-matching'
import { addCalendarDays, calendarToday } from '@/lib/training-calendar'
import { timezoneSchema } from '@/lib/plan-constraints'
import { workoutDefinitionSchema } from '@/schemas/workout-definition.v1'
import {
  ownerId,
  ownedWhere,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'
import { planTransaction, PlanConflictError } from '@/server/plans/transaction'
import { activityReadScope } from './visibility'
import { matchCandidate, matchingMetrics } from './matching-metrics'

export class ActivityMatchError extends Error {}

async function requireActivity(
  tx: Prisma.TransactionClient,
  owner: OwnerContext,
  id: string,
  garminOnly = true,
) {
  const row = await tx.activity.findFirst({
    where: {
      AND: [
        await activityReadScope(owner, tx),
        { id, ...(garminOnly ? { sourceProvider: 'GARMIN' as const } : {}) },
      ],
    },
    include: {
      plannedWorkout: true,
      laps: { where: { userId: ownerId(owner) }, orderBy: { lapIndex: 'asc' } },
    },
  })
  if (!row) throw new OwnedResourceNotFoundError()
  return row
}

// Follow the entire flagged group, including indirect cross-provider duplicates.
async function duplicateGroup(tx: Prisma.TransactionClient, owner: OwnerContext, id: string) {
  const ids = new Set([id])
  let frontier = [id]
  while (frontier.length) {
    const edges = await tx.activityDuplicateCandidate.findMany({
      where: ownedWhere(owner, {
        OR: [{ firstActivityId: { in: frontier } }, { secondActivityId: { in: frontier } }],
      }),
      select: { firstActivityId: true, secondActivityId: true },
    })
    frontier = []
    for (const edge of edges) {
      for (const next of [edge.firstActivityId, edge.secondActivityId]) {
        if (!ids.has(next)) {
          ids.add(next)
          frontier.push(next)
        }
      }
    }
  }
  return [...ids]
}

export async function getActivityMatching(
  owner: OwnerContext,
  input: unknown,
): Promise<ActivityMatchingData> {
  const userId = ownerId(owner)
  const query = matchingQuerySchema.parse(input)
  return planTransaction(async (tx) => {
    const activity = await requireActivity(tx, owner, query.activityId)
    const profile = await tx.athleteProfile.findUnique({
      where: { userId },
      select: { preferredTimezone: true },
    })
    const timezone =
      timezoneSchema.safeParse(profile?.preferredTimezone).data ??
      timezoneSchema.safeParse(activity.sourceTimezone).data ??
      'UTC'
    const localDate = calendarToday(timezone, activity.startedAt)
    const searchDate = query.date ?? localDate
    const actual = matchingMetrics({ ...activity, timerMs: activity.totalMs })
    const source = { startedAt: activity.startedAt, sportType: activity.sportType, metrics: actual }
    const memberships = await tx.planRevisionWorkout.findMany({
      where: ownedWhere(owner, {
        cancelled: false,
        scheduledDate: {
          gte: new Date(`${addCalendarDays(searchDate, -7)}T00:00:00Z`),
          lte: new Date(`${addCalendarDays(searchDate, 7)}T00:00:00Z`),
        },
        workout: { completedActivityId: null },
        revision: { currentFor: { some: { userId } } },
      }),
      orderBy: [{ scheduledDate: 'asc' }, { workoutId: 'asc' }],
    })
    const candidates = memberships
      .filter(
        (m) =>
          workoutDefinitionSchema.parse(m.definition).sport === activity.sportType &&
          activity.sportType !== 'OTHER',
      )
      .map((m) => matchCandidate(m, source))
    const plausible = candidates.filter((c) => c.sameLocalDate)
    const group = await duplicateGroup(tx, owner, activity.id)
    const duplicateLinked = !!(await tx.plannedWorkout.findFirst({
      where: ownedWhere(owner, {
        completedActivityId: { in: group.filter((id) => id !== activity.id) },
      }),
      select: { id: true },
    }))
    const duplicateWorkouts = await tx.plannedWorkout.findMany({
      where: ownedWhere(owner, {
        completedActivityId: { in: group.filter((id) => id !== activity.id) },
        completedActivity: await activityReadScope(owner, tx),
      }),
      select: {
        id: true,
        completedActivity: { select: { id: true, activityTitle: true, sourceProvider: true } },
      },
      orderBy: { id: 'asc' },
    })
    const linked = activity.plannedWorkout
    const comparison = linked?.completedRevisionId
      ? await tx.planRevisionWorkout.findFirst({
          where: ownedWhere(owner, {
            planId: linked.planId,
            revisionId: linked.completedRevisionId,
            workoutId: linked.id,
          }),
        })
      : null
    return {
      activityId: activity.id,
      title: activity.activityTitle ?? activity.sportType,
      sport: activity.sportType,
      startedAt: activity.startedAt.toISOString(),
      localDate,
      timezone,
      sourceRecordType: activity.sourceRecordType,
      externalActivityId: activity.externalActivityId,
      importedAt: activity.importedAt.toISOString(),
      actual,
      laps: activity.laps.map((lap) => ({
        ...matchingMetrics(lap),
        index: lap.lapIndex,
        sourceRecordType: lap.sourceRecordType,
      })),
      searchDate,
      candidates,
      suggestionWorkoutId:
        !linked &&
        !duplicateLinked &&
        group.length === 1 &&
        plausible.length === 1 &&
        plausible[0].metricAgreement
          ? plausible[0].workoutId
          : null,
      ambiguous: plausible.length > 1,
      duplicateCount: group.length - 1,
      duplicateLinked,
      linkedDuplicates: duplicateWorkouts.flatMap((w) =>
        w.completedActivity
          ? [
              {
                activityId: w.completedActivity.id,
                workoutId: w.id,
                title: w.completedActivity.activityTitle ?? 'Saved activity',
                provider: w.completedActivity.sourceProvider,
              },
            ]
          : [],
      ),
      linked: linked
        ? {
            workoutId: linked.id,
            comparison: comparison ? matchCandidate(comparison, source) : null,
          }
        : null,
    }
  })
}

export async function linkActivity(owner: OwnerContext, input: unknown) {
  ownerId(owner)
  const command = matchActivitySchema.parse(input)
  return planTransaction(async (tx) => {
    const activity = await requireActivity(tx, owner, command.activityId)
    if ((activity.plannedWorkout?.id ?? null) !== command.expectedWorkoutId)
      throw new PlanConflictError('Activity link changed; reload before continuing.')
    const plan = await tx.trainingPlan.findFirst({
      where: ownedWhere(owner, { id: command.planId }),
    })
    if (!plan) throw new OwnedResourceNotFoundError()
    if (plan.currentRevisionId !== command.expectedRevisionId) throw new PlanConflictError()
    const member = await tx.planRevisionWorkout.findFirst({
      where: ownedWhere(owner, {
        planId: plan.id,
        revisionId: command.expectedRevisionId,
        workoutId: command.workoutId,
        cancelled: false,
      }),
      include: { workout: true },
    })
    if (!member) throw new OwnedResourceNotFoundError()
    const definition = workoutDefinitionSchema.parse(member.definition)
    if (definition.sport !== activity.sportType || definition.sport === 'OTHER')
      throw new ActivityMatchError('Choose a workout with the same supported sport.')
    if (member.workout.completedActivityId && member.workout.completedActivityId !== activity.id)
      throw new ActivityMatchError('This workout already has a linked activity. Unlink it first.')
    const group = await duplicateGroup(tx, owner, activity.id)
    const conflict = await tx.plannedWorkout.findFirst({
      where: ownedWhere(owner, {
        completedActivityId: { in: group.filter((id) => id !== activity.id) },
      }),
      select: { id: true },
    })
    if (conflict)
      throw new ActivityMatchError(
        'A flagged duplicate is already linked. Unlink that activity before using this one.',
      )
    // Serialize matching against refresh/reschedule, which also touch this plan.
    await tx.trainingPlan.update({ where: { id: plan.id }, data: { updatedAt: new Date() } })
    if (activity.plannedWorkout && activity.plannedWorkout.id !== member.workoutId) {
      await tx.trainingPlan.update({
        where: { id: activity.plannedWorkout.planId },
        data: { updatedAt: new Date() },
      })
      await tx.plannedWorkout.update({
        where: { id: activity.plannedWorkout.id },
        data: {
          completedActivityId: null,
          completedRevisionId: null,
          ...(activity.plannedWorkout.completionFromActivity ? { completionAt: null } : {}),
        },
      })
    }
    return tx.plannedWorkout.update({
      where: { id: member.workoutId },
      data: {
        completedActivityId: activity.id,
        completedRevisionId: member.revisionId,
        completedAt: member.workout.completedAt ?? activity.startedAt,
        lockedAt: member.workout.lockedAt ?? new Date(),
        completionFromActivity:
          member.workout.completionFromActivity || !member.workout.completedAt,
        completionAt:
          member.workout.completionFromActivity || !member.workout.completedAt
            ? activity.startedAt
            : (member.workout.completionAt ?? member.workout.completedAt),
      },
    })
  })
}

export async function unlinkActivity(owner: OwnerContext, input: unknown) {
  ownerId(owner)
  const command = unlinkActivitySchema.parse(input)
  return planTransaction(async (tx) => {
    const activity = await requireActivity(tx, owner, command.activityId, false)
    if (activity.plannedWorkout?.id !== command.expectedWorkoutId)
      throw new PlanConflictError('Activity link changed; reload before continuing.')
    await tx.trainingPlan.update({
      where: { id: activity.plannedWorkout.planId },
      data: { updatedAt: new Date() },
    })
    // History locks remain permanent even when the user corrects an association.
    await tx.plannedWorkout.update({
      where: { id: command.expectedWorkoutId },
      data: {
        completedActivityId: null,
        completedRevisionId: null,
        ...(activity.plannedWorkout.completionFromActivity ? { completionAt: null } : {}),
      },
    })
  })
}
