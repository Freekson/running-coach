import type { WorkoutDefinition, WorkoutStep } from './workout-definition.v1'

export const freeTimeStep: WorkoutStep = {
  type: 'step',
  name: 'Warm up',
  termination: { type: 'time', durationSeconds: 600 },
  target: { type: 'free' },
}

export const nestedIntervalsWorkout: WorkoutDefinition = {
  schemaVersion: 1,
  name: 'Nested intervals',
  sport: 'RUNNING',
  steps: [
    freeTimeStep,
    {
      type: 'repeat',
      count: 2,
      steps: [
        {
          type: 'repeat',
          count: 3,
          steps: [
            {
              type: 'step',
              name: 'Fast interval',
              termination: { type: 'distance', distanceMeters: 400 },
              target: { type: 'pace', minSecondsPerKm: 240, maxSecondsPerKm: 270 },
            },
            {
              type: 'step',
              name: 'Recovery',
              termination: { type: 'time', durationSeconds: 90 },
              target: { type: 'heartRate', minBpm: 100, maxBpm: 140 },
            },
          ],
        },
        {
          type: 'step',
          name: 'Recover until lap press',
          termination: { type: 'lap' },
          target: { type: 'free' },
        },
      ],
    },
  ],
}
