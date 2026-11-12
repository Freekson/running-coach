export const healthStreamIds = ['daily_summary', 'sleep'] as const
export type HealthStreamId = (typeof healthStreamIds)[number]
export type ImportStreamId = HealthStreamId | 'activities'

export type GarminImportStreamState = {
  streamId: ImportStreamId
  status:
    'not_started' | 'running' | 'waiting_retry' | 'paused' | 'completed_with_warnings' | 'completed'
  startDate: string | null
  endDate: string | null
  nextDate: string | null
  lastCheckedDate: string | null
  checkedDays: number
  totalDays: number | null
  failedDateCount: number
  retryAfter: string | null
  lastSyncAt: string | null
  errorCode: string | null
  generation: number | null
  summaryStatus?: GarminImportStreamState['status']
  summaryErrorCode?: string | null
  summaryRetryAfter?: string | null
  laps?: GarminLapImportState
  pagesFetched?: number
  recentSync?: GarminImportStreamState
  activityCount?: number
  currentRange?: { start: string; end: string } | null
}

export type GarminLapImportState = {
  status: GarminImportStreamState['status']
  eligible: number
  processed: number
  complete: number
  failed: number
  unavailable: number
  pending: number
  retryable: number
  totalLaps: number
  retryAfter: string | null
  lastSyncAt: string | null
  errorCode: string | null
}
