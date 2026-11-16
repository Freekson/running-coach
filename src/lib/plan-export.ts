import { z } from 'zod'
import { localDateSchema } from './goals'
import { planConstraintsSchema } from './plan-constraints'
import { dateWindowSchema, planUuidSchema } from '@/schemas/plan-content.v1'

export const exportConsentSchema = z.strictObject({
  recordedActivityMetrics: z.boolean(),
  activityHeartRate: z.boolean(),
  recordedLaps: z.boolean(),
  athleteReport: z.boolean(),
  limitationsOrFatigue: z.boolean(),
  recovery: z.boolean(),
})
export const defaultExportConsent: ExportConsent = {
  recordedActivityMetrics: false,
  activityHeartRate: false,
  recordedLaps: false,
  athleteReport: false,
  limitationsOrFatigue: false,
  recovery: false,
}
const optionalText = z.string().trim().max(1000).optional()
export const exportBackgroundSchema = z.strictObject({
  experience: z.enum(['new_runner', 'returning_runner', 'currently_training', 'unknown']),
  firstWorkoutEver: z.boolean().nullable(),
  previousExperience: optionalText,
  easyEffort: optionalText,
  crossTraining: optionalText,
  preferredWorkoutTypes: optionalText,
  limitationsOrFatigue: optionalText,
  raceOrTestResults: z
    .array(
      z.strictObject({
        date: localDateSchema,
        distanceMeters: z.number().positive().max(1000000),
        elapsedSeconds: z.number().positive().max(10000000),
        kind: z.enum(['race', 'test', 'historical_pb']),
      }),
    )
    .max(5)
    .optional(),
})
export const exportSelectionSchema = z.strictObject({
  draftId: planUuidSchema,
  expectedVersion: z.number().int().nonnegative(),
  allowedDetailWindow: dateWindowSchema,
  consent: exportConsentSchema,
  background: exportBackgroundSchema.optional(),
})
export const openExportSchema = z.strictObject({ goalId: planUuidSchema })
export const exportScheduleSchema = z.strictObject({
  draftId: planUuidSchema,
  expectedVersion: z.number().int().nonnegative(),
  constraints: planConstraintsSchema,
})
export type ExportConsent = z.infer<typeof exportConsentSchema>
export type ExportBackground = z.infer<typeof exportBackgroundSchema>
export type ExportSelection = z.infer<typeof exportSelectionSchema>
export type ExportSetup = {
  mode?: 'initial' | 'refresh'
  goalName: string
  goalDate: string | null
  draftId: string
  version: number
  constraints: z.infer<typeof planConstraintsSchema>
  measurementSystem: 'METRIC' | 'IMPERIAL'
  today: string
}
export type ExportArtifact = {
  requestId: string
  json: string
  prompt: string
  bytes: number
}
