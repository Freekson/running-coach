import { z } from 'zod'

export const incrementalStreamIds = ['activities', 'daily_summary', 'sleep'] as const
export const incrementalStreamSchema = z.enum(incrementalStreamIds)
export const incrementalResultSchema = z.strictObject({
  streamId: incrementalStreamSchema,
  status: z.enum(['idle', 'syncing', 'completed', 'skipped', 'failed', 'rate_limited']),
  reason: z
    .enum([
      'INITIAL_IMPORT_REQUIRED',
      'NOT_CONNECTED',
      'CONNECTION_ERROR',
      'BUSY',
      'BACKOFF',
      'REQUEST_BUDGET',
      'SYNC_FAILED',
    ])
    .nullable(),
  lastSuccessAt: z.iso.datetime().nullable(),
  retryAt: z.iso.datetime().nullable(),
  progressKey: z.string().max(256).nullable().optional(),
})
export const incrementalSnapshotSchema = z.strictObject({
  connection: z.enum(['connected', 'disconnected', 'error']),
  busy: z.boolean().optional(),
  connectionKey: z.string().min(1).max(100).nullable().optional(),
  streams: z.array(incrementalResultSchema).length(3),
})
export type IncrementalStreamId = z.infer<typeof incrementalStreamSchema>
export type IncrementalSyncResult = z.infer<typeof incrementalResultSchema>
export type IncrementalSyncSnapshot = z.infer<typeof incrementalSnapshotSchema>

export const incrementalStreamLabels: Record<IncrementalStreamId, string> = {
  activities: 'Activities',
  daily_summary: 'Daily summary',
  sleep: 'Sleep',
}
