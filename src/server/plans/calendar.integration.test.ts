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
import { createPlanDraft } from './drafts'
import {
  approvePlanDraft,
  createPlanRefreshDraft,
  getPlanRevision,
  lockPlannedWorkout,
  saveGeneratedPlan,
  validateGeneratedPlan,
} from './revisions'
import { PlanConflictError } from './transaction'
import { planContentSchema } from './content'
import { addCalendarDays } from '@/lib/training-calendar'
import { constraintsFixture, contentFixture } from './fixtures'
import { CalendarEditError, getTrainingCalendar, rescheduleCalendarWorkout } from './calendar'

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

describe.skipIf(!enabled)('RUN-31 calendar on PostgreSQL', () => {
  let prisma: PrismaClient, owner: OwnerContext, other: OwnerContext, goalId: string
  const prefix = `run31-${randomUUID()}`
  const now = new Date('2089-12-31T12:00:00Z')
  beforeAll(async () => {
    prisma = await getPrismaClient()
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-a` } })
    const b = await prisma.user.create({ data: { authSubject: `${prefix}-b`, role: 'ADMIN' } })
    owner = getOwnerContext({ id: a.id, role: 'USER', email: null })
    other = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
    goalId = (
      await prisma.goal.create({
        data: {
          userId: a.id,
          name: 'Synthetic calendar goal',
          type: 'COMPLETION',
          distanceMeters: 12000,
          surface: 'ANY',
          targetDate: new Date('2090-03-31'),
        },
      })
    ).id
  }, 30000)
  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
    await prisma.$disconnect()
  })

  async function approve(content = contentFixture(), constraints = constraintsFixture) {
    const draft = await createPlanDraft(owner, { goalId, constraints })
    const saved = await saveGeneratedPlan(owner, { draftId: draft.id, expectedVersion: 0 }, content)
    const valid = await validateGeneratedPlan(owner, {
      draftId: draft.id,
      expectedVersion: saved.version,
    })
    return approvePlanDraft(owner, {
      draftId: draft.id,
      expectedVersion: valid.version,
      expectedRevisionId: null,
      approve: true,
    })
  }
  const command = (
    revision: { id: string; planId: string },
    workoutId: string,
    scheduledDate = '2090-01-06',
    timezone = 'UTC',
  ) => ({
    planId: revision.planId,
    expectedRevisionId: revision.id,
    workoutId,
    scheduledDate,
    timezone,
  })
  async function read(date = '2090-01-05', at = now, who = owner) {
    return getTrainingCalendar(who, { date, view: 'month' }, at)
  }

  it('shows no-plan and sparse history without inventing rest days or sessions', async () => {
    const empty = await read('2090-01-05', now, other)
    expect(empty.hasPlan).toBe(false)
    expect(empty.days.every((d) => !d.rest && !d.workouts.length && !d.activities.length)).toBe(
      true,
    )
    const revision = await approve()
    const data = await read()
    expect(data.days.find((d) => d.date === '2090-01-04')?.rest).toBe(true)
    expect(data.days.find((d) => d.date === '2090-01-29')?.rest).toBe(false)
    expect(
      data.days.flatMap((d) => d.workouts).filter((w) => w.planId === revision.planId),
    ).toHaveLength(1)
  })

  it('moves two sessions on one date independently and preserves all older snapshots', async () => {
    const content = contentFixture()
    content.workouts.push({ ...content.workouts[0], workoutId: randomUUID() })
    const revision = await approve(content)
    const original = await getPlanRevision(owner, revision.planId, revision.id)
    const a = content.workouts[0].workoutId,
      b = content.workouts[1].workoutId
    const nextId = await rescheduleCalendarWorkout(owner, command(revision, a), now)
    const second = await getPlanRevision(owner, revision.planId, nextId)
    expect(second.workouts.find((w) => w.workoutId === a)?.scheduledDate).toEqual(
      new Date('2090-01-06'),
    )
    expect(second.workouts.find((w) => w.workoutId === b)?.scheduledDate).toEqual(
      new Date('2090-01-05'),
    )
    await expect(
      rescheduleCalendarWorkout(owner, command(revision, b), now),
    ).rejects.toBeInstanceOf(PlanConflictError)
    const finalId = await rescheduleCalendarWorkout(
      owner,
      command({ ...revision, id: nextId }, b, '2090-01-07'),
      now,
    )
    const final = await getPlanRevision(owner, revision.planId, finalId)
    expect(final.workouts.find((w) => w.workoutId === a)?.scheduledDate).toEqual(
      new Date('2090-01-06'),
    )
    expect(final.workouts.find((w) => w.workoutId === b)?.scheduledDate).toEqual(
      new Date('2090-01-07'),
    )
    expect(await getPlanRevision(owner, revision.planId, revision.id)).toEqual(original)
    expect(await getPlanRevision(owner, revision.planId, nextId)).toEqual(second)
    expect(final.snapshot).toEqual(original.snapshot)
    const data = await read()
    expect(data.days.flatMap((d) => d.workouts).find((w) => w.id === b)?.movedFrom).toBe(
      '2090-01-05',
    )
  })

  it('moves one session after repeated replacement refreshes exceed the source-draft limit', async () => {
    const content = contentFixture()
    const template = content.workouts[0]
    content.workouts = Array.from({ length: 28 }, (_, index) => ({
      ...template,
      workoutId: randomUUID(),
      scheduledDate: addCalendarDays('2090-01-01', index),
    }))
    let revision = await approve(content, { ...constraintsFixture, sessionsPerWeek: 7 })
    const original = await getPlanRevision(owner, revision.planId, revision.id)
    for (let refresh = 0; refresh < 7; refresh++) {
      content.workouts = content.workouts.map((w) => ({ ...w, workoutId: randomUUID() }))
      const draft = await createPlanRefreshDraft(owner, {
        planId: revision.planId,
        baseRevisionId: revision.id,
      })
      const saved = await saveGeneratedPlan(
        owner,
        { draftId: draft.id, expectedVersion: 0 },
        content,
      )
      const validated = await validateGeneratedPlan(owner, {
        draftId: draft.id,
        expectedVersion: saved.version,
      })
      revision = await approvePlanDraft(owner, {
        draftId: draft.id,
        expectedVersion: validated.version,
        expectedRevisionId: revision.id,
        approve: true,
      })
    }
    for (const [index, completed] of [true, false].entries()) {
      await lockPlannedWorkout(owner, {
        planId: revision.planId,
        expectedRevisionId: revision.id,
        workoutId: content.workouts[index].workoutId,
        completed,
      })
    }
    const before = await getPlanRevision(owner, revision.planId, revision.id)
    expect(before.workouts).toHaveLength(224)
    expect(before.workouts.filter((w) => !w.cancelled)).toHaveLength(28)
    const factsBefore = await prisma.plannedWorkout.findMany({
      where: { userId: owner.userId, planId: revision.planId },
      orderBy: { id: 'asc' },
    })
    const target = content.workouts
      .slice(2)
      .find((w) => new Date(`${w.scheduledDate}T00:00:00Z`).getUTCDay() === 2)!
    const destination = addCalendarDays(target.scheduledDate, 1)
    const move = command(revision, target.workoutId, destination)
    await expect(rescheduleCalendarWorkout(other, move, now)).rejects.toBeInstanceOf(
      OwnedResourceNotFoundError,
    )
    const nextId = await rescheduleCalendarWorkout(owner, move, now)
    const next = await getPlanRevision(owner, revision.planId, nextId)
    const byId = (a: { workoutId: string }, b: { workoutId: string }) =>
      a.workoutId.localeCompare(b.workoutId)
    expect([...next.workouts].sort(byId)).toEqual(
      before.workouts
        .map((w) => ({
          ...w,
          revisionId: next.id,
          scheduledDate:
            w.workoutId === target.workoutId
              ? new Date(`${destination}T00:00:00Z`)
              : w.scheduledDate,
        }))
        .sort(byId),
    )
    expect(next.snapshot).toEqual(before.snapshot)
    expect(await getPlanRevision(owner, revision.planId, revision.id)).toEqual(before)
    expect(await getPlanRevision(owner, original.planId, original.id)).toEqual(original)
    expect(
      await prisma.plannedWorkout.findMany({
        where: { userId: owner.userId, planId: revision.planId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(factsBefore)
    const source = await prisma.planDraft.findFirstOrThrow({
      where: { userId: owner.userId, id: next.sourceDraftId },
    })
    expect(source.state).toBe('APPROVED')
    expect(source.baseRevisionId).toBe(revision.id)
    expect(planContentSchema.parse(source.content).workouts).toEqual([
      { ...target, scheduledDate: destination },
    ])
    await expect(rescheduleCalendarWorkout(owner, move, now)).rejects.toBeInstanceOf(
      PlanConflictError,
    )
  })

  it('keeps date-only sessions fixed when profile timezone changes across the date line', async () => {
    const content = contentFixture(),
      revision = await approve(content)
    await prisma.athleteProfile.upsert({
      where: { userId: owner.userId },
      create: { userId: owner.userId, preferredTimezone: 'Pacific/Honolulu' },
      update: { preferredTimezone: 'Pacific/Honolulu' },
    })
    const before = await read()
    await prisma.athleteProfile.update({
      where: { userId: owner.userId },
      data: { preferredTimezone: 'Asia/Tokyo' },
    })
    const after = await read()
    const pick = (data: Awaited<ReturnType<typeof read>>) =>
      data.days.flatMap((d) => d.workouts).find((w) => w.id === content.workouts[0].workoutId)
    expect(pick(before)).toEqual(pick(after))
    expect(pick(after)).toMatchObject({ date: '2090-01-05', timezone: 'UTC' })
    const nextId = await rescheduleCalendarWorkout(
      owner,
      command(revision, content.workouts[0].workoutId, '2090-01-06', 'America/New_York'),
      now,
    )
    expect((await getPlanRevision(owner, revision.planId, nextId)).workouts[0]).toMatchObject({
      scheduledDate: new Date('2090-01-06'),
      timezone: 'America/New_York',
    })
    expect((await getPlanRevision(owner, revision.planId, revision.id)).workouts[0].timezone).toBe(
      'UTC',
    )
  })

  it('protects current-day and past dates using the original session timezone even during travel', async () => {
    const content = contentFixture(),
      revision = await approve(content)
    for (const at of ['2090-01-05T00:00:00Z', '2090-01-06T00:00:00Z'])
      await expect(
        rescheduleCalendarWorkout(
          owner,
          command(revision, content.workouts[0].workoutId, '2090-01-08', 'Pacific/Honolulu'),
          new Date(at),
        ),
      ).rejects.toBeInstanceOf(CalendarEditError)
    await expect(
      rescheduleCalendarWorkout(
        owner,
        command(revision, content.workouts[0].workoutId, '2089-12-31'),
        now,
      ),
    ).rejects.toBeInstanceOf(CalendarEditError)
    await expect(
      rescheduleCalendarWorkout(
        owner,
        command(revision, content.workouts[0].workoutId, '2090-02-01'),
        now,
      ),
    ).rejects.toBeInstanceOf(CalendarEditError)
  })

  it.each(['editable', 'locked', 'completed'])(
    'preserves a custom session timezone through a refresh that echoes the %s session',
    async (state) => {
      const content = contentFixture()
      const original = await approve(content)
      const workoutId = content.workouts[0].workoutId
      const movedId = await rescheduleCalendarWorkout(
        owner,
        command(original, workoutId, '2090-01-06', 'America/New_York'),
        now,
      )
      if (state !== 'editable')
        await lockPlannedWorkout(owner, {
          planId: original.planId,
          expectedRevisionId: movedId,
          workoutId,
          completed: state === 'completed',
        })
      const moved = await getPlanRevision(owner, original.planId, movedId)
      const draft = await createPlanRefreshDraft(owner, {
        planId: original.planId,
        baseRevisionId: movedId,
      })
      content.workouts[0].scheduledDate = '2090-01-06'
      const generated = await saveGeneratedPlan(
        owner,
        { draftId: draft.id, expectedVersion: 0 },
        content,
      )
      const valid = await validateGeneratedPlan(owner, {
        draftId: draft.id,
        expectedVersion: generated.version,
      })
      const refreshed = await approvePlanDraft(owner, {
        draftId: draft.id,
        expectedVersion: valid.version,
        expectedRevisionId: movedId,
        approve: true,
      })
      expect(
        (await getPlanRevision(owner, original.planId, refreshed.id)).workouts[0],
      ).toMatchObject({
        workoutId,
        scheduledDate: new Date('2090-01-06'),
        timezone: 'America/New_York',
        definition: moved.workouts[0].definition,
      })
      expect(await getPlanRevision(owner, original.planId, movedId)).toEqual(moved)
    },
  )

  it('preserves completed and locked sessions through moves and a subsequent refresh', async () => {
    const content = contentFixture()
    content.workouts.push(
      { ...content.workouts[0], workoutId: randomUUID() },
      { ...content.workouts[0], workoutId: randomUUID() },
    )
    const first = await approve(content)
    const [completed, locked, editable] = content.workouts.map((w) => w.workoutId)
    await lockPlannedWorkout(owner, {
      planId: first.planId,
      expectedRevisionId: first.id,
      workoutId: completed,
      completed: true,
    })
    await lockPlannedWorkout(owner, {
      planId: first.planId,
      expectedRevisionId: first.id,
      workoutId: locked,
      completed: false,
    })
    for (const id of [completed, locked])
      await expect(
        rescheduleCalendarWorkout(owner, command(first, id), now),
      ).rejects.toBeInstanceOf(CalendarEditError)
    const secondId = await rescheduleCalendarWorkout(owner, command(first, editable), now)
    const draft = await createPlanRefreshDraft(owner, {
      planId: first.planId,
      baseRevisionId: secondId,
    })
    const refreshed = { ...content, workouts: [] }
    const generated = await saveGeneratedPlan(
      owner,
      { draftId: draft.id, expectedVersion: 0 },
      refreshed,
    )
    const valid = await validateGeneratedPlan(owner, {
      draftId: draft.id,
      expectedVersion: generated.version,
    })
    const third = await approvePlanDraft(owner, {
      draftId: draft.id,
      expectedVersion: valid.version,
      expectedRevisionId: secondId,
      approve: true,
    })
    const original = await getPlanRevision(owner, first.planId, first.id)
    const final = await getPlanRevision(owner, first.planId, third.id)
    for (const id of [completed, locked])
      expect(final.workouts.find((w) => w.workoutId === id)).toMatchObject({
        scheduledDate: new Date('2090-01-05'),
        definition: original.workouts.find((w) => w.workoutId === id)!.definition,
        cancelled: false,
      })
    expect(final.workouts.find((w) => w.workoutId === editable)?.cancelled).toBe(true)
    const displayed = (await read()).days.flatMap((d) => d.workouts)
    expect(displayed.find((w) => w.id === completed)?.status).toBe('completed')
    expect(displayed.find((w) => w.id === locked)).toMatchObject({ locked: true, editable: false })
    expect(displayed.find((w) => w.id === editable)?.status).toBe('cancelled')
  })

  it('rejects foreign ADMIN access, mixed nested resources and forged ownership contexts', async () => {
    const content = contentFixture(),
      revision = await approve(content),
      another = await approve()
    await expect(
      rescheduleCalendarWorkout(other, command(revision, content.workouts[0].workoutId), now),
    ).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    expect((await read('2090-01-05', now, other)).days.flatMap((d) => d.workouts)).toHaveLength(0)
    await expect(
      rescheduleCalendarWorkout(owner, command(another, content.workouts[0].workoutId), now),
    ).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    await expect(getTrainingCalendar({ userId: owner.userId })).rejects.toBeInstanceOf(
      InvalidOwnerContextError,
    )
    await expect(
      rescheduleCalendarWorkout(
        { userId: owner.userId },
        command(revision, content.workouts[0].workoutId),
        now,
      ),
    ).rejects.toBeInstanceOf(InvalidOwnerContextError)
  })

  it('serializes competing session moves and locks without overwriting a committed change', async () => {
    const content = contentFixture(),
      revision = await approve(content),
      workoutId = content.workouts[0].workoutId
    const results = await Promise.allSettled([
      rescheduleCalendarWorkout(owner, command(revision, workoutId), now),
      rescheduleCalendarWorkout(owner, command(revision, workoutId, '2090-01-07'), now),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: expect.any(PlanConflictError),
    })
    const c = contentFixture(),
      r = await approve(c),
      id = c.workouts[0].workoutId
    const race = await Promise.allSettled([
      rescheduleCalendarWorkout(owner, command(r, id), now),
      lockPlannedWorkout(owner, {
        planId: r.planId,
        expectedRevisionId: r.id,
        workoutId: id,
        completed: true,
      }),
    ])
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  })

  async function activity(
    userId: string,
    title: string,
    sourceProvider: 'MANUAL' | 'GARMIN' = 'MANUAL',
  ) {
    return prisma.activity.create({
      data: {
        userId,
        sourceProvider,
        garminAccountId: 'synthetic-account',
        sportType: 'RUNNING',
        activityTitle: title,
        startedAt: new Date('2090-01-04T16:00:00Z'),
        listStartedAt: new Date('2090-01-04T16:00:00Z'),
        sourceTimezone: 'Asia/Tokyo',
      },
    })
  }

  it('shows saved disconnected Garmin activities on source-local dates and excludes another owner', async () => {
    await prisma.integrationConnection.create({
      data: {
        userId: owner.userId,
        provider: 'GARMIN',
        authMethod: 'FILE',
        status: 'REVOKED',
        externalAccountId: 'synthetic-account',
      },
    })
    const saved = await activity(owner.userId, 'Synthetic saved run', 'GARMIN')
    const privateActivity = await activity(other.userId, 'Other athlete run')
    const data = await read()
    const found = data.days.flatMap((d) => d.activities)
    expect(found.find((a) => a.id === saved.id)).toMatchObject({
      date: '2090-01-05',
      timezone: 'Asia/Tokyo',
    })
    expect(found.some((a) => a.id === privateActivity.id)).toBe(false)
  })

  it('keeps saved activity dates correct through spring and fall DST transitions', async () => {
    for (const [instant, date] of [
      ['2026-03-08T04:59:00Z', '2026-03-07'],
      ['2026-03-08T07:01:00Z', '2026-03-08'],
      ['2026-11-01T05:30:00Z', '2026-11-01'],
      ['2026-11-01T06:30:00Z', '2026-11-01'],
    ]) {
      const saved = await prisma.activity.create({
        data: {
          userId: owner.userId,
          sourceProvider: 'MANUAL',
          sportType: 'RUNNING',
          startedAt: new Date(instant),
          listStartedAt: new Date(instant),
          sourceTimezone: 'America/New_York',
        },
      })
      const data = await read(date)
      expect(data.days.flatMap((d) => d.activities).find((a) => a.id === saved.id)?.date).toBe(date)
    }
  })

  it('resolves linked completed activities once and enforces owner-compatible links and locks in SQL', async () => {
    const content = contentFixture(),
      revision = await approve(content),
      id = content.workouts[0].workoutId
    const saved = await activity(owner.userId, 'Synthetic matched run')
    const foreign = await activity(other.userId, 'Private match')
    await expect(
      prisma.plannedWorkout.update({ where: { id }, data: { completedActivityId: saved.id } }),
    ).rejects.toThrow()
    await expect(
      prisma.plannedWorkout.update({
        where: { id },
        data: { completedActivityId: foreign.id, completedAt: now, lockedAt: now },
      }),
    ).rejects.toThrow()
    await prisma.plannedWorkout.update({
      where: { id },
      data: { completedActivityId: saved.id, completedAt: now, lockedAt: now },
    })
    const data = await read()
    expect(data.days.flatMap((d) => d.workouts).find((w) => w.id === id)).toMatchObject({
      status: 'completed',
      editable: false,
      activity: { id: saved.id },
    })
    expect(data.days.flatMap((d) => d.activities).some((a) => a.id === saved.id)).toBe(false)
    await expect(
      rescheduleCalendarWorkout(owner, command(revision, id), now),
    ).rejects.toBeInstanceOf(CalendarEditError)
    const second = await approve()
    const member = (await getPlanRevision(owner, second.planId, second.id)).workouts[0]
    await expect(
      prisma.plannedWorkout.update({
        where: { id: member.workoutId },
        data: { completedActivityId: saved.id, completedAt: now, lockedAt: now },
      }),
    ).rejects.toThrow()
  })

  it.each(['2090-01-05', '2090-01-06', '2090-01-20'])(
    'places a linked activity on its actual day %s and deduplicates only on the same day',
    async (date) => {
      const content = contentFixture()
      await approve(content)
      const workoutId = content.workouts[0].workoutId
      const saved = await activity(owner.userId, 'Synthetic linked actual-day run')
      await prisma.activity.update({
        where: { id: saved.id },
        data: {
          sourceTimezone: 'UTC',
          startedAt: new Date(`${date}T10:00:00Z`),
          listStartedAt: new Date(`${date}T10:00:00Z`),
        },
      })
      await prisma.plannedWorkout.update({
        where: { id: workoutId },
        data: {
          completedActivityId: saved.id,
          completedAt: new Date(`${date}T10:30:00Z`),
          lockedAt: new Date(`${date}T10:30:00Z`),
        },
      })
      const data = await getTrainingCalendar(
        owner,
        { date, view: 'week' },
        new Date('2090-01-21T12:00:00Z'),
      )
      const actualDay = data.days.find((d) => d.date === date)!
      expect(actualDay.rest).toBe(false)
      const linked = actualDay.activities.filter((a) => a.id === saved.id)
      if (date === '2090-01-05') {
        expect(linked).toHaveLength(0)
        expect(actualDay.workouts.find((w) => w.id === workoutId)?.activity?.id).toBe(saved.id)
      } else {
        expect(linked).toEqual([
          {
            id: saved.id,
            title: 'Synthetic linked actual-day run',
            date,
            timezone: 'UTC',
            linkedWorkoutId: workoutId,
          },
        ])
      }
      expect(
        (await getTrainingCalendar(other, { date, view: 'week' }, now)).days
          .flatMap((d) => d.activities)
          .some((a) => a.id === saved.id),
      ).toBe(false)
    },
  )
})
