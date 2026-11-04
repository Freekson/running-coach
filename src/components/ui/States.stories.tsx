import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ButtonLink } from './Button'
import { EmptyState, LoadingState } from './States'

const meta = {
  title: 'UI/States',
  component: EmptyState,
  args: {
    title: 'No workouts yet',
    description: 'Your workouts will appear here after the plan is approved.',
  },
} satisfies Meta<typeof EmptyState>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}
export const WithAction: Story = {
  args: {
    action: (
      <ButtonLink href="/app" size="compact">
        Review plan
      </ButtonLink>
    ),
  },
}
export const LongTextMobile: Story = {
  args: { title: 'No workouts are scheduled for next week yet' },
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
}
export const Loading: Story = {
  render: () => <LoadingState label="Loading workouts…" />,
}
