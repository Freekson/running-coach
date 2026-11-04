import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { Card } from './Card'

const meta = {
  title: 'UI/Card',
  component: Card,
  args: { children: 'Training this week: 42.5 km' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 400 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Card>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: { style: { padding: 24 } } }
export const Raised: Story = { args: { variant: 'raised', style: { padding: 24 } } }
export const LongContent: Story = {
  args: {
    as: 'article',
    style: { padding: 24 },
    children: 'Marathon preparation: 1,234.56 km this season and the next run at 12:34 /km',
  },
}
