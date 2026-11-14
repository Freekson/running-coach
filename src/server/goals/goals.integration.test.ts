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
