import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ToastProvider } from '@/components/ui/Toast'
import type { GarminImportStreamState } from '@/lib/garmin-import-state'
import { garminHistoryWindowDays } from '@/lib/garmin-import-window'
import { GarminDataImport } from './garmin-data-import'

const initial: GarminImportStreamState[] = (['daily_summary', 'sleep', 'activities'] as const).map(
  (id) => ({
    streamId: id,
    status: 'not_started',
    startDate: null,
    endDate: null,
    nextDate: null,
    lastCheckedDate: null,
    checkedDays: 0,
    totalDays: null,
    failedDateCount: 0,
    retryAfter: null,
    lastSyncAt: null,
    errorCode: null,
    generation: null,
  }),
)
const summary: GarminImportStreamState = {
  ...initial[2],
  status: 'paused',
  summaryStatus: 'completed',
  summaryErrorCode: null,
  laps: {
    status: 'not_started',
    eligible: 62,
    pending: 62,
    complete: 0,
    processed: 0,
    failed: 0,
    unavailable: 0,
    retryable: 0,
    totalLaps: 0,
    retryAfter: null,
    lastSyncAt: null,
    errorCode: null,
  },
  startDate: '2023-11-12',
  endDate: '2026-11-11',
  checkedDays: garminHistoryWindowDays('2023-11-12', '2026-11-11')!,
  totalDays: garminHistoryWindowDays('2023-11-12', '2026-11-11'),
  lastCheckedDate: '2023-11-12',
  lastSyncAt: '2026-11-12T02:00:00Z',
  activityCount: 62,
  pagesFetched: 80,
  generation: 1,
}
const meta = {
  title: 'Athlete/Settings/Garmin Data Import',
  component: GarminDataImport,
  render: (args) => (
    <ToastProvider>
      <GarminDataImport {...args} />
    </ToastProvider>
  ),
  args: { initial },
} satisfies Meta<typeof GarminDataImport>
export default meta
type Story = StoryObj<typeof meta>

export const NotStarted: Story = {}
export const SummaryCompleteLapsPending: Story = {
  args: { initial: [...initial.slice(0, 2), summary] },
}
export const Paused: Story = {
  args: {
    initial: [
      ...initial.slice(0, 2),
      {
        ...summary,
        status: 'paused',
        summaryStatus: 'paused',
        checkedDays: 30,
        nextDate: '2026-10-12',
        activityCount: 12,
        pagesFetched: 4,
        lastCheckedDate: '2026-10-13',
        currentRange: { start: '2026-09-13', end: '2026-10-12' },
      },
    ],
  },
}
export const FailedPage: Story = {
  args: {
    initial: [
      ...initial.slice(0, 2),
      {
        ...summary,
        status: 'paused',
        summaryStatus: 'paused',
        nextDate: '2026-10-12',
        checkedDays: 30,
        errorCode: 'INVALID_RESPONSE',
      },
    ],
  },
}
export const RetryableBearerRejection: Story = {
  args: {
    initial: [
      ...initial.slice(0, 2),
      {
        ...summary,
        status: 'paused',
        summaryStatus: 'paused',
        nextDate: summary.endDate,
        checkedDays: 0,
        errorCode: 'TOKEN_REJECTED',
        activityCount: 40,
        pagesFetched: 2,
      },
    ],
  },
}
export const Mobile: Story = {
  ...SummaryCompleteLapsPending,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}

export const LapsImporting: Story = {
  args: {
    initial: [
      ...initial.slice(0, 2),
      {
        ...summary,
        status: 'running',
        laps: {
          ...summary.laps!,
          status: 'running',
          complete: 30,
          pending: 32,
          processed: 30,
          totalLaps: 120,
          lastSyncAt: '2026-11-12T02:05:00Z',
        },
      },
    ],
  },
}
export const LapsPaused: Story = {
  args: {
    initial: [
      ...initial.slice(0, 2),
      {
        ...summary,
        laps: {
          ...summary.laps!,
          status: 'paused',
          complete: 30,
          pending: 32,
          processed: 30,
          totalLaps: 120,
          lastSyncAt: '2026-11-12T02:05:00Z',
        },
      },
    ],
  },
}
export const FailedFits: Story = {
  args: {
    initial: [
      ...initial.slice(0, 2),
      {
        ...summary,
        laps: {
          ...summary.laps!,
          status: 'paused',
          complete: 60,
          pending: 0,
          processed: 62,
          failed: 2,
          retryable: 2,
          totalLaps: 240,
          lastSyncAt: '2026-11-12T02:10:00Z',
        },
      },
    ],
  },
}
export const Completed: Story = {
  args: {
    initial: [
      ...initial.slice(0, 2),
      {
        ...summary,
        status: 'completed',
        laps: {
          ...summary.laps!,
          status: 'completed',
          complete: 62,
          pending: 0,
          processed: 62,
          totalLaps: 248,
          lastSyncAt: '2026-11-12T02:10:00Z',
        },
      },
    ],
  },
}
export const CompletedWithWarnings: Story = {
  args: {
    initial: [
      ...initial.slice(0, 2),
      {
        ...summary,
        status: 'completed_with_warnings',
        laps: {
          ...summary.laps!,
          status: 'completed_with_warnings',
          complete: 61,
          unavailable: 1,
          pending: 0,
          processed: 62,
          totalLaps: 244,
          lastSyncAt: '2026-11-12T02:10:00Z',
        },
      },
    ],
  },
}

export const FailedFitsCoolingDown: Story = {
  args: {
    initial: [
      ...initial.slice(0, 2),
      {
        ...summary,
        status: 'waiting_retry',
        summaryRetryAfter: null,
        retryAfter: new Date(Date.now() + 3_600_000).toISOString(),
        laps: {
          ...summary.laps!,
          status: 'waiting_retry',
          complete: 60,
          pending: 0,
          processed: 62,
          failed: 2,
          retryable: 0,
          totalLaps: 240,
          retryAfter: new Date(Date.now() + 3_600_000).toISOString(),
        },
      },
    ],
  },
}
