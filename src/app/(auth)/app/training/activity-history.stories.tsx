import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ToastProvider } from '@/components/ui/Toast'
import { MeasurementSystemProvider } from '../measurement-system-provider'
import { ActivityHistory } from './activity-history'
import { ActivityHistorySkeleton } from './activity-history-skeleton'
import { ActivitySyncPanel } from './activity-sync-panel'
import { defaultActivityHistoryQuery, type ActivityHistoryPage } from '@/lib/activity-history'
import type { GarminSyncState } from '@/lib/garmin-sync-state'
import styles from './training.module.scss'

const router = {
  back: fn(),
  forward: fn(),
  refresh: fn(),
  push: fn(),
  replace: fn(),
  prefetch: fn(),
  bfcacheId: 'storybook',
}
const sync: GarminSyncState = {
  status: 'SUCCESS',
  lastAttemptAt: null,
  lastSuccessAt: new Date().toISOString(),
  nextAttemptAt: null,
  window: null,
  nextDate: null,
  processed: 0,
  errorCode: null,
}
const data: ActivityHistoryPage = {
  items: Array.from({ length: 10 }, (_, index) => ({
    id: `activity-${index}`,
    title: ['Riverside Run', 'Morning Ride', 'Park Walk', 'Pool Session', 'Evening Row'][index % 5],
    sport: ['RUNNING', 'CYCLING', 'WALKING', 'SWIMMING', 'OTHER'][index % 5],
    sourceSport: index % 5 === 4 ? 'rowing' : null,
    provider: index % 3 ? 'GARMIN' : 'FILE',
    startedAt: new Date(Date.UTC(2026, 10, 12 - index, 6)).toISOString(),
    distanceMeters: index === 9 ? null : 5000 + index * 750,
    timerMs: index === 9 ? null : 1800000 + index * 150000,
    movingMs: null,
    elapsedMs: null,
    avgSpeedMps: index === 9 ? null : 2.5,
    avgHrBpm: index % 4 ? 145 : null,
  })),
  total: 12,
  importedCount: 12,
  page: 1,
  pageCount: 2,
  pageSize: 10,
  sports: ['RUNNING', 'CYCLING', 'WALKING', 'SWIMMING', 'OTHER'],
  providers: ['GARMIN', 'FILE'],
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dateBounds: { min: '2023-11-11', max: '2026-11-12' },
  imported: true,
  savedAt: sync.lastSuccessAt,
}
const meta = {
  title: 'Training/Activity history',
  component: ActivityHistory,
  decorators: [
    (Story) => (
      <AppRouterContext.Provider value={router}>
        <ToastProvider>
          <MeasurementSystemProvider initialSystem="METRIC">
            <div className={styles.page}>
              <header className={styles.header}>
                <div>
                  <h1>Activity History</h1>
                  <p>Browse and filter your imported workouts.</p>
                </div>
                <ActivitySyncPanel initial={sync} />
              </header>
              <Story />
            </div>
          </MeasurementSystemProvider>
        </ToastProvider>
      </AppRouterContext.Provider>
    ),
  ],
  args: { data, query: defaultActivityHistoryQuery },
} satisfies Meta<typeof ActivityHistory>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const AutomaticFilters: Story = {
  play: async ({ canvasElement }) => {
    router.push.mockClear()
    const canvas = within(canvasElement)
    await userEvent.click(canvasElement.querySelector<HTMLButtonElement>('#activity-sport')!)
    await userEvent.click(canvas.getByRole('option', { name: 'Cycling' }))
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Search activities' }), 'Morning')
    await waitFor(
      () =>
        expect(router.push).toHaveBeenLastCalledWith('/app/training?q=Morning&sport=CYCLING', {
          scroll: false,
        }),
      { timeout: 2000 },
    )
  },
}
export const Running: Story = {
  args: { query: { ...defaultActivityHistoryQuery, sport: 'RUNNING', minDistance: '21.0975' } },
}
export const Cycling: Story = {
  args: { query: { ...defaultActivityHistoryQuery, sport: 'CYCLING', minDistance: '100' } },
}
export const Swimming: Story = {
  args: { query: { ...defaultActivityHistoryQuery, sport: 'SWIMMING', minDistance: '0.1' } },
}
export const SingleResult: Story = {
  args: { data: { ...data, items: data.items.slice(0, 1), total: 1, pageCount: 1 } },
}
export const LoadingTenRows: Story = { render: () => <ActivityHistorySkeleton rows={10} /> }
export const LoadingTwentyFiveRows: Story = { render: () => <ActivityHistorySkeleton rows={25} /> }
export const Mobile: Story = { globals: { viewport: { value: 'mobile1', isRotated: false } } }
export const NotImported: Story = {
  args: {
    data: {
      ...data,
      items: [],
      total: 0,
      importedCount: 0,
      pageCount: 1,
      sports: [],
      providers: [],
      imported: false,
    },
  },
}
export const EmptyImport: Story = {
  args: {
    data: {
      ...data,
      items: [],
      total: 0,
      importedCount: 0,
      pageCount: 1,
      sports: [],
      providers: [],
    },
  },
}
export const NoMatches: Story = {
  args: {
    query: { ...defaultActivityHistoryQuery, q: 'Unmatched activity' },
    data: { ...data, items: [], total: 0, pageCount: 1 },
  },
}
export const CustomDates: Story = {
  args: {
    query: {
      ...defaultActivityHistoryQuery,
      range: 'custom',
      from: '2026-11-01',
      to: '2026-11-12',
    },
  },
}
export const LongTitle: Story = {
  args: {
    data: {
      ...data,
      items: [
        {
          ...data.items[0],
          title:
            'A long outdoor training session with an unexpectedly long imported provider activity title',
        },
      ],
    },
  },
  globals: Mobile.globals,
}
