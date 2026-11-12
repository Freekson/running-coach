import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { HealthHistoryPanel } from './HealthHistoryPanel'

const meta = {
  title: 'Athlete/Health history',
  component: HealthHistoryPanel,
  args: {
    asOfInstant: '2026-11-09T08:00:00.000Z',
    preferredTimezone: 'Europe/Kyiv',
    rows: [
      { date: '2026-11-03', restingHrBpm: 54, sleepDurationMs: 25_200_000 },
      { date: '2026-11-05', restingHrBpm: 52, sleepDurationMs: null },
      {
        date: '2026-11-08',
        restingHrBpm: 53,
        sleepDurationMs: 28_800_000,
        sleepLightMs: 14_400_000,
        sleepDeepMs: 7_200_000,
        sleepRemMs: 7_200_000,
        sleepAwakeMs: 1_200_000,
        sleepScore: 82,
        sleepStartedAt: '2026-11-07T21:00:00Z',
        sleepEndedAt: '2026-11-08T05:20:00Z',
        sleepTimezone: 'Europe/Kyiv',
      },
    ],
  },
} satisfies Meta<typeof HealthHistoryPanel>

export default meta
type Story = StoryObj<typeof meta>

export const PartialHistory: Story = {}
export const SevenDays: Story = {
  args: {
    asOfInstant: '2026-11-12T08:00:00.000Z',
    rows: ['2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'].map(
      (date, index) => {
        const duration = [8, 5, 6, 6.5, 6.5][index] * 3_600_000
        return {
          date,
          restingHrBpm: 53,
          sleepDurationMs: duration,
          sleepLightMs: duration - 7_200_000,
          sleepDeepMs: 3_600_000,
          sleepRemMs: 3_600_000,
          sleepAwakeMs: 0,
          sleepScore: [85, 64, 71, 77, 78][index],
        }
      },
    ),
  },
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[aria-label="Sleep period"] button')?.click()
  },
}
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
export const NarrowCard: Story = {
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 360 }}>
        <Story />
      </div>
    ),
  ],
}
export const SleepTooltip: Story = {
  play: async ({ canvasElement }) => {
    canvasElement
      .querySelector<SVGGElement>('g[data-sleep-date="2026-11-08"]')
      ?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  },
}
export const NoMeasurements: Story = { args: { rows: [] } }
export const SparseSleepHistory: Story = {
  args: {
    rows: [
      {
        date: '2026-11-07',
        restingHrBpm: 55,
        sleepDurationMs: null,
        summaryChecked: true,
        sleepChecked: false,
      },
      {
        date: '2026-11-08',
        restingHrBpm: 54,
        sleepDurationMs: null,
        summaryChecked: true,
        sleepChecked: false,
      },
    ],
  },
}
