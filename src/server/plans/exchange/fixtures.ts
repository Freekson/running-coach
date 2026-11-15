import { Prisma } from '@prisma/client'
import { addHealthDays } from '@/lib/health-history'
import type { OwnerContext } from '@/server/authorization/ownership'
import {
  exchangeRequestSchema,
  type ExchangeRequest,
  type ExchangeResponse,
} from '@/schemas/plan-exchange.v1'
import type { HistoryCoverage } from '@/schemas/training-context.v1'
import { buildTrainingEvidence, type EvidenceActivity } from './evidence'

export const fixtureNow = new Date('2026-11-15T03:00:00Z')
export function fixtureId(index: number) {
  return '00000000-0000-4000-8000-' + index.toString().padStart(12, '0')
}
export function coverageFixture(status: HistoryCoverage['status'] = 'sufficient'): HistoryCoverage {
  return {
    status,
    provider: 'GARMIN',
    timezone: 'Asia/Tokyo',
    window: status === 'absent' ? null : { startDate: '2026-08-23', endDate: '2026-11-14' },
    lastManualSyncAt: status === 'absent' ? null : '2026-11-15T02:00:00Z',
    completeWindows:
      status === 'sufficient' ? [{ startDate: '2026-08-23', endDate: '2026-11-14' }] : [],
    failedWindows: status === 'partial' ? [{ startDate: '2026-10-01', endDate: '2026-10-14' }] : [],
    unfetchedWindows:
      status === 'partial' ? [{ startDate: '2026-08-23', endDate: '2026-09-30' }] : [],
    label: 'recorded history only',
  }
}
export function runFixture(
  userId: string,
  index = 1,
  patch: Partial<EvidenceActivity> = {},
): EvidenceActivity {
  return {
    id: fixtureId(index),
    userId,
    sportType: 'RUNNING',
    sourceProvider: 'GARMIN',
    sourceSportType: 'street_running',
    surfaceType: 'ROAD',
    startedAt: new Date('2026-11-13T23:30:00Z'),
    sourceTimezone: 'Asia/Tokyo',
    sourceObservedAt: new Date('2026-11-15T02:00:00Z'),
    importedAt: new Date('2026-11-15T02:00:00Z'),
    distanceMeters: new Prisma.Decimal(5000),
    elapsedMs: BigInt(1900000),
    movingMs: BigInt(1800000),
    avgSpeedMps: null,
    avgHrBpm: 140,
    maxHrBpm: 160,
    cadence: new Prisma.Decimal(170),
    elevationGainMeters: new Prisma.Decimal(20),
    elevationLossMeters: new Prisma.Decimal(20),
    duplicateCandidate: false,
    laps: [],
    lapCount: 0,
    ...patch,
  }
}
const definition = {
  schemaVersion: 1 as const,
  name: 'Synthetic easy run',
  sport: 'RUNNING' as const,
  steps: [
    {
      type: 'step' as const,
      termination: { type: 'time' as const, durationSeconds: 1200 },
      target: { type: 'free' as const },
    },
  ],
}
export function initialFixture(
  owner: OwnerContext,
  records: EvidenceActivity[] = [],
  status: HistoryCoverage['status'] = 'absent',
): ExchangeRequest {
  return exchangeRequestSchema.parse({
    schemaVersion: 1,
    requestId: fixtureId(100),
    mode: 'initial',
    generatedAt: fixtureNow.toISOString(),
    athleteLocalDate: '2026-11-15',
    timezone: 'Asia/Tokyo',
    goal: {
      name: 'Synthetic arbitrary distance',
      type: 'COMPLETION',
      distanceMeters: 12345,
      targetTimeSeconds: null,
      targetCount: null,
      measurementWindow: null,
      targetDate: '2027-01-31',
      surface: 'ANY',
      elevationGainM: null,
    },
    draft: {
      draftId: fixtureId(101),
      version: 0,
      constraints: {
        sessionsPerWeek: 3,
        availableWeekdays: [0, 1, 2, 3, 4, 5, 6],
        maxSessionMinutes: 60,
        startDate: '2026-11-16',
        timezone: 'Asia/Tokyo',
      },
    },
    allowedDetailWindow: { startDate: '2026-11-16', endDate: '2026-12-13' },
    lockedDates: [],
    consent: {
      recordedActivityMetrics: true,
      activityHeartRate: true,
      recordedLaps: true,
      athleteReport: true,
      limitationsOrFatigue: false,
      recovery: false,
    },
    trainingContext: {
      schemaVersion: 1,
      lifecycle: { firstPlanForAthlete: true, firstWorkoutInPlan: true },
      ...buildTrainingEvidence(owner, records, {
        timezone: 'Asia/Tokyo',
        now: fixtureNow,
        coverage: coverageFixture(status),
        includeHeartRate: true,
        includeLaps: true,
      }),
    },
  })
}
export function initialResponseFixture(): Extract<ExchangeResponse, { mode: 'initial' }> {
  return {
    schemaVersion: 1,
    requestId: fixtureId(100),
    draftVersion: 0,
    mode: 'initial',
    macroPlan: {
      startDate: '2026-11-16',
      endDate: '2027-01-31',
      strategy: 'Conservative progression based on recent recorded load and uncertainty',
      phases: [
        {
          startDate: '2026-11-16',
          endDate: '2027-01-31',
          label: 'Gradual base',
          notes: 'Review load with the athlete; older PBs do not establish current form',
        },
      ],
    },
    detailWindow: { startDate: '2026-11-16', endDate: '2026-12-13' },
    workouts: [{ workoutId: fixtureId(200), scheduledDate: '2026-11-17', definition }],
    warnings: ['Recorded history may be incomplete. Explicit review is required.'],
  }
}
export function refreshFixture(owner: OwnerContext): ExchangeRequest {
  const initial = initialFixture(owner, [runFixture(owner.userId)], 'sufficient')
  const response = initialResponseFixture()
  return exchangeRequestSchema.parse({
    ...initial,
    mode: 'refresh',
    trainingContext: {
      ...initial.trainingContext,
      lifecycle: { firstPlanForAthlete: false, firstWorkoutInPlan: false },
    },
    currentApprovedRevision: {
      planId: fixtureId(300),
      revisionId: fixtureId(301),
      revisionNumber: 1,
      macroPlan: response.macroPlan,
      detailWindow: response.detailWindow,
      commitmentsCoverage: 'complete',
      workouts: [
        {
          workoutId: fixtureId(200),
          scheduledDate: '2026-11-17',
          definition,
          timezone: 'Asia/Tokyo',
          cancelled: false,
          completedAt: null,
          lockedAt: null,
          outcome: 'unknown',
          activityId: null,
        },
        {
          workoutId: fixtureId(201),
          scheduledDate: '2026-11-18',
          definition,
          timezone: 'Asia/Tokyo',
          cancelled: false,
          completedAt: null,
          lockedAt: '2026-11-15T02:00:00Z',
          outcome: 'unknown',
          activityId: null,
        },
        {
          workoutId: fixtureId(202),
          scheduledDate: '2026-11-14',
          definition,
          timezone: 'Asia/Tokyo',
          cancelled: false,
          completedAt: '2026-11-14T02:00:00Z',
          lockedAt: '2026-11-14T02:00:00Z',
          outcome: 'completed',
          activityId: null,
        },
      ],
    },
    allowedWorkoutIds: [fixtureId(200)],
    allowedCreateWorkoutIds: [fixtureId(203)],
  })
}
export function refreshResponseFixture(): ExchangeResponse {
  const response = initialResponseFixture()
  return {
    schemaVersion: response.schemaVersion,
    requestId: response.requestId,
    draftVersion: response.draftVersion,
    macroPlan: response.macroPlan,
    detailWindow: response.detailWindow,
    warnings: response.warnings,
    mode: 'refresh',
    baseRevisionId: fixtureId(301),
    baseRevisionNumber: 1,
    operations: [
      { operation: 'cancel', workoutId: fixtureId(200) },
      { operation: 'create', workoutId: fixtureId(203), scheduledDate: '2026-11-19', definition },
    ],
  }
}
export function validRequestFixtures(owner: OwnerContext): Record<string, ExchangeRequest> {
  const report = (
    experience: 'new_runner' | 'returning_runner' | 'currently_training' | 'unknown',
    firstWorkoutEver: boolean | null,
  ) => ({
    experience,
    firstWorkoutEver,
    provenance: {
      source: 'ATHLETE' as const,
      observedAt: fixtureNow.toISOString(),
      period: { startDate: '2026-11-15', endDate: '2026-11-15' },
      quality: 'reported' as const,
    },
  })
  const novice = initialFixture(owner)
  novice.trainingContext.athleteReport = report('new_runner', true)
  const returning = initialFixture(
    owner,
    [runFixture(owner.userId, 1, { startedAt: new Date('2025-01-01T00:00:00Z') })],
    'partial',
  )
  returning.trainingContext.athleteReport = {
    ...report('returning_runner', false),
    previousExperience: {
      value: 'Previously trained regularly; long break',
      provenance: report('unknown', null).provenance,
    },
    raceOrTestResults: [
      {
        kind: 'historical_pb',
        date: '2024-05-01',
        distanceMeters: 10000,
        elapsedSeconds: 2400,
        provenance: {
          ...report('unknown', null).provenance,
          period: { startDate: '2024-05-01', endDate: '2024-05-01' },
        },
      },
    ],
  }
  const regularRuns = Array.from({ length: 24 }, (_, index) =>
    runFixture(owner.userId, index + 1, {
      startedAt: new Date(addHealthDays('2026-11-14', -index * 2) + 'T00:00:00Z'),
      distanceMeters: new Prisma.Decimal(index === 23 ? 16000 : 5000),
    }),
  )
  const regular = initialFixture(owner, regularRuns, 'sufficient')
  regular.trainingContext.athleteReport = report('currently_training', false)
  const volunteered = initialFixture(owner, [runFixture(owner.userId)], 'sufficient')
  volunteered.consent.limitationsOrFatigue = true
  volunteered.consent.recovery = true
  volunteered.trainingContext.athleteReport = {
    ...report('unknown', null),
    easyEffort: {
      value: 'Conversational effort; no verified pace zones',
      provenance: report('unknown', null).provenance,
    },
    crossTraining: {
      value: 'One easy cycle each week',
      provenance: report('unknown', null).provenance,
    },
    preferredWorkoutTypes: {
      value: 'Easy runs and short strides',
      provenance: report('unknown', null).provenance,
    },
    limitationsOrFatigue: {
      value: 'Volunteered recent fatigue; prefers a lighter first week',
      provenance: report('unknown', null).provenance,
    },
    raceOrTestResults: [
      {
        date: '2026-11-01',
        distanceMeters: 3000,
        elapsedSeconds: 1000,
        kind: 'test',
        provenance: {
          ...report('unknown', null).provenance,
          period: { startDate: '2026-11-01', endDate: '2026-11-01' },
        },
      },
    ],
  }
  const healthMetric = (value: number | null, unit: 'bpm' | 'ms' | 's') => ({
    value,
    unit,
    provenance: {
      source: 'GARMIN' as const,
      observedAt: '2026-11-15T02:00:00Z',
      period: { startDate: '2026-11-14', endDate: '2026-11-14' },
      quality: value === null ? ('unavailable' as const) : ('recorded' as const),
    },
  })
  volunteered.trainingContext.recoveryContext = {
    consentSelected: true,
    timezone: 'Asia/Tokyo',
    coverage: { ...coverageFixture(), window: { startDate: '2026-11-14', endDate: '2026-11-14' } },
    days: [
      {
        date: '2026-11-14',
        restingHr: healthMetric(52, 'bpm'),
        hrv: healthMetric(null, 'ms'),
        sleepDuration: healthMetric(25200, 's'),
      },
    ],
  }
  const mixed = initialFixture(
    owner,
    [
      runFixture(owner.userId, 1, { avgHrBpm: null, maxHrBpm: null }),
      runFixture(owner.userId, 2, {
        distanceMeters: null,
        movingMs: null,
        elapsedMs: null,
        avgSpeedMps: new Prisma.Decimal(3),
      }),
      runFixture(owner.userId, 3, {
        surfaceType: 'TRAIL',
        elevationGainMeters: new Prisma.Decimal(500),
      }),
      runFixture(owner.userId, 4, { movingMs: BigInt(2000000), elapsedMs: BigInt(1000000) }),
      runFixture(owner.userId, 5, { sportType: 'CYCLING' }),
      runFixture(owner.userId, 6, { duplicateCandidate: true }),
    ],
    'sufficient',
  )
  return {
    'no-garmin-account': initialFixture(owner),
    'self-reported-novice': novice,
    'returning-long-break': returning,
    'regular-full-history': regular,
    'partial-import-failed': initialFixture(owner, [runFixture(owner.userId)], 'partial'),
    'mixed-missing-inconsistent': mixed,
    'empty-covered-history': initialFixture(owner, [], 'sufficient'),
    'consented-reports-and-recovery': volunteered,
    refresh: refreshFixture(owner),
  }
}
