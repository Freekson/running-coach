import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getPrismaClient } from '@/server/db/client'
import {
  getOwnerContext,
  InvalidOwnerContextError,
  OwnedResourceNotFoundError,
} from '@/server/authorization/ownership'
import { createPlanDraft, getPlanDraft, updatePlanDraftConstraints } from '@/server/plans/drafts'
import { archiveGoal, deleteGoal, getGoal, GoalInUseError, listGoals, saveGoal } from './goals'
import { archiveGoalAction, deleteGoalAction, saveGoalAction } from '@/app/(auth)/app/goals/actions'
import type { GoalInput } from '@/lib/goals'
import { getEditableGoal, GoalReadOnlyError, listGoalsWithProgress } from './goals'
import { normalizeGarminActivitySummary } from '@/server/garmin/normalization'
import { importCanonicalActivity } from '@/server/activity/import'
import {
  getGoalsSnapshot,
  saveGoalWithReceipt,
  archiveGoalWithReceipt,
  deleteGoalWithReceipt,
} from './goals'
import {
  acceptGoalMutation,
  acceptGoalSnapshot,
  createGoalState,
  goalStateRecords,
  seesGoalMutation,
} from '@/app/(auth)/app/goals/goal-state'
import { readGoalSnapshotMetadata } from './snapshot'

