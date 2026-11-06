import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { Badge } from './Badge'

const meta = {
  title: 'UI/Badge',
  component: Badge,
  args: { children: 'Planned' },
} satisfies Meta<typeof Badge>

export default meta
type Story = StoryObj<typeof meta>

export const Neutral: Story = {}
export const Success: Story = { args: { tone: 'success', children: 'Ready' } }
export const Warning: Story = { args: { tone: 'warning', children: 'Awaiting review' } }
export const Error: Story = { args: { tone: 'error', children: 'Sync failed' } }
export const InvitationStatuses: Story = {
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <Badge tone="warning">Pending</Badge>
      <Badge tone="success">Used</Badge>
      <Badge tone="error">Revoked</Badge>
      <Badge tone="neutral">Expired</Badge>
    </div>
  ),
}
