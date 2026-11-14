import { goalInputSchema, type GoalInput, type GoalRecord } from '@/lib/goals'
import type { GoalProgress } from '@/lib/goal-progress'

export type GoalType = GoalInput['type']
export type GoalSurface = GoalInput['surface']

// String values preserve partially edited form input; the shared schema validates submission.
export type GoalFields = {
  name: string
  type: GoalType
  distanceKm: string
  targetTime: string
  targetDate: string
  surface: GoalSurface
  elevationGainM: string
  sessionsPerWeek: string
  measurementWindow: 'WEEK' | 'MONTH' | 'YEAR'
}

export type GoalView = GoalFields & {
  id: string
  archived: boolean
  progress?: GoalProgress
}

export function goalView(goal: GoalRecord & { progress?: GoalProgress }): GoalView {
  const seconds = goal.targetTimeSeconds
  return {
    id: goal.id,
    archived: goal.archived,
    progress: goal.progress,
    name: goal.name,
    type: goal.type,
    distanceKm: goal.distanceMeters === null ? '' : String(goal.distanceMeters / 1000),
    targetTime:
      seconds === null
        ? ''
        : `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
    targetDate: goal.targetDate ?? '',
    surface: goal.surface,
    elevationGainM: goal.elevationGainM === null ? '' : String(goal.elevationGainM),
    sessionsPerWeek: goal.targetCount === null ? '' : String(goal.targetCount),
    measurementWindow: goal.measurementWindow ?? 'WEEK',
  }
}

export function goalInput(fields: GoalFields): GoalInput {
  const time = fields.targetTime ? /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(fields.targetTime) : null
  const seconds = fields.targetTime
    ? time
      ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])
      : NaN
    : null
  return goalInputSchema.parse({
    name: fields.name,
    type: fields.type,
    distanceMeters: fields.type === 'CONSISTENCY' ? null : Number(fields.distanceKm) * 1000,
    targetTimeSeconds: fields.type === 'PERFORMANCE' ? seconds : null,
    targetCount: fields.type === 'CONSISTENCY' ? Number(fields.sessionsPerWeek) : null,
    measurementWindow:
      fields.type === 'VOLUME' || fields.type === 'CONSISTENCY' ? fields.measurementWindow : null,
    targetDate: fields.targetDate || null,
    surface: fields.surface,
    elevationGainM:
      fields.type === 'CONSISTENCY' || !fields.elevationGainM
        ? null
        : Number(fields.elevationGainM),
  })
}
