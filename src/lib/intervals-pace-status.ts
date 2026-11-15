import { z } from 'zod'

export const intervalsPaceStatusSchema = z.strictObject({
  status: z.enum(['NOT_CHECKED', 'CHECKING', 'READY', 'FAILED']),
  source: z.enum(['existing-user-configuration', 'technical-delivery-reference']).nullable(),
  verifiedAt: z.iso.datetime().nullable(),
})

export type IntervalsPaceStatus = z.infer<typeof intervalsPaceStatusSchema>

export const intervalsPaceMessages = {
  PERMISSION_REQUIRED:
    'Intervals.icu denied access to delivery settings. Check your API key permissions or replace the key, then prepare delivery again.',
  INVALID_KEY:
    'Intervals.icu rejected your saved key. Replace it with a key from your own account.',
  RATE_LIMITED: 'Intervals.icu is rate limiting requests. Wait and prepare delivery again.',
  PROVIDER_UNAVAILABLE:
    'Intervals.icu delivery settings are temporarily unavailable. Try again later.',
  CONFIGURATION_CONFLICT:
    'Your existing Intervals.icu Run settings are incomplete or incompatible. They were preserved. Review the Run pace zones in Intervals.icu, then prepare delivery again.',
  CONFIGURATION_CHANGED:
    'Your Intervals.icu settings changed during preparation. Nothing further was changed. Prepare delivery again.',
  READBACK_FAILED:
    'Intervals.icu delivery settings could not be verified after preparation. Prepare delivery again before publishing; pace targets will not be removed.',
  BUSY: 'Delivery preparation is already running. Wait for it to finish, then try again.',
  CONNECTION_CHANGED:
    'Your connection changed during preparation. Reconnect or test the current key, then prepare delivery again.',
  PACE_TARGET_LOST:
    'The exported workout does not preserve the approved steps or targets. Publication cannot be verified. Keep the local workout and retry after reviewing Intervals.icu delivery settings.',
} as const

export type IntervalsPaceErrorCode = keyof typeof intervalsPaceMessages
