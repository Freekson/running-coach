import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ToastProvider } from '@/components/ui/Toast'
import { ActivitySyncPanel } from './activity-sync-panel'

const meta = {
  title: 'Athlete/Activity sync panel',
  component: ActivitySyncPanel,
  render: (args) => (
    <ToastProvider>
      <ActivitySyncPanel {...args} />
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
} satisfies Meta<typeof ActivitySyncPanel>

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
export const BackfillInProgress: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      status: 'PARTIAL',
      window: { start: '2026-08-17', end: '2026-11-09' },
      nextDate: '2026-08-22',
      processed: 0,
      lastAttemptAt: '2026-11-09T06:00:00Z',
    },
  },
}
export const Paused: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      status: 'PAUSED',
      nextAttemptAt: '2026-11-09T06:05:00Z',
      window: { start: '2026-08-17', end: '2026-11-09' },
      nextDate: '2026-08-22',
      errorCode: 'RATE_LIMITED',
    },
  },
}
export const UpToDate: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      status: 'SUCCESS',
      lastSuccessAt: '2026-11-09T06:00:00Z',
      window: { start: '2026-11-03', end: '2026-11-09' },
    },
  },
}
