import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { PlanExportScreen } from './plan-export'

const meta = {
  title: 'Goals/Plan request',
  component: PlanExportScreen,
  args: {
    goalId: '00000000-0000-4000-8000-000000000001',
    goalName: 'First trail event',
    initialSetup: {
      goalName: 'First trail event',
      goalDate: '2027-01-31',
      draftId: '00000000-0000-4000-8000-000000000002',
      version: 0,
      measurementSystem: 'METRIC',
      today: '2026-11-16',
      constraints: {
        sessionsPerWeek: 3,
        availableWeekdays: [1, 3, 6],
        maxSessionMinutes: 60,
        startDate: null,
        timezone: 'Asia/Tokyo',
      },
    },
    onOpen: async () => ({ success: false, error: 'Story: request unavailable.' }),
    onPreview: async () => ({
      success: false,
      error: 'Story: preview unavailable. No request has been saved.',
    }),
    onSchedule: async () => ({ success: false, error: 'Story: schedule unavailable.' }),
  },
} satisfies Meta<typeof PlanExportScreen>
export default meta
type Story = StoryObj<typeof meta>
export const PrivacyChoices: Story = {}
export const FirstUse: Story = { args: { initialSetup: undefined } }
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
}
