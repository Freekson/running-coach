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
  status: 'completed',
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
