import { z } from 'zod'
import { planUuidSchema } from '@/schemas/plan-content.v1'

export const openRefreshSchema = z.strictObject({
  goalId: planUuidSchema,
  planId: planUuidSchema,
  expectedRevisionId: planUuidSchema,
})
export type ApprovedPlanChoice = {
  id: string
  goalId: string
  goalName: string
  revisionId: string
  revisionNumber: number
}
