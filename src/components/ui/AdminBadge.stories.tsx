import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { AdminBadge } from './AdminBadge'

const meta = {
  title: 'UI/AdminBadge',
  component: AdminBadge,
} satisfies Meta<typeof AdminBadge>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
