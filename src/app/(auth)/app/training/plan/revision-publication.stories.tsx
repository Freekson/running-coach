import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import type { ComponentProps } from 'react'
import { RevisionPublication } from './revision-publication'
import { publicationPreviewFixture as preview } from './revision-publication.fixtures'
import { RefreshChanges } from './new/plan-review'

const args: ComponentProps<typeof RevisionPublication> = {
  planId: preview.planId,
  revisionId: preview.revisionId,
  onPreview: async () => ({ success: true, value: preview }),
  onSend: async (input) => ({
    success: true,
    value: {
      id: '00000000-0000-4000-8000-000000000800',
      localWorkoutId: input.workoutId,
      approvedRevisionId: preview.revisionId,
      publishRevision: 2,
      operation: 'UPDATE',
      status: 'PUBLISHED',
      remoteEventId: 1,
      attemptCount: 1,
      errorCode: null,
      publishedAt: '2026-11-15T03:00:00Z',
      garminConnect: 'UNVERIFIED',
      watch: 'UNVERIFIED',
    },
  }),
}
const meta = {
  title: 'Training/Plan publication',
  component: RevisionPublication,
  args,
} satisfies Meta<typeof RevisionPublication>
export default meta
type Story = StoryObj<typeof meta>
export const ReviewAndConfirm: Story = {}
export const UnknownRemoteBaseline: Story = {
  args: {
    onPreview: async () => ({
      success: true,
      value: {
        ...preview,
        changes: [
          {
            ...preview.changes[1],
            before: null,
            baselineStatus: 'unknown',
            remoteStateUncertain: true,
            recovery: { publicationId: '00000000-0000-4000-8000-000000000800', publishRevision: 2 },
          },
        ],
      },
    }),
  },
}
export const ProtectedWorkoutRecovery: Story = {
  args: {
    onPreview: async () => ({
      success: true,
      value: {
        ...preview,
        changes: [
          {
            ...preview.changes[0],
            status: 'UNCERTAIN',
            recoveryOnly: true,
            recovery: { publicationId: '00000000-0000-4000-8000-000000000800', publishRevision: 1 },
          },
        ],
      },
    }),
  },
}
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
}
export const Conflict: Story = {
  args: {
    onSend: async () => ({
      success: false,
      error:
        'The approved revision changed. Reload saved revisions and review the current changes.',
    }),
  },
}
export const UnsupportedWorkout: Story = {
  args: {
    onPreview: async () => ({
      success: true,
      value: {
        ...preview,
        changes: [
          {
            ...preview.changes[1],
            after: {
              ...preview.changes[1].after,
              definition: {
                ...preview.changes[1].after.definition,
                steps: [
                  {
                    type: 'step',
                    termination: { type: 'time', durationSeconds: 1800 },
                    target: { type: 'heartRate', minBpm: 130, maxBpm: 140 },
                  },
                ],
              },
            },
          },
        ],
      },
    }),
    onSend: async () => ({
      success: false,
      error:
        'This workout cannot be published to Intervals.icu. Absolute BPM is not supported by this text adapter. Use an explicitly reviewed pace/free workout or wait for verified absolute-HR delivery; BPM is never converted to zones or percentages. Your approved local revision is preserved. Refresh and explicitly approve a compatible workout before publishing again.',
    }),
  },
}
export const SportOnlyChange: Story = {
  render: () => {
    const workout = preview.changes[1].after
    return (
      <RefreshChanges
        changes={[
          {
            workoutId: workout.workoutId,
            kind: 'changed',
            before: { ...workout, definition: { ...workout.definition, sport: 'RUNNING' } },
            after: { ...workout, definition: { ...workout.definition, sport: 'CYCLING' } },
          },
        ]}
      />
    )
  },
}
