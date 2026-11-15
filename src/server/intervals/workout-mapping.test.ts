import { describe, expect, it, vi } from 'vitest'
import type { WorkoutDefinition, WorkoutStep } from '@/schemas/workout-definition.v1'
import { freeTimeStep, nestedIntervalsWorkout } from '@/schemas/workout-definition.v1.fixtures'
import probePayload from '../../../docs/fixtures/intervals-workout-probe.json'

vi.mock('server-only', () => ({}))
import {
  assertIntervalsWorkoutConfiguration,
  IntervalsWorkoutMappingError,
  mapWorkoutToIntervals,
} from './workout-mapping'
import { intervalsWatchProbe } from './workout-mapping.fixtures'

const schedule = { localDate: '2026-11-15', timeZone: 'Asia/Tokyo' }
const externalId = 'running-coach:poc:synthetic-session'
const workout: WorkoutDefinition = {
  schemaVersion: 1,
  name: 'Synthetic easy run',
  sport: 'RUNNING',
  steps: [freeTimeStep],
}

function mapStep(step: WorkoutStep) {
  return mapWorkoutToIntervals({ workout: { ...workout, steps: [step] }, schedule, externalId })
}

function expectIssue(input: unknown, code: string, path?: (string | number)[]) {
  try {
    mapWorkoutToIntervals(input)
    expect.fail('Expected mapping to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(IntervalsWorkoutMappingError)
    if (!(error instanceof IntervalsWorkoutMappingError)) throw error
    expect(error.issues).toContainEqual(
      expect.objectContaining({ code, ...(path ? { path } : {}) }),
    )
    expect(error.issues[0].message.length).toBeGreaterThan(20)
  }
}

it('produces only supported calendar fields and makes no publication or delivery claim', () => {
  const fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    expect(mapWorkoutToIntervals({ workout, schedule, externalId })).toEqual({
      event: {
        category: 'WORKOUT',
        type: 'Run',
        target: 'PACE',
        name: 'Synthetic easy run',
        description: '- Warm up 600s',
        start_date_local: '2026-11-15T00:00:00',
        external_id: externalId,
      },
      schedule,
      requirements: { runPaceConfiguration: false },
      warnings: [],
      delivery: { intervals: 'NOT_PUBLISHED', garminConnect: 'UNVERIFIED', watch: 'UNVERIFIED' },
    })
    expect(fetcher).not.toHaveBeenCalled()
  } finally {
    fetcher.mockRestore()
  }
})

it('maps distance in meters and pace slow-to-fast with explicit /km units', () => {
  expect(
    mapStep({
      type: 'step',
      termination: { type: 'distance', distanceMeters: 400 },
      target: { type: 'pace', minSecondsPerKm: 240, maxSecondsPerKm: 270 },
    }).event.description,
  ).toBe('- 400mtr 4:30-4:00/km Pace')
  expect(
    mapStep({
      type: 'step',
      termination: { type: 'time', durationSeconds: 65 },
      target: { type: 'pace', minSecondsPerKm: 305, maxSecondsPerKm: 305 },
    }).event.description,
  ).toBe('- 65s 5:05/km Pace')
})

it('keeps repeat counts and the final recovery, and ends the block before cooldown', () => {
  const repeated = {
    ...workout,
    steps: [
      { type: 'repeat', count: 3, steps: [freeTimeStep, { ...freeTimeStep, name: 'Recovery' }] },
      { ...freeTimeStep, name: 'Cool down' },
    ],
  }
  expect(mapWorkoutToIntervals({ workout: repeated, schedule, externalId }).event.description).toBe(
    '3x\n- Warm up 600s\n- Recovery 600s\n\n- Cool down 600s',
  )
})

it('requires an explicit choice to expand nested groups', () => {
  expectIssue(
    { workout: intervalsWatchProbe, schedule, externalId },
    'NESTED_REPEATS_REQUIRE_EXPANSION',
    ['workout', 'steps', 1],
  )
})

it('expands the synthetic watch probe without dropping or reordering intervals/recoveries', () => {
  const original = structuredClone(intervalsWatchProbe)
  const result = mapWorkoutToIntervals({
    workout: intervalsWatchProbe,
    schedule,
    externalId,
    expandNestedRepeats: true,
  })
  expect([result.event]).toEqual(probePayload)
  expect(result.requirements.runPaceConfiguration).toBe(true)
  expect(result.event.description).toBe(
    [
      '- Warm up 600s',
      '3x\n- Fast interval 400mtr 4:30-4:00/km Pace\n- Recovery 90s',
      '- Set recovery 180s',
      '3x\n- Fast interval 400mtr 4:30-4:00/km Pace\n- Recovery 90s',
      '- Set recovery 180s',
      '- Cool down 300s',
    ].join('\n\n'),
  )
  expect(result.warnings).toEqual([expect.objectContaining({ code: 'NESTED_REPEATS_EXPANDED' })])
  expect(intervalsWatchProbe).toEqual(original)
})

