import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  WORKOUT_LIMITS,
  workoutDefinitionSchema,
  type WorkoutDefinition,
  type WorkoutNode,
} from './workout-definition.v1'
import { freeTimeStep, nestedIntervalsWorkout } from './workout-definition.v1.fixtures'
import { workoutDefinitionJsonSchema } from './workout-definition.v1.json-schema'

function definitionWith(node: unknown) {
  return { schemaVersion: 1, name: 'Synthetic workout', sport: 'RUNNING', steps: [node] }
}

function nestedRepeats(depth: number): WorkoutNode {
  let node: WorkoutNode = freeTimeStep
  for (let i = 0; i < depth; i++) node = { type: 'repeat', count: 2, steps: [node] }
  return node
}

function expectIssue(input: unknown, path: (string | number)[], code: z.ZodIssue['code']) {
  const result = workoutDefinitionSchema.safeParse(input)
  expect(result.success).toBe(false)
  if (result.success) throw new Error('Expected invalid workout')
  expect(result.error).toBeInstanceOf(z.ZodError)
  expect(result.error.issues).toContainEqual(expect.objectContaining({ code, path }))
}

// An independent interpretation of the fixture's execution order verifies that
// repeats survive serialization without changing counts, targets or endings.
function expand(nodes: WorkoutNode[]): WorkoutNode[] {
  return nodes.flatMap((node) =>
    node.type === 'step'
      ? [node]
      : Array.from({ length: node.count }, () => expand(node.steps)).flat(),
  )
}

