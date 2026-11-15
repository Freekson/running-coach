import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { createNavigation, useRouter } from '@storybook/nextjs-vite/navigation.mock'
import { ToastProvider } from '@/components/ui/Toast'
import { IntervalsConnection } from './intervals-connection'

const meta = {
  title: 'Athlete/Intervals connection',
  component: IntervalsConnection,
  beforeEach: () => {
    // Storybook 9's App Router layout context predates Next 16.4's render tree.
    useRouter.mockReturnValue({ ...createNavigation({}), bfcacheId: 'b0' })
  },
  render: (args) => (
    <ToastProvider>
      <IntervalsConnection {...args} />
    </ToastProvider>
  ),
  args: {
    initial: { provider: 'INTERVALS', status: 'DISCONNECTED', createdAt: null, updatedAt: null },
  },
} satisfies Meta<typeof IntervalsConnection>
export default meta
type Story = StoryObj<typeof meta>

export const NotConfigured: Story = {}
export const KeySaved: Story = {
  args: {
    initial: {
      provider: 'INTERVALS',
      status: 'KEY_SAVED',
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:00:00.000Z',
    },
  },
}
export const Connected: Story = {
  args: {
    initial: {
      provider: 'INTERVALS',
      status: 'CONNECTED',
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:00:00.000Z',
    },
  },
}
export const RejectedKey: Story = {
  args: {
    initial: {
      provider: 'INTERVALS',
      status: 'ERROR',
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:00:00.000Z',
    },
  },
}
export const DeliveryPrepared: Story = {
  ...Connected,
  args: {
    ...Connected.args,
    deliveryInitial: {
      status: 'READY',
      source: 'technical-delivery-reference',
      verifiedAt: '2026-11-15T00:00:00.000Z',
    },
  },
}
export const DeliveryNeedsAttention: Story = {
  ...Connected,
  args: {
    ...Connected.args,
    deliveryInitial: { status: 'FAILED', source: null, verifiedAt: null },
  },
}
export const Narrow: Story = {
  ...Connected,
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
}
