import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ToastProvider } from '@/components/ui/Toast'
import { ProviderCredentials } from './provider-credentials'

const meta = {
  title: 'Athlete/Provider credentials',
  component: ProviderCredentials,
  render: (args) => (
    <ToastProvider>
      <ProviderCredentials {...args} />
    </ToastProvider>
  ),
  args: {
    initial: {
      provider: 'GARMIN',
      status: 'DISCONNECTED',
      createdAt: null,
      updatedAt: null,
    },
  },
} satisfies Meta<typeof ProviderCredentials>

export default meta
type Story = StoryObj<typeof meta>

export const NotConfigured: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Open Add key to enter a Garmin key. Validation and save errors appear below the highlighted input without an error toast.',
      },
    },
  },
}
export const KeySaved: Story = {
  args: {
    initial: {
      provider: 'GARMIN',
      status: 'KEY_SAVED',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
  },
}
export const VerificationRequired: Story = {
  args: {
    initial: {
      provider: 'GARMIN',
      status: 'VERIFICATION_REQUIRED',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
  },
}
export const Connected: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Use How it works to reveal the combined import and retry guidance.',
      },
    },
  },
  args: {
    initial: {
      provider: 'GARMIN',
      status: 'CONNECTED',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
    garminImports: [
      {
        streamId: 'daily_summary',
        status: 'completed',
        startDate: '2023-11-10',
        endDate: '2026-11-09',
        nextDate: null,
        lastCheckedDate: '2023-11-10',
        checkedDays: 1096,
        totalDays: 1096,
        failedDateCount: 0,
        retryAfter: null,
        lastSyncAt: '2026-11-10T00:00:00.000Z',
        errorCode: null,
        generation: 1,
      },
      {
        streamId: 'sleep',
        status: 'completed_with_warnings',
        startDate: '2023-11-10',
        endDate: '2026-11-09',
        nextDate: null,
        lastCheckedDate: '2023-11-10',
        checkedDays: 1094,
        totalDays: 1096,
        failedDateCount: 2,
        retryAfter: null,
        lastSyncAt: '2026-11-10T00:00:00.000Z',
        errorCode: 'SLEEP_INVALID_RESPONSE',
        generation: 1,
      },
      {
        streamId: 'activities',
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
      },
    ],
  },
}
export const ImportWithUnresolvedDates: Story = {
  args: {
    initial: {
      provider: 'GARMIN',
      status: 'CONNECTED',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
    garminImports: [
      {
        streamId: 'daily_summary',
        status: 'paused',
        startDate: '2023-11-10',
        endDate: '2026-11-09',
        nextDate: '2026-08-10',
        lastCheckedDate: '2026-08-11',
        checkedDays: 29,
        totalDays: 1096,
        failedDateCount: 62,
        retryAfter: null,
        lastSyncAt: '2026-11-10T12:40:00.000Z',
        errorCode: 'SUMMARY_INVALID_RECORD',
        generation: 1,
      },
    ],
  },
}
export const ImportRateLimited: Story = {
  args: {
    initial: {
      provider: 'GARMIN',
      status: 'CONNECTED',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
    garminImports: [
      {
        streamId: 'daily_summary',
        status: 'waiting_retry',
        startDate: '2023-11-10',
        endDate: '2026-11-09',
        nextDate: '2026-08-10',
        lastCheckedDate: '2026-08-11',
        checkedDays: 91,
        totalDays: 1096,
        failedDateCount: 0,
        retryAfter: new Date(Date.now() + 6 * 60_000).toISOString(),
        lastSyncAt: '2026-11-10T12:40:00.000Z',
        errorCode: 'RATE_LIMITED',
        generation: 1,
      },
    ],
  },
}
export const ConnectionIssue: Story = {
  args: {
    initial: {
      provider: 'GARMIN',
      status: 'ERROR',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
  },
}

export const Expired: Story = {
  args: {
    initial: {
      provider: 'GARMIN',
      status: 'EXPIRED',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
  },
}
export const ImportDashboard: Story = {
  args: {
    initial: {
      provider: 'GARMIN',
      status: 'CONNECTED',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
    garminImports: [
      {
        streamId: 'daily_summary',
        status: 'completed',
        startDate: '2023-11-10',
        endDate: '2026-11-09',
        nextDate: null,
        lastCheckedDate: '2023-11-10',
        checkedDays: 1096,
        totalDays: 1096,
        failedDateCount: 0,
        retryAfter: null,
        lastSyncAt: '2026-11-10T13:26:00.000Z',
        errorCode: null,
        generation: 1,
      },
      {
        streamId: 'sleep',
        status: 'waiting_retry',
        startDate: '2023-11-10',
        endDate: '2026-11-09',
        nextDate: '2026-03-15',
        lastCheckedDate: '2026-03-15',
        checkedDays: 240,
        totalDays: 1096,
        failedDateCount: 12,
        retryAfter: new Date(Date.now() + 6 * 60_000).toISOString(),
        lastSyncAt: '2026-11-10T13:35:00.000Z',
        errorCode: 'RATE_LIMITED',
        generation: 1,
        currentRange: { start: '2026-02-13', end: '2026-03-14' },
      },
      {
        streamId: 'activities',
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
      },
    ],
  },
}
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
