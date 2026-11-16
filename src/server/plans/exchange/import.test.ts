import { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
const mocks = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/server/db/client', () => ({ getPrismaClient: mocks.client }))
import { getOwnerContext, InvalidOwnerContextError } from '@/server/authorization/ownership'
import { previewPlanImport } from './import'
import {
  fixtureId,
  fixtureNow,
  initialFixture,
  initialResponseFixture,
  refreshFixture,
  refreshResponseFixture,
} from './fixtures'

const owner = getOwnerContext({ id: fixtureId(900), role: 'USER', email: null })
const other = getOwnerContext({ id: fixtureId(901), role: 'ADMIN', email: null })
const goalId = fixtureId(102)
const command = { goalId, draftId: fixtureId(101), requestId: fixtureId(100) }
const tx = {
  planExchangeRequest: { findFirst: vi.fn(), create: vi.fn() },
  planDraft: { findFirst: vi.fn(), update: vi.fn() },
  goal: { findFirst: vi.fn() },
  trainingPlan: { findFirst: vi.fn(), update: vi.fn() },
  planRevision: { findFirst: vi.fn(), create: vi.fn() },
  planRevisionWorkout: { findMany: vi.fn() },
  plannedWorkout: { count: vi.fn(), update: vi.fn() },
  workoutPublication: { create: vi.fn() },
}
const transaction = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(fixtureNow)
  mocks.client.mockResolvedValue({ $transaction: transaction })
  transaction.mockImplementation((operation) => operation(tx))
  const request = initialFixture(owner)
  tx.planExchangeRequest.findFirst.mockImplementation(({ where }) => {
    if (
      where.userId !== owner.userId ||
      (where.goalId && where.goalId !== goalId) ||
      (where.draftId && where.draftId !== command.draftId) ||
      (where.id && where.id !== command.requestId)
    )
      return null
    return { id: request.requestId, snapshot: request, schemaVersion: 1, draftVersion: 0 }
  })
  tx.planDraft.findFirst.mockResolvedValue({
    id: request.draft.draftId,
    goalId,
    version: 0,
    state: 'DRAFT',
    ...request.draft.constraints,
    startDate: new Date(request.draft.constraints.startDate!),
    planId: null,
    baseRevisionId: null,
  })
  tx.goal.findFirst.mockResolvedValue({
    ...request.goal,
    id: goalId,
    archived: false,
    distanceMeters: new Prisma.Decimal(request.goal.distanceMeters!),
    targetDate: new Date(request.goal.targetDate!),
  })
  tx.plannedWorkout.count.mockResolvedValue(0)
  tx.planRevisionWorkout.findMany.mockResolvedValue([])
})
afterEach(() => {
  for (const mutation of [
    tx.planExchangeRequest.create,
    tx.planDraft.update,
    tx.trainingPlan.update,
    tx.planRevision.create,
    tx.plannedWorkout.update,
    tx.workoutPublication.create,
  ])
    expect(mutation).not.toHaveBeenCalled()
  vi.useRealTimers()
})

function setupRefresh() {
  const request = refreshFixture(owner)
  if (request.mode !== 'refresh') throw new Error('Wrong fixture')
  request.currentApprovedRevision.narrativePolicy = 'withheld'
  const revision = request.currentApprovedRevision
  tx.planExchangeRequest.findFirst.mockResolvedValue({
    id: request.requestId,
    snapshot: request,
    schemaVersion: 1,
    draftVersion: 0,
  })
  tx.planDraft.findFirst.mockResolvedValue({
    id: request.draft.draftId,
    goalId,
    version: 0,
    state: 'DRAFT',
    ...request.draft.constraints,
    startDate: new Date(request.draft.constraints.startDate!),
    planId: revision.planId,
    baseRevisionId: revision.revisionId,
  })
  tx.trainingPlan.findFirst.mockResolvedValue({
    id: revision.planId,
    currentRevisionId: revision.revisionId,
  })
  tx.planRevision.findFirst.mockResolvedValue({
    id: revision.revisionId,
    planId: revision.planId,
    revisionNumber: 1,
  })
  const rows = revision.workouts.map((w) => ({
    ...w,
    scheduledDate: new Date(w.scheduledDate),
    workout: {
      completedAt: w.completedAt ? new Date(w.completedAt) : null,
      lockedAt: w.lockedAt ? new Date(w.lockedAt) : null,
    },
  }))
  tx.planRevisionWorkout.findMany.mockResolvedValue(rows)
  return { request, rows }
}

