import { describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
import { getOwnerContext } from '@/server/authorization/ownership'
import {
  EXCHANGE_LIMITS,
  type ExchangeRequest,
  type ExchangeResponse,
} from '@/schemas/plan-exchange.v1'
import { addHealthDays } from '@/lib/health-history'
import { validatePlanResponse } from './validation'
import type { WorkoutDefinition } from '@/schemas/workout-definition.v1'
import {
  fixtureId,
  initialFixture,
  initialResponseFixture,
  runFixture,
  validRequestFixtures,
  refreshFixture,
  refreshResponseFixture,
} from './fixtures'

const owner = getOwnerContext({ id: fixtureId(900), role: 'USER', email: null })
const requests = () => validRequestFixtures(owner)
function largeApprovedDefinition(): WorkoutDefinition {
  return {
    schemaVersion: 1,
    name: 'Synthetic legacy repeat structure',
    sport: 'RUNNING',
    steps: [
      {
        type: 'repeat',
        count: 100,
        steps: [
          {
            type: 'repeat',
            count: 100,
            steps: [
              {
                type: 'repeat',
                count: 100,
                steps: [{ type: 'step', termination: { type: 'lap' }, target: { type: 'free' } }],
              },
            ],
          },
        ],
      },
    ],
  }
}
function preview(request: ExchangeRequest, response: ExchangeResponse = initialResponseFixture()) {
  const result = validatePlanResponse(request, JSON.stringify(response))
  if (!result.valid) throw new Error(JSON.stringify(result.errors))
  return result.preview
}
function excessiveResponse(seconds = 3600) {
  const response = initialResponseFixture()
  response.workouts = Array.from({ length: 3 }, (_, index) => ({
    workoutId: fixtureId(210 + index),
    scheduledDate: addHealthDays('2026-11-16', index * 2),
    definition: {
      schemaVersion: 1 as const,
      name: 'Synthetic long paced run',
      sport: 'RUNNING' as const,
      steps: [
        {
          type: 'step' as const,
          termination: { type: 'time' as const, durationSeconds: seconds },
          target: { type: 'pace' as const, minSecondsPerKm: 360, maxSecondsPerKm: 360 },
        },
      ],
    },
  }))
  return response
}

describe('RUN-36 shared contract and workload validation', () => {
  it.each([
    'self-reported-novice',
    'returning-long-break',
    'no-garmin-account',
    'partial-import-failed',
  ])('keeps %s reviewable, with no fabricated load baseline', (key) => {
    const value = preview(requests()[key], excessiveResponse())
    const uncertainty = value.warnings.find((w) => w.code === 'limited_history')!
    expect(uncertainty.confidence).toBe('low')
    expect(uncertainty.evidence.observed).toBeNull()
    expect(value.review.approved).toBe(false)
    expect(value.review.requiresExplicitApproval).toBe(true)
    expect(value.review.readyForExplicitApproval).toBe(false)
    expect(value.warnings.some((w) => w.code === 'pace_comparability')).toBe(true)
  })
  it('compares regular runner volume and longest run using recent evidence, not an old long run', () => {
    const request = requests()['regular-full-history']
    request.draft.constraints.maxSessionMinutes = 90
    const modest = preview(request)
    expect(modest.warnings.map((w) => w.code)).not.toContain('duration_jump')
    const high = preview(request, excessiveResponse(5400))
    for (const code of ['duration_jump', 'distance_jump', 'long_distance', 'long_duration']) {
      const warning = high.warnings.find((w) => w.code === code)!
      expect(warning).toBeDefined()
      expect(warning.workoutIds.length).toBeGreaterThan(0)
      expect(warning.evidence.proposed).toBeGreaterThan(warning.evidence.observed!)
    }
    expect(high.warnings.find((w) => w.code === 'long_distance')?.evidence.observed).toBe(5000)
    expect(high.weeks[0]).toMatchObject({
      sessions: 3,
      durationSeconds: 16200,
      distanceMeters: 45000,
    })
  })
  it('reports a clear frequency jump against complete recorded weeks with session IDs', () => {
    const request = initialFixture(
      owner,
      Array.from({ length: 4 }, (_, i) =>
        runFixture(owner.userId, i + 1, {
          startedAt: new Date(addHealthDays('2026-11-14', -i * 7) + 'T00:00:00Z'),
        }),
      ),
      'sufficient',
    )
    const value = preview(request, excessiveResponse())
    expect(value.warnings.find((w) => w.code === 'frequency_jump')).toMatchObject({
      confidence: 'moderate',
      workoutIds: excessiveResponse().workouts.map((w) => w.workoutId),
      evidence: { proposed: 3, observed: 1, unit: 'sessions' },
    })
  })
  it('never uses many old PBs or stale history as current fitness', () => {
    const request = requests()['returning-long-break']
    const before = preview(request, excessiveResponse())
    request.trainingContext.athleteReport!.raceOrTestResults = Array.from(
      { length: 5 },
      () => request.trainingContext.athleteReport!.raceOrTestResults![0],
    )
    const after = preview(request, excessiveResponse())
    expect(before.warnings.map((w) => [w.code, w.evidence])).toEqual(
      after.warnings.map((w) => [w.code, w.evidence]),
    )
    expect(after.warnings.some((w) => ['duration_jump', 'distance_jump'].includes(w.code))).toBe(
      false,
    )
  })
  it('distinguishes verified empty history from unknown history without assigning first-ever status', () => {
    const value = preview(requests()['empty-covered-history'], excessiveResponse())
    expect(value.warnings.find((w) => w.code === 'frequency_jump')?.evidence.observed).toBe(0)
    expect(value.warnings.find((w) => w.code === 'distance_jump')?.evidence.observed).toBe(0)
    expect(value.warnings.some((w) => w.code === 'limited_history')).toBe(true)
  })
  it('ages issued evidence at preview time and invalidates earlier acknowledgements', () => {
    const request = requests()['regular-full-history']
    const response = excessiveResponse()
    const prior = preview(request, response)
    const result = validatePlanResponse(
      request,
      JSON.stringify(response),
      { acknowledgedWarningIds: prior.warnings.map((w) => w.id) },
      '2026-12-01',
    )
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.preview.warnings.find((w) => w.code === 'limited_history')?.confidence).toBe(
        'low',
      )
      expect(result.preview.review.readyForExplicitApproval).toBe(false)
    }
  })
  it('does not compare hill/flat pace or missing HR as equivalent effort', () => {
    for (const patch of [
      { elevationGainMeters: new Prisma.Decimal(500), surfaceType: 'TRAIL' },
      { avgHrBpm: null, maxHrBpm: null },
      { laps: [], lapCount: 0 },
    ]) {
      const request = initialFixture(owner, [runFixture(owner.userId, 1, patch)], 'sufficient')
      request.goal.surface = 'ROAD'
      const value = preview(request, excessiveResponse())
      expect(value.warnings.find((w) => w.code === 'pace_comparability')).toMatchObject({
        confidence: 'low',
        evidence: { observed: null },
      })
      expect(value.warnings.some((w) => w.code === 'unsafe_pace')).toBe(false)
    }
  })
  it('reports dense targeted intervals and recovery spacing without inventing a hard-effort baseline', () => {
    const response = excessiveResponse()
    response.workouts.forEach((w, i) => {
      w.scheduledDate = addHealthDays('2026-11-16', i)
      w.definition.steps = [
        {
          type: 'repeat',
          count: 6,
          steps: [
            {
              type: 'step',
              termination: { type: 'time', durationSeconds: 120 },
              target: { type: 'pace', minSecondsPerKm: 240, maxSecondsPerKm: 270 },
            },
          ],
        },
      ]
    })
    const value = preview(requests()['regular-full-history'], response)
    expect(value.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['dense_intervals', 'interval_spacing', 'interval_evidence_limited']),
    )
    expect(value.weeks[0].intervalSeconds).toBe(2160)
    expect(
      value.warnings.find((w) => w.code === 'interval_evidence_limited')?.evidence.observed,
    ).toBeNull()
  })
  it('requires fresh, explicit acknowledgement of every warning and never interprets it as approval', () => {
    const request = initialFixture(owner)
    const response = excessiveResponse()
    const original = preview(request, response)
    const ids = original.warnings.map((w) => w.id)
    const reviewed = validatePlanResponse(request, JSON.stringify(response), {
      acknowledgedWarningIds: ids,
      warningRationale: 'Athlete reviewed the uncertainty.',
    })
    expect(reviewed.valid && reviewed.preview.review).toMatchObject({
      readyForExplicitApproval: true,
      approved: false,
      published: false,
      warningRationale: 'Athlete reviewed the uncertainty.',
    })
    response.workouts[0].definition.steps[0] = {
      type: 'step',
      termination: { type: 'time', durationSeconds: 3000 },
      target: { type: 'free' },
    }
    const changed = validatePlanResponse(request, JSON.stringify(response), {
      acknowledgedWarningIds: ids,
    })
    expect(changed.valid && changed.preview.review.readyForExplicitApproval).toBe(false)
  })
  it.each([
    [
      'weekday',
      (r: ExchangeRequest) => {
        r.draft.constraints.availableWeekdays = [0]
      },
    ],
    [
      'max duration',
      (r: ExchangeRequest) => {
        r.draft.constraints.maxSessionMinutes = 10
      },
    ],
    [
      'start date',
      (r: ExchangeRequest) => {
        r.draft.constraints.startDate = '2026-11-20'
      },
    ],
    [
      'goal date',
      (r: ExchangeRequest) => {
        r.goal.targetDate = '2027-02-01'
      },
    ],
    [
      'weekly capacity',
      (r: ExchangeRequest) => {
        r.draft.constraints.sessionsPerWeek = 1
      },
    ],
  ])('blocks contradictory %s constraints regardless of acknowledgements', (_, patch) => {
    const request = initialFixture(owner)
    patch(request)
    const result = validatePlanResponse(request, JSON.stringify(excessiveResponse()), {
      acknowledgedWarningIds: ['a'.repeat(24)],
    })
    expect(result.valid).toBe(false)
  })
  it('bounds malformed UTF-8 byte sizes, nesting and repeat expansion with readable errors', () => {
    const request = initialFixture(owner)
    for (const text of [
      '{',
      '😀'.repeat(EXCHANGE_LIMITS.responseBytes / 3),
      '['.repeat(40) + '0' + ']'.repeat(40),
    ]) {
      const result = validatePlanResponse(request, text)
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.errors[0].path).toEqual([])
        expect(result.errors[0].expected.length).toBeGreaterThan(5)
        expect(result.repairPrompt).toContain('$:')
      }
    }
    const response = initialResponseFixture()
    response.workouts[0].definition.steps = [
      {
        type: 'repeat',
        count: 100,
        steps: [
          {
            type: 'repeat',
            count: 100,
            steps: [
              {
                type: 'repeat',
                count: 100,
                steps: [{ type: 'step', termination: { type: 'lap' }, target: { type: 'free' } }],
              },
            ],
          },
        ],
      },
    ]
    const result = validatePlanResponse(request, JSON.stringify(response))
    expect(!result.valid && result.errors[0].code).toBe('step_limit')
  })
  it('returns typed nested paths without copying unknown keys, payloads or sensitive health narrative', () => {
    const response = initialResponseFixture()
    const secret = 'PRIVATE-health-GPS-key'
    const raw = {
      ...response,
      [secret]: secret,
      workouts: [
        {
          ...response.workouts[0],
          definition: { ...response.workouts[0].definition, sport: secret },
        },
      ],
    }
    const result = validatePlanResponse(initialFixture(owner), JSON.stringify(raw))
    expect(result.valid).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secret)
    if (!result.valid)
      expect(result.errors.map((e) => e.path)).toContainEqual([
        'workouts',
        0,
        'definition',
        'sport',
      ])
  })
  it('rejects excess canonical repeat depth while ignoring nesting characters inside escaped JSON strings', () => {
    const request = initialFixture(owner)
    const response = initialResponseFixture()
    response.macroPlan.strategy = 'Data with escaped quote " and backslash \\ [{{'.repeat(60)
    expect(preview(request, response).response.macroPlan.strategy).toBe(response.macroPlan.strategy)
    const leaf = response.workouts[0].definition.steps[0]
    response.workouts[0].definition.steps = [
      {
        type: 'repeat',
        count: 2,
        steps: [
          {
            type: 'repeat',
            count: 2,
            steps: [
              { type: 'repeat', count: 2, steps: [{ type: 'repeat', count: 2, steps: [leaf] }] },
            ],
          },
        ],
      },
    ]
    expect(validatePlanResponse(request, JSON.stringify(response)).valid).toBe(false)
  })
  it('bounds aggregate expanded steps even when each workout fits its own limit', () => {
    const request = initialFixture(owner)
    request.draft.constraints.sessionsPerWeek = 7
    const response = initialResponseFixture()
    response.workouts = Array.from({ length: 11 }, (_, i) => ({
      workoutId: fixtureId(210 + i),
      scheduledDate: addHealthDays('2026-11-16', i),
      definition: {
        schemaVersion: 1,
        name: 'Synthetic repeated manual laps',
        sport: 'RUNNING',
        steps: [
          {
            type: 'repeat',
            count: 100,
            steps: [
              {
                type: 'repeat',
                count: 100,
                steps: [{ type: 'step', termination: { type: 'lap' }, target: { type: 'free' } }],
              },
            ],
          },
        ],
      },
    }))
    const result = validatePlanResponse(request, JSON.stringify(response))
    expect(!result.valid && result.errors[0]).toMatchObject({ code: 'step_limit', path: [] })
  })
  it('blocks inferred duration contradictions and warns when duration cannot be established', () => {
    const request = initialFixture(owner)
    const response = initialResponseFixture()
    response.workouts[0].definition.steps = [
      {
        type: 'step',
        termination: { type: 'distance', distanceMeters: 20000 },
        target: { type: 'pace', minSecondsPerKm: 300, maxSecondsPerKm: 360 },
      },
    ]
    const result = validatePlanResponse(request, JSON.stringify(response))
    expect(!result.valid && result.errors[0].code).toBe('max_duration')
    response.workouts[0].definition.steps = [
      { type: 'step', termination: { type: 'lap' }, target: { type: 'free' } },
    ]
    expect(preview(request, response).warnings.map((w) => w.code)).toContain('duration_unknown')
  })
  it('keeps omitted refresh commitments and removes only explicit cancellations', () => {
    const request = refreshFixture(owner)
    const response = refreshResponseFixture()
    const value = preview(request, response)
    expect(value.sessions.map((w) => w.workoutId)).toEqual([fixtureId(201), fixtureId(203)])
  })
  it.each([null, '2026-11-15T02:00:00Z'])(
    'preserves an unchanged approved definition beyond import step limits (lockedAt %s)',
    (lockedAt) => {
      const request = refreshFixture(owner)
      if (request.mode !== 'refresh') throw new Error('Wrong fixture')
      request.currentApprovedRevision.workouts[1].definition = largeApprovedDefinition()
      request.currentApprovedRevision.workouts[1].lockedAt = lockedAt
      const before = JSON.stringify(request)
      const value = preview(request, refreshResponseFixture())
      expect(value.sessions.find((s) => s.workoutId === fixtureId(201))?.estimate.stepCount).toBe(
        1000000,
      )
      expect(value.sessions.map((s) => s.workoutId)).toContain(fixtureId(203))
      expect(JSON.stringify(request)).toBe(before)
    },
  )
  it.each(['create', 'update'] as const)(
    'still bounds an oversized %s definition with an actionable response path',
    (operation) => {
      const request = refreshFixture(owner)
      const response = refreshResponseFixture()
      if (response.mode !== 'refresh') throw new Error('Wrong fixture')
      response.operations = [
        {
          operation,
          workoutId: fixtureId(operation === 'create' ? 203 : 200),
          scheduledDate: '2026-11-19',
          definition: largeApprovedDefinition(),
        },
      ]
      const result = validatePlanResponse(request, JSON.stringify(response))
      expect(!result.valid && result.errors[0]).toMatchObject({
        code: 'step_limit',
        path: ['operations', 0, 'definition', 'steps'],
      })
      expect(!result.valid && result.repairPrompt).not.toContain('currentApprovedRevision')
    },
  )
  it('preserves a locked session when newer duration preferences are shorter', () => {
    const request = refreshFixture(owner)
    request.draft.constraints.maxSessionMinutes = 15
    const response = refreshResponseFixture()
    if (response.mode !== 'refresh') throw new Error('Wrong fixture')
    const create = response.operations[1]
    if (create.operation === 'cancel') throw new Error('Wrong operation')
    create.definition.steps = [
      {
        type: 'step',
        termination: { type: 'time', durationSeconds: 600 },
        target: { type: 'free' },
      },
    ]
    expect(preview(request, response).sessions.map((s) => s.workoutId)).toEqual([
      fixtureId(201),
      fixtureId(203),
    ])
  })
  it('uses calendar dates across a DST transition, rejecting invalid local dates', () => {
    const request = initialFixture(owner)
    request.generatedAt = '2026-10-31T12:00:00Z'
    request.athleteLocalDate = '2026-10-31'
    request.allowedDetailWindow = { startDate: '2026-11-01', endDate: '2026-11-28' }
    request.timezone =
      request.draft.constraints.timezone =
      request.trainingContext.recentTrainingSummary.timezone =
      request.trainingContext.activityHistoryCoverage.timezone =
        'America/New_York'
    request.draft.constraints.startDate = '2026-11-01'
    const response = initialResponseFixture()
    response.detailWindow = request.allowedDetailWindow
    response.macroPlan.startDate = response.macroPlan.phases[0].startDate = '2026-11-01'
    response.workouts[0].scheduledDate = '2026-11-01'
    const value = preview(request, response)
    expect(value.weeks.map((w) => w.startDate)).toEqual([
      '2026-11-01',
      '2026-11-08',
      '2026-11-15',
      '2026-11-22',
    ])
    response.workouts[0].scheduledDate = '2026-11-31'
    expect(validatePlanResponse(request, JSON.stringify(response)).valid).toBe(false)
  })
})
