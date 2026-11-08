export type GarminSyncState = {
  status:
    | 'NOT_CONNECTED'
    | 'IDLE'
    | 'SYNCING'
    | 'PAUSED'
    | 'ACTION_REQUIRED'
    | 'ERROR'
    | 'PARTIAL_FAILURE'
    | 'PARTIAL'
    | 'SUCCESS'
    | 'UNAVAILABLE'
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  nextAttemptAt: string | null
  window: { start: string; end: string } | null
  nextDate: string | null
  processed: number
  errorCode: string | null
}
