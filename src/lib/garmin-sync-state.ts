import { z } from 'zod'

export const garminSyncStateSchema = z.strictObject({
  status: z.enum([
    'NOT_CONNECTED',
    'IDLE',
    'SYNCING',
    'PAUSED',
    'ACTION_REQUIRED',
    'ERROR',
    'PARTIAL_FAILURE',
    'PARTIAL',
    'SUCCESS',
    'UNAVAILABLE',
  ]),
  lastAttemptAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  window: z.strictObject({ start: z.string(), end: z.string() }).nullable(),
  nextDate: z.string().nullable(),
  processed: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  sleepRetryDates: z.array(z.iso.date()).max(30).optional(),
  sleepFailedDates: z.array(z.iso.date()).max(30).optional(),
  recentRuns: z
    .array(
      z.strictObject({
        kind: z.enum(['SYNC', 'REQUEST']),
        status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED']),
        startedAt: z.iso.datetime(),
        finishedAt: z.iso.datetime().nullable(),
        datesProcessed: z.number().int().nonnegative(),
        errorCode: z.string().nullable(),
        retryAt: z.iso.datetime().nullable(),
        recoveredApiErrors: z.array(z.string()).max(3),
      }),
    )
    .max(5)
    .optional(),
})

export type GarminSyncState = z.infer<typeof garminSyncStateSchema>
