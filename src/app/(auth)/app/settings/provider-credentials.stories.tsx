import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ProviderCredentials } from './provider-credentials'

const meta = {
  title: 'Athlete/Provider credentials',
  component: ProviderCredentials,
  args: {
    initial: {
      provider: 'OPENAI',
      status: 'DISCONNECTED',
      createdAt: null,
      updatedAt: null,
    },
  },
} satisfies Meta<typeof ProviderCredentials>

export default meta
type Story = StoryObj<typeof meta>

export const Disconnected: Story = {}
export const Connected: Story = {
  args: {
    initial: {
      provider: 'OPENAI',
      status: 'CONNECTED',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
  },
}
export const ErrorState: Story = {
  args: {
    initial: {
      provider: 'OPENAI',
      status: 'ERROR',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
  },
}