const { getCurrentUser } = vi.hoisted(() => ({ getCurrentUser: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class AccountUnavailableError extends Error {},
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const requested = process.env.npm_lifecycle_event === 'test:db'
if (requested) config()
const enabled =
  requested &&
  ['test', 'development'].includes(process.env.APP_DATABASE_ENV ?? '') &&
  !!process.env.DATABASE_URL &&
  !!process.env.DIRECT_URL &&
  !process.env.VERCEL_ENV
if (requested && !enabled) throw new Error('Isolated development/test database required')

const goalInput: GoalInput = {
  name: 'A synthetic goal',
  type: 'PERFORMANCE',
  distanceMeters: 3000,
  targetTimeSeconds: null,
  targetCount: null,
  measurementWindow: null,
  targetDate: '2027-03-15',
  surface: 'TRACK',
  elevationGainM: null,
}

describe.skipIf(!enabled)('RUN-32 PostgreSQL ownership and draft boundaries', () => {
  let prisma: PrismaClient
  const prefix = `run32-${randomUUID()}`
  beforeAll(async () => {
    prisma = await getPrismaClient()
  }, 30000)
  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
    await prisma.$disconnect()
  })

  it('ties snapshots and mutation receipts to actual commits, including a delayed repeatable read', async () => {
    const user = await prisma.user.create({ data: { authSubject: `${prefix}-snapshots` } })
    const otherUser = await prisma.user.create({
      data: { authSubject: `${prefix}-snapshots-other` },
    })
    const owner = getOwnerContext({ id: user.id, role: 'USER', email: null })
    const other = getOwnerContext({ id: otherUser.id, role: 'USER', email: null })
    const initial = await getGoalsSnapshot(owner)
    expect(initial.goals).toEqual([])
    expect(initial.ownerId).toBe(user.id)
    const created = await saveGoalWithReceipt(owner, { ...goalInput, targetDate: null })
    expect(created.receipt.ownerId).toBe(user.id)
    expect(seesGoalMutation(initial.snapshot, created.receipt.transactionId)).toBe(false)
    let state = acceptGoalMutation(createGoalState(initial), created.value.id, created)
    const afterCreate = await getGoalsSnapshot(owner)
    expect(seesGoalMutation(afterCreate.snapshot, created.receipt.transactionId)).toBe(true)
    const [databaseVisibility] = await prisma.$queryRaw<{ visible: boolean }[]>`
      SELECT pg_visible_in_snapshot(${created.receipt.transactionId}::xid8, ${afterCreate.snapshot}::pg_snapshot) AS visible
    `
    expect(databaseVisibility.visible).toBe(true)
    state = acceptGoalSnapshot(state, afterCreate)
    expect(state.confirmed.size).toBe(0)
    expect(goalStateRecords(state).map((goal) => goal.id)).toEqual([created.value.id])
    expect((await getGoalsSnapshot(other)).goals).toEqual([])
    await expect(getGoalsSnapshot({ userId: user.id })).rejects.toBeInstanceOf(
      InvalidOwnerContextError,
    )

    let establish: (() => void) | undefined, release: (() => void) | undefined
    const established = new Promise<void>((resolve) => {
      establish = resolve
    })
    const resume = new Promise<void>((resolve) => {
      release = resolve
    })
    const delayedRead = prisma.$transaction(
      async (tx) => {
        const metadata = await readGoalSnapshotMetadata(tx)
        establish?.()
        await resume
        const count = await tx.goal.count({ where: { userId: user.id, id: created.value.id } })
        return { ...metadata, count }
      },
      { isolationLevel: 'RepeatableRead', timeout: 10000 },
    )
    await established
    let deleted
    try {
      deleted = await deleteGoalWithReceipt(owner, created.value.id)
    } finally {
      release?.()
    }
    const oldRead = await delayedRead
    expect(oldRead.count).toBe(1)
    expect(seesGoalMutation(oldRead.snapshot, deleted.receipt.transactionId)).toBe(false)
    state = acceptGoalMutation(state, created.value.id, deleted)
    state = acceptGoalSnapshot(state, { ...oldRead, ownerId: user.id, goals: afterCreate.goals })
    expect(goalStateRecords(state)).toEqual([])
    const afterDelete = await getGoalsSnapshot(owner)
    expect(seesGoalMutation(afterDelete.snapshot, deleted.receipt.transactionId)).toBe(true)
    state = acceptGoalSnapshot(state, afterDelete)
    expect(state.confirmed.size).toBe(0)
    expect(goalStateRecords(state)).toEqual([])

    const another = await saveGoalWithReceipt(owner, { ...goalInput, targetDate: null })
    const archived = await archiveGoalWithReceipt(owner, another.value.id, true)
    const restored = await archiveGoalWithReceipt(owner, another.value.id, false)
    expect(seesGoalMutation(restored.receipt.snapshot, archived.receipt.transactionId)).toBe(true)
    expect(seesGoalMutation(archived.receipt.snapshot, restored.receipt.transactionId)).toBe(false)
  }, 30000)

  it('imports recorded surfaces and blocks achieved/completed/archived edits at the server boundary', async () => {
    const user = await prisma.user.create({ data: { authSubject: `${prefix}-read-only` } })
    const otherUser = await prisma.user.create({
      data: { authSubject: `${prefix}-read-only-other`, role: 'ADMIN' },
    })
    const owner = getOwnerContext({ id: user.id, role: 'USER', email: null })
    const other = getOwnerContext({ id: otherUser.id, role: 'ADMIN', email: null })
    const account = `${prefix}-account`
    await prisma.integrationConnection.create({
      data: {
        userId: user.id,
        provider: 'GARMIN',
        authMethod: 'OAUTH',
        externalAccountId: account,
      },
    })
    const completion = await saveGoal(owner, {
      ...goalInput,
      type: 'COMPLETION',
      surface: 'TRAIL',
      distanceMeters: 5000,
      targetDate: null,
    })
    const performance = await saveGoal(owner, {
      ...goalInput,
      surface: 'TRAIL',
      distanceMeters: 5000,
      targetTimeSeconds: 1600,
      targetDate: null,
    })
    const normalized = normalizeGarminActivitySummary(owner, {
      activityId: `${prefix}-surface`,
      activityType: { typeKey: 'trail_running' },
      startTimeGMT: '2026-11-12 06:00:00',
      distance: 5000,
      duration: 1500,
      elapsedDuration: 1500,
    })
    const imported = await importCanonicalActivity(owner, normalized, { garminAccountId: account })
    expect(
      (await prisma.activity.findUniqueOrThrow({ where: { id: imported.id } })).surfaceType,
    ).toBe('TRAIL')
    // Legacy rows also work immediately, without a backfill.
    await prisma.activity.update({ where: { id: imported.id }, data: { surfaceType: null } })
    for (const goal of [completion, performance]) {
      expect(
        (await listGoalsWithProgress(owner)).find((item) => item.id === goal.id)?.progress.achieved,
      ).toBe(true)
      await expect(getEditableGoal(owner, goal.id)).rejects.toBeInstanceOf(GoalReadOnlyError)
      await expect(
        saveGoal(owner, { ...goalInput, name: 'Forbidden edit' }, goal.id),
      ).rejects.toBeInstanceOf(GoalReadOnlyError)
      await expect(saveGoal(other, goalInput, goal.id)).rejects.toBeInstanceOf(
        OwnedResourceNotFoundError,
      )
      getCurrentUser.mockResolvedValue({ id: user.id, role: 'USER', email: null })
      expect(await saveGoalAction(goalInput, goal.id)).toEqual({
        success: false,
        error: new GoalReadOnlyError().message,
      })
      expect((await getGoal(owner, goal.id)).name).toBe(goal.name)
    }
    const archived = await saveGoal(owner, { ...goalInput, targetDate: null, surface: 'ROAD' })
    await archiveGoal(owner, archived.id, true)
    await expect(saveGoal(owner, goalInput, archived.id)).rejects.toBeInstanceOf(GoalReadOnlyError)
    await archiveGoal(owner, archived.id, false)
    expect(
      (await saveGoal(owner, { ...goalInput, name: 'Editable after restore' }, archived.id)).name,
    ).toBe('Editable after restore')
    getCurrentUser.mockResolvedValue(null)
    expect((await saveGoalAction(goalInput, completion.id)).success).toBe(false)
  }, 30000)

  it('RUN-45 calculates from only the owner’s eligible activities, never another athlete’s runs', async () => {
    const a = await prisma.user.create({
      data: { authSubject: `${prefix}-progress-a`, role: 'ADMIN' },
    })
    const b = await prisma.user.create({ data: { authSubject: `${prefix}-progress-b` } })
    const ownerA = getOwnerContext({ id: a.id, role: 'ADMIN', email: null })
    const ownerB = getOwnerContext({ id: b.id, role: 'USER', email: null })
    const volume = {
      ...goalInput,
      type: 'VOLUME',
      distanceMeters: 10000,
      surface: 'ANY',
      targetDate: null,
      measurementWindow: 'MONTH',
    }
    await saveGoal(ownerA, volume)
    await saveGoal(ownerB, volume)
    await prisma.athleteProfile.create({ data: { userId: a.id, preferredTimezone: 'Asia/Tokyo' } })
    const activity = {
      sourceProvider: 'MANUAL' as const,
      sportType: 'RUNNING',
      startedAt: new Date('2026-11-05T12:00:00Z'),
      listStartedAt: new Date('2026-11-05T12:00:00Z'),
      distanceMeters: 3000,
    }
    const first = await prisma.activity.create({ data: { ...activity, userId: a.id } })
    await prisma.activity.createMany({
      data: [
        { ...activity, userId: b.id, distanceMeters: 20000 },
        { ...activity, userId: a.id, sportType: 'CYCLING', distanceMeters: 50000 },
        { ...activity, userId: a.id, startedAt: new Date('2026-12-01T00:00:00Z') },
        { ...activity, userId: a.id, sourceProvider: 'GARMIN', garminAccountId: 'unverified' },
        { ...activity, userId: a.id, startedAt: new Date('2026-10-30T00:00:00Z') },
      ],
    })
    const now = new Date('2026-11-14T06:00:00Z')
    expect((await listGoalsWithProgress(ownerA, now))[0].progress).toMatchObject({
      distanceMeters: 3000,
      percent: 30,
      status: 'ACTIVE',
      timezone: 'Asia/Tokyo',
    })
    expect((await listGoalsWithProgress(ownerB, now))[0].progress).toMatchObject({
      distanceMeters: 20000,
      percent: 100,
      status: 'ACHIEVED',
    })
    const duplicate = await prisma.activity.create({ data: { ...activity, userId: a.id } })
    const [firstActivityId, secondActivityId] = [first.id, duplicate.id].sort()
    await prisma.activityDuplicateCandidate.create({
      data: {
        userId: a.id,
        firstActivityId,
        secondActivityId,
      },
    })
    expect((await listGoalsWithProgress(ownerA, now))[0].progress.distanceMeters).toBe(0)
  }, 30000)

  it('isolates goals and independent draft constraints, including ADMIN and nested FK attacks', async () => {
    const a = await prisma.user.create({ data: { authSubject: `${prefix}-a`, role: 'ADMIN' } })
    const b = await prisma.user.create({ data: { authSubject: `${prefix}-b` } })
    const ownerA = getOwnerContext({ id: a.id, role: 'ADMIN', email: null })
    const ownerB = getOwnerContext({ id: b.id, role: 'USER', email: null })
    const aGoal = await saveGoal(ownerA, goalInput)
    const bGoal = await saveGoal(ownerB, {
      ...goalInput,
      name: 'Another athlete goal',
      distanceMeters: 42195,
    })
    for (const distanceMeters of [83501.125, 161000]) {
      expect((await saveGoal(ownerA, { ...goalInput, distanceMeters })).distanceMeters).toBe(
        distanceMeters,
      )
    }
    expect((await listGoals(ownerA)).map((goal) => goal.id)).not.toContain(bGoal.id)
    expect((await listGoals(ownerB)).map((goal) => goal.id)).toEqual([bGoal.id])
    await expect(getGoal(ownerA, bGoal.id)).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    await expect(saveGoal(ownerA, goalInput, bGoal.id)).rejects.toBeInstanceOf(
      OwnedResourceNotFoundError,
    )
    await expect(archiveGoal(ownerA, bGoal.id, true)).rejects.toBeInstanceOf(
      OwnedResourceNotFoundError,
    )
    await expect(deleteGoal(ownerA, bGoal.id)).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    await expect(listGoals({ userId: b.id })).rejects.toBeInstanceOf(InvalidOwnerContextError)
    await expect(saveGoal(ownerA, { ...goalInput, userId: b.id })).rejects.toThrow()
    await expect(saveGoal(ownerA, goalInput, '')).rejects.toThrow()
    const volume = await saveGoal(ownerA, {
      ...goalInput,
      type: 'VOLUME',
      measurementWindow: 'MONTH',
    })
    const consistency = await saveGoal(ownerA, {
      ...goalInput,
      type: 'CONSISTENCY',
      distanceMeters: null,
      targetCount: 4,
      measurementWindow: 'WEEK',
    })
    expect(await getGoal(ownerA, volume.id)).toMatchObject({
      measurementWindow: 'MONTH',
      type: 'VOLUME',
    })
    expect(await getGoal(ownerA, consistency.id)).toMatchObject({
      targetCount: 4,
      distanceMeters: null,
    })

    await archiveGoal(ownerA, aGoal.id, true)
    expect((await getGoal(ownerA, aGoal.id)).archived).toBe(true)
    await archiveGoal(ownerA, aGoal.id, false)
    await saveGoal(ownerA, { ...goalInput, name: 'Updated', targetTimeSeconds: 600 }, aGoal.id)
    expect(await getGoal(ownerA, aGoal.id)).toMatchObject({
      name: 'Updated',
      archived: false,
      targetTimeSeconds: 600,
    })
    await prisma.athleteProfile.create({
      data: {
        userId: a.id,
        defaultTrainingDaysPerWeek: 4,
        defaultAvailableWeekdays: [0, 1, 3, 5],
        preferredTimezone: 'Asia/Tokyo',
      },
    })
    const draftA = await createPlanDraft(ownerA, { goalId: aGoal.id })
    const custom = {
      sessionsPerWeek: 2,
      availableWeekdays: [2, 4],
      maxSessionMinutes: 50,
      startDate: '2027-01-01',
      timezone: 'Asia/Tokyo',
    }
    const draftB = await createPlanDraft(ownerA, { goalId: aGoal.id, constraints: custom })
    expect((await getPlanDraft(ownerA, draftA.id)).constraints).toMatchObject({
      sessionsPerWeek: 4,
      availableWeekdays: [0, 1, 3, 5],
    })
    await updatePlanDraftConstraints(ownerA, draftB.id, {
      ...custom,
      sessionsPerWeek: 1,
      availableWeekdays: [6],
    })
    expect((await getPlanDraft(ownerA, draftA.id)).constraints.sessionsPerWeek).toBe(4)
    expect(
      (await prisma.athleteProfile.findUniqueOrThrow({ where: { userId: a.id } }))
        .defaultTrainingDaysPerWeek,
    ).toBe(4)
    await prisma.athleteProfile.update({
      where: { userId: a.id },
      data: { defaultTrainingDaysPerWeek: 3 },
    })
    expect((await getPlanDraft(ownerA, draftA.id)).constraints.sessionsPerWeek).toBe(4)
    expect((await getGoal(ownerA, aGoal.id)).name).toBe('Updated')
    await expect(createPlanDraft(ownerA, { goalId: bGoal.id })).rejects.toBeInstanceOf(
      OwnedResourceNotFoundError,
    )
    await expect(getPlanDraft(ownerB, draftA.id)).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    await expect(updatePlanDraftConstraints(ownerB, draftA.id, custom)).rejects.toBeInstanceOf(
      OwnedResourceNotFoundError,
    )
    await expect(deleteGoal(ownerA, aGoal.id)).rejects.toBeInstanceOf(GoalInUseError)
    // Bypass services to prove the composite owner FK, not only query filtering.
    await expect(
      prisma.planDraft.create({
        data: { userId: a.id, goalId: bGoal.id, ...custom, startDate: null },
      }),
    ).rejects.toMatchObject({ code: 'P2003' })
    const removable = await saveGoal(ownerA, goalInput)
    await deleteGoal(ownerA, removable.id)
    await expect(getGoal(ownerA, removable.id)).rejects.toBeInstanceOf(OwnedResourceNotFoundError)

    getCurrentUser.mockResolvedValue(null)
    expect((await saveGoalAction(goalInput)).success).toBe(false)
    expect((await archiveGoalAction(bGoal.id, true)).success).toBe(false)
    expect((await deleteGoalAction(bGoal.id)).success).toBe(false)
    getCurrentUser.mockResolvedValue({ id: a.id, role: 'ADMIN', email: null })
    expect(await saveGoalAction(goalInput, bGoal.id)).toEqual({
      success: false,
      error: 'Goal not found.',
    })
    expect(await archiveGoalAction(bGoal.id, true)).toEqual({
      success: false,
      error: 'Goal not found.',
    })
    expect(await deleteGoalAction(bGoal.id)).toEqual({ success: false, error: 'Goal not found.' })
    expect((await saveGoalAction({ ...goalInput, userId: b.id })).success).toBe(false)
    expect((await getGoal(ownerB, bGoal.id)).name).toBe('Another athlete goal')
  }, 30000)
})
