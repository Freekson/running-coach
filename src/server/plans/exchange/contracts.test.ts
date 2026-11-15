import { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
import { getOwnerContext } from '@/server/authorization/ownership'
import {
  exchangeRequestSchema,
  exchangeResponseSchema,
  responseSchemaForRequest,
  EXCHANGE_LIMITS,
} from '@/schemas/plan-exchange.v1'
import { trainingContextSchema } from '@/schemas/training-context.v1'
import {
  createPlanExchangePackage,
  parsePlanResponseJson,
  parsePlanRequestJson,
  assertExchangeCurrent,
} from './package'
import {
  coverageFixture,
  fixtureId,
  fixtureNow,
  initialFixture,
  initialResponseFixture,
  refreshFixture,
  refreshResponseFixture,
  runFixture,
  validRequestFixtures,
} from './fixtures'
import { buildTrainingEvidence } from './evidence'

const owner = getOwnerContext({ id: fixtureId(900), role: 'USER', email: null })
const other = getOwnerContext({ id: fixtureId(901), role: 'ADMIN', email: null })
function paths(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input)
  expect(result.success).toBe(false)
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
}

describe('RUN-34 versioned initial/refresh contracts', () => {
  it('roundtrips all valid synthetic requests, including unknown/nullable history', () => {
    for (const fixture of Object.values(validRequestFixtures(owner))) {
      expect(parsePlanRequestJson(JSON.stringify(fixture))).toEqual(fixture)
      const response =
        fixture.mode === 'refresh' ? refreshResponseFixture() : initialResponseFixture()
      expect(parsePlanResponseJson(JSON.stringify(response), fixture)).toEqual(response)
    }
  })
  it('keeps lifecycle separate from self-reported first-ever and experience', () => {
    const fixtures = validRequestFixtures(owner)
    expect(fixtures['no-garmin-account'].trainingContext.athleteReport).toBeUndefined()
    expect(fixtures['self-reported-novice'].trainingContext.athleteReport?.firstWorkoutEver).toBe(
      true,
    )
    expect(fixtures['returning-long-break'].trainingContext.athleteReport?.experience).toBe(
      'returning_runner',
    )
    expect(
      fixtures['returning-long-break'].trainingContext.daysSinceLastRecordedRun.value,
    ).toBeGreaterThan(300)
    expect(fixtures['returning-long-break'].trainingContext.recentRunSamples).toEqual([])
    expect(
      fixtures['returning-long-break'].trainingContext.athleteReport?.raceOrTestResults?.[0].kind,
    ).toBe('historical_pb')
  })
  it('rejects unsupported schema versions, enum values, nested malformed steps and provider keys with typed paths', () => {
    const request = initialFixture(owner)
    expect(paths(exchangeRequestSchema, { ...request, schemaVersion: 2 })).toContain(
      'schemaVersion',
    )
    const report = {
      experience: 'elite',
      firstWorkoutEver: null,
      provenance: {
        source: 'ATHLETE',
        quality: 'reported',
        observedAt: fixtureNow.toISOString(),
        period: { startDate: '2026-11-15', endDate: '2026-11-15' },
      },
    }
    expect(
      paths(exchangeRequestSchema, {
        ...request,
        trainingContext: { ...request.trainingContext, athleteReport: report },
      }),
    ).toContain('trainingContext.athleteReport.experience')
    const response = initialResponseFixture()
    if (response.mode !== 'initial') throw new Error('Wrong fixture')
    const malformed = structuredClone(response)
    malformed.workouts[0].definition.steps = []
    expect(paths(exchangeResponseSchema, malformed)).toContain('workouts.0.definition.steps')
    const nested = {
      ...response,
      workouts: [
        {
          ...response.workouts[0],
          definition: {
            ...response.workouts[0].definition,
            steps: [
              {
                type: 'step',
                termination: { type: 'time', durationSeconds: -1 },
                target: { type: 'free' },
              },
            ],
          },
        },
      ],
    }
    expect(paths(exchangeResponseSchema, nested)).toContain(
      'workouts.0.definition.steps.0.termination.durationSeconds',
    )
    expect(exchangeResponseSchema.safeParse({ ...response, garminPayload: {} }).success).toBe(false)
  })
  it('rejects stale request IDs, mode, draft and approved revision versions', () => {
    const request = initialFixture(owner)
    const response = initialResponseFixture()
    const schema = responseSchemaForRequest(request)
    expect(paths(schema, { ...response, requestId: fixtureId(999) })).toContain('requestId')
    expect(paths(schema, { ...response, draftVersion: 9 })).toContain('draftVersion')
    const refresh = refreshFixture(owner)
    expect(
      paths(responseSchemaForRequest(refresh), {
        ...refreshResponseFixture(),
        baseRevisionId: fixtureId(999),
      }),
    ).toContain('baseRevisionId')
    expect(
      paths(responseSchemaForRequest(refresh), {
        ...refreshResponseFixture(),
        baseRevisionNumber: 9,
      }),
    ).toContain('baseRevisionNumber')
    expect(paths(responseSchemaForRequest(refresh), response)).toContain('mode')
    const state = {
      requestId: request.requestId,
      draftId: request.draft.draftId,
      draftVersion: 0,
      revisionId: null,
      revisionNumber: null,
    }
    expect(() => assertExchangeCurrent(request, state)).not.toThrow()
    expect(() => assertExchangeCurrent(request, { ...state, draftVersion: 1 })).toThrow(z.ZodError)
    expect(() => assertExchangeCurrent(request, { ...state, requestId: fixtureId(999) })).toThrow(
      z.ZodError,
    )
  })
  it('protects locked, completed, missed and past workouts, dates and identities', () => {
    const request = refreshFixture(owner)
    if (request.mode !== 'refresh') throw new Error('Wrong fixture')
    const response = refreshResponseFixture()
    for (const id of [201, 202, 999]) {
      expect(
        paths(responseSchemaForRequest(request), {
          ...response,
          operations: [{ operation: 'cancel', workoutId: fixtureId(id) }],
        }),
      ).toContain('operations.0.workoutId')
      expect(
        exchangeRequestSchema.safeParse({ ...request, allowedWorkoutIds: [fixtureId(id)] }).success,
      ).toBe(false)
    }
    request.lockedDates = ['2026-11-19']
    expect(paths(responseSchemaForRequest(request), response)).toContain(
      'operations.1.scheduledDate',
    )
    request.lockedDates = []
    request.currentApprovedRevision.workouts[0].outcome = 'missed'
    expect(exchangeRequestSchema.safeParse(request).success).toBe(false)
  })
  it('rejects identity reuse, duplicate operations and unsafe schedule constraints', () => {
    const request = initialFixture(owner)
    const response = initialResponseFixture()
    if (response.mode !== 'initial') throw new Error('Wrong fixture')
    const schema = responseSchemaForRequest(request)
    expect(
      paths(schema, { ...response, workouts: [response.workouts[0], response.workouts[0]] }),
    ).toContain('workouts.1.workoutId')
    expect(
      paths(schema, {
        ...response,
        workouts: [{ ...response.workouts[0], scheduledDate: '2026-11-15' }],
      }),
    ).toContain('workouts.0.scheduledDate')
    request.draft.constraints.availableWeekdays = [1, 3, 5]
    expect(paths(responseSchemaForRequest(request), response)).toContain('workouts')
    request.draft.constraints.availableWeekdays = [0, 1, 2, 3, 4, 5, 6]
    request.draft.constraints.maxSessionMinutes = 5
    expect(paths(responseSchemaForRequest(request), response)).toContain('workouts')
    const refresh = refreshFixture(owner)
    if (refresh.mode !== 'refresh') throw new Error('Wrong fixture')
    expect(
      exchangeRequestSchema.safeParse({ ...refresh, allowedCreateWorkoutIds: [fixtureId(200)] })
        .success,
    ).toBe(false)
  })
  it('enforces consent on optional reports, HR, laps and recovery', () => {
    const request = validRequestFixtures(owner)['self-reported-novice']
    request.consent.athleteReport = false
    expect(paths(exchangeRequestSchema, request)).toContain('trainingContext.athleteReport')
    const metrics = initialFixture(owner, [runFixture(owner.userId)], 'sufficient')
    metrics.consent.activityHeartRate = false
    expect(paths(exchangeRequestSchema, metrics)).toContain('trainingContext.recentRunSamples.0')
    metrics.consent.recordedActivityMetrics = false
    expect(paths(exchangeRequestSchema, metrics)).toContain('trainingContext')
    const volunteered = validRequestFixtures(owner)['consented-reports-and-recovery']
    volunteered.consent.recovery = false
    expect(paths(exchangeRequestSchema, volunteered)).toContain('trainingContext.recoveryContext')
    volunteered.consent.recovery = true
    volunteered.consent.limitationsOrFatigue = false
    expect(paths(exchangeRequestSchema, volunteered)).toContain(
      'trainingContext.athleteReport.limitationsOrFatigue',
    )
  })
  it('rejects mismatched units, invented covered zeros, wrong periods and timezone boundaries', () => {
    const request = initialFixture(owner, [runFixture(owner.userId)], 'sufficient')
    const wrongUnit = structuredClone(request)
    wrongUnit.trainingContext.recentRunSamples[0].averagePace.unit = 'bpm'
    expect(paths(exchangeRequestSchema, wrongUnit)).toContain(
      'trainingContext.recentRunSamples.0.averagePace.unit',
    )
    const unknown = initialFixture(owner)
    unknown.trainingContext.recentTrainingSummary.weeks[0].distance = {
      ...request.trainingContext.recentTrainingSummary.weeks[0].distance,
    }
    expect(paths(exchangeRequestSchema, unknown)).toContain(
      'trainingContext.recentTrainingSummary.weeks.0',
    )
    const timestamp = structuredClone(request)
    timestamp.trainingContext.recentRunSamples[0].averageHr.provenance.observedAt =
      '2026-11-13T00:00:00Z'
    expect(paths(exchangeRequestSchema, timestamp)).toContain(
      'trainingContext.recentRunSamples.0.averageHr',
    )
    expect(paths(exchangeRequestSchema, { ...request, athleteLocalDate: '2026-11-14' })).toContain(
      'athleteLocalDate',
    )
    expect(paths(exchangeRequestSchema, { ...request, timezone: 'UTC' })).toContain('timezone')
  })
  it('checks full macro coverage and counts retained future locked commitments in frequency', () => {
    const request = initialFixture(owner)
    const response = initialResponseFixture()
    const gap = structuredClone(response)
    gap.macroPlan.phases[0].startDate = '2026-11-17'
    expect(paths(responseSchemaForRequest(request), gap)).toContain('macroPlan.phases.0')
    const refresh = refreshFixture(owner)
    refresh.draft.constraints.sessionsPerWeek = 1
    expect(paths(responseSchemaForRequest(refresh), refreshResponseFixture())).toContain(
      'operations',
    )
  })
  it('returns typed errors for malformed dates/timezones and short arrays', () => {
    const request = initialFixture(owner, [runFixture(owner.userId)], 'sufficient')
    expect(paths(exchangeRequestSchema, { ...request, timezone: 'Not/A_Timezone' })).toContain(
      'timezone',
    )
    expect(paths(exchangeRequestSchema, { ...request, generatedAt: 'invalid' })).toContain(
      'generatedAt',
    )
    const dates = structuredClone(request)
    dates.trainingContext.selection.window.startDate = 'invalid'
    expect(paths(exchangeRequestSchema, dates)).toContain(
      'trainingContext.selection.window.startDate',
    )
    const short = structuredClone(request)
    short.trainingContext.recentTrainingSummary.weeks = []
    expect(paths(exchangeRequestSchema, short)).toContain(
      'trainingContext.recentTrainingSummary.weeks',
    )
    const run = structuredClone(request)
    run.trainingContext.recentRunSamples[0].startedAt = 'invalid'
    expect(paths(exchangeRequestSchema, run)).toContain(
      'trainingContext.recentRunSamples.0.startedAt',
    )
  })
  it('bounds UTF-8 bytes before JSON parsing and embeds the entire response schema and conservative instructions', () => {
    const request = initialFixture(owner)
    expect(() =>
      parsePlanResponseJson(' '.repeat(EXCHANGE_LIMITS.responseBytes + 1), request),
    ).toThrow(z.ZodError)
    expect(() =>
      parsePlanResponseJson(
        '"'.concat('あ'.repeat(EXCHANGE_LIMITS.responseBytes / 2), '"'),
        request,
      ),
    ).toThrow('byte limit')
    expect(() => parsePlanResponseJson('{', request)).toThrow('Malformed JSON')
    const pack = createPlanExchangePackage(validRequestFixtures(owner)['regular-full-history'])
    expect(pack.request.requestId).toBe(request.requestId)
    expect(pack.expectedResponseSchema.$schema).toContain('2020-12')
    expect(JSON.stringify(pack.expectedResponseSchema)).toContain('durationSeconds')
    expect(JSON.stringify(pack.expectedResponseSchema)).toContain('operations')
    expect(new TextEncoder().encode(JSON.stringify(pack)).length).toBeLessThan(
      EXCHANGE_LIMITS.requestBytes,
    )
    expect(pack.instructions).toContain('Old PBs/race tests are historical evidence')
    expect(pack.instructions).toContain('explicit human review and approval')
  })
})