describe('WorkoutDefinition v1', () => {
  it('roundtrips nested intervals without mutation or semantic changes', () => {
    const source = JSON.stringify(nestedIntervalsWorkout)
    const parsed = workoutDefinitionSchema.parse(JSON.parse(source))
    const roundtrip = workoutDefinitionSchema.parse(JSON.parse(JSON.stringify(parsed)))
    expect(parsed).toEqual(nestedIntervalsWorkout)
    expect(roundtrip).toEqual(parsed)
    expect(JSON.stringify(nestedIntervalsWorkout)).toBe(source)
    expect(expand(roundtrip.steps)).toEqual([
      freeTimeStep,
      ...Array.from({ length: 2 }, () => [
        ...Array.from({ length: 3 }, () => [
          expect.objectContaining({ name: 'Fast interval' }),
          expect.objectContaining({ name: 'Recovery' }),
        ]).flat(),
        expect.objectContaining({ name: 'Recover until lap press' }),
      ]).flat(),
    ])
  })

  it.each(['RUNNING', 'CYCLING', 'SWIMMING', 'WALKING', 'OTHER'])(
    'accepts provider-neutral sport %s',
    (sport) => {
      expect(workoutDefinitionSchema.safeParse({ ...nestedIntervalsWorkout, sport }).success).toBe(
        true,
      )
    },
  )

  it('preserves fractions, exact targets and all termination/target combinations', () => {
    for (const termination of [
      { type: 'time', durationSeconds: 0.125 },
      { type: 'distance', distanceMeters: 42195.125 },
      { type: 'lap' },
    ]) {
      for (const target of [
        { type: 'free' },
        { type: 'pace', minSecondsPerKm: 250.5, maxSecondsPerKm: 250.5 },
        { type: 'heartRate', minBpm: 150, maxBpm: 150 },
      ]) {
        const input = definitionWith({ type: 'step', termination, target })
        expect(workoutDefinitionSchema.parse(input)).toEqual(input)
      }
    }
  })

  it.each([
    ['schemaVersion', 2],
    ['schemaVersion', '1'],
    ['schemaVersion', undefined],
    ['sport', 'GARMIN_RUNNING'],
    ['name', ''],
    ['name', 'x'.repeat(161)],
  ])('rejects unsupported or invalid %s: %s', (field, value) => {
    expect(
      workoutDefinitionSchema.safeParse({ ...nestedIntervalsWorkout, [field]: value }).success,
    ).toBe(false)
  })

  it.each([
    [{ ...freeTimeStep, type: 'unknown' }, ['type'], 'invalid_union'],
    [
      { ...freeTimeStep, termination: { type: 'minutes', durationSeconds: 10 } },
      ['termination', 'type'],
      'invalid_union',
    ],
    [{ ...freeTimeStep, target: { type: 'power' } }, ['target', 'type'], 'invalid_union'],
    [
      {
        ...freeTimeStep,
        target: { type: 'pace', minSecondsPerKm: 300, maxSecondsPerKm: 250 },
      },
      ['target', 'maxSecondsPerKm'],
      'custom',
    ],
    [
      { ...freeTimeStep, target: { type: 'heartRate', minBpm: 160, maxBpm: 140 } },
      ['target', 'maxBpm'],
      'custom',
    ],
  ] satisfies [unknown, (string | number)[], z.ZodIssue['code']][])(
    'returns typed errors with precise node paths for %o',
    (node, path, code) => expectIssue(definitionWith(node), ['steps', 0, ...path], code),
  )

  it.each([0, -1, NaN, Infinity, -Infinity, '60', null, undefined])(
    'rejects nonpositive, nonfinite and nonnumeric values: %s',
    (value) => {
      for (const termination of [
        { type: 'time', durationSeconds: value },
        { type: 'distance', distanceMeters: value },
      ]) {
        expect(
          workoutDefinitionSchema.safeParse(definitionWith({ ...freeTimeStep, termination }))
            .success,
        ).toBe(false)
      }
      for (const target of [
        { type: 'pace', minSecondsPerKm: value, maxSecondsPerKm: 300 },
        { type: 'pace', minSecondsPerKm: 250, maxSecondsPerKm: value },
        { type: 'heartRate', minBpm: value, maxBpm: 160 },
        { type: 'heartRate', minBpm: 100, maxBpm: value },
      ]) {
        expect(
          workoutDefinitionSchema.safeParse(definitionWith({ ...freeTimeStep, target })).success,
        ).toBe(false)
      }
    },
  )

  it('enforces numeric upper bounds and integer heart rates', () => {
    for (const termination of [
      { type: 'time', durationSeconds: WORKOUT_LIMITS.maxDurationSeconds + 1 },
      { type: 'distance', distanceMeters: WORKOUT_LIMITS.maxDistanceMeters + 1 },
    ]) {
      expect(
        workoutDefinitionSchema.safeParse(definitionWith({ ...freeTimeStep, termination })).success,
      ).toBe(false)
    }
    for (const target of [
      { type: 'pace', minSecondsPerKm: 1, maxSecondsPerKm: WORKOUT_LIMITS.maxPaceSecondsPerKm + 1 },
      { type: 'heartRate', minBpm: 1, maxBpm: WORKOUT_LIMITS.maxHeartRateBpm + 1 },
      { type: 'heartRate', minBpm: 100.5, maxBpm: 150 },
      { type: 'heartRate', minBpm: 100, maxBpm: 150.5 },
    ]) {
      expect(
        workoutDefinitionSchema.safeParse(definitionWith({ ...freeTimeStep, target })).success,
      ).toBe(false)
    }
  })

  it('accepts inclusive upper bounds', () => {
    const input: WorkoutDefinition = {
      ...nestedIntervalsWorkout,
      steps: [
        {
          type: 'repeat',
          count: WORKOUT_LIMITS.maxRepeatCount,
          steps: [
            {
              type: 'step',
              termination: { type: 'time', durationSeconds: WORKOUT_LIMITS.maxDurationSeconds },
              target: {
                type: 'pace',
                minSecondsPerKm: WORKOUT_LIMITS.maxPaceSecondsPerKm,
                maxSecondsPerKm: WORKOUT_LIMITS.maxPaceSecondsPerKm,
              },
            },
            {
              type: 'step',
              termination: { type: 'distance', distanceMeters: WORKOUT_LIMITS.maxDistanceMeters },
              target: {
                type: 'heartRate',
                minBpm: WORKOUT_LIMITS.maxHeartRateBpm,
                maxBpm: WORKOUT_LIMITS.maxHeartRateBpm,
              },
            },
          ],
        },
      ],
    }
    expect(workoutDefinitionSchema.parse(input)).toEqual(input)
  })

  it.each([0, -1, 1.5, 101, Infinity, '2', undefined])('rejects repeat count %s', (count) => {
    expect(
      workoutDefinitionSchema.safeParse(
        definitionWith({ type: 'repeat', count, steps: [freeTimeStep] }),
      ).success,
    ).toBe(false)
  })

  it.each([0, WORKOUT_LIMITS.maxStepsPerGroup + 1])('rejects lists of %s nodes', (count) => {
    const steps = Array.from({ length: count }, () => freeTimeStep)
    expect(workoutDefinitionSchema.safeParse({ ...nestedIntervalsWorkout, steps }).success).toBe(
      false,
    )
    expectIssue(
      definitionWith({ type: 'repeat', count: 2, steps }),
      ['steps', 0, 'steps'],
      count === 0 ? 'too_small' : 'too_big',
    )
  })

  it('accepts maximum list length at root and inside repeats', () => {
    const steps = Array.from({ length: WORKOUT_LIMITS.maxStepsPerGroup }, () => freeTimeStep)
    expect(workoutDefinitionSchema.safeParse({ ...nestedIntervalsWorkout, steps }).success).toBe(
      true,
    )
    expect(
      workoutDefinitionSchema.safeParse(definitionWith({ type: 'repeat', count: 1, steps }))
        .success,
    ).toBe(true)
  })

  it('accepts the exact depth boundary and rejects another repeat with a field path', () => {
    expect(
      workoutDefinitionSchema.safeParse(
        definitionWith(nestedRepeats(WORKOUT_LIMITS.maxRepeatDepth)),
      ).success,
    ).toBe(true)
    expectIssue(
      definitionWith(nestedRepeats(WORKOUT_LIMITS.maxRepeatDepth + 1)),
      ['steps', 0, 'steps', 0, 'steps', 0, 'steps', 0, 'type'],
      'invalid_value',
    )
  })

  it('rejects extreme depth and cyclic objects without overflowing the stack', () => {
    expect(workoutDefinitionSchema.safeParse(definitionWith(nestedRepeats(10_000))).success).toBe(
      false,
    )
    const cyclic: WorkoutNode = { type: 'repeat', count: 2, steps: [] }
    cyclic.steps.push(cyclic)
    expect(workoutDefinitionSchema.safeParse(definitionWith(cyclic)).success).toBe(false)
  })

  it.each(['userId', 'fit', 'garminWorkoutId', 'workout_doc', 'apiKey'])(
    'rejects foreign field %s at every object boundary',
    (key) => {
      expectIssue({ ...nestedIntervalsWorkout, [key]: 'untrusted' }, [], 'unrecognized_keys')
      for (const node of [
        { ...freeTimeStep, [key]: 'untrusted' },
        { type: 'repeat', count: 2, steps: [freeTimeStep], [key]: 'untrusted' },
        { ...freeTimeStep, termination: { ...freeTimeStep.termination, [key]: 'untrusted' } },
        { ...freeTimeStep, target: { ...freeTimeStep.target, [key]: 'untrusted' } },
      ]) {
        expect(workoutDefinitionSchema.safeParse(definitionWith(node)).success).toBe(false)
      }
    },
  )

  it('rejects mixed node/termination/target shapes and malformed roots', () => {
    for (const node of [
      { ...freeTimeStep, count: 2, steps: [freeTimeStep] },
      { type: 'repeat', count: 2, steps: [freeTimeStep], target: { type: 'free' } },
      { ...freeTimeStep, termination: { type: 'lap', durationSeconds: 60 } },
      { ...freeTimeStep, termination: { type: 'distance', durationSeconds: 60 } },
      { ...freeTimeStep, target: { type: 'free', minBpm: 120 } },
      { ...freeTimeStep, target: undefined },
      { ...freeTimeStep, termination: undefined },
      { ...freeTimeStep, name: '' },
      { ...freeTimeStep, name: 'x'.repeat(161) },
      null,
    ]) {
      expect(workoutDefinitionSchema.safeParse(definitionWith(node)).success).toBe(false)
    }
    for (const input of [null, [], 'workout', {}, { ...nestedIntervalsWorkout, steps: null }]) {
      expect(workoutDefinitionSchema.safeParse(input).success).toBe(false)
    }
    expect(() => workoutDefinitionSchema.parse(null)).toThrow(z.ZodError)
  })
})

