import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPrismaClient } from '@/server/db/client'
import { testGarminAccountId } from '@/server/garmin/test-identity'
import {
  getOwnerContext,
  InvalidOwnerContextError,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'
import { createPlanDraft } from '@/server/plans/drafts'
import {
  approvePlanDraft,
  createPlanRefreshDraft,
  saveGeneratedPlan,
  validateGeneratedPlan,
  lockPlannedWorkout,
} from '@/server/plans/revisions'
import { rescheduleCalendarWorkout, getTrainingCalendar } from '@/server/plans/calendar'
import { PlanConflictError } from '@/server/plans/transaction'
import { contentFixture, constraintsFixture } from '@/server/plans/fixtures'
import { projectCommitment } from '@/server/plans/exchange/refresh-context'
import { workoutCompletionAt } from '@/server/plans/completion'
import { disconnectProvider, deleteAllImportedGarminData } from '@/server/provider/vault'
import { canonicalActivitySchema } from './normalization'
import { importCanonicalActivity } from './import'
import { ActivityMatchError, getActivityMatching, linkActivity, unlinkActivity } from './matching'

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
const requested = process.env.npm_lifecycle_event === 'test:db'
if (requested) config()
const enabled =
  requested &&
  ['test', 'development'].includes(process.env.APP_DATABASE_ENV ?? '') &&
  !!process.env.DATABASE_URL &&
  !!process.env.DIRECT_URL &&
  !process.env.VERCEL_ENV
if (requested && !enabled) throw new Error('Isolated development/test database required')

describe.skipIf(!enabled)('RUN-42 matching on PostgreSQL', () => {
  let prisma: PrismaClient, owner: OwnerContext, other: OwnerContext, goalId: string
  const prefix = `run42-${randomUUID()}`
  beforeAll(async () => {
    prisma = await getPrismaClient()
  }, 30000)
  beforeEach(async () => {
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-${randomUUID()}` } })
    const b = await prisma.user.create({
      data: { authSubject: `${prefix}-${randomUUID()}`, role: 'ADMIN' },
    })
    owner = getOwnerContext({ id: a.id, role: 'USER', email: null })
    other = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
    await prisma.integrationConnection.create({
      data: {
        userId: a.id,
        provider: 'GARMIN',
        authMethod: 'API_KEY',
        externalAccountId: testGarminAccountId(owner),
        status: 'CONNECTED',
      },
    })
    await prisma.athleteProfile.create({ data: { userId: a.id, preferredTimezone: 'Asia/Tokyo' } })
    goalId = (
      await prisma.goal.create({
        data: {
          userId: a.id,
          name: 'Synthetic matching goal',
          type: 'COMPLETION',
          distanceMeters: 12000,
          surface: 'ANY',
          targetDate: new Date('2090-03-31'),
        },
      })
    ).id
  })
  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
    await prisma.$disconnect()
  })
  async function approve(content = contentFixture(), timezone = 'Asia/Tokyo') {
    const draft = await createPlanDraft(owner, {
      goalId,
      constraints: { ...constraintsFixture, timezone },
    })
    const saved = await saveGeneratedPlan(owner, { draftId: draft.id, expectedVersion: 0 }, content)
    const valid = await validateGeneratedPlan(owner, {
      draftId: draft.id,
      expectedVersion: saved.version,
    })
    const revision = await approvePlanDraft(owner, {
      draftId: draft.id,
      expectedVersion: valid.version,
      expectedRevisionId: null,
      approve: true,
    })
    return { revision, content }
  }
  function payload(externalActivityId: string = randomUUID()) {
    return canonicalActivitySchema.parse({
      source: {
        userId: owner.userId,
        provider: 'GARMIN',
        externalActivityId,
        externalActivityUuid: null,
        recordType: 'API_ACTIVITY',
      },
      sportType: 'RUNNING',
      sourceSportType: 'running',
      startedAt: '2090-01-04T23:30:00Z',
      sourceTimezone: 'UTC',
      gpsAssetRef: null,
      distanceMeters: 5000,
      totalMs: 1800000,
      elapsedMs: 2000000,
      movingMs: null,
      avgSpeedMps: null,
      avgHrBpm: 140,
      maxHrBpm: null,
      cadenceStepsPerMinute: null,
      elevationGainMeters: null,
      elevationLossMeters: null,
      laps: [
        {
          lapIndex: 0,
          startedAt: null,
          distanceMeters: 1000,
          timerMs: 360000,
          elapsedMs: 400000,
          movingMs: null,
          avgHrBpm: 145,
          maxHrBpm: null,
          avgSpeedMps: null,
          cadenceStepsPerMinute: null,
          sourceRecordType: 'FIT_LAP',
        },
      ],
    })
  }
  async function activity(input = payload()) {
    return importCanonicalActivity(owner, input, { garminAccountId: testGarminAccountId(owner) })
  }
  function command(
    activityId: string,
    approved: Awaited<ReturnType<typeof approve>>,
    index = 0,
    expectedWorkoutId: string | null = null,
  ) {
    return {
      activityId,
      planId: approved.revision.planId,
      expectedRevisionId: approved.revision.id,
      workoutId: approved.content.workouts[index].workoutId,
      expectedWorkoutId,
    }
  }
  async function read(activityId: string, who = owner) {
    return getActivityMatching(who, { activityId })
  }

  it('suggests one local-date/sport/metric match without silently linking or requiring Intervals', async () => {
    const approved = await approve(),
      a = await activity()
    const data = await read(a.id)
    expect(data.localDate).toBe('2090-01-05')
    expect(data.suggestionWorkoutId).toBe(approved.content.workouts[0].workoutId)
    expect(data.linked).toBeNull()
    expect(await prisma.workoutPublication.count({ where: { userId: owner.userId } })).toBe(0)
    await linkActivity(owner, command(a.id, approved))
    const linked = await read(a.id)
    expect(linked.linked?.comparison?.revisionId).toBe(approved.revision.id)
    expect(linked.actual).toMatchObject({
      distanceMeters: 5000,
      durationSeconds: 1800,
      paceSecondsPerKm: 360,
      maxHrBpm: null,
    })
    expect(linked.laps[0]).toMatchObject({
      durationSeconds: 360,
      paceSecondsPerKm: 360,
      sourceRecordType: 'FIT_LAP',
    })
    expect(await prisma.syncRun.count({ where: { userId: owner.userId } })).toBe(0)
    const calendar = await getTrainingCalendar(
      owner,
      { date: '2090-01-05' },
      new Date('2090-01-06'),
    )
    expect(
      calendar.days
        .flatMap((d) => d.workouts)
        .find((w) => w.id === approved.content.workouts[0].workoutId)?.status,
    ).toBe('completed')
  })
  it('leaves multiple plausible candidates unlinked regardless of metric rankings, allowing explicit correction', async () => {
    const content = contentFixture()
    content.workouts.push({ ...content.workouts[0], workoutId: randomUUID() })
    const approved = await approve(content),
      a = await activity()
    expect(await read(a.id)).toMatchObject({
      ambiguous: true,
      suggestionWorkoutId: null,
      linked: null,
    })
    await linkActivity(owner, command(a.id, approved, 1))
    const old = await prisma.plannedWorkout.findUniqueOrThrow({
      where: { id: content.workouts[1].workoutId },
    })
    await linkActivity(owner, command(a.id, approved, 0, old.id))
    expect((await read(a.id)).linked?.workoutId).toBe(content.workouts[0].workoutId)
    expect(await prisma.plannedWorkout.findUnique({ where: { id: old.id } })).toMatchObject({
      completedActivityId: null,
      completedRevisionId: null,
      completedAt: old.completedAt,
      lockedAt: old.lockedAt,
      completionAt: null,
      completionFromActivity: true,
    })
    const calendar = await getTrainingCalendar(owner, { date: '2090-01-05' })
    const workouts = calendar.days
      .flatMap((d) => d.workouts)
      .filter((w) => w.planId === approved.revision.planId)
    expect(workouts.filter((w) => w.status === 'completed').map((w) => w.id)).toEqual([
      content.workouts[0].workoutId,
    ])
    const previousMember = await prisma.planRevisionWorkout.findFirstOrThrow({
      where: { userId: owner.userId, revisionId: approved.revision.id, workoutId: old.id },
      include: { workout: true },
    })
    expect(projectCommitment(previousMember, true)).toMatchObject({
      outcome: 'unknown',
      completedAt: null,
      activityId: null,
    })
    await unlinkActivity(owner, {
      activityId: a.id,
      expectedWorkoutId: content.workouts[0].workoutId,
    })
    expect((await read(a.id)).linked).toBeNull()
    const afterUnlink = await getTrainingCalendar(owner, { date: '2090-01-05' })
    expect(
      afterUnlink.days
        .flatMap((d) => d.workouts)
        .filter((w) => w.planId === approved.revision.planId && w.status === 'completed'),
    ).toHaveLength(0)
  })
  it('supports manual overrides for nearby dates and sparse activities without inventing metrics', async () => {
    const content = contentFixture()
    content.workouts[0].scheduledDate = '2090-01-10'
    const approved = await approve(content)
    const input = payload()
    input.totalMs = null
    input.distanceMeters = null
    input.laps = null
    const a = await activity(input)
    const data = await read(a.id)
    expect(data.suggestionWorkoutId).toBeNull()
    expect(data.actual.paceSecondsPerKm).toBeNull()
    expect(data.laps).toEqual([])
    expect(
      (await getActivityMatching(owner, { activityId: a.id, date: '2090-02-10' })).candidates,
    ).toHaveLength(0)
    await linkActivity(owner, command(a.id, approved))
    expect((await read(a.id)).linked?.comparison?.date).toBe('2090-01-10')
  })
  it('rejects another USER/ADMIN owner, missing activity, wrong nested workout and forged contexts', async () => {
    const approved = await approve(),
      a = await activity(),
      input = command(a.id, approved)
    await expect(read(a.id, other)).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    await expect(linkActivity(other, input)).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    await expect(
      linkActivity(owner, { ...input, activityId: randomUUID() }),
    ).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    const foreignGoal = await prisma.goal.create({
      data: { userId: other.userId, name: 'Other owner', type: 'COMPLETION', surface: 'ANY' },
    })
    const foreignPlan = await prisma.trainingPlan.create({
      data: { userId: other.userId, goalId: foreignGoal.id },
    })
    await expect(linkActivity(owner, { ...input, planId: foreignPlan.id })).rejects.toBeInstanceOf(
      OwnedResourceNotFoundError,
    )
    const foreignWorkout = await prisma.plannedWorkout.create({
      data: { userId: other.userId, planId: foreignPlan.id },
    })
    await expect(
      linkActivity(owner, { ...input, workoutId: foreignWorkout.id }),
    ).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    await expect(linkActivity({ userId: owner.userId }, input)).rejects.toBeInstanceOf(
      InvalidOwnerContextError,
    )
    await linkActivity(owner, input)
    await expect(
      unlinkActivity(other, { activityId: a.id, expectedWorkoutId: input.workoutId }),
    ).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
  })
  it('rejects stale revision and stale link writes after schedule changes', async () => {
    const approved = await approve(),
      a = await activity(),
      input = command(a.id, approved)
    const nextId = await rescheduleCalendarWorkout(
      owner,
      {
        planId: input.planId,
        expectedRevisionId: input.expectedRevisionId,
        workoutId: input.workoutId,
        scheduledDate: '2090-01-06',
        timezone: 'Asia/Tokyo',
      },
      new Date('2089-12-30'),
    )
    await expect(linkActivity(owner, input)).rejects.toBeInstanceOf(PlanConflictError)
    await linkActivity(owner, { ...input, expectedRevisionId: nextId })
    await expect(
      linkActivity(owner, { ...input, expectedRevisionId: nextId }),
    ).rejects.toBeInstanceOf(PlanConflictError)
    await expect(
      unlinkActivity(owner, { activityId: a.id, expectedWorkoutId: randomUUID() }),
    ).rejects.toBeInstanceOf(PlanConflictError)
  })
  it('preserves stable association and pinned prescription across reimports, disconnect and new plan revisions', async () => {
    const content = contentFixture()
    content.workouts.push({
      ...content.workouts[0],
      workoutId: randomUUID(),
      scheduledDate: '2090-01-12',
    })
    const approved = await approve(content),
      raw = payload(),
      a = await activity(raw)
    await linkActivity(owner, command(a.id, approved))
    expect((await activity({ ...raw, avgHrBpm: 151 })).id).toBe(a.id)
    const movedId = await rescheduleCalendarWorkout(
      owner,
      {
        planId: approved.revision.planId,
        expectedRevisionId: approved.revision.id,
        workoutId: content.workouts[1].workoutId,
        scheduledDate: '2090-01-13',
        timezone: 'UTC',
      },
      new Date('2089-12-30'),
    )
    const draft = await createPlanRefreshDraft(owner, {
      planId: approved.revision.planId,
      baseRevisionId: movedId,
    })
    const refresh = structuredClone(content)
    refresh.workouts = []
    const saved = await saveGeneratedPlan(
      owner,
      { draftId: draft.id, expectedVersion: draft.version },
      refresh,
    )
    const validated = await validateGeneratedPlan(owner, {
      draftId: draft.id,
      expectedVersion: saved.version,
    })
    const next = await approvePlanDraft(owner, {
      draftId: draft.id,
      expectedVersion: validated.version,
      expectedRevisionId: movedId,
      approve: true,
    })
    expect(next.id).not.toBe(approved.revision.id)
    await disconnectProvider(owner, 'GARMIN')
    const data = await read(a.id)
    expect(data.linked?.comparison).toMatchObject({
      revisionId: approved.revision.id,
      date: '2090-01-05',
    })
    expect(data.actual.avgHrBpm).toBe(151)
    await unlinkActivity(owner, {
      activityId: a.id,
      expectedWorkoutId: content.workouts[0].workoutId,
    })
    await linkActivity(owner, { ...command(a.id, approved), expectedRevisionId: next.id })
    expect((await read(a.id)).linked?.comparison?.revisionId).toBe(next.id)
  })
  it('blocks incompatible sports, cancelled sessions and non-Garmin sources', async () => {
    const content = contentFixture()
    content.workouts[0].definition.sport = 'CYCLING'
    const approved = await approve(content),
      a = await activity()
    expect((await read(a.id)).candidates).toHaveLength(0)
    await expect(linkActivity(owner, command(a.id, approved))).rejects.toBeInstanceOf(
      ActivityMatchError,
    )
    const cancelled = contentFixture()
    cancelled.workouts[0].cancelled = true
    const cancelledPlan = await approve(cancelled)
    await expect(linkActivity(owner, command(a.id, cancelledPlan))).rejects.toBeInstanceOf(
      OwnedResourceNotFoundError,
    )
    const raw = payload()
    raw.source.provider = 'INTERVALS'
    const legacy = await activity(raw)
    await expect(read(legacy.id)).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
  })
  it('suppresses duplicate suggestions and prevents double-counting transitive flagged groups', async () => {
    const content = contentFixture()
    content.workouts.push({ ...content.workouts[0], workoutId: randomUUID() })
    const approved = await approve(content),
      a = await activity(),
      b = await activity()
    const raw = payload()
    raw.source.provider = 'INTERVALS'
    const legacy = await activity(raw)
    // Import automatically flags the matching cross-provider records.
    expect((await read(a.id)).duplicateCount).toBe(2)
    expect((await read(a.id)).suggestionWorkoutId).toBeNull()
    await linkActivity(owner, command(a.id, approved))
    expect((await read(b.id)).duplicateLinked).toBe(true)
    await expect(linkActivity(owner, command(b.id, approved, 1))).rejects.toBeInstanceOf(
      ActivityMatchError,
    )
    await unlinkActivity(owner, {
      activityId: a.id,
      expectedWorkoutId: content.workouts[0].workoutId,
    })
    await linkActivity(owner, command(b.id, approved, 1))
    expect(
      await prisma.plannedWorkout.count({
        where: { userId: owner.userId, completedActivityId: { in: [a.id, b.id, legacy.id] } },
      }),
    ).toBe(1)
  })
  it('serializes competing activity links to one workout', async () => {
    const approved = await approve(),
      a = await activity(),
      b = await activity()
    const results = await Promise.allSettled([
      linkActivity(owner, command(a.id, approved)),
      linkActivity(owner, command(b.id, approved)),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(
      await prisma.plannedWorkout.count({
        where: { userId: owner.userId, completedActivityId: { not: null } },
      }),
    ).toBe(1)
  })
  it('serializes simultaneous duplicate links even when they target different plans', async () => {
    const first = await approve(),
      second = await approve(),
      a = await activity(),
      b = await activity()
    const raw = payload()
    raw.source.provider = 'INTERVALS'
    await activity(raw)
    const results = await Promise.allSettled([
      linkActivity(owner, command(a.id, first)),
      linkActivity(owner, command(b.id, second)),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(
      await prisma.plannedWorkout.count({
        where: { userId: owner.userId, completedActivityId: { not: null } },
      }),
    ).toBe(1)
  })
  it('enforces owner-compatible comparison foreign keys at the database boundary', async () => {
    const approved = await approve(),
      a = await activity()
    await linkActivity(owner, command(a.id, approved))
    const g = await prisma.goal.create({
      data: { userId: other.userId, name: 'Other', type: 'COMPLETION', surface: 'ANY' },
    })
    const p = await prisma.trainingPlan.create({ data: { userId: other.userId, goalId: g.id } })
    const ownActivity = await prisma.activity.create({
      data: {
        userId: other.userId,
        sourceProvider: 'GARMIN',
        sportType: 'RUNNING',
        startedAt: new Date(),
        listStartedAt: new Date(),
      },
    })
    await expect(
      prisma.plannedWorkout.create({
        data: {
          userId: other.userId,
          planId: p.id,
          completedRevisionId: approved.revision.id,
          completedActivityId: ownActivity.id,
          completedAt: new Date(),
          lockedAt: new Date(),
        },
      }),
    ).rejects.toThrow()
  })
  it('allows explicit deletion of imported Garmin data while preserving plan history locks', async () => {
    const approved = await approve(),
      a = await activity()
    const linked = await linkActivity(owner, command(a.id, approved))
    await deleteAllImportedGarminData(owner)
    expect(await prisma.plannedWorkout.findUnique({ where: { id: linked.id } })).toMatchObject({
      completedActivityId: null,
      completedRevisionId: null,
      completedAt: linked.completedAt,
      lockedAt: linked.lockedAt,
    })
    expect(await prisma.activity.count({ where: { userId: owner.userId } })).toBe(0)
    expect(
      workoutCompletionAt(
        await prisma.plannedWorkout.findUniqueOrThrow({ where: { id: linked.id } }),
      ),
    ).toBeNull()
  })
  it('retains an explicit manual completion after linking and unlinking an activity', async () => {
    const approved = await approve(),
      a = await activity(),
      input = command(a.id, approved)
    const manual = await lockPlannedWorkout(owner, {
      planId: input.planId,
      expectedRevisionId: input.expectedRevisionId,
      workoutId: input.workoutId,
      completed: true,
    })
    await linkActivity(owner, input)
    const original = await prisma.plannedWorkout.findUniqueOrThrow({
      where: { id: input.workoutId },
    })
    const source = await prisma.activity.findUniqueOrThrow({ where: { id: a.id } })
    const corrected = payload(source.externalActivityId ?? undefined)
    corrected.startedAt = '2090-01-06T01:00:00Z'
    await activity(corrected)
    const afterReimport = await prisma.plannedWorkout.findUniqueOrThrow({
      where: { id: input.workoutId },
    })
    expect(workoutCompletionAt(afterReimport)).toEqual(manual.completionAt)
    expect(afterReimport).toMatchObject({
      completedAt: original.completedAt,
      lockedAt: original.lockedAt,
      completedRevisionId: original.completedRevisionId,
    })
    await unlinkActivity(owner, { activityId: a.id, expectedWorkoutId: input.workoutId })
    const saved = await prisma.plannedWorkout.findUniqueOrThrow({ where: { id: input.workoutId } })
    expect(workoutCompletionAt(saved)).toEqual(manual.completionAt)
    expect(saved.completionFromActivity).toBe(false)
  })
  it('can manually confirm a formerly retracted match without restoring its old activity timestamp', async () => {
    const approved = await approve(),
      a = await activity(),
      input = command(a.id, approved)
    const initial = await linkActivity(owner, input)
    await unlinkActivity(owner, { activityId: a.id, expectedWorkoutId: input.workoutId })
    const manual = await lockPlannedWorkout(owner, {
      planId: input.planId,
      expectedRevisionId: input.expectedRevisionId,
      workoutId: input.workoutId,
      completed: true,
    })
    expect(manual.completedAt).toEqual(initial.completedAt)
    expect(manual.completionFromActivity).toBe(false)
    expect(workoutCompletionAt(manual)).not.toEqual(initial.completedAt)
    expect(workoutCompletionAt(manual)?.getTime()).toBeLessThan(Date.parse('2090-01-01'))
  })
  it('uses the replacement activity date after relinking a previously completed workout', async () => {
    const approved = await approve(),
      a = await activity(),
      input = command(a.id, approved)
    await linkActivity(owner, input)
    await unlinkActivity(owner, { activityId: a.id, expectedWorkoutId: input.workoutId })
    const raw = payload()
    raw.startedAt = '2090-01-06T01:00:00Z'
    const replacement = await activity(raw)
    const relinked = await linkActivity(owner, { ...input, activityId: replacement.id })
    expect(workoutCompletionAt(relinked)?.toISOString()).toBe(raw.startedAt.replace('Z', '.000Z'))
    expect(relinked.completedAt?.toISOString()).toBe('2090-01-04T23:30:00.000Z')
  })
  it('exposes and unlinks a blocking legacy duplicate with ownership and stale-link checks', async () => {
    const approved = await approve(),
      a = await activity(),
      raw = payload()
    raw.source.provider = 'INTERVALS'
    const legacy = await activity(raw),
      workoutId = approved.content.workouts[0].workoutId
    await prisma.plannedWorkout.update({
      where: { id: workoutId },
      data: {
        completedActivityId: legacy.id,
        completedRevisionId: approved.revision.id,
        completedAt: new Date(raw.startedAt),
        lockedAt: new Date(),
        completionFromActivity: true,
        completionAt: new Date(raw.startedAt),
      },
    })
    const data = await read(a.id)
    expect(data.duplicateLinked).toBe(true)
    expect(data.linkedDuplicates).toMatchObject([
      { activityId: legacy.id, workoutId, provider: 'INTERVALS' },
    ])
    await expect(
      unlinkActivity(other, { activityId: legacy.id, expectedWorkoutId: workoutId }),
    ).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    await expect(
      unlinkActivity(owner, { activityId: legacy.id, expectedWorkoutId: randomUUID() }),
    ).rejects.toBeInstanceOf(PlanConflictError)
    await unlinkActivity(owner, { activityId: legacy.id, expectedWorkoutId: workoutId })
    expect((await read(a.id)).linkedDuplicates).toEqual([])
    expect((await read(a.id)).duplicateLinked).toBe(false)
    await linkActivity(owner, command(a.id, approved))
    expect((await read(a.id)).linked?.workoutId).toBe(workoutId)
  })
  it('retains recorded speed pace for sparse activities and laps without substituting elapsed duration', async () => {
    const raw = payload()
    raw.totalMs = null
    raw.distanceMeters = null
    raw.avgSpeedMps = 3
    if (!raw.laps) throw new Error('Fixture laps missing')
    raw.laps[0].timerMs = null
    raw.laps[0].distanceMeters = null
    raw.laps[0].avgSpeedMps = 4
    const a = await activity(raw),
      data = await read(a.id)
    expect(data.actual).toMatchObject({
      paceSecondsPerKm: 1000 / 3,
      paceBasis: 'recorded-speed',
      durationSeconds: null,
      distanceMeters: null,
    })
    expect(data.laps[0]).toMatchObject({
      paceSecondsPerKm: 250,
      paceBasis: 'recorded-speed',
      durationSeconds: null,
      distanceMeters: null,
    })
  })
  it.each([false, true])(
    'updates only the active match outcome on a corrected reimport (summaryOnly=%s)',
    async (summaryOnly) => {
      const approved = await approve(),
        raw = payload()
      const firstObservedAt = new Date('2090-01-07T00:00:00Z')
      const saved = await importCanonicalActivity(owner, raw, {
        garminAccountId: testGarminAccountId(owner),
        sourceObservedAt: firstObservedAt,
      })
      const input = command(saved.id, approved)
      const original = await linkActivity(owner, input)
      const beforeMember = await prisma.planRevisionWorkout.findFirstOrThrow({
        where: {
          userId: owner.userId,
          revisionId: approved.revision.id,
          workoutId: input.workoutId,
        },
        include: { workout: true },
      })
      const beforeExport = projectCommitment(beforeMember, true)
      // Another athlete can have the same external provider ID without sharing state.
      const foreignGoal = await prisma.goal.create({
        data: {
          userId: other.userId,
          name: 'Synthetic other owner',
          type: 'COMPLETION',
          surface: 'ANY',
        },
      })
      const foreignPlan = await prisma.trainingPlan.create({
        data: { userId: other.userId, goalId: foreignGoal.id },
      })
      const foreignActivity = await prisma.activity.create({
        data: {
          userId: other.userId,
          sourceProvider: 'GARMIN',
          garminAccountId: testGarminAccountId(other),
          externalActivityId: raw.source.externalActivityId,
          sportType: 'RUNNING',
          startedAt: new Date(raw.startedAt),
          listStartedAt: new Date(raw.startedAt),
        },
      })
      const foreignWorkout = await prisma.plannedWorkout.create({
        data: {
          userId: other.userId,
          planId: foreignPlan.id,
          completedActivityId: foreignActivity.id,
          completedAt: new Date(raw.startedAt),
          lockedAt: firstObservedAt,
          completionFromActivity: true,
          completionAt: new Date(raw.startedAt),
        },
      })
      const corrected = {
        ...raw,
        startedAt: '2090-01-06T06:00:00Z',
        ...(summaryOnly ? { laps: null } : {}),
      }
      const options = {
        garminAccountId: testGarminAccountId(owner),
        sourceObservedAt: new Date('2090-01-08T00:00:00Z'),
        summaryOnly,
      }
      expect((await importCanonicalActivity(owner, corrected, options)).id).toBe(saved.id)
      const updatedMember = await prisma.planRevisionWorkout.findFirstOrThrow({
        where: {
          userId: owner.userId,
          revisionId: approved.revision.id,
          workoutId: input.workoutId,
        },
        include: { workout: true },
      })
      expect(projectCommitment(updatedMember, true)).toMatchObject({
        completedAt: '2090-01-06T06:00:00.000Z',
        outcome: 'completed',
        activityId: saved.id,
      })
      expect(beforeExport.completedAt).not.toBe(projectCommitment(updatedMember, true).completedAt)
      expect(updatedMember.workout).toMatchObject({
        completedAt: original.completedAt,
        lockedAt: original.lockedAt,
        completedRevisionId: original.completedRevisionId,
      })
      expect(await prisma.plannedWorkout.findUnique({ where: { id: foreignWorkout.id } })).toEqual(
        foreignWorkout,
      )
      expect(await prisma.activity.findUnique({ where: { id: foreignActivity.id } })).toMatchObject(
        { startedAt: new Date(raw.startedAt) },
      )
      // An older provider observation must not reverse the corrected date.
      await importCanonicalActivity(owner, raw, { ...options, sourceObservedAt: firstObservedAt })
      expect(
        workoutCompletionAt(
          await prisma.plannedWorkout.findUniqueOrThrow({ where: { id: input.workoutId } }),
        )?.toISOString(),
      ).toBe('2090-01-06T06:00:00.000Z')
      // An unchanged reimport also repairs an already-stale derived date.
      await prisma.plannedWorkout.update({
        where: { id: input.workoutId },
        data: { completionAt: new Date(raw.startedAt) },
      })
      await importCanonicalActivity(owner, corrected, options)
      expect(
        workoutCompletionAt(
          await prisma.plannedWorkout.findUniqueOrThrow({ where: { id: input.workoutId } }),
        )?.toISOString(),
      ).toBe('2090-01-06T06:00:00.000Z')
      await unlinkActivity(owner, { activityId: saved.id, expectedWorkoutId: input.workoutId })
      await importCanonicalActivity(owner, corrected, options)
      const unlinked = await prisma.plannedWorkout.findUniqueOrThrow({
        where: { id: input.workoutId },
      })
      expect(unlinked.completedActivityId).toBeNull()
      expect(workoutCompletionAt(unlinked)).toBeNull()
    },
  )
  it('rolls back a completion-date correction if a later lap write fails', async () => {
    const approved = await approve(),
      raw = payload(),
      saved = await activity(raw)
    const input = command(saved.id, approved),
      original = await linkActivity(owner, input)
    if (!raw.laps) throw new Error('Fixture laps missing')
    const invalidLaps = [raw.laps[0], raw.laps[0]]
    await expect(
      activity({ ...raw, startedAt: '2090-01-06T06:00:00Z', laps: invalidLaps }),
    ).rejects.toMatchObject({ code: 'P2002' })
    expect(await prisma.activity.findUnique({ where: { id: saved.id } })).toMatchObject({
      startedAt: new Date(raw.startedAt),
    })
    expect(await prisma.plannedWorkout.findUnique({ where: { id: input.workoutId } })).toEqual(
      original,
    )
  })
})
