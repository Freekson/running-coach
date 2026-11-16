import { z } from 'zod'
import { calendarQuerySchema } from './training-calendar'
import type { WorkoutEstimate } from './workout-estimate'

export const matchingQuerySchema = z.strictObject({
  activityId: z.uuid(),
  date: calendarQuerySchema.shape.date,
})
export const matchActivitySchema = z.strictObject({
  activityId: z.uuid(),
  // Compare-and-swap protects corrections made in another browser tab.
  expectedWorkoutId: z.uuid().nullable(),
  planId: z.uuid(),
  expectedRevisionId: z.uuid(),
  workoutId: z.uuid(),
})
export const unlinkActivitySchema = z.strictObject({
  activityId: z.uuid(),
  expectedWorkoutId: z.uuid(),
})
export type MatchActivityInput = z.infer<typeof matchActivitySchema>
export type UnlinkActivityInput = z.infer<typeof unlinkActivitySchema>
export type MatchingMetrics = {
  distanceMeters: number | null
  durationSeconds: number | null
  durationBasis: 'timer' | 'unavailable'
  paceSecondsPerKm: number | null
  paceBasis: 'timer-distance' | 'recorded-speed' | 'unavailable'
  avgHrBpm: number | null
  maxHrBpm: number | null
}
export type MatchCandidate = {
  workoutId: string
  planId: string
  revisionId: string
  name: string
  sport: string
  date: string
  timezone: string
  estimate: WorkoutEstimate
  paceSecondsPerKm: { min: number; max: number } | null
  heartRateTargetBpm: { min: number; max: number } | null
  sameLocalDate: boolean
  metricAgreement: boolean
}
export type ActivityMatchingData = {
  activityId: string
  title: string
  sport: string
  startedAt: string
  localDate: string
  timezone: string
  sourceRecordType: string
  externalActivityId: string | null
  importedAt: string
  actual: MatchingMetrics
  laps: (MatchingMetrics & { index: number; sourceRecordType: string })[]
  searchDate: string
  candidates: MatchCandidate[]
  suggestionWorkoutId: string | null
  ambiguous: boolean
  duplicateCount: number
  duplicateLinked: boolean
  linkedDuplicates: { activityId: string; workoutId: string; title: string; provider: string }[]
  linked: { workoutId: string; comparison: MatchCandidate | null } | null
}
export type MatchingResult<T = undefined> =
  { success: true; data: T } | { success: false; error: string }
