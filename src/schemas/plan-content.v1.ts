import { z } from 'zod'
import { localDateSchema } from '@/lib/goals'
import { workoutDefinitionSchema } from './workout-definition.v1'

// PostgreSQL UUID identity is case-insensitive; normalize before comparing IDs.
export const planUuidSchema = z.uuid().toLowerCase()
export const scheduledPlanWorkoutSchema = z.strictObject({
  workoutId: planUuidSchema,
  scheduledDate: localDateSchema,
  definition: workoutDefinitionSchema,
  cancelled: z.boolean().default(false),
})
export const macroPlanSchema = z.strictObject({
  startDate: localDateSchema,
  endDate: localDateSchema,
  strategy: z.string().trim().min(1).max(10000),
  phases: z
    .array(
      z.strictObject({
        startDate: localDateSchema,
        endDate: localDateSchema,
        label: z.string().trim().min(1).max(160),
        notes: z.string().max(4000),
      }),
    )
    .min(1)
    .max(200),
})
export const dateWindowSchema = z
  .strictObject({ startDate: localDateSchema, endDate: localDateSchema })
  .refine((window) => window.startDate <= window.endDate, {
    path: ['endDate'],
    message: 'Observation window must be ordered',
  })
export const planContentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  macroPlan: macroPlanSchema,
  detailWindow: dateWindowSchema,
  workouts: z.array(scheduledPlanWorkoutSchema).max(200),
})
export type PlanContent = z.infer<typeof planContentSchema>
export type ScheduledPlanWorkout = z.infer<typeof scheduledPlanWorkoutSchema>
