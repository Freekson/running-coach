import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { OperationsSummary } from './operations-summary'

const meta = {
  title: 'Admin/Operational health',
  component: OperationsSummary,
  args: {
    summary: {
      since: '2026-11-24T12:00:00Z',
      checkedAt: '2026-11-25T12:00:00Z',
      syncFailures: [{ code: 'RATE_LIMITED', count: 3 }],
      publicationFailures: [{ code: 'RECOVERY_REQUIRED', count: 1 }],
      stalledSyncs: 1,
      stalledPublications: 0,
    },
  },
} satisfies Meta<typeof OperationsSummary>
export default meta
type Story = StoryObj<typeof meta>
export const Failures: Story = {}
export const Unavailable: Story = { args: { summary: null } }
export const Healthy: Story = {
  args: {
    summary: { ...meta.args.summary, syncFailures: [], publicationFailures: [], stalledSyncs: 0 },
  },
}
export const Mobile: Story = { globals: { viewport: { value: 'mobile1', isRotated: false } } }
