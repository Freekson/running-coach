import { z } from 'zod'

export const localDateSchema = z.iso.date().refine((value) => {
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}, 'Enter a valid calendar date')

export const goalTypeSchema = z.enum(['PERFORMANCE', 'COMPLETION', 'VOLUME', 'CONSISTENCY'])
export const goalSurfaceSchema = z.enum(['ANY', 'ROAD', 'TRACK', 'TRAIL', 'TREADMILL'])
export const measurementWindowSchema = z.enum(['WEEK', 'MONTH', 'YEAR'])

export const goalInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(160),
    type: goalTypeSchema,
    distanceMeters: z.number().positive().max(999_999_999).multipleOf(0.001).nullable(),
    targetTimeSeconds: z.number().int().positive().max(3_599_999).nullable(),
    targetCount: z.number().int().min(1).max(366).nullable(),
    measurementWindow: measurementWindowSchema.nullable(),
    targetDate: localDateSchema.nullable(),
    surface: goalSurfaceSchema,
    elevationGainM: z.number().int().min(0).max(1_000_000).nullable(),
  })
  .superRefine((goal, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message })
    if (goal.type !== 'CONSISTENCY' && goal.distanceMeters === null)
      issue('distanceMeters', 'Enter a target distance')
    if (goal.type === 'CONSISTENCY' && goal.targetCount === null)
      issue('targetCount', 'Enter a target run count')
    if (['VOLUME', 'CONSISTENCY'].includes(goal.type) && goal.measurementWindow === null)
      issue('measurementWindow', 'Choose a measurement window')
    if (goal.type !== 'PERFORMANCE' && goal.targetTimeSeconds !== null)
      issue('targetTimeSeconds', 'Target time applies only to performance goals')
    if (goal.type !== 'CONSISTENCY' && goal.targetCount !== null)
      issue('targetCount', 'Run count applies only to consistency goals')
    if (
      goal.type === 'CONSISTENCY' &&
      (goal.distanceMeters !== null || goal.elevationGainM !== null)
    )
      issue('distanceMeters', 'Consistency goals use run counts')
    if (['PERFORMANCE', 'COMPLETION'].includes(goal.type) && goal.measurementWindow !== null)
      issue('measurementWindow', 'Measurement windows apply to volume and consistency goals')
  })

export type GoalInput = z.infer<typeof goalInputSchema>
export type GoalRecord = GoalInput & { id: string; archived: boolean }
