import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { HealthSkeleton } from './health-skeleton'

const meta = { title: 'Health/Loading', component: HealthSkeleton } satisfies Meta<
  typeof HealthSkeleton
>
export default meta
type Story = StoryObj<typeof meta>
export const Page: Story = {}
