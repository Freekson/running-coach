import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ToastProvider } from '@/components/ui/Toast'
import { HealthSyncPanel } from './HealthSyncPanel'

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
