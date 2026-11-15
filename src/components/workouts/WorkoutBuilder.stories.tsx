import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { WorkoutBuilder } from './WorkoutBuilder'
import { intervalWorkout, nestedWorkout } from './workout-builder.fixtures'

const meta = {
  title: 'Training/Workout builder',
  component: WorkoutBuilder,
  decorators: [
    (Story) => (
      <main>
        <h1>Workouts</h1>
        <Story />
      </main>
    ),
  ],
  parameters: { layout: 'padded' },
} satisfies Meta<typeof WorkoutBuilder>
export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}
export const FiveBy1000: Story = { args: { initialDefinition: intervalWorkout } }
export const NestedRepeats: Story = { args: { initialDefinition: nestedWorkout } }
export const Locked: Story = { args: { initialDefinition: intervalWorkout, locked: true } }
export const UnsupportedTarget: Story = {
  args: {
    initialDefinition: {
      ...intervalWorkout,
      steps: [
        { type: 'step', termination: { type: 'lap' }, target: { type: 'power', watts: 200 } },
      ],
    },
  },
}
export const ApplyError: Story = {
  args: {
    initialDefinition: intervalWorkout,
    onApply: async () => {
      throw new Error('Synthetic failure')
    },
  },
}
export const Applying: Story = {
  args: { initialDefinition: intervalWorkout, onApply: () => new Promise<void>(() => {}) },
}
export const Mobile: Story = {
  ...FiveBy1000,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
