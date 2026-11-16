import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ActivityMatching } from './activity-matching'
import { matchingFixture } from './activity-matching.fixtures'
import type { MatchingResult } from '@/lib/activity-matching'

const meta = {
  title: 'Training/Activity matching',
  component: ActivityMatching,
  args: {
    data: matchingFixture(),
    onLink: async (): Promise<MatchingResult> => ({ success: true, data: undefined }),
    onUnlink: async (): Promise<MatchingResult> => ({ success: true, data: undefined }),
    onReload: () => {},
    onSearch: () => {},
  },
} satisfies Meta<typeof ActivityMatching>
export default meta
type Story = StoryObj<typeof meta>
export const Suggested: Story = {}
const ambiguous = matchingFixture()
ambiguous.ambiguous = true
ambiguous.suggestionWorkoutId = null
ambiguous.candidates.push({
  ...ambiguous.candidates[0],
  workoutId: '10000000-0000-4000-8000-000000000005',
  name: 'Second plausible run',
})
export const Ambiguous: Story = { args: { data: ambiguous } }
const linked = matchingFixture()
linked.linked = { workoutId: linked.candidates[0].workoutId, comparison: linked.candidates[0] }
linked.candidates = []
linked.suggestionWorkoutId = null
export const Linked: Story = { args: { data: linked } }
export const Duplicate: Story = {
  args: {
    data: {
      ...matchingFixture(),
      suggestionWorkoutId: null,
      duplicateCount: 2,
      duplicateLinked: true,
      linkedDuplicates: [
        {
          activityId: '10000000-0000-4000-8000-000000000006',
          workoutId: '10000000-0000-4000-8000-000000000007',
          title: 'Legacy matched run',
          provider: 'INTERVALS',
        },
      ],
    },
  },
}
export const Empty: Story = {
  args: { data: { ...matchingFixture(), candidates: [], suggestionWorkoutId: null, laps: [] } },
}
export const Failure: Story = {
  args: {
    onLink: async () => ({ success: false, error: 'The plan changed. Reload before continuing.' }),
  },
}
export const Refreshing: Story = { args: { refreshing: true } }
export const Mobile: Story = {
  args: { data: linked },
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
}
const speedOnly = matchingFixture()
speedOnly.actual = {
  ...speedOnly.actual,
  durationSeconds: null,
  durationBasis: 'unavailable',
  paceSecondsPerKm: 333.33,
  paceBasis: 'recorded-speed',
}
speedOnly.laps[0] = {
  ...speedOnly.laps[0],
  durationSeconds: null,
  paceSecondsPerKm: 250,
  paceBasis: 'recorded-speed',
}
export const RecordedSpeed: Story = { args: { data: speedOnly } }
