import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { HeartPulse, Moon } from 'lucide-react'
import { SectionHeading } from './index'

const meta = {
  title: 'UI/Section heading',
  component: SectionHeading,
  args: {
    icon: HeartPulse,
    title: 'Resting heart rate',
    subtitle: 'Daily Garmin measurements',
  },
} satisfies Meta<typeof SectionHeading>

export default meta
type Story = StoryObj<typeof meta>

export const WithSubtitle: Story = {}
export const TitleOnly: Story = {
  args: { icon: Moon, title: "Last night's sleep", subtitle: undefined, level: 3 },
}
