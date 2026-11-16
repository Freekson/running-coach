import 'server-only'

import type { MatchingMetrics, MatchCandidate } from '@/lib/activity-matching'
import { estimateWorkout } from '@/lib/workout-estimate'
import { calendarToday } from '@/lib/training-calendar'
import { workoutDefinitionSchema, type WorkoutNode } from '@/schemas/workout-definition.v1'

type Numeric = { toNumber(): number }
export function matchingMetrics(row: {
  distanceMeters: Numeric | null
  timerMs: bigint | null
  avgSpeedMps?: Numeric | null
  avgHrBpm: number | null
  maxHrBpm: number | null
}): MatchingMetrics {
  const distance = row.distanceMeters?.toNumber() ?? null
  const seconds = row.timerMs === null ? null : Number(row.timerMs) / 1000
  const speed = row.avgSpeedMps?.toNumber() ?? null
  const timerPace =
    distance !== null && distance > 0 && seconds !== null && seconds > 0
      ? (seconds / distance) * 1000
      : null
  const speedPace = speed !== null && speed > 0 ? 1000 / speed : null
  return {
    distanceMeters: distance,
    durationSeconds: seconds,
    durationBasis: seconds === null ? 'unavailable' : 'timer',
    paceSecondsPerKm: timerPace ?? speedPace,
    paceBasis:
      timerPace !== null ? 'timer-distance' : speedPace !== null ? 'recorded-speed' : 'unavailable',
    avgHrBpm: row.avgHrBpm,
    maxHrBpm: row.maxHrBpm,
  }
}

export function matchCandidate(
  row: {
    workoutId: string
    planId: string
    revisionId: string
    scheduledDate: Date
    timezone: string
    definition: unknown
  },
  activity: { startedAt: Date; sportType: string; metrics: MatchingMetrics },
): MatchCandidate {
  const definition = workoutDefinitionSchema.parse(row.definition)
  const estimate = estimateWorkout(definition)
  const date = row.scheduledDate.toISOString().slice(0, 10)
  const paceTargets: { min: number; max: number }[] = []
  const hrTargets: { min: number; max: number }[] = []
  let allPace = true
  function collect(nodes: WorkoutNode[]) {
    for (const node of nodes) {
      if (node.type === 'repeat') collect(node.steps)
      else {
        if (node.target.type === 'pace')
          paceTargets.push({ min: node.target.minSecondsPerKm, max: node.target.maxSecondsPerKm })
        else allPace = false
        if (node.target.type === 'heartRate')
          hrTargets.push({ min: node.target.minBpm, max: node.target.maxBpm })
      }
    }
  }
  collect(definition.steps)
  const compatible = definition.sport === activity.sportType && definition.sport !== 'OTHER'
  const checks = [
    { range: estimate.distanceMeters, actual: activity.metrics.distanceMeters },
    { range: estimate.durationSeconds, actual: activity.metrics.durationSeconds },
  ].filter((c) => !c.range.incomplete && c.range.max > 0 && c.actual !== null)
  return {
    workoutId: row.workoutId,
    planId: row.planId,
    revisionId: row.revisionId,
    name: definition.name,
    sport: definition.sport,
    date,
    timezone: row.timezone,
    estimate,
    // A target envelope, not an invented average of differently weighted steps.
    paceSecondsPerKm:
      compatible && allPace && paceTargets.length
        ? {
            min: Math.min(...paceTargets.map((p) => p.min)),
            max: Math.max(...paceTargets.map((p) => p.max)),
          }
        : null,
    heartRateTargetBpm: hrTargets.length
      ? {
          min: Math.min(...hrTargets.map((p) => p.min)),
          max: Math.max(...hrTargets.map((p) => p.max)),
        }
      : null,
    sameLocalDate: date === calendarToday(row.timezone, activity.startedAt),
    metricAgreement:
      compatible &&
      checks.length > 0 &&
      checks.every(
        ({ range, actual }) =>
          actual !== null && actual >= range.min * 0.75 && actual <= range.max * 1.25,
      ),
  }
}
