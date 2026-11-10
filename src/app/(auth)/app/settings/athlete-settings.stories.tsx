import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ToastProvider } from '@/components/ui/Toast'
import { MeasurementSystemProvider } from '../measurement-system-provider'
import { AthleteSettings } from './athlete-settings'

const meta = {
  title: 'Athlete/Settings',
  component: AthleteSettings,
  render: (args) => (
    <ToastProvider>
      <MeasurementSystemProvider initialSystem={args.initial.profile.measurementSystem}>
        <AthleteSettings {...args} />
      </MeasurementSystemProvider>
    </ToastProvider>
  ),
  args: {
    registrationName: 'Avery Runner',
    garminConnection: {
      provider: 'GARMIN',
      status: 'KEY_SAVED',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
    },
    initial: {
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
    },
  },
} satisfies Meta<typeof AthleteSettings>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Beginner: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      profile: { ...meta.args.initial.profile, experienceLevel: 'BEGINNER' },
    },
  },
}
export const Imperial: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      profile: { ...meta.args.initial.profile, measurementSystem: 'IMPERIAL' },
    },
  },
}
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
