import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
import { getOwnerContext } from '@/server/authorization/ownership'
import { exchangeRequestSchema, responseSchemaForRequest } from '@/schemas/plan-exchange.v1'
import { mergePlanWorkouts } from '@/server/plans/content'
import { buildTrainingEvidence } from './evidence'
import {
  coverageFixture,
  fixtureId,
  initialFixture,
  refreshFixture,
  refreshResponseFixture,
  runFixture,
} from './fixtures'
import { createPlanExchangePackage, parsePlanRequestJson, parsePlanResponseJson } from './package'

const owner = getOwnerContext({ id: fixtureId(900), role: 'USER', email: null })

function midweekRefresh() {
  const request = refreshFixture(owner)
  const response = refreshResponseFixture()
  if (request.mode !== 'refresh' || response.mode !== 'refresh') throw new Error('Wrong fixture')
  const now = new Date('2026-11-18T03:00:00Z')
  const window = { startDate: '2026-08-26', endDate: '2026-11-17' }
  request.generatedAt = now.toISOString()
  request.athleteLocalDate = '2026-11-18'
  request.allowedDetailWindow = { startDate: '2026-11-19', endDate: '2026-12-16' }
  request.draft.constraints.sessionsPerWeek = 1
  request.trainingContext = {
    schemaVersion: 1,
    lifecycle: { firstPlanForAthlete: false, firstWorkoutInPlan: false },
    ...buildTrainingEvidence(
      owner,
      [
        runFixture(owner.userId, 1, {
          startedAt: new Date('2026-11-17T00:00:00Z'),
          sourceObservedAt: new Date('2026-11-18T02:00:00Z'),
          importedAt: new Date('2026-11-18T02:00:00Z'),
        }),
      ],
      {
        timezone: request.timezone,
        now,
        coverage: {
          ...coverageFixture(),
          window,
          completeWindows: [window],
          lastManualSyncAt: '2026-11-18T02:00:00Z',
        },
        includeHeartRate: true,
        includeLaps: true,
      },
    ),
  }
  const completed = request.currentApprovedRevision.workouts[0]
  completed.completedAt = '2026-11-17T02:00:00Z'
  completed.outcome = 'completed'
  completed.activityId = fixtureId(1)
  request.currentApprovedRevision.workouts = [completed]
  request.allowedWorkoutIds = []
  response.detailWindow = request.allowedDetailWindow
  response.operations = response.operations.filter((operation) => operation.operation === 'create')
  return { request, response }
}

describe('RUN-34 review regressions: consent metadata', () => {
  it.each([
    'eligibleRuns',
    'truncatedRuns',
    'excludedDuplicateCandidates',
    'truncatedLaps',
  ] as const)('rejects nonselected %s at request parsing and package creation', (field) => {
    const request = initialFixture(owner)
    request.consent.recordedActivityMetrics = false
    if (field === 'eligibleRuns' || field === 'truncatedRuns') {
      request.trainingContext.selection.eligibleRuns = 12
      request.trainingContext.selection.truncatedRuns = 12
    } else request.trainingContext.selection[field] = 2
    const result = exchangeRequestSchema.safeParse(request)
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['trainingContext', 'selection', field] }),
        ]),
      )
    expect(() => parsePlanRequestJson(JSON.stringify(request))).toThrow(z.ZodError)
    expect(() => createPlanExchangePackage(request)).toThrow(z.ZodError)
  })
  it('accepts redacted selection counters without inventing covered activity zeros', () => {
    const request = initialFixture(owner)
    request.consent.recordedActivityMetrics = false
    request.consent.recordedLaps = false
    const packet = createPlanExchangePackage(request)
    expect(packet.request.trainingContext.selection).toMatchObject({
      eligibleRuns: 0,
      truncatedRuns: 0,
      excludedDuplicateCandidates: 0,
      truncatedLaps: 0,
    })
    expect(
      packet.request.trainingContext.recentTrainingSummary.weeks.every(
        (week) => week.completedSessions.value === null && week.distance.value === null,
      ),
    ).toBe(true)
  })
  it('rejects lap truncation counts when laps alone were deselected', () => {
    const request = initialFixture(owner)
    request.consent.recordedLaps = false
    request.trainingContext.selection.truncatedLaps = 5
    expect(() => createPlanExchangePackage(request)).toThrow(z.ZodError)
  })
})

