import 'server-only'

import { randomUUID } from 'node:crypto'

const codes = new Set([
  'NOT_CONNECTED',
  'INVALID_KEY',
  'ACCESS_DENIED',
  'ACCOUNT_MISMATCH',
  'ACCOUNT_UNVERIFIABLE',
  'ACCOUNT_VERIFICATION_REQUIRED',
  'INVALID_CHECKPOINT',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'STORAGE_UNAVAILABLE',
  'INTERRUPTED',
  'INVALID_INPUT',
  'NOT_APPROVED',
  'STALE_REVISION',
  'BUSY',
  'RECOVERY_REQUIRED',
  'ACCOUNT_CHANGED',
  'REMOTE_CONFLICT',
  'PROVIDER_UNAVAILABLE',
  'PERMISSION_REQUIRED',
  'EXPORT_UNVERIFIED',
  'INVALID_DATE',
  'INVALID_RESPONSE',
  'IDENTITY_MISMATCH',
  'TOKEN_REJECTED',
  'TIMEOUT',
  'NETWORK_ERROR',
  'PARTIAL_IMPORT',
])

/** Never echo arbitrary persisted codes, exception messages or provider payloads. */
export function safeOperationalCode(code: unknown): string {
  if (typeof code !== 'string' || code.trim() !== code) return 'UNKNOWN_ERROR'
  if (codes.has(code)) return code
  if (/^(?:SLEEP|SUMMARY)_HTTP_[1-5]\d{2}$/.test(code)) return code
  if (
    /^(?:SLEEP|SUMMARY)_(?:TIMEOUT|NETWORK|INVALID_RESPONSE|DATE_MISMATCH|INVALID_RECORD|EMPTY_BODY)$/.test(
      code,
    )
  )
    return code
  return 'UNKNOWN_ERROR'
}

type Operation =
  | 'garmin_sync'
  | 'garmin_health'
  | 'garmin_import'
  | 'garmin_history'
  | 'garmin_laps'
  | 'intervals_publish'
  | 'admin_summary'

/** A projection, not a generic logger: no caller metadata is serialized. */
export function reportOperationalFailure(operation: Operation, code: unknown): void {
  try {
    console.warn(
      JSON.stringify({
        event: 'operation_failed',
        eventId: randomUUID(),
        operation: [
          'garmin_sync',
          'garmin_health',
          'garmin_import',
          'garmin_history',
          'garmin_laps',
          'intervals_publish',
          'admin_summary',
        ].includes(operation)
          ? operation
          : 'unknown',
        code: safeOperationalCode(code),
      }),
    )
  } catch {
    // Reporting must not interrupt checkpoint persistence or recovery.
  }
}
