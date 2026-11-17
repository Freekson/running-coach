import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { PlanReminderBanner } from './plan-reminder-banner'
import type { PlanReminderResult } from '@/lib/plan-reminders'
import { fn } from 'storybook/test'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ToastProvider } from '@/components/ui/Toast'

const router = {
  back: fn(),
  forward: fn(),
  refresh: fn(),
  push: fn(),
  replace: fn(),
  prefetch: fn(),
  bfcacheId: 'storybook',
}

const meta = {
  title: 'App/Plan reminders',
  component: PlanReminderBanner,
  decorators: [
    (Story) => (
      <AppRouterContext.Provider value={router}>
        <ToastProvider>
          <main id="main-content" tabIndex={-1}>
            <Story />
          </main>
        </ToastProvider>
      </AppRouterContext.Provider>
    ),
  ],
  args: {
    reminder: {
      planId: '00000000-0000-4000-8000-000000000047',
      fingerprint: 'a'.repeat(64),
      goalName: 'Autumn endurance goal',
      detailEndDate: '2090-01-28',
      timezone: 'Asia/Tokyo',
      exhausted: false,
      refreshByDate: '2090-03-17',
      nextAction: 'refresh',
    },
    onRespond: async (): Promise<PlanReminderResult> => ({ success: true }),
  },
} satisfies Meta<typeof PlanReminderBanner>
export default meta
type Story = StoryObj<typeof meta>
export const Due: Story = {}
export const Exhausted: Story = { args: { reminder: { ...meta.args.reminder, exhausted: true } } }
export const RefreshDeadlinePassed: Story = {
  args: { reminder: { ...meta.args.reminder, nextAction: 'review-plan' } },
}
export const SaveError: Story = {
  args: {
    onRespond: async () => ({
      success: false,
      error: 'The reminder could not be saved. Please try again.',
    }),
  },
}
export const Saving: Story = { args: { onRespond: () => new Promise(() => {}) } }
export const Narrow: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 320 }}>
        <Story />
      </div>
    ),
  ],
}
