import 'server-only'

import { z } from 'zod'
import {
  workoutDefinitionSchema,
  type WorkoutNode,
  type WorkoutStep,
} from '@/schemas/workout-definition.v1'
import { compatiblePaceZones, parseIntervalsRunSettings } from './pace-policy'

// Conservative application PoC budget, not a claimed Garmin device limit.
export const INTERVALS_MAX_RENDERED_STEPS = 50

const mappingInputSchema = z.strictObject({
  workout: workoutDefinitionSchema,
  externalId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9:_-]+$/),
  schedule: z.strictObject({
    localDate: z.iso.date(),
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value })
          return !/^[+-]/.test(value)
        } catch {
          return false
        }
      }, 'Use an IANA time zone, for example Asia/Tokyo'),
  }),
  expandNestedRepeats: z.boolean().optional(),
})

type MappingIssueCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_SPORT'
  | 'UNSUPPORTED_HEART_RATE'
  | 'UNSUPPORTED_LAP'
  | 'UNSUPPORTED_PRECISION'
  | 'UNSUPPORTED_CUE'
  | 'NESTED_REPEATS_REQUIRE_EXPANSION'
  | 'PACE_CONFIGURATION_REQUIRED'
  | 'WORKOUT_TOO_LARGE'

export type IntervalsMappingIssue = {
  code: MappingIssueCode
  path: (string | number)[]
  message: string
}

export class IntervalsWorkoutMappingError extends Error {
  constructor(readonly issues: IntervalsMappingIssue[]) {
    super('Workout cannot be mapped to Intervals.icu')
  }
}

export type IntervalsWorkoutEvent = {
  category: 'WORKOUT'
  type: 'Run'
  target: 'PACE'
  name: string
  description: string
  start_date_local: string
  external_id: string
}

export type IntervalsWorkoutMapping = {
  event: IntervalsWorkoutEvent
  schedule: { localDate: string; timeZone: string }
  warnings: { code: 'NESTED_REPEATS_EXPANDED'; message: string }[]
  requirements: { runPaceConfiguration: boolean }
  // Conversion alone establishes no provider or device delivery evidence.
  delivery: { intervals: 'NOT_PUBLISHED'; garminConnect: 'UNVERIFIED'; watch: 'UNVERIFIED' }
}

function fail(code: MappingIssueCode, path: (string | number)[], message: string): never {
  throw new IntervalsWorkoutMappingError([{ code, path, message }])
}

function requireInteger(value: number, path: (string | number)[]) {
  if (!Number.isInteger(value))
    fail(
      'UNSUPPORTED_PRECISION',
      path,
      'This adapter supports whole seconds and meters only. Edit the workout explicitly; values are never rounded.',
    )
}