describe('RUN-34 stored training evidence semantics', () => {
  const build = (records = [runFixture(owner.userId)], coverage = coverageFixture()) =>
    buildTrainingEvidence(owner, records, {
      timezone: 'Asia/Tokyo',
      now: fixtureNow,
      coverage,
      includeHeartRate: true,
      includeLaps: true,
    })
  it('uses absolute athlete dates and rolling 4/8/12-week windows, with truthful covered zeros', () => {
    const full = build([])
    expect(full.recentTrainingSummary.weeks).toHaveLength(12)
    expect(full.selection.window).toEqual({ startDate: '2026-08-23', endDate: '2026-11-14' })
    expect(full.recentTrainingSummary.rollingTotals.map((total) => total.weeks)).toEqual([4, 8, 12])
    expect(full.recentTrainingSummary.weeks[0].completedSessions.value).toBe(0)
    expect(full.recentTrainingSummary.weeks[0].distance.value).toBe(0)
    expect(full.recentTrainingSummary.weeks[0].daysWithoutRecordedRuns.value).toBe(7)
    expect(
      build([], coverageFixture('absent')).recentTrainingSummary.weeks[0].distance.value,
    ).toBeNull()
    expect(
      build([], coverageFixture('partial')).recentTrainingSummary.weeks[0].completedSessions.value,
    ).toBeNull()
    const failed = coverageFixture()
    failed.failedWindows = [{ startDate: '2026-11-10', endDate: '2026-11-11' }]
    expect(build([], failed).recentTrainingSummary.weeks[11].distance.value).toBeNull()
    const unknown = { ...coverageFixture(), status: 'unknown' as const }
    expect(build([], unknown).recentTrainingSummary.weeks[0].distance.value).toBeNull()
    const narrow = {
      ...coverageFixture(),
      window: { startDate: '2026-11-08', endDate: '2026-11-14' },
    }
    expect(build([], narrow).recentTrainingSummary.weeks[0].distance.value).toBeNull()
    expect(build().recentRunSamples[0].localDate).toBe('2026-11-14')
    expect(build().recentRunSamples[0].source.observedAt).toBe('2026-11-15T02:00:00.000Z')
  })
  it('pairs pace and HR from each same recorded run and uses compatible positive duration', () => {
    const evidence = build([
      runFixture(owner.userId, 1, { avgHrBpm: 130 }),
      runFixture(owner.userId, 2, { avgHrBpm: 170, movingMs: null, elapsedMs: BigInt(1500000) }),
      runFixture(owner.userId, 3, {
        avgHrBpm: null,
        maxHrBpm: null,
        distanceMeters: null,
        movingMs: null,
        elapsedMs: null,
        avgSpeedMps: new Prisma.Decimal(4),
      }),
      runFixture(owner.userId, 4, { movingMs: BigInt(2000000), elapsedMs: BigInt(1000000) }),
      runFixture(owner.userId, 5, {
        distanceMeters: new Prisma.Decimal(0),
        movingMs: BigInt(0),
        elapsedMs: BigInt(0),
      }),
    ])
    expect(evidence.recentRunSamples[0]).toMatchObject({
      averagePace: { value: 360, unit: 's/km' },
      averageHr: { value: 130, unit: 'bpm' },
      paceBasis: 'moving',
    })
    expect(evidence.recentRunSamples[1]).toMatchObject({
      averagePace: { value: 300 },
      averageHr: { value: 170 },
      paceBasis: 'elapsed',
    })
    expect(evidence.recentRunSamples[2]).toMatchObject({
      averagePace: { value: 250 },
      averageHr: { value: null },
      paceBasis: 'recorded_average_speed',
    })
    expect(evidence.recentRunSamples[3]).toMatchObject({
      averagePace: { value: null },
      flags: ['inconsistent_times'],
    })
    expect(evidence.recentRunSamples[4].averagePace.value).toBeNull()
    expect(evidence.recentTrainingSummary.weeks[11].duration.value).toBeNull()
  })
  it('excludes other owners, non-runs, duplicate candidates, repeated IDs and future activities', () => {
    const run = runFixture(owner.userId)
    const evidence = build([
      run,
      run,
      runFixture(other.userId, 2),
      runFixture(owner.userId, 3, { sportType: 'CYCLING' }),
      runFixture(owner.userId, 4, { duplicateCandidate: true }),
      runFixture(owner.userId, 5, { startedAt: new Date('2026-11-20T00:00:00Z') }),
    ])
    expect(evidence.selection).toMatchObject({ eligibleRuns: 1, excludedDuplicateCandidates: 1 })
    expect(evidence.recentTrainingSummary.weeks[11].completedSessions.value).toBeNull()
    expect(evidence.recentRunSamples.map((sample) => sample.activityId)).toEqual([run.id])
    expect(() =>
      buildTrainingEvidence({ userId: owner.userId }, [], {
        timezone: 'Asia/Tokyo',
        now: fixtureNow,
        coverage: coverageFixture(),
        includeHeartRate: false,
        includeLaps: false,
      }),
    ).toThrow('Verified owner context required')
  })
  it('bounds deterministic samples and laps, reserving long and faster evidenced sessions', () => {
    const runs = Array.from({ length: 30 }, (_, index) =>
      runFixture(owner.userId, index + 1, {
        distanceMeters: new Prisma.Decimal(index === 29 ? 20000 : 5000),
        startedAt: new Date(
          '2026-11-' + String(14 - Math.floor(index / 3)).padStart(2, '0') + 'T01:00:00Z',
        ),
        elapsedMs: BigInt(7200000),
        movingMs: BigInt(index === 28 ? 1000000 : 7000000),
        lapCount: 12,
        laps: Array.from({ length: 12 }, (_, lapIndex) => ({
          lapIndex,
          startedAt: null,
          sourceRecordType: 'FIT_LAP',
          distanceMeters: new Prisma.Decimal(400),
          elapsedMs: BigInt(120000),
          movingMs: null,
          avgSpeedMps: null,
          avgHrBpm: lapIndex % 2 ? 140 : 160,
        })),
      }),
    )
    const evidence = build(runs)
    expect(build([...runs].reverse())).toEqual(evidence)
    expect(evidence.recentRunSamples).toHaveLength(20)
    expect(evidence.recentRunSamples.some((run) => run.activityId === fixtureId(30))).toBe(true)
    expect(evidence.recentRunSamples.some((run) => run.activityId === fixtureId(29))).toBe(true)
    expect(evidence.recentRunSamples.flatMap((run) => run.lapSamples ?? [])).toHaveLength(40)
    expect(evidence.selection).toMatchObject({ truncatedRuns: 10, truncatedLaps: 200 })
    expect(evidence.recentRunSamples[0].lapSamples?.[0]).toMatchObject({
      averagePace: { value: 300 },
      averageHr: { value: 160 },
    })
    expect(
      trainingContextSchema.safeParse({
        ...evidence,
        schemaVersion: 1,
        lifecycle: { firstPlanForAthlete: true, firstWorkoutInPlan: true },
      }).success,
    ).toBe(true)
  })
  it('preserves optional hilly/flat/surface/cadence information, and never exports raw provider data', () => {
    const evidence = build([
      runFixture(owner.userId, 1, {
        surfaceType: 'TRAIL',
        elevationGainMeters: new Prisma.Decimal(800),
      }),
      runFixture(owner.userId, 2, {
        surfaceType: null,
        sourceSportType: 'running',
        cadence: null,
        elevationGainMeters: null,
      }),
    ])
    expect(evidence.recentRunSamples[0]).toMatchObject({
      surface: 'TRAIL',
      elevationGain: { value: 800 },
      cadence: { unit: 'steps/min', value: 170 },
    })
    expect(evidence.recentRunSamples[1]).toMatchObject({
      surface: null,
      elevationGain: { value: null },
      cadence: { value: null },
    })
    const json = JSON.stringify(evidence)
    for (const field of ['rawObjectRef', 'gpsAssetRef', 'credentials', 'garminAccountId', 'userId'])
      expect(json).not.toContain(field)
  })
})
