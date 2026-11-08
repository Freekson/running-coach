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

export const NotConfigured: Story = {}
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
export const Connected: Story = {
  args: {
    initial: {
      provider: 'GARMIN',
      status: 'CONNECTED',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
  },
}
export const BackfillInProgress: Story = {
  args: {
    ...Connected.args,
    initialSync: {
      status: 'PARTIAL',
      lastAttemptAt: '2026-11-08T00:00:00.000Z',
      lastSuccessAt: null,
      nextAttemptAt: null,
      window: { start: '2026-08-17', end: '2026-11-08' },
      nextDate: '2026-08-20',
      processed: 2,
      errorCode: null,
    },
  },
}
export const RateLimited: Story = {
  args: {
    ...Connected.args,
    initialSync: {
      status: 'PAUSED',
      lastAttemptAt: '2026-11-08T00:00:00.000Z',
      lastSuccessAt: null,
      nextAttemptAt: '2026-11-08T00:05:00.000Z',
      window: { start: '2026-08-17', end: '2026-11-08' },
      nextDate: '2026-08-20',
      processed: 1,
      errorCode: 'RATE_LIMITED',
    },
  },
}
export const InvalidKey: Story = {
  args: {
    initial: {
      provider: 'GARMIN',
      status: 'ERROR',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
    initialSync: {
      status: 'ACTION_REQUIRED',
      lastAttemptAt: '2026-11-08T00:00:00.000Z',
      lastSuccessAt: null,
      nextAttemptAt: null,
      window: { start: '2026-08-17', end: '2026-11-08' },
      nextDate: '2026-08-17',
      processed: 0,
      errorCode: 'INVALID_KEY',
    },
  },
}
export const AccessDenied: Story = {
  args: {
    ...Connected.args,
    initialSync: {
      status: 'ACTION_REQUIRED',
      lastAttemptAt: '2026-11-08T00:00:00.000Z',
      lastSuccessAt: null,
      nextAttemptAt: null,
      window: { start: '2026-08-17', end: '2026-11-08' },
      nextDate: '2026-08-17',
      processed: 0,
      errorCode: 'ACCESS_DENIED',
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
export const SavedOpenAIKey: Story = {
  args: {
    openaiInitial: {
      provider: 'OPENAI',
      status: 'CONNECTED',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
  },
}
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
