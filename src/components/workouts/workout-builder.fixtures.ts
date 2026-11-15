import type { WorkoutDefinition } from '@/schemas/workout-definition.v1'

export const intervalWorkout: WorkoutDefinition = {
  schemaVersion: 1,
  name: '5 × 1000 m with recoveries',
  sport: 'RUNNING',
  steps: [
    {
      type: 'step',
      name: 'Warmup',
      termination: { type: 'time', durationSeconds: 600 },
      target: { type: 'free' },
    },
    {
      type: 'repeat',
      count: 5,
      steps: [
        {
          type: 'step',
          name: 'Work',
          termination: { type: 'distance', distanceMeters: 1000 },
          target: { type: 'pace', minSecondsPerKm: 240, maxSecondsPerKm: 270 },
        },
        {
          type: 'step',
          name: 'Recovery',
          termination: { type: 'time', durationSeconds: 120 },
          target: { type: 'free' },
        },
      ],
    },
    {
      type: 'step',
      name: 'Cooldown',
      termination: { type: 'time', durationSeconds: 600 },
      target: { type: 'free' },
    },
  ],
}

export const nestedWorkout: WorkoutDefinition = {
  ...intervalWorkout,
  name: 'Nested intervals and lap cooldown',
  steps: [
    intervalWorkout.steps[0],
    { type: 'repeat', count: 2, steps: [intervalWorkout.steps[1]] },
    {
      type: 'step',
      name: 'Cooldown',
      termination: { type: 'lap' },
      target: { type: 'heartRate', minBpm: 120, maxBpm: 140 },
    },
  ],
}
