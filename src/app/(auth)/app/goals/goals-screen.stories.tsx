import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { GoalsScreen } from './goals-screen'
import type { GoalView } from './goal-view'
import type { GoalProgress } from '@/lib/goal-progress'

const progress: GoalProgress = {
  status: 'ACTIVE',
  timezone: 'Europe/Kyiv',
  from: null,
  through: '2026-11-14',
  daysRemaining: 121,
  distanceMeters: 0,
  elevationGainM: 0,
  runCount: 0,
  surfaceUnknownRunCount: 0,
  bestTimeSeconds: null,
  percent: null,
  achieved: false,
  planCoverage: 'UNAVAILABLE',
}

const examples: GoalView[] = [
  {
    id: 'track',
    progress: { ...progress, bestTimeSeconds: 635 },
    measurementWindow: 'WEEK',
    name: '3000 m personal best',
    type: 'PERFORMANCE',
    distanceKm: '3',
    targetTime: '00:10:00',
    targetDate: '2027-03-15',
    surface: 'TRACK',
    elevationGainM: '',
    sessionsPerWeek: '',
    archived: false,
  },
  {
    id: 'marathon',
    progress: { ...progress, daysRemaining: 218 },
    measurementWindow: 'WEEK',
    name: 'Finish my first marathon',
    type: 'COMPLETION',
    distanceKm: '42.195',
    targetTime: '',
    targetDate: '2027-06-20',
    surface: 'ROAD',
    elevationGainM: '',
    sessionsPerWeek: '',
    archived: false,
  },
  {
    id: 'volume',
    progress: {
      ...progress,
      from: '2026-11-01',
      daysRemaining: 78,
      distanceMeters: 68400,
      percent: 68,
    },
    measurementWindow: 'MONTH',
    name: 'Run 100 km in one month',
    type: 'VOLUME',
    distanceKm: '100',
    targetTime: '',
    targetDate: '2027-01-31',
    surface: 'ANY',
    elevationGainM: '',
    sessionsPerWeek: '',
    archived: false,
  },
  {
    id: 'archived',
    progress: { ...progress, status: 'ARCHIVED', daysRemaining: -34 },
    measurementWindow: 'WEEK',
    name: 'Finish a trail ultra',
    type: 'COMPLETION',
    distanceKm: '83.5',
    targetTime: '',
    targetDate: '2026-10-11',
    surface: 'TRAIL',
    elevationGainM: '2400',
    sessionsPerWeek: '',
    archived: true,
  },
  {
    id: 'consistency',
    measurementWindow: 'WEEK',
    name: 'Run 4 times per week',
    type: 'CONSISTENCY',
    distanceKm: '',
    targetTime: '',
    targetDate: '',
    surface: 'ANY',
    elevationGainM: '',
    sessionsPerWeek: '4',
    archived: false,
    progress: { ...progress, from: '2026-11-09', runCount: 3, percent: 75, daysRemaining: null },
  },
  {
    id: 'overdue',
    measurementWindow: 'WEEK',
    name: 'Finish a 17.3 km trail run',
    type: 'COMPLETION',
    distanceKm: '17.3',
    targetTime: '',
    targetDate: '2026-11-10',
    surface: 'TRAIL',
    elevationGainM: '',
    sessionsPerWeek: '',
    archived: false,
    progress: { ...progress, status: 'OVERDUE', daysRemaining: -4, through: '2026-11-10' },
  },
  {
    id: 'achieved',
    measurementWindow: 'WEEK',
    name: 'Finish a 12.7 km run',
    type: 'COMPLETION',
    distanceKm: '12.7',
    targetTime: '',
    targetDate: '',
    surface: 'ANY',
    elevationGainM: '',
    sessionsPerWeek: '',
    archived: false,
    progress: { ...progress, status: 'ACHIEVED', daysRemaining: null, achieved: true },
  },
]

function GoalsPreview({
  initialGoals = examples,
  initialDialog,
  saveState = 'success',
}: {
  initialGoals?: GoalView[]
  initialDialog?: 'create'
  saveState?: 'success' | 'error' | 'pending'
}) {
  const [goals, setGoals] = useState(initialGoals)
  return (
    <div style={{ padding: 'clamp(16px, 3vw, 32px)' }}>
      <GoalsScreen
        goals={goals}
        initialDialog={initialDialog}
        onSave={async (fields, id) => {
          if (saveState === 'error') throw new Error('Synthetic save failure')
          if (saveState === 'pending') await new Promise<void>(() => {})
          setGoals((previous) =>
            id
              ? previous.map((goal) =>
                  goal.id === id ? { ...goal, ...fields, progress: undefined } : goal,
                )
              : [...previous, { ...fields, id: crypto.randomUUID(), archived: false }],
          )
        }}
        onArchive={async (id, archived) => {
          setGoals((previous) =>
            previous.map((goal) =>
              goal.id === id
                ? {
                    ...goal,
                    archived,
                    progress: goal.progress
                      ? {
                          ...goal.progress,
                          status: archived
                            ? 'ARCHIVED'
                            : goal.progress.achieved
                              ? 'ACHIEVED'
                              : (goal.progress.daysRemaining ?? 0) < 0
                                ? 'OVERDUE'
                                : 'ACTIVE',
                        }
                      : undefined,
                  }
                : goal,
            ),
          )
        }}
        onDelete={async (id) => setGoals((previous) => previous.filter((goal) => goal.id !== id))}
      />
    </div>
  )
}

const meta = {
  title: 'Training/Goals',
  component: GoalsPreview,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'RUN-45 progress preview with synthetic goals in all four types and statuses. Use the tabs to inspect achieved and archived goals. Changes remain in Storybook memory; edited and new goals show progress unavailable until recalculated by the real server.',
      },
    },
  },
} satisfies Meta<typeof GoalsPreview>

export default meta
type Story = StoryObj<typeof meta>
export const ActiveGoals: Story = {}
export const CreateGoal: Story = { args: { initialDialog: 'create' } }
export const Empty: Story = { args: { initialGoals: [] } }
export const AllGoalTypes: Story = {}
export const UnknownSurface: Story = {
  args: {
    initialGoals: [{ ...examples[0], progress: { ...progress, surfaceUnknownRunCount: 6 } }],
  },
}
export const DueToday: Story = {
  args: {
    initialGoals: [
      { ...examples[0], targetDate: '2026-11-14', progress: { ...progress, daysRemaining: 0 } },
    ],
  },
}
export const ProgressUnavailable: Story = {
  args: { initialGoals: [{ ...examples[0], progress: undefined }] },
}
export const SaveError: Story = { args: { initialDialog: 'create', saveState: 'error' } }
export const Saving: Story = { args: { initialDialog: 'create', saveState: 'pending' } }
export const Mobile: Story = { globals: { viewport: { value: 'mobile1', isRotated: false } } }
export const MobileCreateGoal: Story = { ...Mobile, args: { initialDialog: 'create' } }
