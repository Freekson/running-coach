import { randomUUID } from 'node:crypto'
import type { PlanConstraints } from '@/lib/plan-constraints'
import type { WorkoutDefinition } from '@/schemas/workout-definition.v1'
import type { PlanContent } from './content'

export const constraintsFixture: PlanConstraints = {
  sessionsPerWeek: 3,
  availableWeekdays: [0, 1, 2, 3, 4, 5, 6],
  maxSessionMinutes: 90,
  startDate: '2090-01-01',
  timezone: 'UTC',
}

export const definitionFixture: WorkoutDefinition = {
  schemaVersion: 1,
  name: 'Synthetic easy session',
  sport: 'RUNNING',
  steps: [
    {
      type: 'step',
      termination: { type: 'time', durationSeconds: 1800 },
      target: { type: 'free' },
    },
  ],
}

export function contentFixture(): PlanContent {
  return {
    schemaVersion: 1,
    macroPlan: {
      startDate: '2090-01-01',
      endDate: '2090-03-31',
      strategy: 'Synthetic base and progression',
      phases: [
        {
          startDate: '2090-01-01',
          endDate: '2090-03-31',
          label: 'Base',
          notes: 'Gradual progression',
        },
      ],
    },
    detailWindow: { startDate: '2090-01-01', endDate: '2090-01-28' },
    workouts: [
      {
        workoutId: randomUUID(),
        scheduledDate: '2090-01-05',
        definition: structuredClone(definitionFixture),
        cancelled: false,
      },
    ],
  }
}
