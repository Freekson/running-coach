import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { HealthSnapshot } from './HealthSnapshot'

const meta = {
  title: 'Athlete/Health snapshot',
  component: HealthSnapshot,
  args: {
    asOfInstant: '2026-11-08T12:00:00.000Z',
    data: {
      restingHr: null,
      sleep: null,
      restingHrChecked: false,
      sleepChecked: false,
      lastUpdatedAt: null,
    },
  },
} satisfies Meta<typeof HealthSnapshot>

export default meta
type Story = StoryObj<typeof meta>

export const NoData: Story = {}

export const DatedMeasurements: Story = {
  args: {
    data: {
      restingHr: {
        value: 53,
        date: '2026-11-07',
        timezone: 'Europe/Kyiv',
        fetchedAt: '2026-11-08T08:00:00.000Z',
      },
      sleep: {
        value: 25_200_000,
        date: '2026-11-06',
        timezone: 'Europe/Kyiv',
        fetchedAt: '2026-11-08T08:00:00.000Z',
      },
      restingHrChecked: true,
      sleepChecked: true,
      lastUpdatedAt: '2026-11-08T08:00:00.000Z',
    },
  },
}

export const OlderReading: Story = {
  args: {
    data: {
      restingHr: {
        value: 55,
        date: '2026-10-01',
        timezone: 'Europe/Kyiv',
        fetchedAt: '2026-10-02T08:00:00.000Z',
      },
      sleep: null,
      restingHrChecked: true,
      sleepChecked: true,
      lastUpdatedAt: '2026-10-02T08:00:00.000Z',
    },
  },
}

export const SleepRequestFailed: Story = {
  args: {
    failedSleepDate: '2026-11-07',
    data: {
      restingHr: {
        value: 55,
        date: '2026-11-07',
        timezone: 'Asia/Tokyo',
        fetchedAt: '2026-11-09T07:59:06.000Z',
      },
      sleep: null,
      restingHrChecked: true,
      sleepChecked: false,
      lastUpdatedAt: '2026-11-09T07:59:06.000Z',
    },
  },
}
