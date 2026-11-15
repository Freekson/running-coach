import {
  Encoder,
  Profile,
  type FileIdMesg,
  type WorkoutMesg,
  type WorkoutStepMesg,
} from '@garmin/fitsdk'
import { expect, it, vi } from 'vitest'
import type { WorkoutDefinition, WorkoutNode } from '@/schemas/workout-definition.v1'
vi.mock('server-only', () => ({}))
import { assertIntervalsWorkoutExport } from './workout-export'
import { intervalsWatchProbe } from './workout-mapping.fixtures'

function exportedFit(
  workout: WorkoutDefinition,
  alter: (steps: WorkoutStepMesg[]) => void = () => {},
) {
  const steps: WorkoutStepMesg[] = []
  function encode(nodes: WorkoutNode[]) {
    for (const node of nodes) {
      if (node.type === 'repeat') {
        const start = steps.length
        encode(node.steps)
        steps.push({
          messageIndex: steps.length,
          durationType: 'repeatUntilStepsCmplt',
          durationValue: start,
          targetValue: node.count,
        })
      } else {
        const target = node.target
        const end = node.termination
        if (target.type === 'heartRate' || end.type === 'lap')
          throw new Error('Unsupported test case')
        steps.push({
          messageIndex: steps.length,
          durationType: end.type,
          durationValue:
            end.type === 'time' ? end.durationSeconds * 1000 : end.distanceMeters * 100,
          targetType: target.type === 'pace' ? 'speed' : 'open',
          ...(target.type === 'pace'
            ? {
                targetValue: 0,
                customTargetValueLow: Math.round(1_000_000 / target.maxSecondsPerKm),
                customTargetValueHigh: Math.round(1_000_000 / target.minSecondsPerKm),
              }
            : {}),
        })
      }
    }
  }
  encode(workout.steps)
  alter(steps)
  const encoder = new Encoder()
  const fileId: FileIdMesg = {
    type: 'workout',
    manufacturer: 'development',
    product: 1,
    timeCreated: new Date('2026-11-15T00:00:00Z'),
  }
  encoder.onMesg(Profile.MesgNum.FILE_ID, fileId)
  const workoutMessage: WorkoutMesg = {
    sport: 'running',
    wktName: 'Synthetic export',
    numValidSteps: steps.length,
  }
  encoder.onMesg(Profile.MesgNum.WORKOUT, workoutMessage)
  for (const step of steps) encoder.onMesg(Profile.MesgNum.WORKOUT_STEP, step)
  return encoder.close()
}

it('checks exact nested execution order and every final recovery in a valid FIT export', () => {
  expect(
    assertIntervalsWorkoutExport(intervalsWatchProbe, exportedFit(intervalsWatchProbe)),
  ).toBeUndefined()
})

it.each([
  [210, 240],
  [240, 270],
  [330, 360],
  [420, 450],
  [300, 300],
])(
  'preserves absolute pace %s–%s seconds/km without a threshold argument',
  (minSecondsPerKm, maxSecondsPerKm) => {
    const workout: WorkoutDefinition = {
      schemaVersion: 1,
      name: 'Pace matrix',
      sport: 'RUNNING',
      steps: [
        {
          type: 'step',
          termination: { type: 'distance', distanceMeters: 400 },
          target: { type: 'pace', minSecondsPerKm, maxSecondsPerKm },
        },
      ],
    }
    expect(assertIntervalsWorkoutExport(workout, exportedFit(workout))).toBeUndefined()
  },
)

it.each([
  (steps: WorkoutStepMesg[]) => {
    steps[1].targetType = 'open'
  },
  (steps: WorkoutStepMesg[]) => {
    steps[1].customTargetValueHigh = 5000
  },
  (steps: WorkoutStepMesg[]) => {
    steps[1].durationValue = 50000
  },
  (steps: WorkoutStepMesg[]) => {
    steps[2].durationValue = 60000
  },
  (steps: WorkoutStepMesg[]) => {
    steps[3].targetValue = 2
  },
  (steps: WorkoutStepMesg[]) => {
    steps[3].durationValue = 99
  },
  (steps: WorkoutStepMesg[]) => {
    steps[2].targetType = 'heartRate'
  },
  (steps: WorkoutStepMesg[]) => {
    steps[0].messageIndex = 9
  },
  (steps: WorkoutStepMesg[]) => {
    steps.pop()
  },
])('blocks lost targets, changed steps/repeats and dropped recoveries: %#', (alter) => {
  expect(() =>
    assertIntervalsWorkoutExport(intervalsWatchProbe, exportedFit(intervalsWatchProbe, alter)),
  ).toThrow(expect.objectContaining({ code: 'PACE_TARGET_LOST' }))
})

it('rejects corrupt, oversized and unrelated binary responses safely', () => {
  for (const bytes of [
    new Uint8Array(),
    new TextEncoder().encode('private provider HTML'),
    new Uint8Array(1024 * 1024 + 1),
  ])
    expect(() => assertIntervalsWorkoutExport(intervalsWatchProbe, bytes)).toThrow(
      expect.objectContaining({ code: 'PACE_TARGET_LOST' }),
    )
})

it('rejects an inverted speed range even when both endpoints are within FIT quantization tolerance', () => {
  const workout: WorkoutDefinition = {
    schemaVersion: 1,
    name: 'Exact pace',
    sport: 'RUNNING',
    steps: [
      {
        type: 'step',
        termination: { type: 'distance', distanceMeters: 400 },
        target: { type: 'pace', minSecondsPerKm: 240, maxSecondsPerKm: 240 },
      },
    ],
  }
  const bytes = exportedFit(workout, (steps) => {
    steps[0].customTargetValueLow = 4168
    steps[0].customTargetValueHigh = 4166
  })
  expect(() => assertIntervalsWorkoutExport(workout, bytes)).toThrow(
    expect.objectContaining({ code: 'PACE_TARGET_LOST' }),
  )
})
