import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ToastProvider } from '@/components/ui/Toast'
import { HealthSyncDetails, HealthSyncPanel } from './HealthSyncPanel'

const meta = {
  title: 'Athlete/Health sync panel',
  component: HealthSyncPanel,
  render: (args) => (
    <ToastProvider>
      <HealthSyncPanel {...args} />
    </ToastProvider>
  ),
  args: {
    initial: {
      status: 'IDLE',
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextAttemptAt: null,
      window: null,
      nextDate: null,
      processed: 0,
      errorCode: null,
    },
  },
} satisfies Meta<typeof HealthSyncPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {}
export const NotConnected: Story = {
  args: { initial: { ...meta.args.initial, status: 'NOT_CONNECTED' } },
}
export const VerificationRequired: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      status: 'ACTION_REQUIRED',
      errorCode: 'ACCOUNT_VERIFICATION_REQUIRED',
    },
  },
}
export const InitialProgress: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      status: 'PARTIAL',
      window: { start: '2026-10-11', end: '2026-11-09' },
      nextDate: '2026-10-21',
      processed: 10,
    },
  },
}
export const RateLimited: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      status: 'PAUSED',
      nextAttemptAt: '2026-11-09T06:00:00Z',
      window: { start: '2026-11-03', end: '2026-11-09' },
      nextDate: '2026-11-05',
      errorCode: 'RATE_LIMITED',
    },
  },
}
export const LastSyncFailed: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      status: 'PARTIAL_FAILURE',
      window: { start: '2026-11-03', end: '2026-11-09' },
      nextDate: '2026-11-05',
      processed: 2,
      errorCode: 'UNAVAILABLE',
    },
  },
}
export const SleepRetry: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      status: 'PAUSED',
      window: { start: '2026-11-03', end: '2026-11-09' },
      nextDate: '2026-11-08',
      sleepRetryDates: ['2026-11-07'],
      processed: 1,
      errorCode: 'SLEEP_TIMEOUT',
      nextAttemptAt: '2026-11-09T08:15:00Z',
    },
  },
}
export const UpToDate: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      status: 'SUCCESS',
      lastSuccessAt: '2026-11-09T05:00:00Z',
      window: { start: '2026-11-03', end: '2026-11-09' },
    },
  },
}

export const DetailsExpanded: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      status: 'SUCCESS',
      lastSuccessAt: '2026-11-09T13:48:00Z',
      window: { start: '2026-10-11', end: '2026-11-09' },
      processed: 10,
      recentRuns: [
        {
          kind: 'SYNC',
          status: 'FAILED',
          startedAt: '2026-11-09T13:40:00Z',
          finishedAt: '2026-11-09T13:40:15Z',
          datesProcessed: 4,
          errorCode: 'SLEEP_HTTP_503',
          retryAt: null,
          recoveredApiErrors: [],
        },
        {
          kind: 'SYNC',
          status: 'SUCCEEDED',
          startedAt: '2026-11-09T13:48:00Z',
          finishedAt: '2026-11-09T13:48:20Z',
          datesProcessed: 10,
          errorCode: null,
          retryAt: null,
          recoveredApiErrors: ['SLEEP_HTTP_503'],
        },
      ],
    },
  },
  render: ({ initial }) => <HealthSyncDetails state={initial} />,
  play: ({ canvasElement }) => {
    canvasElement.querySelector('summary')?.click()
  },
}