describe('generated WorkoutDefinition JSON Schema', () => {
  const schema = z.fromJSONSchema(JSON.parse(JSON.stringify(workoutDefinitionJsonSchema)))

  it('is serializable Draft 2020-12 generated from the canonical schema', () => {
    expect(workoutDefinitionJsonSchema).toMatchObject({
      ...z.toJSONSchema(workoutDefinitionSchema, { target: 'draft-2020-12', reused: 'ref' }),
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'WorkoutDefinition v1',
      additionalProperties: false,
    })
    expect(schema.parse(nestedIntervalsWorkout)).toEqual(nestedIntervalsWorkout)
  })

  it('carries structural bounds, strict objects, versions, enums and units', () => {
    for (const input of [
      { ...nestedIntervalsWorkout, schemaVersion: 2 },
      { ...nestedIntervalsWorkout, sport: 'GARMIN_RUNNING' },
      { ...nestedIntervalsWorkout, garminWorkoutId: 123 },
      { ...nestedIntervalsWorkout, steps: [] },
      definitionWith(nestedRepeats(WORKOUT_LIMITS.maxRepeatDepth + 1)),
      definitionWith({ type: 'repeat', count: 0, steps: [freeTimeStep] }),
      definitionWith({ type: 'repeat', count: 2.5, steps: [freeTimeStep] }),
      definitionWith({ ...freeTimeStep, termination: { type: 'time', durationSeconds: 0 } }),
      definitionWith({ ...freeTimeStep, termination: { type: 'distance', distanceMeters: -1 } }),
      definitionWith({ ...freeTimeStep, termination: { type: 'lap', durationSeconds: 60 } }),
      definitionWith({ ...freeTimeStep, termination: { type: 'time', durationMinutes: 10 } }),
      definitionWith({ ...freeTimeStep, target: { type: 'heartRate', minBpm: 100, maxBpm: 301 } }),
    ]) {
      expect(schema.safeParse(input).success).toBe(false)
    }
    expect(
      schema.safeParse(definitionWith(nestedRepeats(WORKOUT_LIMITS.maxRepeatDepth))).success,
    ).toBe(true)
  })

  it('explicitly documents semantic range checks that require Zod', () => {
    expect(workoutDefinitionJsonSchema.$comment).toContain('minSecondsPerKm <= maxSecondsPerKm')
    expect(workoutDefinitionJsonSchema.$comment).toContain('minBpm <= maxBpm')
    const reversedRange = definitionWith({
      ...freeTimeStep,
      target: { type: 'pace', minSecondsPerKm: 300, maxSecondsPerKm: 250 },
    })
    expect(schema.safeParse(reversedRange).success).toBe(true)
    expect(workoutDefinitionSchema.safeParse(reversedRange).success).toBe(false)
  })
})
