import 'server-only'

import { z } from 'zod'
import { activityProviderSchema } from '@/server/activity/normalization'

const nonnegativeInteger = z.number().int().nonnegative().nullable()

export const dailyHealthObservationSchema = z.object({
  userId: z.uuid(),
  sourceProvider: activityProviderSchema,
  sourceRecordType: z.enum(['API_DAILY_SUMMARY', 'API_SLEEP', 'MANUAL_ENTRY', 'FILE_IMPORT']),
  sourceRecordId: z.string().trim().min(1).nullable(),
  localDate: z.iso.date(),
  sourceTimezone: z.string().min(1),
  restingHrBpm: nonnegativeInteger,
  hrvMs: z.number().finite().nonnegative().nullable(),
  sleepDurationMs: nonnegativeInteger,
  sleepStartedAt: z.iso.datetime({ offset: true }).nullable(),
  sleepEndedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  sleepLightMs: nonnegativeInteger.optional(),
  sleepDeepMs: nonnegativeInteger.optional(),
  sleepRemMs: nonnegativeInteger.optional(),
  sleepAwakeMs: nonnegativeInteger.optional(),
  sleepScore: nonnegativeInteger,
  steps: nonnegativeInteger,
  stress: nonnegativeInteger,
  bodyBattery: nonnegativeInteger,
})

export type DailyHealthObservation = z.infer<typeof dailyHealthObservationSchema>
