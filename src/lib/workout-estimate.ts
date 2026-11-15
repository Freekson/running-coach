import type { WorkoutDefinition, WorkoutNode } from '@/schemas/workout-definition.v1'

type Range = { min: number; max: number; incomplete: boolean }
export type WorkoutEstimate = { durationSeconds: Range; distanceMeters: Range; stepCount: number }

// Aggregate repeat blocks algebraically; never expand potentially millions of steps.
export function estimateWorkout(definition: WorkoutDefinition): WorkoutEstimate {
  function estimate(nodes: WorkoutNode[]): WorkoutEstimate {
    const total: WorkoutEstimate = {
      durationSeconds: { min: 0, max: 0, incomplete: false },
      distanceMeters: { min: 0, max: 0, incomplete: false },
      stepCount: 0,
    }
    for (const node of nodes) {
      if (node.type === 'repeat') {
        const child = estimate(node.steps)
        total.stepCount += child.stepCount * node.count
        for (const key of ['durationSeconds', 'distanceMeters'] as const) {
          total[key].min += child[key].min * node.count
          total[key].max += child[key].max * node.count
          total[key].incomplete ||= child[key].incomplete
        }
        continue
      }
      total.stepCount++
      const ending = node.termination
      const pace = node.target.type === 'pace' ? node.target : null
      if (ending.type === 'time') {
        total.durationSeconds.min += ending.durationSeconds
        total.durationSeconds.max += ending.durationSeconds
        if (pace) {
          total.distanceMeters.min += (ending.durationSeconds / pace.maxSecondsPerKm) * 1000
          total.distanceMeters.max += (ending.durationSeconds / pace.minSecondsPerKm) * 1000
        } else total.distanceMeters.incomplete = true
      } else if (ending.type === 'distance') {
        total.distanceMeters.min += ending.distanceMeters
        total.distanceMeters.max += ending.distanceMeters
        if (pace) {
          total.durationSeconds.min += (ending.distanceMeters / 1000) * pace.minSecondsPerKm
          total.durationSeconds.max += (ending.distanceMeters / 1000) * pace.maxSecondsPerKm
        } else total.durationSeconds.incomplete = true
      } else {
        total.durationSeconds.incomplete = true
        total.distanceMeters.incomplete = true
      }
    }
    return total
  }
  const result = estimate(definition.steps)
  // The canonical contract accepts tiny positive paces. Derived distances can
  // overflow even though every input is finite; report an unknown estimate.
  for (const key of ['durationSeconds', 'distanceMeters'] as const) {
    if (!Number.isFinite(result[key].min) || !Number.isFinite(result[key].max)) {
      result[key] = { min: 0, max: 0, incomplete: true }
    }
  }
  return result
}

export function formatDuration(seconds: number) {
  const rounded = Math.round(seconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const remainder = String(rounded % 60).padStart(2, '0')
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`
}

export function formatEstimate(range: Range, unit: 'time' | 'distance') {
  if (range.incomplete && range.max === 0) return 'Unknown'
  const format =
    unit === 'time' ? formatDuration : (value: number) => `${Number((value / 1000).toFixed(3))} km`
  const value =
    range.min === range.max ? format(range.min) : `${format(range.min)}–${format(range.max)}`
  return range.incomplete ? `${value} + unknown` : value
}
