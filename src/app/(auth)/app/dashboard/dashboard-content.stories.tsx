import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { fn } from 'storybook/test'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { buildDashboardWeeks } from '@/lib/dashboard'
import { incrementalStreamIds } from '@/lib/garmin-incremental-sync'
import type { ActivityHistoryRow } from '@/lib/activity-history'
import { DashboardContent } from './dashboard-content'
import { DashboardSkeleton } from './dashboard-skeleton'

const asOfInstant = '2026-11-13T10:00:00.000Z'
const activities: ActivityHistoryRow[] = Array.from({ length: 8 }, (_, index) => ({
  id: `synthetic-${index}`,
  title: index === 7 ? 'Evening run' : 'Easy run',
  sport: 'RUNNING',
  sourceSport: null,
  provider: 'GARMIN',
  startedAt: new Date(
    Date.parse('2026-11-12T09:00:00Z') - (7 - index) * 7 * 86_400_000,
  ).toISOString(),
  distanceMeters: 3000 + index * 1000,
  timerMs: 1_200_000 + index * 300_000,
  movingMs: null,
  elapsedMs: null,
  avgSpeedMps: null,
  avgHrBpm: index === 6 ? null : 140,
}))
const meta = {
  title: 'Dashboard/Overview',
  component: DashboardContent,
  decorators: [
    (Story) => (
      <AppRouterContext.Provider
        value={{
          back: fn(),
          forward: fn(),
          push: fn(),
          replace: fn(),
          prefetch: fn(),
          refresh: fn(),
          bfcacheId: 'dashboard-story',
        }}
      >
        <Story />
      </AppRouterContext.Provider>
    ),
  ],
  args: {
    name: 'Alex',
    asOfInstant,
    timezone: 'Asia/Tokyo',
    system: 'METRIC',
    overview: {
      weeks: buildDashboardWeeks(activities, asOfInstant, 'Asia/Tokyo'),
      timezone: 'Asia/Tokyo',
    },
    recent: activities.slice(-3).reverse(),
    health: {
      restingHr: { value: 52, date: '2026-11-12', timezone: 'Asia/Tokyo', fetchedAt: asOfInstant },
      sleep: {
        value: 25_920_000,
        date: '2026-11-13',
        timezone: 'Asia/Tokyo',
        fetchedAt: asOfInstant,
      },
      sleepScore: { value: 81, date: '2026-11-13', timezone: 'Asia/Tokyo', fetchedAt: asOfInstant },
      restingHrChecked: true,
      sleepChecked: true,
      lastUpdatedAt: asOfInstant,
    },
    sync: {
      connection: 'connected',
      streams: incrementalStreamIds.map((streamId) => ({
        streamId,
        status: 'completed',
        reason: null,
        lastSuccessAt: asOfInstant,
        retryAt: null,
      })),
    },
  },
} satisfies Meta<typeof DashboardContent>
export default meta
type Story = StoryObj<typeof meta>
export const Populated: Story = {}
export const SparseWeeks: Story = {
  args: {
    overview: {
      ...meta.args.overview,
      weeks: buildDashboardWeeks(
        activities.filter((_, index) => index !== 1 && index !== 4),
        asOfInstant,
        'Asia/Tokyo',
      ),
    },
  },
}
export const Loading: Story = { render: () => <DashboardSkeleton /> }
export const NewAthlete: Story = {
  args: {
    overview: { weeks: buildDashboardWeeks([], asOfInstant, 'UTC'), timezone: 'UTC' },
    recent: [],
    health: {
      restingHr: null,
      sleep: null,
      restingHrChecked: false,
      sleepChecked: false,
      lastUpdatedAt: null,
    },
    sync: {
      connection: 'disconnected',
      streams: incrementalStreamIds.map((streamId) => ({
        streamId,
        status: 'skipped',
        reason: 'NOT_CONNECTED',
        lastSuccessAt: null,
        retryAt: null,
      })),
    },
  },
}
export const ReadFailures: Story = {
  args: { overview: null, recent: null, health: null, sync: null },
}
export const MissingHealth: Story = { args: { health: NewAthlete.args!.health } }
export const Imperial: Story = { args: { system: 'IMPERIAL' } }
export const OlderHealth: Story = {
  args: {
    health: {
      ...meta.args.health,
      restingHr: { ...meta.args.health.restingHr, date: '2026-10-01' },
      sleep: null,
      sleepScore: null,
    },
  },
}
