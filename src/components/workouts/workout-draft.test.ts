import { describe, expect, it } from 'vitest'
import {
  WORKOUT_LIMITS,
  type WorkoutDefinition,
  type WorkoutNode,
} from '@/schemas/workout-definition.v1'
import { draftFromDefinition, newStep, validateDraft } from './workout-draft'
import { intervalWorkout, nestedWorkout } from './workout-builder.fixtures'

describe('workout editor contract', () => {
  it.each([intervalWorkout, nestedWorkout])(
    'preserves canonical order, nesting and targets on revision',
    (definition) => {
      const before = structuredClone(definition)
      const result = validateDraft(draftFromDefinition(definition))
      expect(result.success && result.data).toEqual(definition)
      expect(definition).toEqual(before)
    },
  )

  it('preserves unnamed steps, fractional units and all sports', () => {
    const definition: WorkoutDefinition = {
      schemaVersion: 1,
      name: 'Fractional',
      sport: 'SWIMMING',
      steps: [
        {
          type: 'step',
          termination: { type: 'time', durationSeconds: 12.125 },
          target: { type: 'pace', minSecondsPerKm: 321.125, maxSecondsPerKm: 321.125 },
        },
        {
          type: 'step',
          termination: { type: 'distance', distanceMeters: 25.5 },
          target: { type: 'free' },
        },
      ],
    }
    const parsed = validateDraft(draftFromDefinition(definition))
    expect(parsed.success && parsed.data).toEqual(definition)
  })

  it('rejects unsupported targets, unknown fields, versions and excessive nesting', () => {
    for (const input of [
      null,
      { ...intervalWorkout, schemaVersion: 2 },
      { ...intervalWorkout, userId: 'other-user' },
      {
        ...intervalWorkout,
        steps: [
          {
            type: 'step',
            termination: { type: 'lap' },
            target: { type: 'heartRateZone', zone: 2 },
          },
        ],
      },
    ]) {
      expect(() => draftFromDefinition(input)).toThrow()
    }
    let node: WorkoutNode = intervalWorkout.steps[0]
    for (let depth = 0; depth <= WORKOUT_LIMITS.maxRepeatDepth; depth++)
      node = { type: 'repeat', count: 2, steps: [node] }
    expect(() => draftFromDefinition({ ...intervalWorkout, steps: [node] })).toThrow()
  })

  it.each(['', '0', '-1', 'Infinity', 'NaN', '604801'])(
    'refuses invalid time %s with an inline path',
    (durationSeconds) => {
      const result = validateDraft({
        name: 'Invalid',
        sport: 'RUNNING',
        steps: [{ ...newStep('a'), durationSeconds }],
      })
      expect(result.success).toBe(false)
      if (!result.success)
        expect(result.error.issues[0].path).toEqual(['steps', 0, 'termination', 'durationSeconds'])
    },
  )

  it('rejects reversed ranges, fractional HR, repeat counts and empty groups', () => {
    const base = newStep('a')
    const nodes = [
      { ...base, target: 'pace' as const, minSecondsPerKm: '400', maxSecondsPerKm: '300' },
      { ...base, target: 'heartRate' as const, minBpm: '160', maxBpm: '140' },
      { ...base, target: 'heartRate' as const, minBpm: '130.5' },
      { id: 'b', type: 'repeat' as const, count: '2.5', steps: [base] },
      { id: 'b', type: 'repeat' as const, count: '101', steps: [base] },
      { id: 'b', type: 'repeat' as const, count: '2', steps: [] },
    ]
    for (const node of nodes)
      expect(validateDraft({ name: 'Invalid', sport: 'RUNNING', steps: [node] }).success).toBe(
        false,
      )
  })
})
