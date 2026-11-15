import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getPrismaClient } from '@/server/db/client'
import {
  getOwnerContext,
  InvalidOwnerContextError,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'
import { createPlanDraft, getPlanDraft, updatePlanDraftConstraints } from './drafts'
import {
  approvePlanDraft,
  createPlanRefreshDraft,
  getPlanRevision,
  getTrainingPlan,
  listPlanRevisions,
  lockPlannedWorkout,
  saveGeneratedPlan,
  validateGeneratedPlan,
} from './revisions'
import { PlanConflictError, PlanStateError } from './transaction'
import { PlanValidationError, type PlanContent } from './content'
import { constraintsFixture, contentFixture } from './fixtures'

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

describe.skipIf(!enabled)('RUN-33 immutable plans and ownership in PostgreSQL', () => {
  let prisma: PrismaClient
  const prefix = `run33-${randomUUID()}`
  let owner: OwnerContext, other: OwnerContext
  let goalId: string, otherGoalId: string
  beforeAll(async () => {
    prisma = await getPrismaClient()
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-a` } })
    const b = await prisma.user.create({ data: { authSubject: `${prefix}-b`, role: 'ADMIN' } })
    owner = getOwnerContext({ id: a.id, role: 'USER', email: null })
    other = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
    const data = {
      name: 'Synthetic long goal',
      type: 'COMPLETION',
      distanceMeters: 12500,
      surface: 'ANY',
      targetDate: new Date('2090-03-31'),
    }
    goalId = (await prisma.goal.create({ data: { ...data, userId: a.id } })).id
    otherGoalId = (await prisma.goal.create({ data: { ...data, userId: b.id } })).id
  }, 30000)
  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
    await prisma.$disconnect()
  })

  async function initial(content = contentFixture(), who = owner, goal = goalId) {
    const draft = await createPlanDraft(who, { goalId: goal, constraints: constraintsFixture })
    return validate(draft.id, 0, content, who)
  }
  async function validate(draftId: string, version: number, content: PlanContent, who = owner) {
    const generated = await saveGeneratedPlan(who, { draftId, expectedVersion: version }, content)
    return validateGeneratedPlan(who, { draftId, expectedVersion: generated.version })
  }
  async function approved(content = contentFixture(), who = owner, goal = goalId) {
    const draft = await initial(content, who, goal)
    return approvePlanDraft(who, {
      draftId: draft.id,
      expectedVersion: draft.version,
      expectedRevisionId: null,
      approve: true,
    })
  }

  it('maintains independent constraints and never writes profile defaults', async () => {
    const profileBefore = await prisma.athleteProfile.findUnique({
      where: { userId: owner.userId },
    })
    const a = await createPlanDraft(owner, { goalId, constraints: constraintsFixture })
    const b = await createPlanDraft(owner, {
      goalId,
      constraints: { ...constraintsFixture, sessionsPerWeek: 2 },
    })
    await updatePlanDraftConstraints(owner, b.id, { ...constraintsFixture, sessionsPerWeek: 1 }, 0)
    expect((await getPlanDraft(owner, a.id)).constraints.sessionsPerWeek).toBe(3)
    expect((await getPlanDraft(owner, b.id)).constraints.sessionsPerWeek).toBe(1)
    expect(await prisma.athleteProfile.findUnique({ where: { userId: owner.userId } })).toEqual(
      profileBefore,
    )
  })

  it('rejects case-variant duplicate workout IDs before approval', async () => {
    const c = contentFixture()
    c.workouts.push({ ...c.workouts[0], workoutId: c.workouts[0].workoutId.toUpperCase() })
    const draft = await createPlanDraft(owner, { goalId, constraints: constraintsFixture })
    const generated = await saveGeneratedPlan(owner, { draftId: draft.id, expectedVersion: 0 }, c)
    await expect(
      validateGeneratedPlan(owner, { draftId: draft.id, expectedVersion: generated.version }),
    ).rejects.toBeInstanceOf(PlanValidationError)
    expect((await getPlanDraft(owner, draft.id)).state).toBe('GENERATED')
    expect(await prisma.planRevision.count({ where: { sourceDraftId: draft.id } })).toBe(0)
  })

  it('accepts uppercase IDs while preserving a single logical workout through refresh and locking', async () => {
    const c = contentFixture()
    const workoutId = c.workouts[0].workoutId
    c.workouts[0].workoutId = workoutId.toUpperCase()
    const first = await approved(c)
    const draft = await createPlanRefreshDraft(owner, {
      planId: first.planId.toUpperCase(),
      baseRevisionId: first.id.toUpperCase(),
    })
    c.workouts[0].scheduledDate = '2090-01-06'
    const ready = await validate(draft.id.toUpperCase(), 0, c)
    const second = await approvePlanDraft(owner, {
      draftId: ready.id.toUpperCase(),
      expectedVersion: ready.version,
      expectedRevisionId: first.id.toUpperCase(),
      approve: true,
    })
    expect(
      (await getPlanRevision(owner, first.planId.toUpperCase(), second.id.toUpperCase())).workouts,
    ).toMatchObject([{ workoutId, scheduledDate: new Date('2090-01-06') }])
    expect(await prisma.plannedWorkout.count({ where: { planId: first.planId } })).toBe(1)
    await lockPlannedWorkout(owner, {
      planId: first.planId.toUpperCase(),
      expectedRevisionId: second.id.toUpperCase(),
      workoutId: workoutId.toUpperCase(),
      completed: true,
    })
    await expect(getTrainingPlan(other, first.planId.toUpperCase())).rejects.toBeInstanceOf(
      OwnedResourceNotFoundError,
    )
  })

  it('rejects a shortened goal horizon until its affected future sessions are explicitly rescheduled', async () => {
    const privateGoal = await prisma.goal.create({
      data: {
        userId: owner.userId,
        name: 'Synthetic moving event',
        type: 'COMPLETION',
        distanceMeters: 12500,
        surface: 'ANY',
        targetDate: new Date('2090-03-31'),
      },
    })
    const c = contentFixture()
    c.workouts[0].scheduledDate = '2090-01-27'
    const first = await approved(c, owner, privateGoal.id)
    const original = await getPlanRevision(owner, first.planId, first.id)
    await prisma.goal.update({
      where: { id: privateGoal.id },
      data: { targetDate: new Date('2090-01-20') },
    })
    const draft = await createPlanRefreshDraft(owner, {
      planId: first.planId,
      baseRevisionId: first.id,
    })
    c.macroPlan.endDate = '2090-01-20'
    c.macroPlan.phases[0].endDate = '2090-01-20'
    c.detailWindow.endDate = '2090-01-14'
    c.workouts = []
    const generated = await saveGeneratedPlan(owner, { draftId: draft.id, expectedVersion: 0 }, c)
    await expect(
      validateGeneratedPlan(owner, { draftId: draft.id, expectedVersion: generated.version }),
    ).rejects.toBeInstanceOf(PlanValidationError)
    expect((await getTrainingPlan(owner, first.planId)).currentRevisionId).toBe(first.id)
    expect(await getPlanRevision(owner, first.planId, first.id)).toEqual(original)
    expect(await listPlanRevisions(owner, first.planId)).toHaveLength(1)
    c.workouts = [
      {
        workoutId: original.workouts[0].workoutId,
        scheduledDate: '2090-01-10',
        definition: contentFixture().workouts[0].definition,
        cancelled: false,
      },
    ]
    const ready = await validate(draft.id, generated.version, c)
    const next = await approvePlanDraft(owner, {
      draftId: draft.id,
      expectedVersion: ready.version,
      expectedRevisionId: first.id,
      approve: true,
    })
    expect((await getPlanRevision(owner, first.planId, next.id)).workouts).toMatchObject([
      {
        workoutId: original.workouts[0].workoutId,
        scheduledDate: new Date('2090-01-10'),
        cancelled: false,
      },
    ])
    expect(await getPlanRevision(owner, first.planId, first.id)).toEqual(original)
  })

  it('requires explicit approval after generation and validation', async () => {
    const draft = await createPlanDraft(owner, { goalId, constraints: constraintsFixture })
    const command = {
      draftId: draft.id,
      expectedVersion: 0,
      expectedRevisionId: null,
      approve: true,
    }
    await expect(approvePlanDraft(owner, command)).rejects.toBeInstanceOf(PlanStateError)
    const generated = await saveGeneratedPlan(
      owner,
      { draftId: draft.id, expectedVersion: 0 },
      contentFixture(),
    )
    expect(generated.state).toBe('GENERATED')
    await expect(
      approvePlanDraft(owner, { ...command, expectedVersion: generated.version }),
    ).rejects.toBeInstanceOf(PlanStateError)
    expect(await prisma.planRevision.count({ where: { sourceDraftId: draft.id } })).toBe(0)
    const validated = await validateGeneratedPlan(owner, {
      draftId: draft.id,
      expectedVersion: generated.version,
    })
    await expect(
      approvePlanDraft(owner, { ...command, expectedVersion: validated.version, approve: false }),
    ).rejects.toThrow()
    const before = await prisma.workoutPublication.count({ where: { userId: owner.userId } })
    const revision = await approvePlanDraft(owner, {
      ...command,
      expectedVersion: validated.version,
    })
    expect(
      (await prisma.trainingPlan.findUniqueOrThrow({ where: { id: revision.planId } }))
        .currentRevisionId,
    ).toBe(revision.id)
    expect((await getPlanDraft(owner, draft.id)).state).toBe('APPROVED')
    expect(await prisma.workoutPublication.count({ where: { userId: owner.userId } })).toBe(before)
    await expect(
      updatePlanDraftConstraints(owner, draft.id, constraintsFixture, validated.version + 1),
    ).rejects.toBeInstanceOf(PlanStateError)
  })

  it('invalidates generated content and validation after a constraints edit', async () => {
    const draft = await initial()
    const updated = await updatePlanDraftConstraints(
      owner,
      draft.id,
      { ...constraintsFixture, sessionsPerWeek: 2 },
      draft.version,
    )
    expect(updated).toMatchObject({ state: 'DRAFT', content: null, version: draft.version + 1 })
    await expect(
      saveGeneratedPlan(
        owner,
        { draftId: draft.id, expectedVersion: draft.version },
        contentFixture(),
      ),
    ).rejects.toBeInstanceOf(PlanConflictError)
  })

  it('stores immutable full membership, cancels omitted future sessions and extends the detail window', async () => {
    const c = contentFixture()
    const stableId = c.workouts[0].workoutId
    c.workouts.push({ ...c.workouts[0], workoutId: randomUUID(), scheduledDate: '2090-01-20' })
    const first = await approved(c)
    const firstSnapshot = await getPlanRevision(owner, first.planId, first.id)
    const draft = await createPlanRefreshDraft(owner, {
      planId: first.planId,
      baseRevisionId: first.id,
    })
    const next = contentFixture()
    next.detailWindow = { startDate: '2090-01-15', endDate: '2090-02-11' }
    next.workouts = [{ ...c.workouts[0], scheduledDate: '2090-01-16' }]
    const ready = await validate(draft.id, 0, next)
    const second = await approvePlanDraft(owner, {
      draftId: ready.id,
      expectedVersion: ready.version,
      expectedRevisionId: first.id,
      approve: true,
    })
    const snapshot = await getPlanRevision(owner, first.planId, second.id)
    expect(
      snapshot.workouts
        .find((w) => w.workoutId === stableId)
        ?.scheduledDate.toISOString()
        .slice(0, 10),
    ).toBe('2090-01-16')
    expect(snapshot.workouts.find((w) => w.workoutId === c.workouts[1].workoutId)?.cancelled).toBe(
      true,
    )
    expect(await getPlanRevision(owner, first.planId, first.id)).toEqual(firstSnapshot)
    expect((await listPlanRevisions(owner, first.planId)).map((r) => r.revisionNumber)).toEqual([
      2, 1,
    ])
    expect(await prisma.plannedWorkout.count({ where: { planId: first.planId } })).toBe(2)
  })

  it.each([false, true])(
    'preserves locked/completed sessions (completed=%s)',
    async (completed) => {
      const c = contentFixture()
      const first = await approved(c)
      await lockPlannedWorkout(owner, {
        planId: first.planId,
        expectedRevisionId: first.id,
        workoutId: c.workouts[0].workoutId,
        completed,
      })
      const draft = await createPlanRefreshDraft(owner, {
        planId: first.planId,
        baseRevisionId: first.id,
      })
      const changed = structuredClone(c)
      changed.workouts[0].definition.name = 'Unsafe change'
      const generated = await saveGeneratedPlan(
        owner,
        { draftId: draft.id, expectedVersion: 0 },
        changed,
      )
      await expect(
        validateGeneratedPlan(owner, { draftId: draft.id, expectedVersion: generated.version }),
      ).rejects.toBeInstanceOf(PlanValidationError)
      const omitted = await validate(draft.id, generated.version, { ...c, workouts: [] })
      const revision = await approvePlanDraft(owner, {
        draftId: draft.id,
        expectedVersion: omitted.version,
        expectedRevisionId: first.id,
        approve: true,
      })
      expect((await getPlanRevision(owner, first.planId, revision.id)).workouts[0]).toMatchObject({
        workoutId: c.workouts[0].workoutId,
        cancelled: false,
        definition: c.workouts[0].definition,
      })
    },
  )

  it('rechecks locks acquired after validation and rolls back approval', async () => {
    const c = contentFixture(),
      first = await approved(c)
    const draft = await createPlanRefreshDraft(owner, {
      planId: first.planId,
      baseRevisionId: first.id,
    })
    c.workouts[0].definition.name = 'Later change'
    const ready = await validate(draft.id, 0, c)
    await lockPlannedWorkout(owner, {
      planId: first.planId,
      expectedRevisionId: first.id,
      workoutId: c.workouts[0].workoutId,
      completed: true,
    })
    await expect(
      approvePlanDraft(owner, {
        draftId: ready.id,
        expectedVersion: ready.version,
        expectedRevisionId: first.id,
        approve: true,
      }),
    ).rejects.toBeInstanceOf(PlanValidationError)
    expect(await listPlanRevisions(owner, first.planId)).toHaveLength(1)
  })

  it('allows only one concurrent approval and rejects stale refresh bases', async () => {
    const first = await approved()
    const a = await createPlanRefreshDraft(owner, {
      planId: first.planId,
      baseRevisionId: first.id,
    })
    const b = await createPlanRefreshDraft(owner, {
      planId: first.planId,
      baseRevisionId: first.id,
    })
    const ready = await Promise.all([
      validate(a.id, 0, contentFixture()),
      validate(b.id, 0, contentFixture()),
    ])
    const results = await Promise.allSettled(
      ready.map((d) =>
        approvePlanDraft(owner, {
          draftId: d.id,
          expectedVersion: d.version,
          expectedRevisionId: first.id,
          approve: true,
        }),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results)
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(PlanConflictError)
    expect(await listPlanRevisions(owner, first.planId)).toHaveLength(2)
    await expect(
      createPlanRefreshDraft(owner, { planId: first.planId, baseRevisionId: first.id }),
    ).rejects.toBeInstanceOf(PlanConflictError)
  })

  it('atomically rejects concurrent initial approval of the same draft', async () => {
    const draft = await initial()
    const planCount = await prisma.trainingPlan.count({ where: { userId: owner.userId } })
    const command = {
      draftId: draft.id,
      expectedVersion: draft.version,
      expectedRevisionId: null,
      approve: true,
    }
    const results = await Promise.allSettled([
      approvePlanDraft(owner, command),
      approvePlanDraft(owner, command),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await prisma.planRevision.count({ where: { sourceDraftId: draft.id } })).toBe(1)
    expect(await prisma.trainingPlan.count({ where: { userId: owner.userId } })).toBe(planCount + 1)
  })

  it('rejects cross-owner and mismatched nested plan, goal, draft and workout associations', async () => {
    const c = contentFixture()
    const a = await approved(c),
      b = await approved(contentFixture(), other, otherGoalId)
    const draft = await initial()
    const denied = [
      () => createPlanDraft(owner, { goalId: otherGoalId }),
      () => getPlanDraft(other, draft.id),
      () =>
        saveGeneratedPlan(
          other,
          { draftId: draft.id, expectedVersion: draft.version },
          contentFixture(),
        ),
      () => validateGeneratedPlan(other, { draftId: draft.id, expectedVersion: draft.version }),
      () =>
        approvePlanDraft(other, {
          draftId: draft.id,
          expectedVersion: draft.version,
          expectedRevisionId: null,
          approve: true,
        }),
      () => createPlanRefreshDraft(other, { planId: a.planId, baseRevisionId: a.id }),
      () => createPlanRefreshDraft(owner, { planId: a.planId, baseRevisionId: b.id }),
      () => getPlanRevision(other, a.planId, a.id),
      () => getTrainingPlan(other, a.planId),
      () => getPlanRevision(owner, a.planId, b.id),
      () => listPlanRevisions(other, a.planId),
      () =>
        lockPlannedWorkout(other, {
          planId: a.planId,
          expectedRevisionId: a.id,
          workoutId: c.workouts[0].workoutId,
          completed: true,
        }),
      () =>
        lockPlannedWorkout(owner, {
          planId: b.planId,
          expectedRevisionId: b.id,
          workoutId: c.workouts[0].workoutId,
          completed: true,
        }),
    ]
    for (const run of denied) await expect(run()).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    await expect(
      prisma.planDraft.create({
        data: { userId: owner.userId, goalId: otherGoalId, ...constraintsFixture, startDate: null },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.planDraft.create({
        data: {
          userId: owner.userId,
          goalId,
          planId: b.planId,
          ...constraintsFixture,
          startDate: null,
        },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.trainingPlan.update({ where: { id: a.planId }, data: { currentRevisionId: b.id } }),
    ).rejects.toThrow()
    const stolen = contentFixture()
    stolen.workouts[0].workoutId = c.workouts[0].workoutId
    const generated = await saveGeneratedPlan(
      other,
      {
        draftId: (
          await createPlanDraft(other, { goalId: otherGoalId, constraints: constraintsFixture })
        ).id,
        expectedVersion: 0,
      },
      stolen,
    )
    await expect(
      validateGeneratedPlan(other, { draftId: generated.id, expectedVersion: generated.version }),
    ).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
  })

  it('requires an issued authenticated owner on every persistence entry point', async () => {
    const forged = { userId: owner.userId },
      id = randomUUID()
    const denied = [
      () => createPlanDraft(forged, { goalId }),
      () => getPlanDraft(forged, id),
      () => updatePlanDraftConstraints(forged, id, constraintsFixture, 0),
      () => saveGeneratedPlan(forged, { draftId: id, expectedVersion: 0 }, contentFixture()),
      () => validateGeneratedPlan(forged, { draftId: id, expectedVersion: 0 }),
      () =>
        approvePlanDraft(forged, {
          draftId: id,
          expectedVersion: 0,
          expectedRevisionId: null,
          approve: true,
        }),
      () => createPlanRefreshDraft(forged, { planId: id, baseRevisionId: id }),
      () => getPlanRevision(forged, id, id),
      () => getTrainingPlan(forged, id),
      () => listPlanRevisions(forged, id),
      () =>
        lockPlannedWorkout(forged, {
          planId: id,
          expectedRevisionId: id,
          workoutId: id,
          completed: true,
        }),
    ]
    for (const run of denied) await expect(run()).rejects.toBeInstanceOf(InvalidOwnerContextError)
  })

  it('rejects wrong-plan references even when both plans have the same owner and goal', async () => {
    const a = await approved(),
      b = await approved()
    const draft = await createPlanRefreshDraft(owner, { planId: a.planId, baseRevisionId: a.id })
    await expect(
      createPlanRefreshDraft(owner, { planId: a.planId, baseRevisionId: b.id }),
    ).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    await expect(
      prisma.trainingPlan.update({ where: { id: a.planId }, data: { currentRevisionId: b.id } }),
    ).rejects.toThrow()
    await expect(
      prisma.planDraft.update({ where: { id: draft.id }, data: { planId: b.planId } }),
    ).rejects.toThrow()
    await expect(
      prisma.planRevision.create({
        data: {
          userId: owner.userId,
          goalId,
          planId: b.planId,
          sourceDraftId: draft.id,
          revisionNumber: 2,
          parentRevisionId: b.id,
          snapshot: { schemaVersion: 1 },
        },
      }),
    ).rejects.toThrow()
    expect((await getTrainingPlan(owner, a.planId)).currentRevisionId).toBe(a.id)
    expect((await getTrainingPlan(owner, b.planId)).currentRevisionId).toBe(b.id)
  })

  it('enforces database immutability, including late membership inserts', async () => {
    const c = contentFixture(),
      r = await approved(c)
    await expect(
      prisma.planRevision.update({ where: { id: r.id }, data: { snapshot: {} } }),
    ).rejects.toThrow()
    await expect(prisma.planRevision.delete({ where: { id: r.id } })).rejects.toThrow()
    await expect(
      prisma.planRevisionWorkout.updateMany({
        where: { revisionId: r.id },
        data: { cancelled: true },
      }),
    ).rejects.toThrow()
    await expect(
      prisma.planRevisionWorkout.deleteMany({ where: { revisionId: r.id } }),
    ).rejects.toThrow()
    const extra = await prisma.plannedWorkout.create({
      data: { userId: owner.userId, planId: r.planId },
    })
    await expect(
      prisma.planRevisionWorkout.create({
        data: {
          userId: owner.userId,
          planId: r.planId,
          revisionId: r.id,
          workoutId: extra.id,
          scheduledDate: new Date('2090-01-10'),
          timezone: 'UTC',
          definition: c.workouts[0].definition,
        },
      }),
    ).rejects.toThrow()
    await lockPlannedWorkout(owner, {
      planId: r.planId,
      expectedRevisionId: r.id,
      workoutId: c.workouts[0].workoutId,
      completed: true,
    })
    await expect(
      prisma.plannedWorkout.update({
        where: { id: c.workouts[0].workoutId },
        data: { lockedAt: null, completedAt: null },
      }),
    ).rejects.toThrow()
  })

  it('rejects approval if the goal changes after validation', async () => {
    const draft = await initial()
    await prisma.goal.update({
      where: { id: goalId },
      data: { name: 'Changed synthetic goal', updatedAt: new Date('2080-01-01') },
    })
    await expect(
      approvePlanDraft(owner, {
        draftId: draft.id,
        expectedVersion: draft.version,
        expectedRevisionId: null,
        approve: true,
      }),
    ).rejects.toBeInstanceOf(PlanConflictError)
    expect(await prisma.planRevision.count({ where: { sourceDraftId: draft.id } })).toBe(0)
  })

  it('rechecks the local date at approval and preserves sessions that became history', async () => {
    const c = contentFixture(),
      first = await approved(c)
    const draft = await createPlanRefreshDraft(owner, {
      planId: first.planId,
      baseRevisionId: first.id,
    })
    const changed = structuredClone(c)
    changed.workouts[0].definition.name = 'Unsafe historical rewrite'
    const ready = await validate(draft.id, 0, changed)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2090-01-06T12:00:00Z'))
    try {
      await expect(
        approvePlanDraft(owner, {
          draftId: ready.id,
          expectedVersion: ready.version,
          expectedRevisionId: first.id,
          approve: true,
        }),
      ).rejects.toBeInstanceOf(PlanValidationError)
      expect((await getTrainingPlan(owner, first.planId)).currentRevisionId).toBe(first.id)
      const preserved = await validate(draft.id, ready.version, { ...c, workouts: [] })
      const next = await approvePlanDraft(owner, {
        draftId: draft.id,
        expectedVersion: preserved.version,
        expectedRevisionId: first.id,
        approve: true,
      })
      expect((await getPlanRevision(owner, first.planId, next.id)).workouts[0]).toMatchObject({
        workoutId: c.workouts[0].workoutId,
        definition: c.workouts[0].definition,
        cancelled: false,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