describe('RUN-34 review regressions: weekly refresh capacity', () => {
  it.each(['completed', 'unknown'] as const)(
    'counts a retained %s current-week session before adding a future workout',
    (outcome) => {
      const { request, response } = midweekRefresh()
      const prior = request.currentApprovedRevision.workouts[0]
      prior.outcome = outcome
      if (outcome === 'unknown') {
        prior.completedAt = null
        prior.activityId = null
      }
      expect(exchangeRequestSchema.safeParse(request).success).toBe(true)
      const result = responseSchemaForRequest(request).safeParse(response)
      expect(result.success).toBe(false)
      if (!result.success)
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: ['operations'],
              message: 'Schedule exceeds sessions per calendar week',
            }),
          ]),
        )
      expect(() => parsePlanResponseJson(JSON.stringify(response), request)).toThrow(z.ZodError)
    },
  )
  it('counts a completed commitment linked to a sampled Activity exactly once', () => {
    const { request, response } = midweekRefresh()
    request.draft.constraints.sessionsPerWeek = 2
    expect(request.currentApprovedRevision.workouts[0].activityId).toBe(
      request.trainingContext.recentRunSamples[0].activityId,
    )
    expect(responseSchemaForRequest(request).safeParse(response).success).toBe(true)
  })
  it.each(['cancelled', 'missed'] as const)(
    'does not consume capacity for %s sessions',
    (state) => {
      const { request, response } = midweekRefresh()
      const prior = request.currentApprovedRevision.workouts[0]
      prior.completedAt = null
      prior.activityId = null
      prior.outcome = state === 'missed' ? 'missed' : 'unknown'
      prior.cancelled = state === 'cancelled'
      expect(responseSchemaForRequest(request).safeParse(response).success).toBe(true)
    },
  )
  it('does not reject an already over-budget historical week when adding sessions next week', () => {
    const { request, response } = midweekRefresh()
    const prior = request.currentApprovedRevision.workouts[0]
    request.currentApprovedRevision.workouts.push({
      ...prior,
      workoutId: fixtureId(205),
      scheduledDate: '2026-11-18',
      completedAt: '2026-11-18T02:00:00Z',
      activityId: null,
    })
    request.allowedDetailWindow = { startDate: '2026-11-23', endDate: '2026-12-20' }
    response.detailWindow = request.allowedDetailWindow
    response.operations = response.operations.map((operation) =>
      operation.operation === 'create' ? { ...operation, scheduledDate: '2026-11-24' } : operation,
    )
    expect(responseSchemaForRequest(request).safeParse(response).success).toBe(true)
  })
})

describe('RUN-34 review regressions: protected commitments and macro horizon', () => {
  function shortenedRefresh() {
    const request = refreshFixture(owner)
    const response = refreshResponseFixture()
    if (request.mode !== 'refresh' || response.mode !== 'refresh') throw new Error('Wrong fixture')
    request.goal.targetDate = null
    request.currentApprovedRevision.workouts[1].scheduledDate = '2027-01-10'
    response.macroPlan.endDate = '2026-12-13'
    response.macroPlan.phases[0].endDate = '2026-12-13'
    return { request, response }
  }
  it('rejects a shortened horizon that excludes an unfinished locked future commitment, matching RUN-33', () => {
    const { request, response } = shortenedRefresh()
    expect(exchangeRequestSchema.safeParse(request).success).toBe(true)
    const result = responseSchemaForRequest(request).safeParse(response)
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['operations'],
            message: 'Retained future commitments must fit the macro period',
          }),
        ]),
      )
    const previous = request.currentApprovedRevision.workouts.map((workout) => ({
      workoutId: workout.workoutId,
      scheduledDate: workout.scheduledDate,
      definition: workout.definition,
      cancelled: workout.cancelled,
      timezone: workout.timezone,
    }))
    expect(() =>
      mergePlanWorkouts(
        previous,
        {
          schemaVersion: 1,
          macroPlan: response.macroPlan,
          detailWindow: response.detailWindow,
          workouts: [],
        },
        request.draft.constraints,
        request.currentApprovedRevision.workouts.map((workout) => ({
          id: workout.workoutId,
          completedAt: workout.completedAt ? new Date(workout.completedAt) : null,
          lockedAt: workout.lockedAt ? new Date(workout.lockedAt) : null,
        })),
        new Date(request.generatedAt),
      ),
    ).toThrow('Retained future workouts must be within the macro period')
  })
  it.each(['completed', 'cancelled'] as const)(
    'preserves %s commitments outside a shortened horizon',
    (state) => {
      const { request, response } = shortenedRefresh()
      const prior = request.currentApprovedRevision.workouts[1]
      if (state === 'completed') {
        prior.completedAt = '2026-11-15T02:00:00Z'
        prior.outcome = 'completed'
      } else prior.cancelled = true
      expect(responseSchemaForRequest(request).safeParse(response).success).toBe(true)
    },
  )
  it('uses the original workout timezone when deciding whether a locked session is still future', () => {
    const { request, response } = shortenedRefresh()
    const prior = request.currentApprovedRevision.workouts[1]
    prior.timezone = 'Pacific/Honolulu'
    prior.scheduledDate = '2026-11-15'
    expect(responseSchemaForRequest(request).safeParse(response).success).toBe(false)
  })
})
