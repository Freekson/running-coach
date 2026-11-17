import 'server-only'

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { dateWindowSchema, macroPlanSchema } from '@/schemas/plan-content.v1'
import { timezoneSchema } from '@/lib/plan-constraints'
import { addCalendarDays, calendarToday } from '@/lib/training-calendar'
import type { PlanReminder } from '@/lib/plan-reminders'

const reminderSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  macroPlan: macroPlanSchema,
  detailWindow: dateWindowSchema,
  constraints: z.object({ timezone: timezoneSchema }),
})

// Calendar-day policy in the approved plan's timezone, independent of workout
// density, completion, provider syncs and the athlete's later profile edits.
export function planReminderEvent(
  plan: {
    id: string
    goalName: string
    goalTargetDate: string | null
    revisionId: string
    snapshot: unknown
  },
  now: Date,
): PlanReminder | null {
  const snapshot = reminderSnapshotSchema.parse(plan.snapshot)
  const { macroPlan, detailWindow, constraints } = snapshot
  const today = calendarToday(constraints.timezone, now)
  // Refresh needs 14 future days. Warn by its last valid start opportunity,
  // even when the normal seven-day reminder would arrive too late.
  const refreshByDate = addCalendarDays(macroPlan.endDate, -14)
  if (
    // The existing refresh flow rejects a changed dated goal horizon.
    (plan.goalTargetDate !== null && plan.goalTargetDate !== macroPlan.endDate) ||
    detailWindow.startDate < macroPlan.startDate ||
    detailWindow.endDate > macroPlan.endDate ||
    today < macroPlan.startDate ||
    today < detailWindow.startDate ||
    today > macroPlan.endDate ||
    detailWindow.endDate >= macroPlan.endDate ||
    (detailWindow.endDate > addCalendarDays(today, 7) && today < refreshByDate)
  )
    return null

  return {
    planId: plan.id,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(['plan-refresh-v1', plan.id, plan.revisionId]))
      .digest('hex'),
    goalName: plan.goalName,
    detailEndDate: detailWindow.endDate,
    timezone: constraints.timezone,
    exhausted: detailWindow.endDate < today,
    refreshByDate,
    nextAction: today <= refreshByDate ? 'refresh' : 'review-plan',
  }
}
