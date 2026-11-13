import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { fn } from 'storybook/test'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { incrementalStreamIds } from '@/lib/garmin-incremental-sync'
import { GarminSyncPanel } from './garmin-sync-panel'

const meta = {
  title: 'Dashboard/Garmin sync',
  component: GarminSyncPanel,
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
          bfcacheId: 'dashboard-sync-story',
        }}
      >
        <Story />
      </AppRouterContext.Provider>
    ),
  ],
  args: {
    asOfInstant: '2026-11-13T10:00:00Z',
    initial: {
      connection: 'connected',
      streams: incrementalStreamIds.map((streamId) => ({
        streamId,
        status: 'idle',
        reason: null,
        lastSuccessAt: null,
        retryAt: null,
      })),
    },
  },
} satisfies Meta<typeof GarminSyncPanel>
export default meta
type Story = StoryObj<typeof meta>
export const Ready: Story = {}
export const ActivityIncomplete: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      streams: meta.args.initial.streams.map((stream) => ({
        ...stream,
        status: stream.streamId === 'activities' ? 'skipped' : 'completed',
        reason: stream.streamId === 'activities' ? 'REQUEST_BUDGET' : null,
        lastSuccessAt: stream.streamId === 'activities' ? null : '2026-11-13T09:51:00Z',
      })),
    },
  },
}
export const Incomplete: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      streams: meta.args.initial.streams.map((stream) => ({
        ...stream,
        status: 'skipped',
        reason: 'REQUEST_BUDGET',
      })),
    },
  },
}
export const UpToDate: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      streams: meta.args.initial.streams.map((stream) => ({
        ...stream,
        status: 'completed',
        lastSuccessAt: '2026-11-13T09:51:00Z',
      })),
    },
  },
}
export const ImportRequired: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      streams: meta.args.initial.streams.map((s) => ({
        ...s,
        status: 'skipped',
        reason: 'INITIAL_IMPORT_REQUIRED',
      })),
    },
  },
}
export const PartialSuccess: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      streams: meta.args.initial.streams.map((s) => ({
        ...s,
        status: s.streamId === 'sleep' ? 'failed' : 'completed',
        reason: s.streamId === 'sleep' ? 'SYNC_FAILED' : null,
        lastSuccessAt: s.streamId === 'sleep' ? null : '2026-11-13T06:00:00Z',
      })),
    },
  },
}
export const RateLimited: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      streams: meta.args.initial.streams.map((s) => ({
        ...s,
        status: 'rate_limited',
        reason: 'BACKOFF',
        retryAt: new Date(Date.now() + 3_600_000).toISOString(),
      })),
    },
  },
}
export const Disconnected: Story = {
  args: {
    initial: {
      connection: 'disconnected',
      streams: meta.args.initial.streams.map((s) => ({
        ...s,
        status: 'skipped',
        reason: 'NOT_CONNECTED',
      })),
    },
  },
}
export const ReadFailure: Story = { args: { initial: null } }
export const TwoFailed: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      streams: meta.args.initial.streams.map((stream) => ({
        ...stream,
        status: stream.streamId === 'sleep' ? 'completed' : 'failed',
        reason: stream.streamId === 'sleep' ? null : 'SYNC_FAILED',
        lastSuccessAt: '2026-11-13T09:51:00Z',
      })),
    },
  },
}
export const OneSyncing: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      busy: true,
      streams: meta.args.initial.streams.map((stream) => ({
        ...stream,
        status: stream.streamId === 'daily_summary' ? 'syncing' : 'completed',
        lastSuccessAt: '2026-11-13T09:51:00Z',
      })),
    },
  },
}
export const Outdated: Story = {
  args: {
    initial: {
      ...meta.args.initial,
      streams: meta.args.initial.streams.map((stream) => ({
        ...stream,
        status: 'completed',
        lastSuccessAt: '2026-11-10T09:51:00Z',
      })),
    },
  },
}
