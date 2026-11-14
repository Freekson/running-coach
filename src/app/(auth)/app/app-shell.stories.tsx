import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { fn } from 'storybook/test'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { ToastProvider } from '@/components/ui/Toast'
import { AppShell } from './app-shell'
import { AthleteSettings } from './settings/athlete-settings'

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
  title: 'App/Navigation',
  component: AppShell,
  parameters: {
    layout: 'fullscreen',
  },
  // Storybook 9's App Router provider uses the cache shape from before Next 16.
  decorators: [
    (Story) => (
      <AppRouterContext.Provider value={router}>
        <PathnameContext.Provider value="/app/settings">
          <Story />
        </PathnameContext.Provider>
      </AppRouterContext.Provider>
    ),
  ],
  args: {
    user: {
      id: 'story-user',
      role: 'USER',
      displayName: 'Avery Runner',
      email: 'runner@example.test',
    },
    measurementSystem: 'METRIC',
    children: (
      <ToastProvider>
        <AthleteSettings
          registrationName="Avery Runner"
          initial={{
            profile: {
              displayName: null,
              birthDate: null,
              sex: 'FEMALE',
              heightCm: 168,
              experienceLevel: 'INTERMEDIATE',
              measurementSystem: 'METRIC',
              defaultTrainingDaysPerWeek: 4,
              defaultAvailableWeekdays: [0, 1, 3, 5],
            },
          }}
        />
      </ToastProvider>
    ),
  },
} satisfies Meta<typeof AppShell>

export default meta
type Story = StoryObj<typeof meta>

export const Desktop: Story = {}
export const TrainingExpanded: Story = {
  args: { children: <h1>Goals</h1> },
  decorators: [
    (Story) => (
      <PathnameContext.Provider value="/app/goals">
        <Story />
      </PathnameContext.Provider>
    ),
  ],
}
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
export const MobileAdmin: Story = {
  ...Mobile,
  args: { user: { ...meta.args.user, role: 'ADMIN' } },
}
export const MobileLongName: Story = {
  ...Mobile,
  args: {
    user: { ...meta.args.user, displayName: 'Alexandria-Alexandria-Alexandria Trail Runner' },
  },
}
