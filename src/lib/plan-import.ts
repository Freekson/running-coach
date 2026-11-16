import { z } from 'zod'
import { planUuidSchema } from '@/schemas/plan-content.v1'
import type { ExchangeResponse } from '@/schemas/plan-exchange.v1'
import type { WorkoutEstimate } from './workout-estimate'
import type { PlanContent, ScheduledPlanWorkout } from '@/schemas/plan-content.v1'

export type RefreshWorkout = ScheduledPlanWorkout & { timezone: string }
export type RefreshDiff = {
  workoutId: string
  kind: 'created' | 'changed' | 'canceled' | 'unchanged'
  before: RefreshWorkout | null
  after: RefreshWorkout
}
export type PlanRefreshPreview = {
  macroPlan: PlanContent['macroPlan']
  changes: RefreshDiff[]
  schedule: RefreshWorkout[]
  retainedOutsideWindow: number
}

export const planImportCommandSchema = z.strictObject({
  goalId: planUuidSchema,
  draftId: planUuidSchema,
  requestId: planUuidSchema,
  acknowledgedWarningIds: z
    .array(z.string().regex(/^[a-f0-9]{24}$/))
    .max(400)
    .default([]),
  warningRationale: z.string().trim().min(1).max(1000).optional(),
})
export type JsonPath = (string | number)[]
export type ImportError = {
  severity: 'blocking'
  code: string
  path: JsonPath
  message: string
  expected: string
}
export type TrainingWarning = {
  id: string
  severity: 'warning'
  code: string
  confidence: 'low' | 'moderate'
  path: JsonPath
  workoutIds: string[]
  message: string
  evidence: {
    proposed: number | null
    observed: number | null
    unit: 'sessions' | 's' | 'm' | 's/km' | null
    window: { startDate: string; endDate: string } | null
    observedWindow?: { startDate: string; endDate: string }
    observedWeeks?: number
  }
}
export type PreviewSession = {
  workoutId: string
  scheduledDate: string
  path: JsonPath
  estimate: WorkoutEstimate
  intervalSeconds: number
  intervalMeters: number
}
export type PlanImportResult =
  | { valid: false; errors: ImportError[]; repairPrompt: string | null }
  | {
      valid: true
      errors: []
      repairPrompt: null
      preview: {
        requestId: string
        draftVersion: number
        baseRevisionId: string | null
        response: ExchangeResponse
        refresh?: PlanRefreshPreview
        sessions: PreviewSession[]
        weeks: {
          startDate: string
          endDate: string
          workoutIds: string[]
          sessions: number
          durationSeconds: number
          distanceMeters: number
          durationIncomplete: boolean
          distanceIncomplete: boolean
          intervalSeconds: number
          intervalMeters: number
        }[]
        methodVersion: 'recorded-load-v1'
        warnings: TrainingWarning[]
        review: {
          acknowledgedWarningIds: string[]
          unacknowledgedWarningIds: string[]
          warningRationale: string | null
          readyForExplicitApproval: boolean
          requiresExplicitApproval: true
          approved: false
          published: false
        }
      }
    }
