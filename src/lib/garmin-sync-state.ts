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
})

export type GarminSyncState = z.infer<typeof garminSyncStateSchema>
