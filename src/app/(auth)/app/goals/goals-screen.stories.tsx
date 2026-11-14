import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { GoalsScreen } from './goals-screen'
import type { GoalView } from './goal-view'

const examples: GoalView[] = [
  {
    id: 'track',
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
              ? previous.map((goal) => (goal.id === id ? { ...goal, ...fields } : goal))
              : [...previous, { ...fields, id: crypto.randomUUID(), archived: false }],
          )
        }}
        onArchive={async (id, archived) => {
          setGoals((previous) =>
            previous.map((goal) => (goal.id === id ? { ...goal, archived } : goal)),
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
          'RUN-32 design preview with synthetic goals. Changes remain in Storybook memory; no persistence or plan constraints UI is connected.',
      },
    },
  },
} satisfies Meta<typeof GoalsPreview>

export default meta
type Story = StoryObj<typeof meta>
export const ActiveGoals: Story = {}
export const CreateGoal: Story = { args: { initialDialog: 'create' } }
export const Empty: Story = { args: { initialGoals: [] } }
export const AllGoalTypes: Story = {
  args: {
    initialGoals: [
      ...examples,
      {
        ...examples[0],
        id: 'consistency',
        name: 'Build a regular running habit',
        type: 'CONSISTENCY',
        distanceKm: '',
        targetTime: '',
        surface: 'ANY',
        sessionsPerWeek: '4',
      },
    ],
  },
}
export const SaveError: Story = { args: { initialDialog: 'create', saveState: 'error' } }
export const Saving: Story = { args: { initialDialog: 'create', saveState: 'pending' } }
export const Mobile: Story = { globals: { viewport: { value: 'mobile1', isRotated: false } } }
export const MobileCreateGoal: Story = { ...Mobile, args: { initialDialog: 'create' } }
