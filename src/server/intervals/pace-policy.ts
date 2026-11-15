import 'server-only'

import { z } from 'zod'
import { intervalsPaceMessages, type IntervalsPaceErrorCode } from '@/lib/intervals-pace-status'

// Delivery metadata only. Never import this module into athlete analytics or AI context.
export const INTERVALS_DELIVERY_REFERENCE = {
  version: 1,
  secondsPerKm: 300,
  metersPerSecond: 1000 / 300,
  // Provider-default compatible zone boundaries; these are not athlete recommendations.
  zones: [77.5, 87.7, 94.3, 100, 103.4, 111.5, 999],
  zoneNames: ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'Zone 5a', 'Zone 5b', 'Zone 5c'],
} as const

export class IntervalsPaceError extends Error {
  constructor(readonly code: IntervalsPaceErrorCode) {
    super(intervalsPaceMessages[code])
  }
}

const runSettingsSchema = z.object({
  id: z.number().int().positive(),
  types: z.array(z.string()).min(1),
  threshold_pace: z.number().nonnegative().nullable().optional(),
  pace_zones: z.array(z.number()).max(20).nullable().optional(),
  pace_zone_names: z.array(z.string().min(1).max(160)).max(20).nullable().optional(),
})

export type IntervalsRunSettings = z.infer<typeof runSettingsSchema>
export type IntervalsPacePatch = {
  threshold_pace?: number
  pace_zones?: number[]
  pace_zone_names?: string[]
}

export function parseIntervalsRunSettings(value: unknown): IntervalsRunSettings {
  const parsed = z.array(runSettingsSchema).max(100).safeParse(value)
  const runs = parsed.success ? parsed.data.filter((setting) => setting.types.includes('Run')) : []
  if (runs.length !== 1) throw new IntervalsPaceError('CONFIGURATION_CONFLICT')
  return runs[0]
}

export function compatiblePaceZones(settings: IntervalsRunSettings): boolean {
  const zones = settings.pace_zones
  if (!zones || zones.length < 2 || zones.at(-1) !== 999) return false
  if (!zones.every((zone, i) => zone > 0 && (i === 0 || zone > zones[i - 1]))) return false
  const names = settings.pace_zone_names
  return !names?.length || names.length === zones.length
}

/** Only absent fields are provisioned. Nonempty invalid/custom partial data fails closed. */
export function missingIntervalsPaceSettings(settings: IntervalsRunSettings): IntervalsPacePatch {
  const patch: IntervalsPacePatch = {}
  if (!settings.threshold_pace) patch.threshold_pace = INTERVALS_DELIVERY_REFERENCE.metersPerSecond
  if (!settings.pace_zones?.length) {
    if (settings.pace_zone_names?.length) throw new IntervalsPaceError('CONFIGURATION_CONFLICT')
    patch.pace_zones = [...INTERVALS_DELIVERY_REFERENCE.zones]
    patch.pace_zone_names = [...INTERVALS_DELIVERY_REFERENCE.zoneNames]
  } else if (!compatiblePaceZones(settings)) {
    throw new IntervalsPaceError('CONFIGURATION_CONFLICT')
  }
  return patch
}

export function samePaceSettings(a: IntervalsRunSettings, b: IntervalsRunSettings): boolean {
  return (
    a.id === b.id &&
    a.threshold_pace === b.threshold_pace &&
    JSON.stringify(a.types) === JSON.stringify(b.types) &&
    JSON.stringify(a.pace_zones) === JSON.stringify(b.pace_zones) &&
    JSON.stringify(a.pace_zone_names) === JSON.stringify(b.pace_zone_names)
  )
}

export function assertPaceReadback(
  before: IntervalsRunSettings,
  after: IntervalsRunSettings,
  patch: IntervalsPacePatch,
): void {
  const expectedThreshold = patch.threshold_pace ?? before.threshold_pace
  const expectedZones = patch.pace_zones ?? before.pace_zones
  const expectedNames = patch.pace_zone_names ?? before.pace_zone_names
  if (
    after.id !== before.id ||
    !after.threshold_pace ||
    !expectedThreshold ||
    Math.abs(after.threshold_pace - expectedThreshold) > 0.000001 ||
    !compatiblePaceZones(after) ||
    JSON.stringify(after.pace_zones) !== JSON.stringify(expectedZones) ||
    JSON.stringify(after.pace_zone_names) !== JSON.stringify(expectedNames)
  )
    throw new IntervalsPaceError('READBACK_FAILED')
}
