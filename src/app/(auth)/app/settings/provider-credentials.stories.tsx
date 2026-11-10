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
  args: {
    initial: {
      provider: 'GARMIN',
      status: 'CONNECTED',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
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
