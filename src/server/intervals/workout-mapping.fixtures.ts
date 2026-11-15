import type { WorkoutDefinition } from '@/schemas/workout-definition.v1'

// Synthetic delivery probe. HR and lap-only steps have separate rejection cases.
export const intervalsWatchProbe: WorkoutDefinition = {
  schemaVersion: 1,
  name: 'Running Coach delivery probe',
  sport: 'RUNNING',
  steps: [
    {
      type: 'step',
      name: 'Warm up',
      termination: { type: 'time', durationSeconds: 600 },
      target: { type: 'free' },
    },
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
              target: { type: 'free' },
            },
          ],
        },
        {
          type: 'step',
          name: 'Set recovery',
          termination: { type: 'time', durationSeconds: 180 },
          target: { type: 'free' },
        },
      ],
    },
    {
      type: 'step',
      name: 'Cool down',
      termination: { type: 'time', durationSeconds: 300 },
      target: { type: 'free' },
    },
  ],
}

// Exercises absolute targets on both sides of the version-1 5:00/km reference.
export const intervalsPaceReferenceProbe: WorkoutDefinition = {
  schemaVersion: 1,
  name: 'Running Coach reference probe',
  sport: 'RUNNING',
  steps: [
    {
      type: 'step',
      name: 'Warm up',
      termination: { type: 'time', durationSeconds: 60 },
      target: { type: 'free' },
    },
    {
      type: 'repeat',
      count: 2,
      steps: [
        {
          type: 'repeat',
          count: 2,
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
              termination: { type: 'time', durationSeconds: 30 },
              target: { type: 'free' },
            },
            {
              type: 'step',
              name: 'Steady interval',
              termination: { type: 'time', durationSeconds: 60 },
              target: { type: 'pace', minSecondsPerKm: 330, maxSecondsPerKm: 360 },
            },
            {
              type: 'step',
              name: 'Recovery',
              termination: { type: 'time', durationSeconds: 30 },
              target: { type: 'free' },
            },
          ],
        },
        {
          type: 'step',
          name: 'Set recovery',
          termination: { type: 'time', durationSeconds: 60 },
          target: { type: 'free' },
        },
      ],
    },
    {
      type: 'step',
      name: 'Cool down',
      termination: { type: 'time', durationSeconds: 60 },
      target: { type: 'free' },
    },
  ],
}
