import 'server-only'

import { z } from 'zod'

export const activitySurfaceSchema = z.enum(['ROAD', 'TRACK', 'TRAIL', 'TREADMILL'])

/** Only explicit surfaces and unambiguous recorded Garmin subtypes establish a surface. */
export function recordedActivitySurface(activity: {
  sportType: string
  surfaceType?: string | null
  sourceProvider: string
  sourceSportType: string | null
}): z.infer<typeof activitySurfaceSchema> | null {
  const recorded = activitySurfaceSchema.safeParse(activity.surfaceType)
  if (recorded.success) return recorded.data
  if (activity.sportType !== 'RUNNING' || activity.sourceProvider !== 'GARMIN') return null
  switch (activity.sourceSportType) {
    case 'trail_running':
      return 'TRAIL'
    case 'track_running':
      return 'TRACK'
    case 'street_running':
      return 'ROAD'
    case 'treadmill_running':
      return 'TREADMILL'
    default:
      return null
  }
}