function pace(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function renderStep(step: WorkoutStep, path: (string | number)[]): string {
  const termination = step.termination
  if (termination.type === 'lap')
    fail(
      'UNSUPPORTED_LAP',
      [...path, 'termination'],
      'Lap-only termination has no verified text mapping. Choose time/distance explicitly or wait for a verified FIT adapter; no fallback duration is invented.',
    )
  const target = step.target
  if (target.type === 'heartRate')
    fail(
      'UNSUPPORTED_HEART_RATE',
      [...path, 'target'],
      'Absolute BPM is not supported by this text adapter. Use an explicitly reviewed pace/free workout or wait for verified absolute-HR delivery; BPM is never converted to zones or percentages.',
    )

  // Cues share the provider's command parser. Do not let an imported name add
  // duration, target, lap, ramp, intensity, or extra workout lines.
  if (
    step.name &&
    (!/^[\p{L} ]+$/u.test(step.name) ||
      /\b(lap|ramp|free|freeride|pace|hr|lthr|power|intensity|repeat)\b/i.test(step.name))
  )
    fail(
      'UNSUPPORTED_CUE',
      [...path, 'name'],
      'Use a step name containing only letters/spaces and no workout commands, or omit the name. Imported cues cannot change provider workout syntax.',
    )

  let end: string
  if (termination.type === 'time') {
    requireInteger(termination.durationSeconds, [...path, 'termination', 'durationSeconds'])
    end = `${termination.durationSeconds}s`
  } else {
    requireInteger(termination.distanceMeters, [...path, 'termination', 'distanceMeters'])
    end = `${termination.distanceMeters}mtr`
  }
  let effort = ''
  if (target.type === 'pace') {
    requireInteger(target.minSecondsPerKm, [...path, 'target', 'minSecondsPerKm'])
    requireInteger(target.maxSecondsPerKm, [...path, 'target', 'maxSecondsPerKm'])
    // Provider examples express a pace band slow-to-fast; canonical seconds/km
    // are ordered fast-to-slow. Always specify /km, independent of display units.
    effort =
      target.minSecondsPerKm === target.maxSecondsPerKm
        ? ` ${pace(target.minSecondsPerKm)}/km Pace`
        : ` ${pace(target.maxSecondsPerKm)}-${pace(target.minSecondsPerKm)}/km Pace`
  }
  return `- ${step.name ? `${step.name} ` : ''}${end}${effort}`
}

/** Pure conversion, with no credential access, persistence, approval or HTTP effects. */
export function mapWorkoutToIntervals(input: unknown): IntervalsWorkoutMapping {
  const parsed = mappingInputSchema.safeParse(input)
  if (!parsed.success)
    throw new IntervalsWorkoutMappingError(
      parsed.error.issues.map((issue) => ({
        code: 'INVALID_INPUT',
        path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
        message:
          'Invalid mapping input. Check the canonical v1 workout, external ID and local schedule.',
      })),
    )
  const { workout, schedule, externalId, expandNestedRepeats } = parsed.data
  if (workout.sport !== 'RUNNING')
    fail(
      'UNSUPPORTED_SPORT',
      ['workout', 'sport'],
      'Only RUNNING workouts are supported by this adapter.',
    )

  const blocks: string[] = []
  let renderedSteps = 0
  let expanded = false
  function reserve(count: number, path: (string | number)[]) {
    renderedSteps += count
    if (renderedSteps > INTERVALS_MAX_RENDERED_STEPS)
      fail(
        'WORKOUT_TOO_LARGE',
        path,
        `The proof-of-concept adapter allows at most ${INTERVALS_MAX_RENDERED_STEPS} rendered steps including repeat markers. Simplify the workout explicitly.`,
      )
  }
  function render(nodes: WorkoutNode[], path: (string | number)[]) {
    for (const [index, node] of nodes.entries()) {
      const nodePath = [...path, index]
      if (node.type === 'step') {
        reserve(1, nodePath)
        blocks.push(renderStep(node, nodePath))
      } else if (node.steps.every((child) => child.type === 'step')) {
        reserve(1 + node.steps.length, nodePath)
        blocks.push(
          [
            `${node.count}x`,
            ...node.steps.map((step, i) => renderStep(step, [...nodePath, 'steps', i])),
          ].join('\n'),
        )
      } else {
        if (!expandNestedRepeats)
          fail(
            'NESTED_REPEATS_REQUIRE_EXPANSION',
            nodePath,
            'Native nested repeats are unsupported. Preview with expandNestedRepeats: true to expand outer groups while preserving every interval and recovery.',
          )
        expanded = true
        for (let repetition = 0; repetition < node.count; repetition++)
          render(node.steps, [...nodePath, 'steps'])
      }
    }
  }
  render(workout.steps, ['workout', 'steps'])
  function needsPace(node: WorkoutNode): boolean {
    return node.type === 'step' ? node.target.type === 'pace' : node.steps.some(needsPace)
  }
  return {
    event: {
      category: 'WORKOUT',
      type: 'Run',
      target: 'PACE',
      name: workout.name,
      description: blocks.join('\n\n'),
      // This is a floating calendar date in the athlete's provider time zone.
      // Converting through UTC would move dates across offsets/DST boundaries.
      start_date_local: `${schedule.localDate}T00:00:00`,
      external_id: externalId,
    },
    schedule,
    requirements: { runPaceConfiguration: workout.steps.some(needsPace) },
    warnings: expanded
      ? [
          {
            code: 'NESTED_REPEATS_EXPANDED',
            message:
              'Outer repeat groups were expanded. Preview the resulting sequence before explicitly publishing; native nesting is not preserved.',
          },
        ]
      : [],
    delivery: { intervals: 'NOT_PUBLISHED', garminConnect: 'UNVERIFIED', watch: 'UNVERIFIED' },
  }
}

/** Before writing, callers must supply current sport settings from the same
 * authenticated provider account that will receive this event. This check does
 * not fetch settings, authenticate an owner or authorize publication. */
export function assertIntervalsWorkoutConfiguration(
  mapping: IntervalsWorkoutMapping,
  rawSportSettings: unknown,
): void {
  if (!mapping.requirements.runPaceConfiguration) return
  try {
    const running = parseIntervalsRunSettings(rawSportSettings)
    if (running.threshold_pace && compatiblePaceZones(running)) return
  } catch {
    // Pure assertion only. Owner-scoped provisioning belongs to pace-preflight.
  }
  fail(
    'PACE_CONFIGURATION_REQUIRED',
    ['providerSportSettings'],
    'Prepare workout delivery to configure or verify the missing Intervals.icu Run settings before publishing. Pace targets will not be removed or replaced.',
  )
}
