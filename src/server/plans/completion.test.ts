import { expect, it, vi } from 'vitest'
import { workoutCompletionAt, type WorkoutCompletion } from './completion'

vi.mock('server-only', () => ({}))
const first = new Date('2026-11-10T06:00:00Z')
const latest = new Date('2026-11-11T07:00:00Z')
const workout: WorkoutCompletion = {
  completedAt: first,
  completedActivityId: 'activity',
  completionAt: latest,
  completionFromActivity: true,
}
it('uses the current matched activity time rather than the immutable first marker', () => {
  expect(workoutCompletionAt(workout)).toEqual(latest)
})
it('removes a retracted match outcome even when the first completion marker remains', () => {
  expect(
    workoutCompletionAt({ ...workout, completedActivityId: null, completionAt: null }),
  ).toBeNull()
})
it('retains manual and legacy completions without requiring an activity link', () => {
  expect(
    workoutCompletionAt({ ...workout, completionFromActivity: false, completedActivityId: null }),
  ).toEqual(latest)
  expect(
    workoutCompletionAt({
      ...workout,
      completionFromActivity: false,
      completedActivityId: null,
      completionAt: null,
    }),
  ).toEqual(first)
})
