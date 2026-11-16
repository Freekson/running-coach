import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  evidence: vi.fn(),
  recovery: vi.fn(),
  coverage: vi.fn(),
}))
vi.mock('../transaction', async (original) => ({
  ...(await original<typeof import('../transaction')>()),
  planTransaction: mocks.transaction,
}))
vi.mock('./evidence', async (original) => ({
  ...(await original<typeof import('./evidence')>()),
  readTrainingEvidence: mocks.evidence,
}))
vi.mock('./stored-context', async (original) => ({
  ...(await original<typeof import('./stored-context')>()),
  readStoredActivityCoverage: mocks.coverage,
  readStoredRecovery: mocks.recovery,
}))
import { getOwnerContext, OwnedResourceNotFoundError } from '@/server/authorization/ownership'
import { defaultExportConsent } from '@/lib/plan-export'
import {
  exchangeRequestSchema,
  EXCHANGE_LIMITS,
  responseSchemaForRequest,
} from '@/schemas/plan-exchange.v1'
import { addHealthDays } from '@/lib/health-history'
import { buildTrainingEvidence } from './evidence'
import {
  fixtureId,
  fixtureNow,
  coverageFixture,
  initialFixture,
  refreshFixture,
  refreshResponseFixture,
  runFixture,
} from './fixtures'
import { exportArtifact, getIssuedPlanExport, issuePlanExport } from './export'
import { RefreshWindowError } from '../transaction'

const owner = getOwnerContext({ id: fixtureId(900), role: 'USER', email: null })
const other = getOwnerContext({ id: fixtureId(901), role: 'ADMIN', email: null })
const initial = initialFixture(owner)
const draft = {
  id: initial.draft.draftId,
  userId: owner.userId,
  goalId: fixtureId(102),
  version: 0,
  state: 'DRAFT',
  ...initial.draft.constraints,
  startDate: new Date('2026-11-16'),
  baseRevisionId: null as string | null,
  planId: null as string | null,
}
const tx = {
  planDraft: { findFirst: vi.fn() },
  goal: { findFirst: vi.fn() },
  athleteProfile: { findUnique: vi.fn() },
  planRevision: { count: vi.fn(), findFirst: vi.fn() },
  trainingPlan: { findFirst: vi.fn() },
  planRevisionWorkout: { findMany: vi.fn() },
  planExchangeRequest: { create: vi.fn(), findFirst: vi.fn() },
}
const command = {
  draftId: draft.id,
  expectedVersion: 0,
  allowedDetailWindow: initial.allowedDetailWindow,
  consent: { ...defaultExportConsent },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(fixtureNow)
  mocks.transaction.mockImplementation((fn) => fn(tx))
  tx.planDraft.findFirst.mockImplementation(({ where }) =>
    where.userId === owner.userId
      ? Promise.resolve({ ...draft, baseRevisionId: null, planId: null })
      : Promise.resolve(null),
  )
  tx.goal.findFirst.mockResolvedValue({
    ...initial.goal,
    id: draft.goalId,
    distanceMeters: new Prisma.Decimal(initial.goal.distanceMeters!),
    targetDate: new Date(initial.goal.targetDate!),
  })
  tx.athleteProfile.findUnique.mockResolvedValue({ measurementSystem: 'IMPERIAL' })
  tx.planRevision.count.mockResolvedValue(0)
  tx.planExchangeRequest.create.mockImplementation(async ({ data }) => data)
  mocks.coverage.mockResolvedValue(coverageFixture())
  mocks.evidence.mockImplementation(async (context, options) =>
    buildTrainingEvidence(context, [runFixture(owner.userId)], options),
  )
})

function request(artifact: { json: string }) {
  return exchangeRequestSchema.parse(JSON.parse(artifact.json).request)
}

