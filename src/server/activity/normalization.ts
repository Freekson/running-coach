import 'server-only'

import { z } from 'zod'
import type { OwnerContext } from '@/server/authorization/ownership'

export const activityProviderSchema = z.enum(['GARMIN', 'INTERVALS', 'MANUAL', 'FILE'])
export const sourceRecordTypeSchema = z.enum(['API_ACTIVITY', 'FIT_FILE', 'MANUAL_ENTRY'])
export const canonicalSportSchema = z.enum(['RUNNING', 'CYCLING', 'SWIMMING', 'WALKING', 'OTHER'])
const nonnegative = z.number().finite().nonnegative()
const nullableNonnegative = nonnegative.nullable()
const nullableInteger = z.number().int().nonnegative().nullable()

export const activitySourceIdentitySchema = z.object({
  userId: z.uuid(),
  provider: activityProviderSchema,
  externalActivityId: z.string().trim().min(1).nullable(),
  externalActivityUuid: z.string().trim().min(1).nullable(),
  recordType: sourceRecordTypeSchema,
})

export const canonicalLapSchema = z.object({
  lapIndex: z.number().int().nonnegative(),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  distanceMeters: nullableNonnegative,
  elapsedMs: nullableInteger,
  movingMs: nullableInteger,
  avgHrBpm: nullableInteger,
  avgSpeedMps: nullableNonnegative,
  cadenceStepsPerMinute: nullableNonnegative,
  sourceRecordType: z.literal('FIT_LAP'),
})

export const canonicalActivitySchema = z.object({
  source: activitySourceIdentitySchema,
  sportType: canonicalSportSchema,
  sourceSportType: z.string().trim().min(1).nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  sourceTimezone: z.string().nullable(),
  gpsAssetRef: z.string().trim().min(1).nullable(),
  distanceMeters: nullableNonnegative,
  totalMs: nullableInteger,
  elapsedMs: nullableInteger,
  movingMs: nullableInteger,
  avgSpeedMps: nullableNonnegative,
  avgHrBpm: nullableInteger,
  maxHrBpm: nullableInteger,
  cadenceStepsPerMinute: nullableNonnegative,
  elevationGainMeters: nullableNonnegative,
  elevationLossMeters: nullableNonnegative,
  laps: z.array(canonicalLapSchema).nullable(),
})

export type CanonicalActivity = z.infer<typeof canonicalActivitySchema>
export type CanonicalLap = z.infer<typeof canonicalLapSchema>
export type ActivitySourceIdentity = z.infer<typeof activitySourceIdentitySchema>

export interface ActivitySource {
  readonly provider: ActivitySourceIdentity['provider']
  normalizeActivity(owner: OwnerContext, payload: unknown): CanonicalActivity
}

/** Only an owner/provider/external ID tuple can be used for automatic same-provider upsert. */
export function activityUpsertKey(source: ActivitySourceIdentity): string | null {
  const valid = activitySourceIdentitySchema.parse(source)
  if (!valid.externalActivityId) return null
  return JSON.stringify([valid.userId, valid.provider, valid.externalActivityId])
}

/** A review candidate only. Never merge, delete, or link based on this heuristic. */
export function isCrossProviderDuplicateCandidate(
  a: CanonicalActivity,
  b: CanonicalActivity,
): boolean {
  const first = canonicalActivitySchema.parse(a)
  const second = canonicalActivitySchema.parse(b)
  if (
    first.source.userId !== second.source.userId ||
    first.source.provider === second.source.provider
  )
    return false
  if (
    first.sportType === 'OTHER' ||
    first.sportType !== second.sportType ||
    first.distanceMeters === null ||
    second.distanceMeters === null
  )
    return false
  if (
    first.distanceMeters === 0 ||
    second.distanceMeters === 0 ||
    first.elapsedMs === null ||
    second.elapsedMs === null ||
    first.elapsedMs === 0 ||
    second.elapsedMs === 0
  )
    return false
  const startGap = Math.abs(Date.parse(first.startedAt) - Date.parse(second.startedAt))
  const distanceGap = Math.abs(first.distanceMeters - second.distanceMeters)
  const elapsedGap = Math.abs(first.elapsedMs - second.elapsedMs)
  return (
    startGap <= 120_000 &&
    distanceGap <= Math.max(100, Math.max(first.distanceMeters, second.distanceMeters) * 0.02) &&
    elapsedGap <= Math.max(60_000, Math.max(first.elapsedMs, second.elapsedMs) * 0.05)
  )
}

/** Seconds per kilometer; zero or missing distance/duration yields no pace. */
export function paceSecondsPerKm(
  distanceMeters: number | null,
  durationMs: number | null,
): number | null {
  if (distanceMeters === null || durationMs === null || distanceMeters <= 0 || durationMs <= 0)
    return null
  return durationMs / distanceMeters
}
