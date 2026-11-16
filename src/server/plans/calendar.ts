import 'server-only'

import { z } from 'zod'
import {
  addCalendarDays,
  calendarQuerySchema,
  calendarRange,
  calendarToday,
  rescheduleWorkoutSchema,
  type CalendarWorkout,
  type TrainingCalendarData,
} from '@/lib/training-calendar'
import { planConstraintsSchema, timezoneSchema } from '@/lib/plan-constraints'
import {
  ownerId,
  ownedIdWhere,
  ownedWhere,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'
import { activityReadScope } from '@/server/activity/visibility'
import { planContentSchema, scheduledPlanWorkoutSchema } from './content'
import { appendApprovedRevision } from './snapshots'
import { planTransaction, PlanConflictError } from './transaction'

const scheduleSnapshotSchema = planContentSchema.omit({ workouts: true }).extend({
  constraints: planConstraintsSchema,
  goal: z.json(),
})

export class CalendarEditError extends Error {}

export async function getTrainingCalendar(
  owner: OwnerContext,
  input: unknown = {},
  now = new Date(),
): Promise<TrainingCalendarData> {
  const userId = ownerId(owner)
  const query = calendarQuerySchema.parse(input)
  return planTransaction(async (tx) => {
    const profile = await tx.athleteProfile.findUnique({
      where: { userId },
      select: { preferredTimezone: true },
    })
    const timezone = timezoneSchema.safeParse(profile?.preferredTimezone).data ?? 'UTC'
    const today = calendarToday(timezone, now)
    const date = query.date ?? today
    const range = calendarRange(date, query.view)
    const plans = await tx.trainingPlan.findMany({
      where: ownedWhere(owner, { currentRevisionId: { not: null } }),
      include: {
        currentRevision: {
          include: {
            workouts: {
              where: {
                scheduledDate: {
                  gte: new Date(`${range.start}T00:00:00Z`),
                  lte: new Date(`${range.end}T00:00:00Z`),
                },
              },
              include: { workout: true },
              orderBy: [{ scheduledDate: 'asc' }, { workoutId: 'asc' }],
            },
          },
        },
      },
      orderBy: { id: 'asc' },
    })
    const visibleActivityScope = await activityReadScope(owner, tx)
    const linkedIds = plans.flatMap(
      (p) =>
        p.currentRevision?.workouts
          .map((w) => w.workout.completedActivityId)
          .filter((id): id is string => !!id) ?? [],
    )
    const activities = await tx.activity.findMany({
      where: {
        AND: [
          visibleActivityScope,
          {
            OR: [
              {
                startedAt: {
                  gte: new Date(`${addCalendarDays(range.start, -2)}T00:00:00Z`),
                  lt: new Date(`${addCalendarDays(range.end, 3)}T00:00:00Z`),
                },
              },
              { id: { in: linkedIds } },
            ],
          },
        ],
      },
      select: {
        id: true,
        activityTitle: true,
        sportType: true,
        sourceTimezone: true,
        startedAt: true,
        plannedWorkout: { select: { id: true } },
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    })
    const visibleActivities = new Map(activities.map((a) => [a.id, a]))
    const history = await tx.planRevisionWorkout.findMany({
      where: ownedWhere(owner, {
        planId: { in: plans.map((p) => p.id) },
        workoutId: {
          in: plans.flatMap((p) => p.currentRevision?.workouts.map((w) => w.workoutId) ?? []),
        },
      }),
      select: { workoutId: true, scheduledDate: true, timezone: true },
      orderBy: { revision: { revisionNumber: 'desc' } },
    })
    const workouts: CalendarWorkout[] = []
    const windows: { startDate: string; endDate: string }[] = []
    for (const plan of plans) {
      const revision = plan.currentRevision
      if (!revision) continue
      const snapshot = scheduleSnapshotSchema.parse(revision.snapshot)
      windows.push(snapshot.detailWindow)
      for (const member of revision.workouts) {
        const date = member.scheduledDate.toISOString().slice(0, 10)
        if (date < range.start || date > range.end) continue
        const canonical = scheduledPlanWorkoutSchema.parse({
          workoutId: member.workoutId,
          scheduledDate: date,
          definition: member.definition,
          cancelled: member.cancelled,
        })
        const localToday = calendarToday(member.timezone, now)
        const completed = !!member.workout.completedAt
        const previous = history.find(
          (w) =>
            w.workoutId === member.workoutId &&
            (w.scheduledDate.getTime() !== member.scheduledDate.getTime() ||
              w.timezone !== member.timezone),
        )
        const previousDate = previous?.scheduledDate.toISOString().slice(0, 10) ?? null
        const activity = member.workout.completedActivityId
          ? visibleActivities.get(member.workout.completedActivityId)
          : null
        workouts.push({
          id: member.workoutId,
          planId: plan.id,
          revisionId: revision.id,
          name: canonical.definition.name,
          sport: canonical.definition.sport,
          date,
          timezone: member.timezone,
          status: completed
            ? 'completed'
            : member.cancelled
              ? 'cancelled'
              : date < localToday
                ? 'missed'
                : 'planned',
          locked: !!member.workout.lockedAt,
          editable:
            !completed &&
            !member.workout.lockedAt &&
            !member.cancelled &&
            date > localToday &&
            date >= snapshot.detailWindow.startDate &&
            date <= snapshot.detailWindow.endDate,
          movedFrom:
            previousDate && (previousDate !== date || previous?.timezone !== member.timezone)
              ? previousDate
              : null,
          minDate: snapshot.detailWindow.startDate,
          maxDate: snapshot.detailWindow.endDate,
          activity: activity
            ? { id: activity.id, title: activity.activityTitle ?? activity.sportType }
            : null,
        })
      }
    }
    const datedActivities = activities.map((a) => {
      const zone = timezoneSchema.safeParse(a.sourceTimezone).data ?? timezone
      return {
        id: a.id,
        title: a.activityTitle ?? a.sportType,
        date: calendarToday(zone, a.startedAt),
        timezone: zone,
        linkedWorkoutId: a.plannedWorkout?.id ?? null,
      }
    })
    // Deduplicate a linked activity only when its completed prescription is
    // already shown on that same local day. A delayed run still occupies its
    // actual training day, even if its prescription is outside the visible range.
    const dailyActivities = datedActivities.filter(
      (activity) =>
        !workouts.some(
          (workout) =>
            workout.id === activity.linkedWorkoutId &&
            workout.date === activity.date &&
            workout.activity?.id === activity.id,
        ),
    )
    return {
      date,
      view: query.view,
      timezone,
      today,
      hasPlan: plans.length > 0,
      days: range.dates.map((date) => {
        const scheduled = workouts.filter((w) => w.date === date)
        const saved = dailyActivities.filter((a) => a.date === date)
        return {
          date,
          workouts: scheduled,
          activities: saved,
          rest:
            !scheduled.some((w) => w.status !== 'cancelled') &&
            !saved.length &&
            windows.some((w) => date >= w.startDate && date <= w.endDate),
        }
      }),
    }
  })
}

export async function rescheduleCalendarWorkout(
  owner: OwnerContext,
  input: unknown,
  now = new Date(),
) {
  const userId = ownerId(owner)
  const command = rescheduleWorkoutSchema.parse(input)
  return planTransaction(async (tx) => {
    const plan = await tx.trainingPlan.findFirst({ where: ownedIdWhere(owner, command.planId) })
    if (!plan) throw new OwnedResourceNotFoundError()
    if (plan.currentRevisionId !== command.expectedRevisionId) throw new PlanConflictError()
    const base = await tx.planRevision.findFirst({
      where: ownedWhere(owner, { id: command.expectedRevisionId, planId: plan.id }),
      include: {
        sourceDraft: { select: { validatedGoalUpdatedAt: true } },
        workouts: { include: { workout: true } },
      },
    })
    if (!base) throw new OwnedResourceNotFoundError()
    const member = base.workouts.find((w) => w.workoutId === command.workoutId)
    if (!member) throw new OwnedResourceNotFoundError()
    const oldDate = member.scheduledDate.toISOString().slice(0, 10)
    if (
      member.cancelled ||
      member.workout.completedAt ||
      member.workout.lockedAt ||
      oldDate <= calendarToday(member.timezone, now)
    )
      throw new CalendarEditError(
        'Past, current-day, completed, locked or canceled sessions cannot be moved.',
      )
    const snapshot = scheduleSnapshotSchema.parse(base.snapshot)
    if (command.scheduledDate <= calendarToday(command.timezone, now))
      throw new CalendarEditError('Choose a future date in the session timezone.')
    if (
      command.scheduledDate < snapshot.detailWindow.startDate ||
      command.scheduledDate > snapshot.detailWindow.endDate ||
      oldDate < snapshot.detailWindow.startDate ||
      oldDate > snapshot.detailWindow.endDate
    )
      throw new CalendarEditError(
        'Move sessions within the approved detail window. Refresh the plan to extend it.',
      )
    if (command.scheduledDate === oldDate && command.timezone === member.timezone) return base.id
    const workouts = base.workouts.map((w) => ({
      ...scheduledPlanWorkoutSchema.parse({
        workoutId: w.workoutId,
        scheduledDate:
          w.workoutId === command.workoutId
            ? command.scheduledDate
            : w.scheduledDate.toISOString().slice(0, 10),
        definition: w.definition,
        cancelled: w.cancelled,
      }),
      timezone: w.workoutId === command.workoutId ? command.timezone : w.timezone,
    }))
    // A calendar move is explicit human approval of one date/zone change. It
    // preserves the approved strategy and every other membership row exactly.
    const content = planContentSchema.parse({
      schemaVersion: 1,
      macroPlan: snapshot.macroPlan,
      detailWindow: snapshot.detailWindow,
      workouts: workouts
        .filter(
          (w) =>
            w.scheduledDate >= snapshot.detailWindow.startDate &&
            w.scheduledDate <= snapshot.detailWindow.endDate,
        )
        .map((w) => ({
          workoutId: w.workoutId,
          scheduledDate: w.scheduledDate,
          definition: w.definition,
          cancelled: w.cancelled,
        })),
    })
    const constraints = snapshot.constraints
    const draft = await tx.planDraft.create({
      data: {
        userId,
        goalId: plan.goalId,
        planId: plan.id,
        baseRevisionId: base.id,
        ...constraints,
        startDate: constraints.startDate ? new Date(`${constraints.startDate}T00:00:00Z`) : null,
        content,
        state: 'VALIDATED',
        validatedGoalUpdatedAt: base.sourceDraft.validatedGoalUpdatedAt,
      },
    })
    const next = await appendApprovedRevision(tx, owner, {
      planId: plan.id,
      goalId: plan.goalId,
      draftId: draft.id,
      parent: base,
      snapshot,
      workouts,
      knownIds: new Set(base.workouts.map((w) => w.workoutId)),
    })
    return next.id
  })
}
