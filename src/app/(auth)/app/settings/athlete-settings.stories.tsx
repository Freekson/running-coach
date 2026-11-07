import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ToastProvider } from '@/components/ui/Toast'
import { MeasurementSystemProvider } from '../measurement-system-provider'
import { AthleteSettings } from './athlete-settings'

const readings = [76.4, 76.8, 77.3, 77.5].map((valueKg, index) => ({
  id: `reading-${index}`,
  measuredAt: new Date(Date.now() - index * 5 * 24 * 60 * 60 * 1000).toISOString(),
  measuredOn: null,
  createdAt: new Date(Date.now() - index * 5 * 24 * 60 * 60 * 1000).toISOString(),
  valueKg,
}))

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
      weights: readings,
      chartWeights: readings,
    },
  },
} satisfies Meta<typeof AthleteSettings>

export default meta
type Story = StoryObj<typeof meta>

export const WithHistory: Story = {}
export const LongHistory: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      weights: Array.from({ length: 3 }, (_, index) => ({
        id: `recent-${index}`,
        measuredAt: new Date(Date.now() - index * 86_400_000).toISOString(),
        measuredOn: null,
        createdAt: new Date(Date.now() - index * 86_400_000).toISOString(),
        valueKg: 85 + index * 0.2,
      })),
      chartWeights: Array.from({ length: 90 }, (_, index) => ({
        id: `daily-${index}`,
        measuredAt: new Date(Date.now() - index * 86_400_000).toISOString(),
        measuredOn: null,
        createdAt: new Date(Date.now() - index * 86_400_000).toISOString(),
        valueKg: 85 + index * 0.04 + Math.sin(index / 4) * 0.5,
      })),
    },
  },
}
export const Beginner: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      profile: { ...meta.args.initial.profile, experienceLevel: 'BEGINNER' },
    },
  },
}
export const EmptyHistory: Story = {
  args: { initial: { ...meta.args.initial, weights: [], chartWeights: [] } },
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
