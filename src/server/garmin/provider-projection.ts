import 'server-only'

import { z } from 'zod'

const objectSchema = z.record(z.string(), z.unknown())
const fields = {
  summary: {
    steps: { path: ['movement', 'steps', 'value'], max: 10_000_000 },
    stepGoal: { path: ['movement', 'steps', 'goal'], max: 10_000_000 },
    distanceInMeters: { path: ['movement', 'steps', 'distanceInMeters'], max: 1_000_000 },
    caloriesBurnedResting: { path: ['calories', 'burnedResting'], max: 100_000 },
    caloriesBurnedActive: { path: ['calories', 'burnedActive'], max: 100_000 },
    caloriesBurnedTotal: { path: ['calories', 'burnedTotal'], max: 100_000 },
    moderateIntensityMinutes: { path: ['intensityMinutes', 'moderate'], max: 1_440 },
    vigorousIntensityMinutes: { path: ['intensityMinutes', 'vigorous'], max: 1_440 },
    stressAvgLevel: { path: ['stress', 'avgLevel'], max: 100 },
    stressMaxLevel: { path: ['stress', 'maxLevel'], max: 100 },
    bodyBatteryMinValue: { path: ['bodyBattery', 'minValue'], max: 100 },
    bodyBatteryMaxValue: { path: ['bodyBattery', 'maxValue'], max: 100 },
    bodyBatteryLatestValue: { path: ['bodyBattery', 'latestValue'], max: 100 },
    respirationAvgValue: { path: ['respiration', 'avgValue'], max: 200 },
    respirationMinValue: { path: ['respiration', 'minValue'], max: 200 },
    respirationMaxValue: { path: ['respiration', 'maxValue'], max: 200 },
    hydrationConsumedInMl: { path: ['hydration', 'consumedInMl'], max: 100_000 },
    hydrationGoalInMl: { path: ['hydration', 'goalInMl'], max: 100_000 },
  },
  sleep: {
    napTimeSeconds: { path: ['napTimeSeconds'], max: 86_400 },
    awakeCount: { path: ['awakeCount'], max: 1_000 },
    avgHeartRate: { path: ['avgHeartRate'], max: 300 },
    avgSleepStress: { path: ['avgSleepStress'], max: 100 },
    averageRespirationValue: { path: ['averageRespirationValue'], max: 200 },
  },
} as const

export type ProjectionKind = keyof typeof fields
export type ProviderProjection = { schemaVersion: 1; [key: string]: number }

function nested(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    const parsed = objectSchema.safeParse(current)
    if (!parsed.success) return undefined
    current = parsed.data[key]
  }
  return current
}

/** Retain only bounded, named source fields; no IDs, timestamps, GPS or payloads. */
export function projectGarminHealth(
  kind: ProjectionKind,
  payload: unknown,
): ProviderProjection | null {
  const result: ProviderProjection = { schemaVersion: 1 }
  for (const [name, descriptor] of Object.entries(fields[kind])) {
    const value = nested(payload, descriptor.path)
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= descriptor.max
    )
      result[name] = value
  }
  return Object.keys(result).length > 1 ? result : null
}

export function mergeGarminProjection(
  existing: unknown,
  incoming: ProviderProjection,
): ProviderProjection {
  const previous = objectSchema.safeParse(existing)
  const merged: ProviderProjection = { schemaVersion: 1 }
  if (previous.success && previous.data.schemaVersion === 1) {
    const allowed = new Set([...Object.keys(fields.summary), ...Object.keys(fields.sleep)])
    for (const [key, value] of Object.entries(previous.data)) {
      if (allowed.has(key) && typeof value === 'number' && Number.isFinite(value))
        merged[key] = value
    }
  }
  return { ...merged, ...incoming }
}