it('expands all three allowed repeat levels in execution order', () => {
  const nested = {
    ...workout,
    steps: [
      {
        type: 'repeat',
        count: 2,
        steps: [
          {
            type: 'repeat',
            count: 2,
            steps: [{ type: 'repeat', count: 3, steps: [freeTimeStep] }],
          },
        ],
      },
    ],
  }
  const result = mapWorkoutToIntervals({
    workout: nested,
    schedule,
    externalId,
    expandNestedRepeats: true,
  })
  expect(result.event.description).toBe(Array(4).fill('3x\n- Warm up 600s').join('\n\n'))
})

describe('actionable compatibility errors', () => {
  it('refuses the canonical all-capabilities fixture instead of losing BPM or lap semantics', () => {
    expectIssue(
      { workout: nestedIntervalsWorkout, schedule, externalId, expandNestedRepeats: true },
      'UNSUPPORTED_HEART_RATE',
      ['workout', 'steps', 1, 'steps', 0, 'steps', 1, 'target'],
    )
  })

  it.each([
    { ...freeTimeStep, target: { type: 'heartRate', minBpm: 130, maxBpm: 140 } },
    { ...freeTimeStep, target: { type: 'heartRate', minBpm: 130, maxBpm: 130 } },
  ])('never invents an HR zone or percentage from absolute BPM', (step) => {
    expectIssue(
      { workout: { ...workout, steps: [step] }, schedule, externalId },
      'UNSUPPORTED_HEART_RATE',
      ['workout', 'steps', 0, 'target'],
    )
  })

  it('never invents a duration for lap-only termination', () => {
    expectIssue(
      {
        workout: { ...workout, steps: [{ ...freeTimeStep, termination: { type: 'lap' } }] },
        schedule,
        externalId,
      },
      'UNSUPPORTED_LAP',
      ['workout', 'steps', 0, 'termination'],
    )
  })

  it.each([
    { ...freeTimeStep, termination: { type: 'time', durationSeconds: 30.5 } },
    { ...freeTimeStep, termination: { type: 'distance', distanceMeters: 400.5 } },
    { ...freeTimeStep, target: { type: 'pace', minSecondsPerKm: 240.5, maxSecondsPerKm: 270 } },
    { ...freeTimeStep, target: { type: 'pace', minSecondsPerKm: 240, maxSecondsPerKm: 270.5 } },
  ])('rejects precision the adapter has not verified instead of rounding', (step) => {
    expectIssue(
      { workout: { ...workout, steps: [step] }, schedule, externalId },
      'UNSUPPORTED_PRECISION',
    )
  })

  it.each(['CYCLING', 'SWIMMING', 'WALKING', 'OTHER'])('does not coerce %s to Run', (sport) => {
    expectIssue({ workout: { ...workout, sport }, schedule, externalId }, 'UNSUPPORTED_SPORT', [
      'workout',
      'sport',
    ])
  })

  it.each([
    'Attack\n- 1s 200%',
    'Z2',
    'Press lap',
    'ramp',
    'free',
    'pace',
    '90 rpm',
    'Run intensity=rest',
  ])('prevents cues from injecting provider syntax: %s', (name) => {
    expectIssue(
      { workout: { ...workout, steps: [{ ...freeTimeStep, name }] }, schedule, externalId },
      'UNSUPPORTED_CUE',
      ['workout', 'steps', 0, 'name'],
    )
  })

  it('bounds nested expansion before constructing a huge provider payload', () => {
    const huge = {
      ...workout,
      steps: [
        {
          type: 'repeat',
          count: 100,
          steps: [{ type: 'repeat', count: 100, steps: [freeTimeStep] }],
        },
      ],
    }
    expectIssue(
      { workout: huge, schedule, externalId, expandNestedRepeats: true },
      'WORKOUT_TOO_LARGE',
    )
  })

  it('accepts the exact rendering budget and rejects one more step', () => {
    const fifty = { ...workout, steps: Array(50).fill(freeTimeStep) }
    expect(
      mapWorkoutToIntervals({ workout: fifty, schedule, externalId }).event.description.split(
        '\n\n',
      ),
    ).toHaveLength(50)
    expectIssue(
      { workout: { ...fifty, steps: [...fifty.steps, freeTimeStep] }, schedule, externalId },
      'WORKOUT_TOO_LARGE',
    )
  })
})

