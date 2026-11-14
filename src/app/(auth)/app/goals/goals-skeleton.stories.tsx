import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { GoalsSkeleton } from './goals-skeleton'

const meta = { title: 'Training/Goals loading', component: GoalsSkeleton } satisfies Meta<
  typeof GoalsSkeleton
>
export default meta
type Story = StoryObj<typeof meta>
export const Page: Story = {}
export const Mobile: Story = { globals: { viewport: { value: 'mobile1', isRotated: false } } }
