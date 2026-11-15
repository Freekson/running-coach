import { z } from 'zod'

export const publicationStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'PUBLISHED',
  'CANCELLED',
  'FAILED',
  'UNCERTAIN',
  'SUPERSEDED',
])
export type PublicationStatus = z.infer<typeof publicationStatusSchema>

// Browser-safe copy for the RUN-33/38 publication controls. Provider acceptance
// and prescription verification never establish downstream watch receipt.
export const publicationStatusLabels: Record<PublicationStatus, string> = {
  QUEUED: 'Queued for publication',
  RUNNING: 'Publishing to Intervals.icu',
  PUBLISHED: 'Published to Intervals.icu · watch delivery unverified',
  CANCELLED: 'Cancelled in Intervals.icu · check Garmin Connect and your watch',
  FAILED: 'Publication failed · approved local workout preserved',
  UNCERTAIN: 'Publication outcome uncertain · retry to reconcile',
  SUPERSEDED: 'Newer approval available · publish pending changes',
}

export const intervalsDownstreamGuidance =
  'In Intervals.icu Settings, connect Garmin Connect and enable Upload planned workouts. Check the workout in Garmin Connect, sync your watch, then verify its date, steps and targets on the device. Intervals.icu API success does not confirm watch receipt.'

export const publicationSummarySchema = z.strictObject({
  id: z.uuid(),
  localWorkoutId: z.uuid(),
  approvedRevisionId: z.uuid(),
  publishRevision: z.number().int().positive(),
  operation: z.enum(['CREATE', 'UPDATE', 'RESCHEDULE', 'CANCEL']),
  status: publicationStatusSchema,
  remoteEventId: z.number().int().positive().nullable(),
  attemptCount: z.number().int().nonnegative(),
  errorCode: z.string().max(48).nullable(),
  publishedAt: z.iso.datetime().nullable(),
  garminConnect: z.literal('UNVERIFIED'),
  watch: z.literal('UNVERIFIED'),
})
export type PublicationSummary = z.infer<typeof publicationSummarySchema>
