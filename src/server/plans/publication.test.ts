import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  queue: vi.fn(),
  dispatch: vi.fn(),
  factory: vi.fn(),
}))
vi.mock('@/server/db/client', () => ({ getPrismaClient: mocks.client }))
vi.mock('@/server/intervals/publication', () => ({
  createIntervalsPublicationService: mocks.factory.mockReturnValue({
    queue: mocks.queue,
    dispatch: mocks.dispatch,
  }),
}))
import { getOwnerContext, InvalidOwnerContextError } from '@/server/authorization/ownership'
import { fixtureId, fixtureNow, initialResponseFixture } from './exchange/fixtures'
import { previewRevisionPublication, sendRevisionPublication } from './publication'
import type { WorkoutDefinition } from '@/schemas/workout-definition.v1'

const owner = getOwnerContext({ id: fixtureId(900), role: 'USER', email: null })
const other = getOwnerContext({ id: fixtureId(901), role: 'ADMIN', email: null })
const input = { planId: fixtureId(300), expectedRevisionId: fixtureId(301) }
const tx = {
  trainingPlan: { findFirst: vi.fn() },
  planRevisionWorkout: { findMany: vi.fn() },
  workoutPublication: { findMany: vi.fn() },
}
function uncertainReceipt(workout: {
  workoutId: string
  definition: WorkoutDefinition
  scheduledDate: Date
  timezone: string
}) {
  return {
    id: fixtureId(800),
    localWorkoutId: workout.workoutId,
    approvedRevisionId: fixtureId(299),
    publishRevision: 1,
    status: 'UNCERTAIN',
    operation: 'UPDATE',
    pendingWrite: { kind: 'UPSERT', token: fixtureId(801) },
    leaseToken: null,
    payload: {
      localWorkoutId: workout.workoutId,
      revisionId: fixtureId(299),
      approved: true,
      cancelled: false,
      locked: false,
      workout: workout.definition,
      schedule: {
        localDate: workout.scheduledDate.toISOString().slice(0, 10),
        timeZone: workout.timezone,
      },
    },
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(fixtureNow)
  mocks.client.mockResolvedValue({
    $transaction: (operation: (value: typeof tx) => unknown) => operation(tx),
  })
  tx.trainingPlan.findFirst.mockImplementation(({ where }) =>
    where.userId === owner.userId
      ? { id: input.planId, currentRevisionId: input.expectedRevisionId }
      : null,
  )
  const response = initialResponseFixture()
  if (response.mode !== 'initial') throw new Error('Wrong fixture')
  tx.planRevisionWorkout.findMany.mockResolvedValue(
    response.workouts.map((w) => ({
      ...w,
      scheduledDate: new Date(w.scheduledDate),
      timezone: 'Asia/Tokyo',
      cancelled: false,
      workout: { completedAt: null, lockedAt: null },
    })),
  )
  tx.workoutPublication.findMany.mockResolvedValue([])
  mocks.queue.mockResolvedValue({ id: fixtureId(800), publishRevision: 1, status: 'QUEUED' })
  mocks.dispatch.mockResolvedValue({ id: fixtureId(800), publishRevision: 1, status: 'PUBLISHED' })
})
afterEach(() => vi.useRealTimers())
it('previews owned approved future workouts without queuing, provider reads or dispatch', async () => {
  const result = await previewRevisionPublication(owner, input)
  expect(result.workouts[0]).toMatchObject({
    workoutId: result.changes[0].workoutId,
    status: null,
    cancelled: false,
    errorCode: null,
  })
  expect(result.changes[0]).toMatchObject({
    operation: 'CREATE',
    before: null,
    expectedPublishRevision: 0,
  })
  expect(mocks.queue).not.toHaveBeenCalled()
  expect(mocks.dispatch).not.toHaveBeenCalled()
  expect(tx.planRevisionWorkout.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { userId: owner.userId, planId: input.planId, revisionId: input.expectedRevisionId },
    }),
  )
  expect(tx.workoutPublication.findMany).toHaveBeenCalledWith({
    where: {
      userId: owner.userId,
      provider: 'INTERVALS',
      localWorkoutId: { in: result.workouts.map((workout) => workout.workoutId) },
    },
  })
})
it('retains saved publication statuses after settled workouts leave the pending list', async () => {
  const workout = (await tx.planRevisionWorkout.findMany())[0]
  const receipt = uncertainReceipt(workout)
  tx.workoutPublication.findMany.mockResolvedValue([
    {
      ...receipt,
      status: 'PUBLISHED',
      pendingWrite: null,
      errorCode: null,
      remoteAthleteId: 'private-provider-binding',
    },
  ])
  const result = await previewRevisionPublication(owner, input)
  expect(result.changes.some((change) => change.workoutId === workout.workoutId)).toBe(false)
  expect(result.workouts.find((entry) => entry.workoutId === workout.workoutId)).toMatchObject({
    name: workout.definition.name,
    status: 'PUBLISHED',
    fromEarlierRevision: true,
  })
  expect(JSON.stringify(result)).not.toContain('private-provider-binding')
  expect(mocks.queue).not.toHaveBeenCalled()
  expect(mocks.dispatch).not.toHaveBeenCalled()
})
it.each(['QUEUED', 'FAILED', 'RUNNING'] as const)(
  'restores %s receipts without dispatching and presents expired leases as uncertain',
  async (status) => {
    const workout = (await tx.planRevisionWorkout.findMany())[0]
    tx.workoutPublication.findMany.mockResolvedValue([
      {
        ...uncertainReceipt(workout),
        status,
        pendingWrite: null,
        leaseToken: status === 'RUNNING' ? fixtureId(802) : null,
        leaseExpiresAt: status === 'RUNNING' ? new Date(fixtureNow.getTime() - 1) : null,
        errorCode: status === 'FAILED' ? 'PERMISSION_REQUIRED' : null,
      },
    ])
    const result = await previewRevisionPublication(owner, input)
    const expected = status === 'RUNNING' ? 'UNCERTAIN' : status
    expect(result.workouts[0]).toMatchObject({ status: expected })
    expect(result.changes[0]).toMatchObject({ status: expected })
    expect(mocks.queue).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
  },
)
it('shows the last confirmed schedule after a reschedule intent fails instead of comparing the intent with itself', async () => {
  const workout = (await tx.planRevisionWorkout.findMany())[0]
  const pending = uncertainReceipt(workout)
  const baseline = {
    ...pending.payload,
    schedule: { ...pending.payload.schedule, localDate: '2026-11-16' },
  }
  const intent = { ...pending.payload, revisionId: input.expectedRevisionId }
  tx.workoutPublication.findMany.mockResolvedValue([
    {
      ...pending,
      status: 'FAILED',
      operation: 'RESCHEDULE',
      pendingWrite: null,
      payload: intent,
      lastConfirmedPayload: baseline,
    },
  ])
  const result = await previewRevisionPublication(owner, input)
  expect(result.changes[0]).toMatchObject({
    operation: 'RESCHEDULE',
    kind: 'changed',
    baselineStatus: 'confirmed',
    remoteStateUncertain: false,
    before: { scheduledDate: '2026-11-16' },
    after: { scheduledDate: workout.scheduledDate.toISOString().slice(0, 10) },
  })
  expect(result.changes[0].before?.scheduledDate).not.toBe(result.changes[0].after.scheduledDate)
  tx.workoutPublication.findMany.mockResolvedValue([
    { ...pending, payload: intent, operation: 'RESCHEDULE', lastConfirmedPayload: baseline },
  ])
  const uncertain = await previewRevisionPublication(owner, input)
  expect(uncertain.changes[0]).toMatchObject({
    operation: 'RESCHEDULE',
    before: { scheduledDate: '2026-11-16' },
    remoteStateUncertain: true,
    baselineStatus: 'confirmed',
  })
})
it('exposes an unknown legacy baseline explicitly and preserves the original retry operation', async () => {
  const workout = (await tx.planRevisionWorkout.findMany())[0]
  const pending = uncertainReceipt(workout)
  tx.workoutPublication.findMany.mockResolvedValue([
    {
      ...pending,
      operation: 'RESCHEDULE',
      payload: { ...pending.payload, revisionId: input.expectedRevisionId },
      lastConfirmedPayload: null,
    },
  ])
  const preview = await previewRevisionPublication(owner, input)
  expect(preview.changes[0]).toMatchObject({
    before: null,
    kind: 'changed',
    operation: 'RESCHEDULE',
    baselineStatus: 'unknown',
    remoteStateUncertain: true,
  })
})
it('queues and dispatches only the exact change after separate explicit confirmation', async () => {
  const preview = await previewRevisionPublication(owner, input)
  const change = preview.changes[0]
  const command = { ...input, workoutId: change.workoutId, reviewToken: change.reviewToken }
  await expect(sendRevisionPublication(owner, command)).rejects.toThrow()
  expect(mocks.queue).not.toHaveBeenCalled()
  await sendRevisionPublication(owner, { ...command, confirm: true })
  expect(mocks.queue).toHaveBeenCalledExactlyOnceWith(owner, {
    localWorkoutId: change.workoutId,
    expectedRevisionId: input.expectedRevisionId,
    expectedPublishRevision: 0,
  })
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(owner, {
    publicationId: fixtureId(800),
    publishRevision: 1,
  })
})
it('rejects foreign, forged, stale and tampered reviews before any outbox effects', async () => {
  const preview = await previewRevisionPublication(owner, input)
  const command = {
    ...input,
    workoutId: preview.changes[0].workoutId,
    reviewToken: preview.changes[0].reviewToken,
    confirm: true,
  }
  await expect(sendRevisionPublication(other, command)).rejects.toThrow()
  await expect(sendRevisionPublication({ userId: owner.userId }, command)).rejects.toBeInstanceOf(
    InvalidOwnerContextError,
  )
  await expect(
    sendRevisionPublication(owner, { ...command, reviewToken: '0'.repeat(64) }),
  ).rejects.toThrow('changed')
  tx.trainingPlan.findFirst.mockResolvedValue({
    id: input.planId,
    currentRevisionId: fixtureId(999),
  })
  await expect(sendRevisionPublication(owner, command)).rejects.toThrow('changed')
  expect(mocks.queue).not.toHaveBeenCalled()
  expect(mocks.dispatch).not.toHaveBeenCalled()
})
it('blocks a reviewed workout that became completed or locked before confirmation', async () => {
  const preview = await previewRevisionPublication(owner, input)
  const rows = await tx.planRevisionWorkout.findMany()
  rows[0].workout.lockedAt = fixtureNow
  await expect(
    sendRevisionPublication(owner, {
      ...input,
      workoutId: preview.changes[0].workoutId,
      reviewToken: preview.changes[0].reviewToken,
      confirm: true,
    }),
  ).rejects.toThrow('changed')
  expect(mocks.queue).not.toHaveBeenCalled()
})
it('reconciles an uncertain earlier intent before queuing changes from a newer revision', async () => {
  const rows = await tx.planRevisionWorkout.findMany()
  const workout = rows[0]
  tx.workoutPublication.findMany.mockResolvedValue([uncertainReceipt(workout)])
  const preview = await previewRevisionPublication(owner, input)
  const change = preview.changes[0]
  expect(change.recovery).toEqual({ publicationId: fixtureId(800), publishRevision: 1 })
  mocks.dispatch.mockResolvedValue({ id: fixtureId(800), status: 'SUPERSEDED' })
  expect(
    await sendRevisionPublication(owner, {
      ...input,
      workoutId: change.workoutId,
      reviewToken: change.reviewToken,
      confirm: true,
    }),
  ).toMatchObject({ status: 'SUPERSEDED' })
  expect(mocks.queue).not.toHaveBeenCalled()
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(owner, change.recovery)
})
it.each(['locked', 'completed', 'past'] as const)(
  'keeps uncertain %s workouts recoverable without queuing new prescriptions',
  async (protection) => {
    const rows = await tx.planRevisionWorkout.findMany()
    const workout = rows[0]
    const receipt = uncertainReceipt(workout)
    tx.workoutPublication.findMany.mockResolvedValue([receipt])
    if (protection === 'locked') workout.workout.lockedAt = fixtureNow
    else if (protection === 'completed') workout.workout.completedAt = fixtureNow
    else workout.scheduledDate = new Date('2026-11-14')
    const preview = await previewRevisionPublication(owner, input)
    const change = preview.changes.find((entry) => entry.workoutId === workout.workoutId)!
    expect(change).toMatchObject({
      recoveryOnly: true,
      recovery: { publicationId: receipt.id, publishRevision: 1 },
    })
    mocks.dispatch.mockResolvedValue({ id: receipt.id, status: 'SUPERSEDED' })
    await expect(
      sendRevisionPublication(other, {
        ...input,
        workoutId: change.workoutId,
        reviewToken: change.reviewToken,
        confirm: true,
      }),
    ).rejects.toThrow()
    await sendRevisionPublication(owner, {
      ...input,
      workoutId: change.workoutId,
      reviewToken: change.reviewToken,
      confirm: true,
    })
    expect(mocks.queue).not.toHaveBeenCalled()
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(owner, change.recovery)
    tx.workoutPublication.findMany.mockResolvedValue([
      { ...receipt, status: 'SUPERSEDED', pendingWrite: null },
    ])
    expect(
      (await previewRevisionPublication(owner, input)).changes.some(
        (entry) => entry.workoutId === change.workoutId,
      ),
    ).toBe(false)
  },
)
