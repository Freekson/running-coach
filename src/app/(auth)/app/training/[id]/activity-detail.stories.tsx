import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { fn, userEvent, within, waitFor } from 'storybook/test'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ActivityDetailView } from './activity-detail'
import { ActivityChartsPanel } from './activity-charts'
import { ActivityRoute } from './activity-route'
import { HeartRateZones } from './heart-rate-zones'
import { detailFixture, chartsFixture } from './activity-detail.fixtures'
import { MeasurementSystemProvider } from '../../measurement-system-provider'
import styles from './activity-detail.module.scss'
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
  title: 'Training/Activity details',
  component: ActivityDetailView,
  decorators: [
    (Story) => (
      <AppRouterContext.Provider value={router}>
        <MeasurementSystemProvider initialSystem="METRIC">
          <Story />
        </MeasurementSystemProvider>
      </AppRouterContext.Provider>
    ),
  ],
  args: { activity: detailFixture },
} satisfies Meta<typeof ActivityDetailView>
export default meta
type Story = StoryObj<typeof meta>
export const SavedSummary: Story = {}
export const ManyLaps: Story = {
  args: {
    activity: {
      ...detailFixture,
      laps: Array.from({ length: 13 }, (_, index) => ({
        ...detailFixture.laps[index % detailFixture.laps.length],
        index,
      })),
    },
  },
}
export const LoadedWorkout: Story = {
  play: async ({ canvasElement }) => {
    const original = window.fetch
    window.fetch = async (input, init) => {
      if (String(input) === `/api/activities/${detailFixture.id}/charts`)
        return new Response(JSON.stringify(chartsFixture), {
          headers: { 'Content-Type': 'application/json' },
        })
      return original(input, init)
    }
    try {
      const canvas = within(canvasElement)
      await userEvent.click(canvas.getByRole('button', { name: 'Load FIT charts' }))
      await waitFor(() => canvas.getByRole('heading', { name: 'Workout charts' }))
    } finally {
      window.fetch = original
    }
  },
}
export const Mobile: Story = { globals: { viewport: { value: 'mobile1', isRotated: false } } }
export const LoadedMobile: Story = { ...LoadedWorkout, globals: Mobile.globals }
export const Disconnected: Story = {
  args: { activity: { ...detailFixture, fitAvailability: 'NOT_CONNECTED' } },
}
export const MissingMetrics: Story = {
  args: {
    activity: {
      ...detailFixture,
      distanceMeters: null,
      avgSpeedMps: null,
      timerMs: null,
      movingMs: null,
      elapsedMs: null,
      avgHrBpm: null,
      maxHrBpm: null,
      calories: null,
      cadenceStepsPerMinute: null,
      laps: [],
      fitAvailability: 'UNSUPPORTED',
    },
  },
}
export const Cycling: Story = {
  args: {
    activity: {
      ...detailFixture,
      sport: 'CYCLING',
      sourceSport: 'cycling',
      title: 'Morning Ride',
      avgSpeedMps: 8,
      cadenceStepsPerMinute: null,
    },
  },
}
export const InteractiveCharts: Story = {
  render: () => <ActivityChartsPanel data={chartsFixture} sport="RUNNING" />,
}
export const MobileCharts: Story = { ...InteractiveCharts, globals: Mobile.globals }
export const LongRecordingCharts: Story = {
  render: () => (
    <ActivityChartsPanel
      sport="RUNNING"
      data={{
        ...chartsFixture,
        sourceSampleCount: 20001,
        sampleIntervalSeconds: 10,
        samples: Array.from({ length: 4000 }, (_, index) => ({
          ...chartsFixture.samples[index % chartsFixture.samples.length],
          timeSeconds: index * 50,
          distanceMeters: index * 150,
        })),
      }}
    />
  ),
}
export const PartialMetricCharts: Story = {
  render: () => (
    <ActivityChartsPanel
      data={{
        ...chartsFixture,
        samples: chartsFixture.samples.map((sample) => ({
          ...sample,
          powerWatts: null,
          cadence: null,
        })),
      }}
      sport="CYCLING"
    />
  ),
}
export const PartialDistanceCharts: Story = {
  render: () => (
    <ActivityChartsPanel
      data={{
        ...chartsFixture,
        samples: chartsFixture.samples.map((sample, index) => ({
          ...sample,
          distanceMeters: index % 3 === 0 ? null : sample.distanceMeters,
        })),
      }}
      sport="RUNNING"
    />
  ),
}
export const RecordedRoute: Story = {
  render: () => (
    <div className={styles.overviewGrid}>
      <ActivityRoute samples={chartsFixture.samples} />
      <HeartRateZones seconds={chartsFixture.session.heartRateZoneSeconds} />
    </div>
  ),
}
export const HeartRateDistribution: Story = {
  render: () => <HeartRateZones seconds={chartsFixture.session.heartRateZoneSeconds} />,
}
export const ZoneExplanations: Story = {
  ...HeartRateDistribution,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'About heart rate zones' }))
    await waitFor(() => canvas.getByRole('tooltip'))
  },
}
export const MobileZoneExplanations: Story = { ...ZoneExplanations, globals: Mobile.globals }
export const LongHeartRateDistribution: Story = {
  render: () => <HeartRateZones seconds={[0, 1050, 7707, 10558, 4210]} />,
}
export const SmallZoneSectors: Story = {
  render: () => <HeartRateZones seconds={[0.01, 2, 3, 1100, 1400, 240]} />,
}
export const SingleHeartRateZone: Story = {
  render: () => <HeartRateZones seconds={[0, 0, 600]} />,
}
export const MissingHeartRateZones: Story = {
  render: () => <HeartRateZones seconds={[]} />,
}
export const MissingGPS: Story = {
  render: () => (
    <ActivityRoute
      samples={chartsFixture.samples.map((sample) => ({
        ...sample,
        latitude: null,
        longitude: null,
      }))}
    />
  ),
}