function mockRefresh() {
  const fixture = refreshFixture(owner)
  if (fixture.mode !== 'refresh') throw new Error('Wrong fixture')
  const base = { ...fixture.currentApprovedRevision, constraints: fixture.draft.constraints }
  const rows = base.workouts.map((w) => ({
    ...w,
    scheduledDate: new Date(w.scheduledDate),
    workout: {
      completedAt: w.completedAt ? new Date(w.completedAt) : null,
      lockedAt: w.lockedAt ? new Date(w.lockedAt) : null,
      completedActivityId: null,
    },
  }))
  tx.planDraft.findFirst.mockResolvedValue({
    ...draft,
    baseRevisionId: base.revisionId,
    planId: base.planId,
  })
  tx.trainingPlan.findFirst.mockResolvedValue({
    id: base.planId,
    currentRevisionId: base.revisionId,
  })
  tx.planRevision.findFirst.mockResolvedValue({
    id: base.revisionId,
    revisionNumber: base.revisionNumber,
    snapshot: base,
  })
  tx.planRevisionWorkout.findMany.mockResolvedValue(rows)
  return { base, rows }
}
afterEach(() => vi.useRealTimers())

describe('RUN-35 issued owner-bound request snapshots', () => {
  it.each([
    { label: 'after the macro end', startDate: '2027-02-01', endDate: '2027-02-14' },
    { label: 'overlapping the macro end', startDate: '2027-01-25', endDate: '2027-02-07' },
    { label: 'before the macro start', startDate: '2026-11-16', endDate: '2026-11-29' },
  ])('rejects an undated-goal refresh $label before issuing a request', async (window) => {
    const { base } = mockRefresh()
    tx.goal.findFirst.mockResolvedValue({
      ...initial.goal,
      id: draft.goalId,
      distanceMeters: new Prisma.Decimal(initial.goal.distanceMeters!),
      targetDate: null,
    })
    if (window.label === 'before the macro start') {
      base.constraints.startDate = null
      base.macroPlan.startDate = '2026-11-20'
      base.macroPlan.phases[0].startDate = '2026-11-20'
      tx.planDraft.findFirst.mockResolvedValue({
        ...draft,
        startDate: null,
        planId: base.planId,
        baseRevisionId: base.revisionId,
      })
      tx.planRevisionWorkout.findMany.mockResolvedValue([])
    }
    const { startDate, endDate } = window
    await expect(
      issuePlanExport(owner, { ...command, allowedDetailWindow: { startDate, endDate } }),
    ).rejects.toBeInstanceOf(RefreshWindowError)
    expect(tx.planExchangeRequest.create).not.toHaveBeenCalled()
  })
  it.each([
    { startDate: '2026-11-16', endDate: '2026-12-13' },
    { startDate: '2027-01-18', endDate: '2027-01-31' },
  ])(
    'accepts refresh windows touching the approved macro boundaries: $startDate',
    async (window) => {
      mockRefresh()
      const result = request(
        await issuePlanExport(owner, { ...command, allowedDetailWindow: window }),
      )
      expect(result.allowedDetailWindow).toEqual(window)
      expect(tx.planExchangeRequest.create).toHaveBeenCalledTimes(1)
    },
  )
  it('requires a legacy unfiltered refresh snapshot to be reissued before downstream use', async () => {
    const legacy = refreshFixture(owner)
    tx.planExchangeRequest.findFirst.mockResolvedValue({
      id: legacy.requestId,
      draftId: legacy.draft.draftId,
      snapshot: legacy,
    })
    await expect(getIssuedPlanExport(owner, legacy.requestId)).rejects.toThrow('changed')
  })
  it.each([false, true])(
    'withholds prior approved free text in JSON, prompt and saved snapshot even with current report consent %s',
    async (includeReport) => {
      const { base, rows } = mockRefresh()
      const secret = 'PRIVATE prior injury and sleep feedback'
      base.macroPlan.strategy = secret
      base.macroPlan.phases[0].label = secret
      base.macroPlan.phases[0].notes = secret
      rows[0].definition = {
        ...rows[0].definition,
        name: secret,
        steps: [
          {
            type: 'repeat',
            count: 2,
            steps: [
              {
                type: 'step',
                name: secret,
                termination: { type: 'time', durationSeconds: 120 },
                target: { type: 'free' },
              },
            ],
          },
        ],
      }
      const before = JSON.stringify({ base, rows })
      const artifact = await issuePlanExport(owner, {
        ...command,
        consent: {
          ...command.consent,
          athleteReport: includeReport,
          limitationsOrFatigue: includeReport,
        },
        background: {
          experience: 'unknown',
          firstWorkoutEver: null,
          limitationsOrFatigue: 'New voluntarily selected report',
        },
      })
      expect(artifact.json).not.toContain(secret)
      expect(artifact.prompt).not.toContain(secret)
      expect(
        JSON.stringify(tx.planExchangeRequest.create.mock.calls[0][0].data.snapshot),
      ).not.toContain(secret)
      expect(artifact.prompt.includes('New voluntarily selected report')).toBe(includeReport)
      const snapshot = request(artifact)
      if (snapshot.mode !== 'refresh') throw new Error('Wrong mode')
      expect(snapshot.currentApprovedRevision.narrativePolicy).toBe('withheld')
      expect(snapshot.currentApprovedRevision.workouts[0].definition.steps).toEqual([
        {
          type: 'repeat',
          count: 2,
          steps: [
            {
              type: 'step',
              termination: { type: 'time', durationSeconds: 120 },
              target: { type: 'free' },
            },
          ],
        },
      ])
      expect(JSON.stringify({ base, rows })).toBe(before)
    },
  )
  it('exports more than 200 retained commitments with explicit bounded history and complete validation context', async () => {
    const { rows } = mockRefresh()
    const old = Array.from({ length: 240 }, (_, i) => ({
      ...rows[0],
      workoutId: fixtureId(i + 500),
      scheduledDate: new Date(addHealthDays('2026-11-01', -i)),
      cancelled: i % 2 === 0,
    }))
    const future = { ...rows[0], workoutId: fixtureId(800), scheduledDate: new Date('2026-12-20') }
    const records = [...old, ...rows, future]
    tx.planRevisionWorkout.findMany.mockResolvedValue(records)
    const before = JSON.stringify(records)
    const snapshot = request(await issuePlanExport(owner, command))
    if (snapshot.mode !== 'refresh') throw new Error('Wrong mode')
    expect(snapshot.currentApprovedRevision.workouts).toHaveLength(24)
    expect(snapshot.currentApprovedRevision.omittedHistoricalCommitments).toBe(220)
    expect(snapshot.currentApprovedRevision.commitmentsCoverage).toBe('partial')
    const ids = snapshot.currentApprovedRevision.workouts.map((w) => w.workoutId)
    for (const row of [...rows, future]) expect(ids).toContain(row.workoutId)
    expect(snapshot.allowedWorkoutIds).not.toContain(future.workoutId)
    const response = refreshResponseFixture()
    if (response.mode !== 'refresh') throw new Error('Wrong response')
    response.requestId = snapshot.requestId
    response.operations = response.operations.map((op) =>
      op.operation === 'create' ? { ...op, workoutId: snapshot.allowedCreateWorkoutIds[0] } : op,
    )
    expect(() => responseSchemaForRequest(snapshot).parse(response)).not.toThrow()
    expect(JSON.stringify(records)).toBe(before)
  })
  it('omits an oversized optional past prescription instead of failing an otherwise valid refresh', async () => {
    const { rows } = mockRefresh()
    const step = {
      type: 'step',
      termination: { type: 'time', durationSeconds: 60 },
      target: { type: 'free' },
    }
    const old = {
      ...rows[0],
      workoutId: fixtureId(500),
      scheduledDate: new Date('2026-11-01'),
      definition: {
        schemaVersion: 1,
        name: 'Old large workout',
        sport: 'RUNNING',
        steps: [
          {
            type: 'repeat',
            count: 2,
            steps: Array.from({ length: 100 }, () => ({
              type: 'repeat',
              count: 2,
              steps: Array.from({ length: 100 }, () => step),
            })),
          },
        ],
      },
    }
    tx.planRevisionWorkout.findMany.mockResolvedValue([...rows, old])
    const artifact = await issuePlanExport(owner, command)
    const snapshot = request(artifact)
    if (snapshot.mode !== 'refresh') throw new Error('Wrong mode')
    expect(snapshot.currentApprovedRevision.workouts).toHaveLength(3)
    expect(snapshot.currentApprovedRevision.omittedHistoricalCommitments).toBe(1)
    expect(snapshot.currentApprovedRevision.commitmentsCoverage).toBe('partial')
    expect(artifact.bytes).toBeLessThanOrEqual(EXCHANGE_LIMITS.requestBytes)
  })
  it('exports repeated replacement refreshes with over 200 cancelled window identities', async () => {
    const { rows } = mockRefresh()
    const cancelled = Array.from({ length: 240 }, (_, index) => ({
      ...rows[0],
      workoutId: fixtureId(1000 + index),
      cancelled: true,
    }))
    tx.planRevisionWorkout.findMany.mockResolvedValue([...cancelled, ...rows])
    const snapshot = request(await issuePlanExport(owner, command))
    if (snapshot.mode !== 'refresh') throw new Error('Wrong mode')
    expect(snapshot.currentApprovedRevision.workouts).toHaveLength(23)
    expect(snapshot.currentApprovedRevision.omittedHistoricalCommitments).toBe(220)
    expect(snapshot.currentApprovedRevision.commitmentsCoverage).toBe('partial')
    expect(snapshot.allowedWorkoutIds).toEqual([rows[0].workoutId])
    const response = refreshResponseFixture()
    if (response.mode !== 'refresh') throw new Error('Wrong response')
    response.requestId = snapshot.requestId
    response.operations = response.operations.map((op) =>
      op.operation === 'create' ? { ...op, workoutId: snapshot.allowedCreateWorkoutIds[0] } : op,
    )
    expect(() => responseSchemaForRequest(snapshot).parse(response)).not.toThrow()
  })
  it('uses one filtered snapshot for persisted JSON and prompt, with default-off consent', async () => {
    const artifact = await issuePlanExport(owner, {
      ...command,
      background: {
        experience: 'returning_runner',
        firstWorkoutEver: false,
        limitationsOrFatigue: 'PRIVATE-PAIN',
        easyEffort: 'PRIVATE-EASY',
      },
    })
    const snapshot = request(artifact)
    expect(snapshot.measurementSystem).toBe('IMPERIAL')
    expect(snapshot.trainingContext.recentRunSamples).toEqual([])
    expect(
      snapshot.trainingContext.recentTrainingSummary.weeks.every((w) => w.distance.value === null),
    ).toBe(true)
    expect(snapshot.trainingContext.athleteReport).toBeUndefined()
    expect(snapshot.trainingContext.recoveryContext).toBeUndefined()
    expect(snapshot.trainingContext.lastRecordedRunAt).toBeNull()
    expect(snapshot.trainingContext.activityHistoryCoverage.status).toBe('sufficient')
    expect(artifact.prompt).toContain(artifact.json)
    expect(artifact.prompt).not.toContain('PRIVATE-')
    expect(mocks.evidence).not.toHaveBeenCalled()
    expect(mocks.recovery).not.toHaveBeenCalled()
    expect(tx.planExchangeRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: artifact.requestId,
        userId: owner.userId,
        goalId: draft.goalId,
        draftId: draft.id,
        draftVersion: 0,
        schemaVersion: 1,
        snapshot,
      }),
    })
  })
  it('does not let ADMIN reference another owner draft or issued request', async () => {
    await expect(issuePlanExport(other, command)).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    expect(tx.planExchangeRequest.create).not.toHaveBeenCalled()
    tx.planExchangeRequest.findFirst.mockResolvedValue(null)
    await expect(getIssuedPlanExport(other, fixtureId(100))).rejects.toBeInstanceOf(
      OwnedResourceNotFoundError,
    )
    expect(tx.planExchangeRequest.findFirst).toHaveBeenCalledWith({
      where: { id: fixtureId(100), userId: other.userId },
    })
    await expect(issuePlanExport({ userId: owner.userId }, command)).rejects.toThrow(
      'Verified owner context',
    )
  })
  it.each(['new_runner', 'returning_runner', 'currently_training', 'unknown'] as const)(
    'keeps %s explicit without deriving experience from records or profile defaults',
    async (experience) => {
      const artifact = await issuePlanExport(owner, {
        ...command,
        consent: { ...command.consent, athleteReport: true },
        background: {
          experience,
          firstWorkoutEver: experience === 'new_runner' ? true : null,
          previousExperience: 'Ten years running; break since May',
          easyEffort: 'Easy 6:30/km, conversational',
          limitationsOrFatigue: 'PRIVATE-PAIN',
          raceOrTestResults: [
            {
              date: '2025-04-01',
              distanceMeters: 5000,
              elapsedSeconds: 1500,
              kind: 'historical_pb',
            },
            { date: '2026-01-01', distanceMeters: 10000, elapsedSeconds: 3200, kind: 'race' },
          ],
        },
      })
      const context = request(artifact).trainingContext
      expect(context.athleteReport?.experience).toBe(experience)
      expect(context.athleteReport?.raceOrTestResults).toHaveLength(2)
      expect(context.athleteReport?.easyEffort?.value).toContain('conversational')
      expect(context.athleteReport?.limitationsOrFatigue).toBeUndefined()
      expect(context.lifecycle).toEqual({ firstPlanForAthlete: true, firstWorkoutInPlan: true })
      expect(context.lastRecordedRunAt).toBeNull()
      expect(artifact.prompt).not.toContain('PRIVATE-PAIN')
    },
  )
  it('pairs recorded pace/HR only when consented and includes selected limitations', async () => {
    const artifact = await issuePlanExport(owner, {
      ...command,
      consent: {
        ...command.consent,
        recordedActivityMetrics: true,
        athleteReport: true,
        limitationsOrFatigue: true,
      },
      background: {
        experience: 'currently_training',
        firstWorkoutEver: false,
        limitationsOrFatigue: 'Reported sore calf',
      },
    })
    const sample = request(artifact).trainingContext.recentRunSamples[0]
    expect(sample.averagePace.value).toBe(360)
    expect(
      request(artifact).trainingContext.recentTrainingSummary.rollingTotals[0].movingDuration
        ?.value,
    ).toBe(1800)
    expect(
      request(artifact).trainingContext.recentTrainingSummary.rollingTotals[0].duration.value,
    ).toBe(1900)
    expect(sample.averageHr.value).toBeNull()
    expect(sample.lapSamples).toBeNull()
    expect(artifact.prompt).toContain('Reported sore calf')
    const hr = request(
      await issuePlanExport(owner, {
        ...command,
        consent: { ...command.consent, recordedActivityMetrics: true, activityHeartRate: true },
      }),
    )
    expect(hr.trainingContext.recentRunSamples[0].averageHr.value).toBe(140)
  })
  it('keeps no records / failed or unknown coverage distinct from zero training', async () => {
    mocks.coverage.mockResolvedValue(coverageFixture('partial'))
    mocks.evidence.mockImplementation(async (context, options) =>
      buildTrainingEvidence(context, [], options),
    )
    const snapshot = request(
      await issuePlanExport(owner, {
        ...command,
        consent: { ...command.consent, recordedActivityMetrics: true },
      }),
    )
    expect(snapshot.trainingContext.lastRecordedRunAt).toBeNull()
    expect(snapshot.trainingContext.daysSinceLastRecordedRun.value).toBeNull()
    expect(snapshot.trainingContext.activityHistoryCoverage.failedWindows).not.toEqual([])
    expect(
      snapshot.trainingContext.recentTrainingSummary.rollingTotals.every(
        (t) => t.distance.value === null,
      ),
    ).toBe(true)
    expect(snapshot.trainingContext.athleteReport).toBeUndefined()
  })
  it('rejects stale versions, unknown owner input and invalid goal/date windows before issuing', async () => {
    await expect(issuePlanExport(owner, { ...command, expectedVersion: 10 })).rejects.toThrow(
      'changed',
    )
    await expect(issuePlanExport(owner, { ...command, userId: other.userId })).rejects.toThrow()
    await expect(
      issuePlanExport(owner, {
        ...command,
        allowedDetailWindow: { startDate: '2027-02-01', endDate: '2027-03-01' },
      }),
    ).rejects.toThrow()
    expect(tx.planExchangeRequest.create).not.toHaveBeenCalled()
  })
  it('refresh preserves actual completion/locks and never labels unlinked activities as completed plans', async () => {
    const refresh = refreshFixture(owner)
    if (refresh.mode !== 'refresh') throw new Error('Wrong fixture')
    const base = { ...refresh.currentApprovedRevision, constraints: refresh.draft.constraints }
    tx.planDraft.findFirst.mockResolvedValue({
      ...draft,
      baseRevisionId: base.revisionId,
      planId: base.planId,
    })
    tx.trainingPlan.findFirst.mockResolvedValue({
      id: base.planId,
      currentRevisionId: base.revisionId,
    })
    tx.planRevision.findFirst.mockResolvedValue({
      id: base.revisionId,
      revisionNumber: base.revisionNumber,
      snapshot: base,
    })
    tx.planRevisionWorkout.findMany.mockResolvedValue(
      base.workouts.map((w) => ({
        ...w,
        scheduledDate: new Date(w.scheduledDate),
        workout: {
          completedAt: w.completedAt ? new Date(w.completedAt) : null,
          lockedAt: w.lockedAt ? new Date(w.lockedAt) : null,
          completedActivityId: null,
        },
      })),
    )
    const result = request(await issuePlanExport(owner, command))
    expect(result.mode).toBe('refresh')
    if (result.mode !== 'refresh') throw new Error('Wrong mode')
    expect(result.currentApprovedRevision.workouts.map((w) => w.workoutId)).toEqual(
      base.workouts.map((w) => w.workoutId),
    )
    expect(result.currentApprovedRevision.workouts.every((w) => w.activityId === null)).toBe(true)
    expect(result.trainingContext.lifecycle.firstWorkoutInPlan).toBe(false)
    expect(tx.planExchangeRequest.create).toHaveBeenCalledTimes(1)
  })
  it('caps deterministic samples/laps and the serialized JSON and prompt', async () => {
    const records = Array.from({ length: 30 }, (_, i) =>
      runFixture(owner.userId, i + 1, {
        laps: Array.from({ length: 8 }, (_, lapIndex) => ({
          lapIndex,
          sourceRecordType: 'FIT_LAP',
          startedAt: null,
          distanceMeters: new Prisma.Decimal(400),
          elapsedMs: BigInt(120000),
          movingMs: BigInt(120000),
          avgSpeedMps: null,
          avgHrBpm: 160,
        })),
        lapCount: 12,
      }),
    )
    const context = buildTrainingEvidence(owner, records, {
      timezone: 'Asia/Tokyo',
      now: fixtureNow,
      coverage: coverageFixture(),
      includeHeartRate: true,
      includeLaps: true,
    })
    expect(context.recentRunSamples).toHaveLength(20)
    expect(context.recentRunSamples.flatMap((r) => r.lapSamples ?? [])).toHaveLength(40)
    expect(context.selection.truncatedRuns).toBe(10)
    expect(context.selection.truncatedLaps).toBe(200)
    expect(
      buildTrainingEvidence(owner, [...records].reverse(), {
        timezone: 'Asia/Tokyo',
        now: fixtureNow,
        coverage: coverageFixture(),
        includeHeartRate: true,
        includeLaps: true,
      }),
    ).toEqual(context)
    const artifact = exportArtifact({
      ...initial,
      trainingContext: { ...initial.trainingContext, ...context },
    })
    expect(artifact.bytes).toBeLessThanOrEqual(EXCHANGE_LIMITS.requestBytes)
    expect(new TextEncoder().encode(artifact.prompt).byteLength).toBeLessThanOrEqual(
      EXCHANGE_LIMITS.requestBytes,
    )
    expect(artifact.bytes).toBe(new TextEncoder().encode(artifact.json).byteLength)
  })
  it('rejects an oversized required-future package before writing a snapshot', async () => {
    const refresh = refreshFixture(owner)
    if (refresh.mode !== 'refresh') throw new Error('Wrong fixture')
    const base = { ...refresh.currentApprovedRevision, constraints: refresh.draft.constraints }
    tx.planDraft.findFirst.mockResolvedValue({
      ...draft,
      baseRevisionId: base.revisionId,
      planId: base.planId,
    })
    tx.trainingPlan.findFirst.mockResolvedValue({
      id: base.planId,
      currentRevisionId: base.revisionId,
    })
    tx.planRevision.findFirst.mockResolvedValue({
      id: base.revisionId,
      revisionNumber: base.revisionNumber,
      snapshot: base,
    })
    const definition = {
      schemaVersion: 1,
      name: 'Synthetic large prescription',
      sport: 'RUNNING',
      steps: Array.from({ length: 100 }, () => ({
        type: 'step',
        name: 'Synthetic step '.repeat(10),
        termination: { type: 'time', durationSeconds: 60 },
        target: { type: 'free' },
      })),
    }
    tx.planRevisionWorkout.findMany.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => ({
        workoutId: fixtureId(index + 500),
        scheduledDate: new Date('2026-11-17'),
        timezone: 'Asia/Tokyo',
        definition,
        cancelled: false,
        workout: { completedAt: null, lockedAt: null, completedActivityId: null },
      })),
    )
    await expect(issuePlanExport(owner, command)).rejects.toThrow('byte limit')
    expect(tx.planExchangeRequest.create).not.toHaveBeenCalled()
  })
})