it.each([
  '2026-03-08',
  '2026-11-01', // US DST boundaries
  '2026-03-29',
  '2026-10-25', // European DST boundaries
  '2028-02-29',
])('preserves the local calendar day %s across time zones', (localDate) => {
  for (const timeZone of [
    'Asia/Tokyo',
    'America/Los_Angeles',
    'Europe/Berlin',
    'Pacific/Kiritimati',
    'UTC',
  ]) {
    const result = mapWorkoutToIntervals({ workout, schedule: { localDate, timeZone }, externalId })
    expect(result.event.start_date_local).toBe(`${localDate}T00:00:00`)
    expect(result.schedule.timeZone).toBe(timeZone)
  }
})

it('keeps the stable external ID when a workout changes or moves date', () => {
  const first = mapWorkoutToIntervals({ workout, schedule, externalId })
  const second = mapWorkoutToIntervals({
    workout: { ...workout, name: 'Updated session' },
    schedule: { ...schedule, localDate: '2026-11-16' },
    externalId,
  })
  expect(second.event.external_id).toBe(first.event.external_id)
  expect(second.event.start_date_local).toBe('2026-11-16T00:00:00')
  expect(second.event.name).toBe('Updated session')
})

it.each([
  { workout: { ...workout, schemaVersion: 2 }, schedule, externalId },
  { workout: { ...workout, userId: 'another-owner' }, schedule, externalId },
  { workout, schedule, externalId, athleteId: 'another-athlete' },
  { workout, schedule, externalId, apiKey: 'synthetic-secret' },
  { workout, schedule, externalId: '' },
  { workout, schedule, externalId: 'unsafe\nidentifier' },
  { workout, schedule: { ...schedule, localDate: '2026-02-29' }, externalId },
  { workout, schedule: { ...schedule, localDate: '2026-11-15T23:00:00Z' }, externalId },
  { workout, schedule: { ...schedule, timeZone: 'Not/AZone' }, externalId },
  { workout, schedule: { ...schedule, timeZone: '+09:00' }, externalId },
  { workout, schedule: { localDate: '2026-11-15' }, externalId },
  { workout, schedule, externalId, expandNestedRepeats: 'true' },
  {
    workout: {
      ...workout,
      steps: [
        { ...freeTimeStep, target: { type: 'pace', minSecondsPerKm: 300, maxSecondsPerKm: 240 } },
      ],
    },
    schedule,
    externalId,
  },
])('validates untrusted input without accepting provider routing or credentials: %#', (input) => {
  expectIssue(input, 'INVALID_INPUT')
})

it('does not expose untrusted input values in validation errors', () => {
  try {
    mapWorkoutToIntervals({
      workout,
      schedule,
      externalId,
      'synthetic-secret-value': 'synthetic-secret-value',
    })
    expect.fail('Expected mapping to fail')
  } catch (error) {
    expect(String(error)).not.toContain('synthetic-secret-value')
    expect(JSON.stringify(error)).not.toContain('synthetic-secret-value')
  }
})

describe('provider pace configuration preflight', () => {
  const mapping = mapWorkoutToIntervals({
    workout: intervalsWatchProbe,
    schedule,
    externalId,
    expandNestedRepeats: true,
  })
  const configured = {
    id: 123,
    types: ['Run', 'VirtualRun'],
    threshold_pace: 3.5,
    pace_zones: [70, 80, 90, 100, 110, 999],
  }

  it('accepts current Run settings with threshold and pace zones', () => {
    expect(assertIntervalsWorkoutConfiguration(mapping, [configured])).toBeUndefined()
  })

  it('does not require pace settings for a free-target-only workout', () => {
    const freeMapping = mapWorkoutToIntervals({ workout, schedule, externalId })
    expect(assertIntervalsWorkoutConfiguration(freeMapping, [])).toBeUndefined()
  })

  it.each([
    null,
    {},
    [],
    [{ types: ['Run'] }],
    [{ ...configured, threshold_pace: null }],
    [{ ...configured, threshold_pace: 0 }],
    [{ ...configured, threshold_pace: '3.5' }],
    [{ ...configured, pace_zones: [] }],
    [{ ...configured, pace_zones: null }],
    [{ ...configured, pace_zones: ['untrusted'] }],
    [{ ...configured, types: ['Ride'] }],
    [configured, configured],
  ])('blocks missing, ambiguous or untrusted configuration before a publish: %#', (settings) => {
    expect(() => assertIntervalsWorkoutConfiguration(mapping, settings)).toThrowError(
      expect.objectContaining({
        issues: [
          expect.objectContaining({
            code: 'PACE_CONFIGURATION_REQUIRED',
            path: ['providerSportSettings'],
          }),
        ],
      }),
    )
  })
})