describe('RUN-36 live owner-bound preview', () => {
  it('validates without draft, approval, publication or provider mutations', async () => {
    const result = await previewPlanImport(owner, command, JSON.stringify(initialResponseFixture()))
    expect(result.valid).toBe(true)
    expect(transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'Serializable' })
  })
  it('rejects a forged owner before reading the database', async () => {
    await expect(previewPlanImport({ userId: owner.userId }, command, '{}')).rejects.toBeInstanceOf(
      InvalidOwnerContextError,
    )
    expect(mocks.client).not.toHaveBeenCalled()
  })
  it('gives another user including ADMIN the same unavailable error as an unknown request', async () => {
    const foreign = await previewPlanImport(other, command, '{}')
    const missing = await previewPlanImport(owner, { ...command, requestId: fixtureId(999) }, '{}')
    expect(foreign).toEqual(missing)
    expect(!foreign.valid && foreign.errors[0].code).toBe('request_unavailable')
  })
  it.each([{ goalId: fixtureId(999) }, { draftId: fixtureId(999) }])(
    'requires the selected goal and draft %j',
    async (patch) => {
      const result = await previewPlanImport(owner, { ...command, ...patch }, '{}')
      expect(!result.valid && result.errors[0].code).toBe('request_unavailable')
    },
  )
  it('rejects a response for a different request ID with a repair path', async () => {
    const result = await previewPlanImport(
      owner,
      command,
      JSON.stringify({ ...initialResponseFixture(), requestId: fixtureId(999) }),
    )
    expect(!result.valid && result.errors[0].path).toEqual(['requestId'])
  })
  it('rejects a superseded export before accepting its response', async () => {
    tx.planExchangeRequest.findFirst
      .mockResolvedValueOnce({ id: command.requestId, snapshot: initialFixture(owner) })
      .mockResolvedValueOnce({ id: fixtureId(999) })
    const result = await previewPlanImport(owner, command, JSON.stringify(initialResponseFixture()))
    expect(!result.valid && result.errors[0].code).toBe('stale_request')
    expect(!result.valid && result.repairPrompt).toBeNull()
  })
  it('rejects a concurrently edited draft, changed goal and changed constraints', async () => {
    const originalDraft = await tx.planDraft.findFirst()
    const originalGoal = await tx.goal.findFirst()
    for (const [draft, goal] of [
      [{ ...originalDraft, version: 1 }, originalGoal],
      [originalDraft, { ...originalGoal, name: 'Changed selected goal' }],
      [{ ...originalDraft, maxSessionMinutes: 15 }, originalGoal],
    ]) {
      tx.planDraft.findFirst.mockResolvedValue(draft)
      tx.goal.findFirst.mockResolvedValue(goal)
      const result = await previewPlanImport(
        owner,
        command,
        JSON.stringify(initialResponseFixture()),
      )
      expect(!result.valid && result.errors[0].code).toBe('stale_request')
    }
  })
  it('rechecks revision identity against the current plan pointer', async () => {
    setupRefresh()
    tx.trainingPlan.findFirst.mockResolvedValue({
      id: fixtureId(300),
      currentRevisionId: fixtureId(999),
    })
    tx.planRevision.findFirst.mockResolvedValue({
      id: fixtureId(999),
      planId: fixtureId(300),
      revisionNumber: 2,
    })
    const result = await previewPlanImport(owner, command, JSON.stringify(refreshResponseFixture()))
    expect(!result.valid && result.errors[0].code).toBe('stale_request')
  })
  it.each([
    { field: 'completedAt', code: 'stale_request' },
    { field: 'lockedAt', code: 'locked_workout' },
  ] as const)(
    'refuses updates when the workout acquired $field after export',
    async ({ field, code }) => {
      const { rows } = setupRefresh()
      rows[0].workout[field] = new Date(fixtureNow)
      const result = await previewPlanImport(
        owner,
        command,
        JSON.stringify(refreshResponseFixture()),
      )
      expect(!result.valid && result.errors[0].code).toBe(code)
    },
  )
  it('rejects omitted newly completed commitments before accepting previous warning acknowledgements', async () => {
    const { rows } = setupRefresh()
    const response = refreshResponseFixture()
    if (response.mode !== 'refresh') throw new Error('Wrong fixture')
    response.operations = []
    const text = JSON.stringify(response)
    const original = await previewPlanImport(owner, command, text)
    if (!original.valid) throw new Error('Expected an initial valid preview')
    expect(original.preview.sessions.map((w) => w.workoutId)).toContain(rows[0].workoutId)
    rows[0].workout.completedAt = fixtureNow
    const result = await previewPlanImport(
      owner,
      {
        ...command,
        acknowledgedWarningIds: original.preview.warnings.map((w) => w.id),
      },
      text,
    )
    expect(!result.valid && result.errors[0].code).toBe('stale_request')
    expect(!result.valid && result.repairPrompt).toBeNull()
  })
  it('preserves omitted protected original narrative during refresh validation', async () => {
    const { rows } = setupRefresh()
    rows[1].definition.name = 'PRIVATE prior-plan narrative'
    const before = JSON.stringify(rows)
    const result = await previewPlanImport(owner, command, JSON.stringify(refreshResponseFixture()))
    expect(result.valid).toBe(true)
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(JSON.stringify(rows)).toBe(before)
  })
  it('rejects a new session landing on a newly locked date', async () => {
    const { rows } = setupRefresh()
    rows[0].workout.lockedAt = fixtureNow
    const response = refreshResponseFixture()
    if (response.mode !== 'refresh') throw new Error('Wrong fixture')
    response.operations = [response.operations[1]]
    const create = response.operations[0]
    if (create.operation === 'cancel') throw new Error('Wrong operation')
    create.scheduledDate = '2026-11-17'
    const result = await previewPlanImport(owner, command, JSON.stringify(response))
    expect(!result.valid && result.errors[0].code).toBe('invalid_date')
  })
  it('requires a fresh export when the detail window is no longer entirely future', async () => {
    setupRefresh()
    vi.setSystemTime(new Date('2026-11-17T00:00:00Z'))
    const result = await previewPlanImport(owner, command, JSON.stringify(refreshResponseFixture()))
    expect(!result.valid && result.errors[0].code).toBe('stale_request')
  })
  it('refuses an elapsed workout in its own timezone even while the request window remains future', async () => {
    const { request, rows } = setupRefresh()
    if (request.mode !== 'refresh') throw new Error('Wrong fixture')
    request.currentApprovedRevision.workouts[0].scheduledDate = '2026-11-16'
    request.currentApprovedRevision.workouts[0].timezone = 'Pacific/Kiritimati'
    rows[0].scheduledDate = new Date('2026-11-16')
    rows[0].timezone = 'Pacific/Kiritimati'
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'))
    const result = await previewPlanImport(owner, command, JSON.stringify(refreshResponseFixture()))
    expect(!result.valid && result.errors.some((e) => e.code === 'locked_workout')).toBe(true)
  })
  it('refuses reused workout IDs without exposing another owner or plan', async () => {
    tx.plannedWorkout.count.mockResolvedValue(1)
    const result = await previewPlanImport(owner, command, JSON.stringify(initialResponseFixture()))
    expect(!result.valid && result.errors[0].code).toBe('workout_identity')
  })
  it('on a serialization retry rechecks concurrently acquired locks without partial writes', async () => {
    const { rows } = setupRefresh()
    transaction.mockImplementationOnce(async (operation) => {
      const first = await operation(tx)
      expect(first.valid).toBe(true)
      rows[0].workout.completedAt = fixtureNow
      throw new Prisma.PrismaClientKnownRequestError('serialization conflict', {
        code: 'P2034',
        clientVersion: '6.19.0',
      })
    })
    const result = await previewPlanImport(owner, command, JSON.stringify(refreshResponseFixture()))
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(!result.valid && result.errors[0].code).toBe('stale_request')
  })
  it('malformed input cannot be acknowledged into a successful preview', async () => {
    const result = await previewPlanImport(
      owner,
      { ...command, acknowledgedWarningIds: ['a'.repeat(24)] },
      '{',
    )
    expect(!result.valid && result.errors[0].code).toBe('invalid_contract')
  })
})
