import { expect, it } from 'vitest'
import type { WorkoutDefinition } from '@/schemas/workout-definition.v1'
import { estimateWorkout, formatDuration, formatEstimate } from './workout-estimate'

const workout: WorkoutDefinition = {
  schemaVersion: 1,
  name: 'Synthetic intervals',
  sport: 'RUNNING',
  steps: [
    {
      type: 'repeat',
      count: 5,
      steps: [
        {
          type: 'step',
          termination: { type: 'distance', distanceMeters: 1000 },
          target: { type: 'pace', minSecondsPerKm: 240, maxSecondsPerKm: 270 },
        },
        {
          type: 'step',
          termination: { type: 'time', durationSeconds: 120 },
          target: { type: 'free' },
        },
      ],
    },
  ],
}

it('counts the final recovery, estimates time ranges and keeps unknown distance explicit', () => {
  const estimate = estimateWorkout(workout)
  expect(estimate).toEqual({
    durationSeconds: { min: 1800, max: 1950, incomplete: false },
    distanceMeters: { min: 5000, max: 5000, incomplete: true },
    stepCount: 10,
  })
  expect(formatEstimate(estimate.durationSeconds, 'time')).toBe('30:00–32:30')
  expect(formatEstimate(estimate.distanceMeters, 'distance')).toBe('5 km + unknown')
})

it('uses inverse pace bounds for time-ended steps and scales nested repeats', () => {
  const estimate = estimateWorkout({
    ...workout,
    steps: [
      {
        type: 'repeat',
        count: 3,
        steps: [
          {
            type: 'repeat',
            count: 2,
            steps: [
              {
                type: 'step',
                termination: { type: 'time', durationSeconds: 600 },
                target: { type: 'pace', minSecondsPerKm: 300, maxSecondsPerKm: 600 },
              },
            ],
          },
        ],
      },
    ],
  })
  expect(estimate).toEqual({
    durationSeconds: { min: 3600, max: 3600, incomplete: false },
    distanceMeters: { min: 6000, max: 12000, incomplete: false },
    stepCount: 6,
  })
  expect(formatEstimate(estimate.durationSeconds, 'time')).toBe('1:00:00')
})

it('does not invent speed from HR, free distance or lap steps', () => {
  const estimate = estimateWorkout({
    ...workout,
    steps: [
      {
        type: 'step',
        termination: { type: 'lap' },
        target: { type: 'pace', minSecondsPerKm: 300, maxSecondsPerKm: 330 },
      },
      {
        type: 'step',
        termination: { type: 'distance', distanceMeters: 1000 },
        target: { type: 'heartRate', minBpm: 130, maxBpm: 140 },
      },
    ],
  })
  expect(formatEstimate(estimate.durationSeconds, 'time')).toBe('Unknown')
  expect(formatEstimate(estimate.distanceMeters, 'distance')).toBe('1 km + unknown')
  expect(formatDuration(3599.9)).toBe('1:00:00')
})

it('aggregates maximum repeat nesting without expanding leaf steps', () => {
  let steps = workout.steps
  steps = [{ type: 'repeat', count: 100, steps: [{ type: 'repeat', count: 100, steps }] }]
  expect(estimateWorkout({ ...workout, steps }).stepCount).toBe(100000)
})

it('reports unknown when finite canonical values overflow derived estimates', () => {
  const estimate = estimateWorkout({
    ...workout,
    steps: [
      {
        type: 'step',
        termination: { type: 'time', durationSeconds: 600 },
        target: {
          type: 'pace',
          minSecondsPerKm: Number.MIN_VALUE,
          maxSecondsPerKm: Number.MIN_VALUE,
        },
      },
    ],
  })
  expect(formatEstimate(estimate.distanceMeters, 'distance')).toBe('Unknown')
})
