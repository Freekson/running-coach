import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  saveGeneratedPlan,
  validateGeneratedPlan,
} from './revisions'
import { constraintsFixture, contentFixture } from './fixtures'
import { PlanConflictError } from './transaction'
import { getPlanReminders, respondToPlanReminder } from './reminders'

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

describe.skipIf(!enabled)('RUN-47 persistent owner-scoped plan reminders in PostgreSQL', () => {
  let prisma: PrismaClient, owner: OwnerContext, other: OwnerContext, goalId: string
  const prefix = `run47-${randomUUID()}`
  const now = new Date('2090-01-21T12:00:00Z')
  beforeAll(async () => {
    prisma = await getPrismaClient()
  })
  beforeEach(async () => {
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-${randomUUID()}` } })
    const b = await prisma.user.create({
      data: { authSubject: `${prefix}-${randomUUID()}`, role: 'ADMIN' },
    })
    owner = getOwnerContext({ id: a.id, role: 'USER', email: null })
    other = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
    goalId = (
      await prisma.goal.create({
        data: {
          userId: a.id,
          name: 'Synthetic endurance goal',
          type: 'COMPLETION',
          distanceMeters: 12500,
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

  async function approve(content = contentFixture(), base?: { planId: string; id: string }) {
    const draft = base
      ? await createPlanRefreshDraft(owner, { planId: base.planId, baseRevisionId: base.id })
      : await createPlanDraft(owner, { goalId, constraints: constraintsFixture })
    const generated = await saveGeneratedPlan(
      owner,
      { draftId: draft.id, expectedVersion: 0 },
      content,
    )
    const validated = await validateGeneratedPlan(owner, {
      draftId: draft.id,
      expectedVersion: generated.version,
    })
    return approvePlanDraft(owner, {
      draftId: draft.id,
      expectedVersion: validated.version,
      expectedRevisionId: base?.id ?? null,
      approve: true,
    })
  }

  it('stays quiet without an approved plan and evaluates reloads without writing state', async () => {
    await createPlanDraft(owner, { goalId, constraints: constraintsFixture })
    expect(await getPlanReminders(owner, now)).toEqual([])
    await approve()
    expect(await getPlanReminders(owner, new Date('2090-01-20T12:00:00Z'))).toEqual([])
    const first = await getPlanReminders(owner, now)
    expect(first).toHaveLength(1)
    expect(await getPlanReminders(owner, now)).toEqual(first)
    expect(await prisma.planReminderState.count({ where: { userId: owner.userId } })).toBe(0)
  })

  it('persists dismissal across reloads, repeated commands and a late snooze', async () => {
    await approve()
    const [event] = await getPlanReminders(owner, now)
    const command = { planId: event.planId, fingerprint: event.fingerprint, action: 'dismiss' }
    await respondToPlanReminder(owner, command, now)
    await respondToPlanReminder(owner, command, now)
    await respondToPlanReminder(owner, { ...command, action: 'snooze' }, now)
    expect(await getPlanReminders(owner, now)).toEqual([])
    expect(await getPlanReminders(owner, new Date('2090-02-01T12:00:00Z'))).toEqual([])
    expect(
      await prisma.planReminderState.findMany({ where: { userId: owner.userId } }),
    ).toMatchObject([{ dismissedAt: now, snoozedUntil: null }])
  })

  it('honors a persisted 24-hour snooze until the exact expiry and can then dismiss', async () => {
    await approve()
    const [event] = await getPlanReminders(owner, now)
    const command = { planId: event.planId, fingerprint: event.fingerprint, action: 'snooze' }
    await respondToPlanReminder(owner, command, now)
    expect(await getPlanReminders(owner, new Date(now.getTime() + 86400000 - 1))).toEqual([])
    expect(await getPlanReminders(owner, new Date(now.getTime() + 86400000))).toEqual([event])
    await respondToPlanReminder(
      owner,
      { ...command, action: 'dismiss' },
      new Date(now.getTime() + 86400000),
    )
    expect(await getPlanReminders(owner, new Date(now.getTime() + 172800000))).toEqual([])
  })

  it('creates a new event for a new approval and rejects suppression from an old tab', async () => {
    const content = contentFixture()
    const first = await approve(content)
    const [old] = await getPlanReminders(owner, now)
    await respondToPlanReminder(
      owner,
      { planId: old.planId, fingerprint: old.fingerprint, action: 'dismiss' },
      now,
    )
    content.workouts[0].definition.name = 'Updated approved session'
    await approve(content, first)
    const [next] = await getPlanReminders(owner, now)
    expect(next.fingerprint).not.toBe(old.fingerprint)
    await expect(
      respondToPlanReminder(
        owner,
        {
          planId: old.planId,
          fingerprint: old.fingerprint,
          action: 'snooze',
        },
        now,
      ),
    ).rejects.toBeInstanceOf(PlanConflictError)
    expect(await getPlanReminders(owner, now)).toEqual([next])
  })

  it('resolves on an extended detail window or archived goal without changing approved history', async () => {
    const content = contentFixture()
    const first = await approve(content)
    expect(await getPlanReminders(owner, now)).toHaveLength(1)
    const snapshot = await prisma.planRevision.findUniqueOrThrow({ where: { id: first.id } })
    content.detailWindow = { startDate: '2090-01-22', endDate: '2090-02-18' }
    content.workouts[0].scheduledDate = '2090-01-25'
    await approve(content, first)
    expect(await getPlanReminders(owner, now)).toEqual([])
    expect(await getPlanReminders(owner, new Date('2090-02-11T12:00:00Z'))).toHaveLength(1)
    await prisma.goal.update({ where: { id: goalId }, data: { archived: true } })
    expect(await getPlanReminders(owner, new Date('2090-02-11T12:00:00Z'))).toEqual([])
    expect(await prisma.planRevision.findUniqueOrThrow({ where: { id: first.id } })).toEqual(
      snapshot,
    )
  })

  it('keeps a fully covered plan and a completed macro period quiet', async () => {
    const content = contentFixture()
    content.macroPlan.endDate = '2090-01-28'
    content.macroPlan.phases[0].endDate = '2090-01-28'
    await prisma.goal.update({
      where: { id: goalId },
      data: { targetDate: new Date('2090-01-28') },
    })
    await approve(content)
    expect(await getPlanReminders(owner, now)).toEqual([])
    expect(await getPlanReminders(owner, new Date('2090-01-29T12:00:00Z'))).toEqual([])
  })

  it('isolates reads and mutations from a different ADMIN and enforces the owner-plan foreign key', async () => {
    await approve()
    const [event] = await getPlanReminders(owner, now)
    expect(await getPlanReminders(other, now)).toEqual([])
    await expect(
      respondToPlanReminder(
        other,
        {
          planId: event.planId,
          fingerprint: event.fingerprint,
          action: 'dismiss',
        },
        now,
      ),
    ).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    await expect(
      prisma.planReminderState.create({
        data: {
          userId: other.userId,
          planId: event.planId,
          fingerprint: event.fingerprint,
          dismissedAt: now,
        },
      }),
    ).rejects.toThrow()
    expect(await getPlanReminders(owner, now)).toEqual([event])
  })

  it('rejects forged contexts and arbitrary event fingerprints or client-supplied owners', async () => {
    await approve()
    const [event] = await getPlanReminders(owner, now)
    const command = { planId: event.planId, fingerprint: event.fingerprint, action: 'dismiss' }
    await expect(getPlanReminders({ userId: owner.userId }, now)).rejects.toBeInstanceOf(
      InvalidOwnerContextError,
    )
    await expect(
      respondToPlanReminder({ userId: owner.userId }, command, now),
    ).rejects.toBeInstanceOf(InvalidOwnerContextError)
    await expect(
      respondToPlanReminder(owner, { ...command, fingerprint: '0'.repeat(64) }, now),
    ).rejects.toBeInstanceOf(PlanConflictError)
    await expect(
      respondToPlanReminder(owner, { ...command, userId: other.userId }, now),
    ).rejects.toThrow()
    expect(await prisma.planReminderState.count({ where: { userId: owner.userId } })).toBe(0)
  })

  it('cascades suppression when the owning account is deleted', async () => {
    await approve()
    const [event] = await getPlanReminders(owner, now)
    await respondToPlanReminder(
      owner,
      { planId: event.planId, fingerprint: event.fingerprint, action: 'dismiss' },
      now,
    )
    await prisma.user.delete({ where: { id: owner.userId } })
    expect(await prisma.planReminderState.count({ where: { userId: owner.userId } })).toBe(0)
  })

  it('suppresses one plan without hiding another due plan', async () => {
    await approve()
    await approve()
    const events = await getPlanReminders(owner, now)
    expect(events).toHaveLength(2)
    await respondToPlanReminder(
      owner,
      { planId: events[0].planId, fingerprint: events[0].fingerprint, action: 'dismiss' },
      now,
    )
    expect(await getPlanReminders(owner, now)).toEqual([events[1]])
  })

  it('preserves dismissal when two tabs concurrently snooze and dismiss the same event', async () => {
    await approve()
    const [event] = await getPlanReminders(owner, now)
    const key = { planId: event.planId, fingerprint: event.fingerprint }
    await Promise.all([
      respondToPlanReminder(owner, { ...key, action: 'dismiss' }, now),
      respondToPlanReminder(owner, { ...key, action: 'snooze' }, now),
    ])
    expect(await getPlanReminders(owner, new Date('2090-01-23T12:00:00Z'))).toEqual([])
    expect(await prisma.planReminderState.count({ where: { userId: owner.userId } })).toBe(1)
  })

  it('does not offer a refresh after the dated goal horizon changes', async () => {
    await approve()
    expect(await getPlanReminders(owner, now)).toHaveLength(1)
    await prisma.goal.update({
      where: { id: goalId },
      data: { targetDate: new Date('2090-04-30') },
    })
    expect(await getPlanReminders(owner, now)).toEqual([])
  })

  it.each(['2090-02-03', '2090-02-04'])(
    'preserves suppression across the refresh deadline for %s',
    async (endDate) => {
      const content = contentFixture()
      content.macroPlan.endDate = endDate
      content.macroPlan.phases[0].endDate = endDate
      await prisma.goal.update({ where: { id: goalId }, data: { targetDate: new Date(endDate) } })
      await approve(content)
      const deadline = new Date(`${endDate}T12:00:00Z`)
      deadline.setUTCDate(deadline.getUTCDate() - 14)
      const [event] = await getPlanReminders(owner, deadline)
      expect(event.nextAction).toBe('refresh')
      const after = new Date(deadline.getTime() + 86400000)
      expect(await getPlanReminders(owner, after)).toMatchObject([
        { fingerprint: event.fingerprint, nextAction: 'review-plan' },
      ])
      await respondToPlanReminder(
        owner,
        { planId: event.planId, fingerprint: event.fingerprint, action: 'snooze' },
        new Date(deadline.getTime() + 3600000),
      )
      expect(await getPlanReminders(owner, after)).toEqual([])
      const expires = new Date(deadline.getTime() + 90000000)
      expect(await getPlanReminders(owner, expires)).toMatchObject([
        { fingerprint: event.fingerprint, nextAction: 'review-plan' },
      ])
      await respondToPlanReminder(
        owner,
        { planId: event.planId, fingerprint: event.fingerprint, action: 'dismiss' },
        expires,
      )
      expect(await getPlanReminders(owner, new Date(expires.getTime() + 86400000))).toEqual([])
    },
  )
})
