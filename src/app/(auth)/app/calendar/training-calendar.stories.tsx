import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import type { RescheduleResult } from '@/lib/training-calendar'
import { CalendarLoading } from './calendar-loading'
import { calendarFixture } from './calendar.fixtures'
import { TrainingCalendar } from './training-calendar'

const meta = {
  title: 'Training/Calendar',
  component: TrainingCalendar,
  args: {
    data: calendarFixture(),
    onReschedule: async (): Promise<RescheduleResult> => ({ success: true }),
    onReload: () => {},
  },
} satisfies Meta<typeof TrainingCalendar>
export default meta
type Story = StoryObj<typeof meta>
export const Week: Story = {}
export const Month: Story = { args: { data: calendarFixture('month') } }
export const Mobile: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
}
export const NoPlan: Story = {
  args: {
    data: {
      ...calendarFixture(),
      hasPlan: false,
      days: calendarFixture().days.map((d) => ({ ...d, rest: false, workouts: [] })),
    },
  },
}
export const SparseHistory: Story = {
  args: {
    data: {
      ...calendarFixture(),
      days: calendarFixture().days.map((d) => ({
        ...d,
        rest: false,
        workouts: [],
        activities: [],
      })),
    },
  },
}
export const Conflict: Story = {
  args: {
    onReschedule: async () => ({
      success: false,
      code: 'conflict',
      error: 'The plan changed. Reload the calendar before moving this session.',
    }),
  },
}
export const Refreshing: Story = { args: { refreshing: true } }
export const Loading: Story = { render: () => <CalendarLoading /> }

const delayed = calendarFixture()
const completedId = delayed.days
  .flatMap((day) => day.workouts)
  .find((w) => w.name === 'Easy run')!.id
delayed.days = delayed.days.map((day) => ({
  ...day,
  workouts: day.workouts.map((w) =>
    w.id === completedId
      ? {
          ...w,
          status: 'completed',
          locked: true,
          editable: false,
          activity: { id: 'delayed-run', title: 'Delayed easy run' },
        }
      : w,
  ),
  rest: day.date === '2026-11-15' ? false : day.rest,
  activities:
    day.date === '2026-11-15'
      ? [
          {
            id: 'delayed-run',
            title: 'Delayed easy run',
            date: day.date,
            timezone: 'America/New_York',
            linkedWorkoutId: completedId,
          },
        ]
      : day.activities,
}))
export const DelayedLinkedActivity: Story = { args: { data: delayed } }
