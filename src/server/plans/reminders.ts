import 'server-only'

import {
  ownedIdWhere,
  ownedWhere,
  ownerId,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'
import { planReminderCommandSchema, type PlanReminder } from '@/lib/plan-reminders'
import { planTransaction, PlanConflictError } from './transaction'
import { planReminderEvent } from './reminder-event'

export async function getPlanReminders(
  owner: OwnerContext,
  now = new Date(),
): Promise<PlanReminder[]> {
  const userId = ownerId(owner)
  return planTransaction(async (tx) => {
    const plans = await tx.trainingPlan.findMany({
      where: ownedWhere(owner, { currentRevisionId: { not: null }, goal: { archived: false } }),
      select: {
        id: true,
        goal: { select: { name: true, targetDate: true } },
        currentRevision: { select: { id: true, snapshot: true } },
      },
      orderBy: { id: 'asc' },
    })
    const events = plans.flatMap((plan) => {
      if (!plan.currentRevision) return []
      const event = planReminderEvent(
        {
          id: plan.id,
          goalName: plan.goal.name,
          goalTargetDate: plan.goal.targetDate?.toISOString().slice(0, 10) ?? null,
          revisionId: plan.currentRevision.id,
          snapshot: plan.currentRevision.snapshot,
        },
        now,
      )
      return event ? [event] : []
    })
    if (!events.length) return []
    const states = await tx.planReminderState.findMany({
      where: {
        userId,
        OR: events.map(({ planId, fingerprint }) => ({ planId, fingerprint })),
      },
    })
    return events.filter(
      (event) =>
        !states.some(
          (state) =>
            state.planId === event.planId &&
            state.fingerprint === event.fingerprint &&
            (state.dismissedAt || (state.snoozedUntil && state.snoozedUntil > now)),
        ),
    )
  })
}

export async function respondToPlanReminder(owner: OwnerContext, input: unknown, now = new Date()) {
  const userId = ownerId(owner)
  const command = planReminderCommandSchema.parse(input)
  return planTransaction(async (tx) => {
    const plan = await tx.trainingPlan.findFirst({
      where: ownedIdWhere(owner, command.planId),
      select: {
        id: true,
        goal: { select: { name: true, archived: true, targetDate: true } },
        currentRevision: { select: { id: true, snapshot: true } },
      },
    })
    if (!plan) throw new OwnedResourceNotFoundError()
    const event =
      !plan.goal.archived && plan.currentRevision
        ? planReminderEvent(
            {
              id: plan.id,
              goalName: plan.goal.name,
              goalTargetDate: plan.goal.targetDate?.toISOString().slice(0, 10) ?? null,
              revisionId: plan.currentRevision.id,
              snapshot: plan.currentRevision.snapshot,
            },
            now,
          )
        : null
    if (!event || event.fingerprint !== command.fingerprint) throw new PlanConflictError()
    const key = { userId, planId: plan.id, fingerprint: event.fingerprint }
    const previous = await tx.planReminderState.findUnique({
      where: { userId_planId_fingerprint: key },
    })
    // A late snooze from another tab must never undo a permanent dismissal.
    if (previous?.dismissedAt) return
    const state =
      command.action === 'dismiss'
        ? { dismissedAt: now, snoozedUntil: null }
        : { dismissedAt: null, snoozedUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000) }
    await tx.planReminderState.upsert({
      where: { userId_planId_fingerprint: key },
      create: { ...key, ...state },
      update: state,
    })
  })
}
