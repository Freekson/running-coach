import 'server-only'

import type { PlannedWorkout } from '@prisma/client'

export type WorkoutCompletion = Pick<
  PlannedWorkout,
  'completedAt' | 'completedActivityId' | 'completionAt' | 'completionFromActivity'
>

/** First completion/history locks are permanent; corrected match outcomes are not. */
export function workoutCompletionAt(workout: WorkoutCompletion): Date | null {
  if (workout.completionFromActivity)
    return workout.completedActivityId ? workout.completionAt : null
  // Rows written by an older application still represent explicit completion.
  return workout.completionAt ?? workout.completedAt
}
