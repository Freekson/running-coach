import { z } from 'zod'
import { planUuidSchema } from '@/schemas/plan-content.v1'

export const planReminderCommandSchema = z.strictObject({
  planId: planUuidSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  action: z.enum(['dismiss', 'snooze']),
})
export type PlanReminderCommand = z.infer<typeof planReminderCommandSchema>
export type PlanReminder = {
  planId: string
  fingerprint: string
  goalName: string
  detailEndDate: string
  timezone: string
  exhausted: boolean
  refreshByDate: string
  nextAction: 'refresh' | 'review-plan'
}
export type PlanReminderResult = { success: true } | { success: false; error: string }
