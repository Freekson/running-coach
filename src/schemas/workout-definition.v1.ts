import { z } from 'zod'

export const WORKOUT_SCHEMA_VERSION = 1
export const WORKOUT_LIMITS = {
  maxRepeatDepth: 3,
  maxStepsPerGroup: 100,
  maxRepeatCount: 100,
  maxDurationSeconds: 604_800,
  maxDistanceMeters: 1_000_000,
  maxPaceSecondsPerKm: 36_000,
  maxHeartRateBpm: 300,
} as const

export const workoutTerminationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('time'),
    durationSeconds: z.number().positive().max(WORKOUT_LIMITS.maxDurationSeconds),
  }),
  z.strictObject({
    type: z.literal('distance'),
    distanceMeters: z.number().positive().max(WORKOUT_LIMITS.maxDistanceMeters),
  }),
  z.strictObject({ type: z.literal('lap') }),
])

export const workoutTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('free') }),
  z
    .strictObject({
      type: z.literal('pace'),
      minSecondsPerKm: z.number().positive().max(WORKOUT_LIMITS.maxPaceSecondsPerKm),
      maxSecondsPerKm: z.number().positive().max(WORKOUT_LIMITS.maxPaceSecondsPerKm),
    })
    .refine((target) => target.minSecondsPerKm <= target.maxSecondsPerKm, {
      path: ['maxSecondsPerKm'],
      message: 'Maximum pace seconds per kilometer must be at least the minimum',
    }),
  z
    .strictObject({
      type: z.literal('heartRate'),
      minBpm: z.number().int().positive().max(WORKOUT_LIMITS.maxHeartRateBpm),
      maxBpm: z.number().int().positive().max(WORKOUT_LIMITS.maxHeartRateBpm),
    })
    .refine((target) => target.minBpm <= target.maxBpm, {
      path: ['maxBpm'],
      message: 'Maximum heart rate must be at least the minimum',
    }),
])

export const workoutStepSchema = z.strictObject({
  type: z.literal('step'),
  name: z.string().min(1).max(160).optional(),
  termination: workoutTerminationSchema,
  target: workoutTargetSchema,
})

export type WorkoutTermination = z.infer<typeof workoutTerminationSchema>
export type WorkoutTarget = z.infer<typeof workoutTargetSchema>
export type WorkoutStep = z.infer<typeof workoutStepSchema>
export type WorkoutRepeat = {
  type: 'repeat'
  count: number
  steps: WorkoutNode[]
}
export type WorkoutNode = WorkoutStep | WorkoutRepeat

// Build a finite tree instead of an unbounded lazy schema. Parsing stops at the
// depth boundary, even for inputs much deeper than the limit (or cyclic objects).
function nodeSchema(remainingRepeatDepth: number): z.ZodType<WorkoutNode> {
  if (remainingRepeatDepth === 0) return workoutStepSchema
  return z.discriminatedUnion('type', [
    workoutStepSchema,
    z.strictObject({
      type: z.literal('repeat'),
      count: z.number().int().min(1).max(WORKOUT_LIMITS.maxRepeatCount),
      steps: z
        .array(nodeSchema(remainingRepeatDepth - 1))
        .min(1)
        .max(WORKOUT_LIMITS.maxStepsPerGroup),
    }),
  ])
}

export const workoutNodeSchema = nodeSchema(WORKOUT_LIMITS.maxRepeatDepth)

export const workoutDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(WORKOUT_SCHEMA_VERSION),
  name: z.string().min(1).max(160),
  sport: z.enum(['RUNNING', 'CYCLING', 'SWIMMING', 'WALKING', 'OTHER']),
  steps: z.array(workoutNodeSchema).min(1).max(WORKOUT_LIMITS.maxStepsPerGroup),
})

export type WorkoutDefinition = z.infer<typeof workoutDefinitionSchema>
