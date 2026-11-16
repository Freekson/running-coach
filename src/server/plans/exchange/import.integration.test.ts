import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
import { getPrismaClient } from '@/server/db/client'
import { getOwnerContext, type OwnerContext } from '@/server/authorization/ownership'
import { addHealthDays, healthLocalDay } from '@/lib/health-history'
import { defaultExportConsent } from '@/lib/plan-export'
import { planContentSchema } from '@/schemas/plan-content.v1'
import { saveProviderApiKey } from '@/server/provider/vault'
import { saveGoal } from '@/server/goals/goals'
import { RefreshGoalConflictError, RefreshWindowError } from '../transaction'
import { publicationProviderFixture } from '@/server/intervals/publication.fixtures'
import {
  exchangeRequestSchema,
  type ExchangeRequest,
  type ExchangeResponse,
} from '@/schemas/plan-exchange.v1'
import { createPlanDraft, updatePlanDraftConstraints } from '../drafts'
import {
  approvePlanDraft,
  createPlanRefreshDraft,
  getPlanRevision,
  listPlanRevisions,
  lockPlannedWorkout,
  saveGeneratedPlan,
  validateGeneratedPlan,
} from '../revisions'
import { definitionFixture } from '../fixtures'
import { getIssuedPlanExport, issuePlanExport, openPlanExport } from './export'
import { previewPlanImport } from './import'
import { approvePlanImport } from './approve'
import { listApprovedPlans } from '../refresh'
import {
  previewRevisionPublication,
  readApprovedPlanWorkout,
  sendRevisionPublication,
} from '../publication'
import {
  publicationExternalId,
  publicationPayloadHash,
  publicationPayloadSchema,
} from '@/server/intervals/publication-contract'

const requested = process.env.npm_lifecycle_event === 'test:db'
if (requested) config()
const enabled =
  requested &&
  ['test', 'development'].includes(process.env.APP_DATABASE_ENV ?? '') &&
  !!process.env.DATABASE_URL &&
  !!process.env.DIRECT_URL &&
  !process.env.VERCEL_ENV
if (requested && !enabled) throw new Error('Isolated development/test database required')

describe.skipIf(!enabled)('RUN-36/37/38 PostgreSQL import, approval and owner isolation', () => {
  let prisma: PrismaClient
  let owner: OwnerContext, other: OwnerContext
  const prefix = 'run36-' + randomUUID()
  const today = healthLocalDay(new Date().toISOString(), 'Asia/Tokyo')
  const startDate = addHealthDays(today, 1)
  beforeAll(async () => {
    prisma = await getPrismaClient()
    const a = await prisma.user.create({ data: { authSubject: prefix + '-a' } })
    const b = await prisma.user.create({ data: { authSubject: prefix + '-b', role: 'ADMIN' } })
    owner = getOwnerContext({ id: a.id, role: 'USER', email: null })
    other = getOwnerContext({ id: b.id, role: 'ADMIN', email: null })
  }, 30000)
  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
    await prisma.$disconnect()
  })

  async function issue(draftId: string, expectedVersion: number) {
    const artifact = await issuePlanExport(owner, {
      draftId,
      expectedVersion,
      allowedDetailWindow: { startDate, endDate: addHealthDays(today, 28) },
      consent: defaultExportConsent,
    })
    return exchangeRequestSchema.parse(JSON.parse(artifact.json).request)
  }
  function responseFor(request: ExchangeRequest): ExchangeResponse {
    const common = {
      schemaVersion: 1 as const,
      requestId: request.requestId,
      draftVersion: request.draft.version,
      macroPlan: {
        startDate,
        endDate: addHealthDays(today, 90),
        strategy: 'Synthetic gradual progression',
        phases: [{ startDate, endDate: addHealthDays(today, 90), label: 'Base', notes: '' }],
      },
      detailWindow: request.allowedDetailWindow,
    }
    return request.mode === 'initial'
      ? {
          ...common,
          mode: 'initial',
          workouts: [
            {
              workoutId: randomUUID(),
              scheduledDate: addHealthDays(today, 2),
              definition: definitionFixture,
            },
          ],
        }
      : {
          ...common,
          mode: 'refresh',
          baseRevisionId: request.currentApprovedRevision.revisionId,
          baseRevisionNumber: request.currentApprovedRevision.revisionNumber,
          operations: request.allowedWorkoutIds.length
            ? [{ operation: 'cancel', workoutId: request.allowedWorkoutIds[0] }]
            : [],
        }
  }
  function commandFor(request: ExchangeRequest, goalId: string) {
    return { goalId, draftId: request.draft.draftId, requestId: request.requestId }
  }
  async function scenario() {
    const goal = await prisma.goal.create({
      data: {
        userId: owner.userId,
        name: 'Synthetic RUN-36 goal',
        type: 'COMPLETION',
        distanceMeters: 12345,
        surface: 'ANY',
        targetDate: new Date(addHealthDays(today, 90)),
      },
    })
    const draft = await createPlanDraft(owner, {
      goalId: goal.id,
      constraints: {
        sessionsPerWeek: 3,
        availableWeekdays: [0, 1, 2, 3, 4, 5, 6],
        maxSessionMinutes: 60,
        startDate,
        timezone: 'Asia/Tokyo',
      },
    })
    const request = await issue(draft.id, draft.version)
    return {
      goal,
      draft,
      request,
      response: responseFor(request),
      command: commandFor(request, goal.id),
    }
  }
  async function state(draftId: string) {
    return {
      draft: await prisma.planDraft.findUniqueOrThrow({ where: { id: draftId } }),
      revisions: await prisma.planRevision.count({ where: { userId: owner.userId } }),
      publications: await prisma.workoutPublication.count({ where: { userId: owner.userId } }),
    }
  }
  async function refreshScenario(definition = definitionFixture, lockBeforeExport = false) {
    const s = await scenario()
    if (s.response.mode !== 'initial') throw new Error('Wrong fixture')
    s.response.workouts[0].definition = definition
    const generated = await saveGeneratedPlan(
      owner,
      { draftId: s.draft.id, expectedVersion: 0 },
      {
        schemaVersion: 1,
        macroPlan: s.response.macroPlan,
        detailWindow: s.response.detailWindow,
        workouts: s.response.workouts,
      },
    )
    const validated = await validateGeneratedPlan(owner, {
      draftId: generated.id,
      expectedVersion: generated.version,
    })
    const revision = await approvePlanDraft(owner, {
      draftId: validated.id,
      expectedVersion: validated.version,
      expectedRevisionId: null,
      approve: true,
    })
    if (lockBeforeExport)
      await lockPlannedWorkout(owner, {
        planId: revision.planId,
        expectedRevisionId: revision.id,
        workoutId: s.response.workouts[0].workoutId,
        completed: false,
      })
    const draft = await createPlanRefreshDraft(owner, {
      planId: revision.planId,
      baseRevisionId: revision.id,
    })
    const request = await issue(draft.id, draft.version)
    const response = responseFor(request)
    return { ...s, draft, request, response, command: commandFor(request, s.goal.id), revision }
  }

  it('accepts a valid preview and rejects malformed/cross-owner/wrong-selection inputs with no writes', async () => {
    const s = await scenario()
    const before = await state(s.draft.id)
    expect((await previewPlanImport(owner, s.command, JSON.stringify(s.response))).valid).toBe(true)
    for (const result of [
      await previewPlanImport(owner, s.command, '{'),
      await previewPlanImport(other, s.command, JSON.stringify(s.response)),
      await previewPlanImport(
        owner,
        { ...s.command, goalId: randomUUID() },
        JSON.stringify(s.response),
      ),
      await previewPlanImport(
        owner,
        s.command,
        JSON.stringify({ ...s.response, requestId: randomUUID() }),
      ),
    ])
      expect(result.valid).toBe(false)
    expect(await state(s.draft.id)).toEqual(before)
  })
  it('refuses superseded requests and concurrent draft edits without mutating content', async () => {
    const s = await scenario()
    await issue(s.draft.id, 0)
    const stale = await previewPlanImport(owner, s.command, JSON.stringify(s.response))
    expect(!stale.valid && stale.errors[0].code).toBe('stale_request')
    const current = await issue(s.draft.id, 0)
    await updatePlanDraftConstraints(
      owner,
      s.draft.id,
      { ...current.draft.constraints, maxSessionMinutes: 30 },
      0,
    )
    const before = await state(s.draft.id)
    expect(
      (
        await previewPlanImport(
          owner,
          commandFor(current, s.goal.id),
          JSON.stringify(responseFor(current)),
        )
      ).valid,
    ).toBe(false)
    expect(await state(s.draft.id)).toEqual(before)
  })
  it('rechecks newly completed workouts and preserves the approved revision after refresh failure', async () => {
    const s = await refreshScenario()
    await lockPlannedWorkout(owner, {
      planId: s.revision.planId,
      expectedRevisionId: s.revision.id,
      workoutId: s.response.mode === 'refresh' ? s.response.operations[0].workoutId : '',
      completed: true,
    })
    const before = await prisma.planRevision.findUniqueOrThrow({
      where: { id: s.revision.id },
      include: { workouts: true },
    })
    const draftBefore = await state(s.draft.id)
    const result = await previewPlanImport(owner, s.command, JSON.stringify(s.response))
    expect(!result.valid && result.errors[0].code).toBe('stale_request')
    expect(
      await prisma.planRevision.findUniqueOrThrow({
        where: { id: s.revision.id },
        include: { workouts: true },
      }),
    ).toEqual(before)
    expect(await state(s.draft.id)).toEqual(draftBefore)
  })
  it('rejects an omitted newly completed session and its old acknowledgements without writes', async () => {
    const s = await refreshScenario()
    if (s.response.mode !== 'refresh') throw new Error('Wrong fixture')
    const workoutId = s.response.operations[0].workoutId
    s.response.operations = []
    const text = JSON.stringify(s.response)
    const original = await previewPlanImport(owner, s.command, text)
    if (!original.valid) throw new Error('Expected an initial valid preview')
    await lockPlannedWorkout(owner, {
      planId: s.revision.planId,
      expectedRevisionId: s.revision.id,
      workoutId,
      completed: true,
    })
    const before = await state(s.draft.id)
    const approvedBefore = await prisma.planRevision.findUniqueOrThrow({
      where: { id: s.revision.id },
      include: { workouts: true },
    })
    const result = await previewPlanImport(
      owner,
      { ...s.command, acknowledgedWarningIds: original.preview.warnings.map((w) => w.id) },
      text,
    )
    expect(!result.valid && result.errors[0].code).toBe('stale_request')
    expect(!result.valid && result.repairPrompt).toBeNull()
    expect(await state(s.draft.id)).toEqual(before)
    expect(
      await prisma.planRevision.findUniqueOrThrow({
        where: { id: s.revision.id },
        include: { workouts: true },
      }),
    ).toEqual(approvedBefore)
  })
  it('concurrent refresh approval makes the older issued response stale without replacing the approved revision', async () => {
    const s = await refreshScenario()
    const concurrent = await createPlanRefreshDraft(owner, {
      planId: s.revision.planId,
      baseRevisionId: s.revision.id,
    })
    const prior = await prisma.planRevisionWorkout.findMany({
      where: { revisionId: s.revision.id },
    })
    const generated = await saveGeneratedPlan(
      owner,
      { draftId: concurrent.id, expectedVersion: 0 },
      {
        schemaVersion: 1,
        macroPlan: s.response.macroPlan,
        detailWindow: s.response.detailWindow,
        workouts: prior.map((w) => ({
          workoutId: w.workoutId,
          scheduledDate: w.scheduledDate.toISOString().slice(0, 10),
          definition: w.definition,
          cancelled: w.cancelled,
        })),
      },
    )
    const validated = await validateGeneratedPlan(owner, {
      draftId: generated.id,
      expectedVersion: generated.version,
    })
    const next = await approvePlanDraft(owner, {
      draftId: validated.id,
      expectedVersion: validated.version,
      expectedRevisionId: s.revision.id,
      approve: true,
    })
    const before = await state(s.draft.id)
    const result = await previewPlanImport(owner, s.command, JSON.stringify(s.response))
    expect(!result.valid && result.errors[0].code).toBe('stale_request')
    expect(
      (await prisma.trainingPlan.findUniqueOrThrow({ where: { id: s.revision.planId } }))
        .currentRevisionId,
    ).toBe(next.id)
    expect(await state(s.draft.id)).toEqual(before)
  })
  it('previews a new session while preserving a locked approved definition beyond the import step cap', async () => {
    const s = await refreshScenario(
      {
        ...definitionFixture,
        steps: [
          {
            type: 'repeat',
            count: 100,
            steps: [
              {
                type: 'repeat',
                count: 100,
                steps: [
                  {
                    type: 'repeat',
                    count: 100,
                    steps: [
                      { type: 'step', termination: { type: 'lap' }, target: { type: 'free' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      true,
    )
    if (s.request.mode !== 'refresh' || s.response.mode !== 'refresh')
      throw new Error('Wrong fixture')
    s.response.operations = [
      {
        operation: 'create',
        workoutId: s.request.allowedCreateWorkoutIds[0],
        scheduledDate: addHealthDays(today, 4),
        definition: definitionFixture,
      },
    ]
    const before = await state(s.draft.id)
    const approvedBefore = await prisma.planRevision.findUniqueOrThrow({
      where: { id: s.revision.id },
      include: { workouts: true },
    })
    const result = await previewPlanImport(owner, s.command, JSON.stringify(s.response))
    expect(result.valid).toBe(true)
    if (result.valid)
      expect(
        result.preview.sessions.some((session) => session.estimate.stepCount === 1000000),
      ).toBe(true)
    expect(await state(s.draft.id)).toEqual(before)
    expect(
      await prisma.planRevision.findUniqueOrThrow({
        where: { id: s.revision.id },
        include: { workouts: true },
      }),
    ).toEqual(approvedBefore)
  })

  async function approvalCommand(s: Awaited<ReturnType<typeof scenario>>) {
    const preview = await previewPlanImport(owner, s.command, JSON.stringify(s.response))
    if (!preview.valid) throw new Error(JSON.stringify(preview.errors))
    return {
      ...s.command,
      approve: true,
      acknowledgedWarningIds: preview.preview.warnings.map((warning) => warning.id),
    }
  }
  it('preserves the latest usable request when an undated-goal refresh exceeds its approved macro horizon', async () => {
    const s = await refreshScenario()
    await saveGoal(owner, { ...s.request.goal, targetDate: null }, s.goal.id)
    const request = await issue(s.draft.id, s.draft.version)
    if (request.mode !== 'refresh') throw new Error('Expected refresh')
    const response = JSON.stringify(responseFor(request))
    const command = commandFor(request, s.goal.id)
    expect((await previewPlanImport(owner, command, response)).valid).toBe(true)
    const before = await state(s.draft.id)
    const revision = await getPlanRevision(owner, s.revision.planId, s.revision.id)
    const requestsBefore = await prisma.planExchangeRequest.count({
      where: { userId: owner.userId, draftId: s.draft.id },
    })
    const macroEnd = request.currentApprovedRevision.macroPlan.endDate
    for (const offset of [-5, 1]) {
      const selection = {
        draftId: s.draft.id,
        expectedVersion: s.draft.version,
        allowedDetailWindow: {
          startDate: addHealthDays(macroEnd, offset),
          endDate: addHealthDays(macroEnd, offset + 13),
        },
        consent: defaultExportConsent,
      }
      await expect(issuePlanExport(owner, selection)).rejects.toBeInstanceOf(RefreshWindowError)
      await expect(issuePlanExport(other, selection)).rejects.toThrow('Resource not found')
    }
    expect(
      await prisma.planExchangeRequest.count({
        where: { userId: owner.userId, draftId: s.draft.id },
      }),
    ).toBe(requestsBefore)
    expect((await getIssuedPlanExport(owner, request.requestId)).requestId).toBe(request.requestId)
    expect((await previewPlanImport(owner, command, response)).valid).toBe(true)
    expect(await state(s.draft.id)).toEqual(before)
    expect(await getPlanRevision(owner, s.revision.planId, s.revision.id)).toEqual(revision)
  })
  it('blocks changed goal horizons before exporting or reviewing approval and preserves the approved revision', async () => {
    const s = await refreshScenario()
    const oldCommand = await approvalCommand(s)
    const prior = await getPlanRevision(owner, s.revision.planId, s.revision.id)
    const updatedGoal = await saveGoal(
      owner,
      { ...s.request.goal, targetDate: addHealthDays(today, 100) },
      s.goal.id,
    )
    const draftsBefore = await prisma.planDraft.count({ where: { userId: owner.userId } })
    const requestsBefore = await prisma.planExchangeRequest.count({
      where: { userId: owner.userId },
    })
    await expect(
      openPlanExport(
        owner,
        { goalId: s.goal.id },
        { planId: s.revision.planId, expectedRevisionId: s.revision.id },
      ),
    ).rejects.toBeInstanceOf(RefreshGoalConflictError)
    await expect(issue(s.draft.id, 0)).rejects.toBeInstanceOf(RefreshGoalConflictError)
    expect(await prisma.planExchangeRequest.count({ where: { userId: owner.userId } })).toBe(
      requestsBefore,
    )
    expect(await prisma.planDraft.count({ where: { userId: owner.userId } })).toBe(draftsBefore)
    // Emulate a fresh request issued by the older implementation after the edit.
    const legacy = {
      ...s.request,
      requestId: randomUUID(),
      goal: { ...s.request.goal, targetDate: updatedGoal.targetDate },
    }
    await prisma.planExchangeRequest.create({
      data: {
        id: legacy.requestId,
        userId: owner.userId,
        goalId: s.goal.id,
        draftId: s.draft.id,
        draftVersion: s.draft.version,
        schemaVersion: 1,
        generatedAt: new Date(legacy.generatedAt),
        snapshot: legacy,
      },
    })
    const response = responseFor(legacy)
    response.macroPlan.endDate = updatedGoal.targetDate!
    response.macroPlan.phases[0].endDate = updatedGoal.targetDate!
    const command = { ...s.command, requestId: legacy.requestId }
    const before = await state(s.draft.id)
    const preview = await previewPlanImport(owner, command, JSON.stringify(response))
    expect(preview.valid).toBe(false)
    if (preview.valid) throw new Error('Expected an actionable conflict')
    expect(preview.errors[0].code).toBe('goal_horizon_changed')
    expect(preview.errors[0].expected).toContain('Create a new training plan')
    expect(preview.repairPrompt).toBeNull()
    expect(
      (
        await approvePlanImport(
          owner,
          { ...oldCommand, requestId: legacy.requestId },
          JSON.stringify(response),
        )
      ).approved,
    ).toBe(false)
    expect(await state(s.draft.id)).toEqual(before)
    expect(await getPlanRevision(owner, s.revision.planId, s.revision.id)).toEqual(prior)
    expect((await openPlanExport(owner, { goalId: s.goal.id }, { initialOnly: true })).mode).toBe(
      'initial',
    )
  })
  it('RUN-37 requires explicit approval and all warning acknowledgements without writes', async () => {
    const s = await scenario()
    const before = await state(s.draft.id)
    await expect(approvePlanImport(owner, s.command, JSON.stringify(s.response))).rejects.toThrow()
    await expect(
      approvePlanImport({ userId: owner.userId }, { ...s.command, approve: true }, '{}'),
    ).rejects.toThrow('Verified owner')
    const result = await approvePlanImport(
      owner,
      { ...s.command, approve: true },
      JSON.stringify(s.response),
    )
    expect(result.approved).toBe(false)
    expect(await state(s.draft.id)).toEqual(before)
  })
  it('RUN-37 atomically approves an immutable revision with no publication and rejects replay', async () => {
    const s = await scenario()
    const command = await approvalCommand(s)
    const publications = await prisma.workoutPublication.count()
    const result = await approvePlanImport(owner, command, JSON.stringify(s.response))
    expect(result.approved).toBe(true)
    if (!result.approved) throw new Error('Approval failed')
    const draft = await prisma.planDraft.findUniqueOrThrow({ where: { id: s.draft.id } })
    expect(draft.state).toBe('APPROVED')
    const revision = await prisma.planRevision.findUniqueOrThrow({
      where: { id: result.revisionId },
      include: { workouts: true },
    })
    expect(revision.workouts).toHaveLength(1)
    expect(revision.sourceDraftId).toBe(s.draft.id)
    expect(await prisma.workoutPublication.count()).toBe(publications)
    expect((await approvePlanImport(owner, command, JSON.stringify(s.response))).approved).toBe(
      false,
    )
    expect(await prisma.planRevision.count({ where: { sourceDraftId: s.draft.id } })).toBe(1)
  })
  it('RUN-37 rejects another owner including ADMIN, wrong nested selection and malformed responses', async () => {
    const s = await scenario()
    const command = await approvalCommand(s)
    const before = await state(s.draft.id)
    for (const [who, input, text] of [
      [other, command, JSON.stringify(s.response)],
      [owner, { ...command, goalId: randomUUID() }, JSON.stringify(s.response)],
      [owner, { ...command, draftId: randomUUID() }, JSON.stringify(s.response)],
      [owner, command, '{broken'],
    ] as const)
      expect((await approvePlanImport(who, input, text)).approved).toBe(false)
    expect(await state(s.draft.id)).toEqual(before)
  })
  it('RUN-37 rejects superseded exports and constraints edited after preview', async () => {
    const s = await scenario()
    const command = await approvalCommand(s)
    await issue(s.draft.id, s.draft.version)
    expect((await approvePlanImport(owner, command, JSON.stringify(s.response))).approved).toBe(
      false,
    )
    const next = await scenario()
    const nextCommand = await approvalCommand(next)
    await updatePlanDraftConstraints(
      owner,
      next.draft.id,
      { ...next.request.draft.constraints, maxSessionMinutes: 90 },
      next.draft.version,
    )
    const before = await state(next.draft.id)
    expect(
      (await approvePlanImport(owner, nextCommand, JSON.stringify(next.response))).approved,
    ).toBe(false)
    expect(await state(next.draft.id)).toEqual(before)
  })
  it('RUN-37 initial wizard preserves approved history on failure and resumes its own draft', async () => {
    const s = await refreshScenario()
    const before = await prisma.planRevision.findUniqueOrThrow({
      where: { id: s.revision.id },
      include: { workouts: true },
    })
    const setup = await openPlanExport(owner, { goalId: s.goal.id }, { initialOnly: true })
    expect(setup.draftId).not.toBe(s.draft.id)
    expect(
      (await openPlanExport(owner, { goalId: s.goal.id }, { initialOnly: true })).draftId,
    ).toBe(setup.draftId)
    const request = await issue(setup.draftId, setup.version)
    expect(request.mode).toBe('initial')
    expect(
      (
        await approvePlanImport(
          owner,
          {
            goalId: s.goal.id,
            draftId: setup.draftId,
            requestId: request.requestId,
            approve: true,
          },
          '{broken',
        )
      ).approved,
    ).toBe(false)
    expect(
      await prisma.planRevision.findUniqueOrThrow({
        where: { id: s.revision.id },
        include: { workouts: true },
      }),
    ).toEqual(before)
    expect(
      (await prisma.trainingPlan.findUniqueOrThrow({ where: { id: s.revision.planId } }))
        .currentRevisionId,
    ).toBe(s.revision.id)
    expect(
      (
        await approvePlanImport(
          owner,
          { ...s.command, approve: true, acknowledgedWarningIds: [] },
          JSON.stringify(s.response),
        )
      ).approved,
    ).toBe(false)
  })
  it('RUN-37 concurrent approvals create exactly one revision and keep the committed draft immutable', async () => {
    const s = await scenario()
    const command = await approvalCommand(s)
    const results = await Promise.allSettled([
      approvePlanImport(owner, command, JSON.stringify(s.response)),
      approvePlanImport(owner, command, JSON.stringify(s.response)),
    ])
    expect(
      results.filter((result) => result.status === 'fulfilled' && result.value.approved),
    ).toHaveLength(1)
    expect(await prisma.planRevision.count({ where: { sourceDraftId: s.draft.id } })).toBe(1)
    expect((await prisma.planDraft.findUniqueOrThrow({ where: { id: s.draft.id } })).state).toBe(
      'APPROVED',
    )
  })

  async function richRefreshScenario() {
    const s = await scenario()
    const draft = await updatePlanDraftConstraints(
      owner,
      s.draft.id,
      { ...s.request.draft.constraints, sessionsPerWeek: 7 },
      0,
    )
    const initial = await issue(draft.id, draft.version)
    const initialResponse = responseFor(initial)
    if (initialResponse.mode !== 'initial') throw new Error('Wrong fixture')
    const ids: string[] = Array.from({ length: 6 }, () => randomUUID())
    initialResponse.workouts = [2, 9, 10, 11, 12, 27].map((day, index) => ({
      workoutId: ids[index],
      scheduledDate: addHealthDays(today, day),
      definition: { ...definitionFixture, name: `Original workout ${index}` },
    }))
    const text = JSON.stringify(initialResponse)
    const preview = await previewPlanImport(
      owner,
      { ...s.command, requestId: initial.requestId },
      text,
    )
    if (!preview.valid) throw new Error(JSON.stringify(preview.errors))
    const approved = await approvePlanImport(
      owner,
      {
        ...s.command,
        requestId: initial.requestId,
        approve: true,
        acknowledgedWarningIds: preview.preview.warnings.map((w) => w.id),
      },
      text,
    )
    if (!approved.approved) throw new Error('Initial approval failed')
    for (const index of [0, 4])
      await lockPlannedWorkout(owner, {
        planId: approved.planId,
        expectedRevisionId: approved.revisionId,
        workoutId: ids[index],
        completed: index === 0,
      })
    const refreshDraft = await createPlanRefreshDraft(owner, {
      planId: approved.planId,
      baseRevisionId: approved.revisionId,
    })
    const artifact = await issuePlanExport(owner, {
      draftId: refreshDraft.id,
      expectedVersion: 0,
      allowedDetailWindow: {
        startDate: addHealthDays(today, 8),
        endDate: addHealthDays(today, 35),
      },
      consent: defaultExportConsent,
    })
    const request = exchangeRequestSchema.parse(JSON.parse(artifact.json).request)
    if (request.mode !== 'refresh') throw new Error('Wrong fixture')
    const response = responseFor(request)
    if (response.mode !== 'refresh') throw new Error('Wrong fixture')
    response.macroPlan = request.currentApprovedRevision.macroPlan
    response.operations = [
      {
        operation: 'update',
        workoutId: ids[1],
        scheduledDate: addHealthDays(today, 15),
        definition: { ...definitionFixture, name: 'Refreshed workout' },
      },
      { operation: 'cancel', workoutId: ids[2] },
      {
        operation: 'create',
        workoutId: request.allowedCreateWorkoutIds[0],
        scheduledDate: addHealthDays(today, 16),
        definition: definitionFixture,
      },
    ]
    return {
      ...s,
      draft: refreshDraft,
      request,
      response,
      command: commandFor(request, s.goal.id),
      approved,
      ids,
    }
  }
  it('RUN-38 approves explicit operations, preserves omitted definitions/locks/history and retains recoverable revisions without publication', async () => {
    const s = await richRefreshScenario()
    const prior = await getPlanRevision(owner, s.approved.planId, s.approved.revisionId)
    const beforePublications = await prisma.workoutPublication.count()
    const preview = await previewPlanImport(owner, s.command, JSON.stringify(s.response))
    if (!preview.valid) throw new Error(JSON.stringify(preview.errors))
    expect(preview.preview.refresh?.changes.map((c) => c.kind).sort()).toEqual(
      ['canceled', 'changed', 'created', 'unchanged', 'unchanged', 'unchanged'].sort(),
    )
    expect(
      (await approvePlanImport(owner, { ...s.command, approve: true }, JSON.stringify(s.response)))
        .approved,
    ).toBe(false)
    const command = await approvalCommand(s)
    const next = await approvePlanImport(owner, command, JSON.stringify(s.response))
    if (!next.approved) throw new Error('Refresh approval failed')
    const saved = await getPlanRevision(owner, next.planId, next.revisionId)
    expect(saved.parentRevisionId).toBe(prior.id)
    expect(saved.revisionNumber).toBe(2)
    expect(saved.workouts).toHaveLength(7)
    expect(saved.snapshot).toMatchObject({
      macroPlan: planContentSchema.omit({ workouts: true }).strip().parse(prior.snapshot).macroPlan,
      constraints: s.request.draft.constraints,
    })
    expect(saved.workouts.find((w) => w.workoutId === s.ids[2])?.cancelled).toBe(true)
    expect(
      saved.workouts
        .find((w) => w.workoutId === s.ids[1])
        ?.scheduledDate.toISOString()
        .slice(0, 10),
    ).toBe(addHealthDays(today, 15))
    for (const index of [0, 3, 4, 5])
      expect(saved.workouts.find((w) => w.workoutId === s.ids[index])).toMatchObject({
        definition: prior.workouts.find((w) => w.workoutId === s.ids[index])!.definition,
      })
    expect(await getPlanRevision(owner, next.planId, prior.id)).toEqual(prior)
    expect(await listPlanRevisions(owner, next.planId)).toHaveLength(2)
    expect(await prisma.workoutPublication.count()).toBe(beforePublications)
    expect((await approvePlanImport(owner, command, JSON.stringify(s.response))).approved).toBe(
      false,
    )
  })
  it('RUN-38 rechecks a late lock and leaves the draft and current revision untouched', async () => {
    const s = await richRefreshScenario()
    const command = await approvalCommand(s)
    await lockPlannedWorkout(owner, {
      planId: s.approved.planId,
      expectedRevisionId: s.approved.revisionId,
      workoutId: s.ids[1],
      completed: false,
    })
    const before = await state(s.draft.id)
    expect((await approvePlanImport(owner, command, JSON.stringify(s.response))).approved).toBe(
      false,
    )
    expect(await state(s.draft.id)).toEqual(before)
    expect(
      (await prisma.trainingPlan.findUniqueOrThrow({ where: { id: s.approved.planId } }))
        .currentRevisionId,
    ).toBe(s.approved.revisionId)
  })
  it('RUN-38 simultaneous refreshes produce one successor and an actionable conflict for the other', async () => {
    const s = await richRefreshScenario()
    const command = await approvalCommand(s)
    const secondDraft = await createPlanRefreshDraft(owner, {
      planId: s.approved.planId,
      baseRevisionId: s.approved.revisionId,
    })
    const artifact = await issuePlanExport(owner, {
      draftId: secondDraft.id,
      expectedVersion: 0,
      allowedDetailWindow: s.request.allowedDetailWindow,
      consent: defaultExportConsent,
    })
    const request = exchangeRequestSchema.parse(JSON.parse(artifact.json).request)
    const response = {
      ...s.response,
      requestId: request.requestId,
      operations: s.response.operations.filter((entry) => entry.operation !== 'create'),
    }
    const second = {
      ...s,
      draft: secondDraft,
      request,
      response,
      command: commandFor(request, s.goal.id),
    }
    const secondCommand = await approvalCommand(second)
    const results = await Promise.all([
      approvePlanImport(owner, command, JSON.stringify(s.response)),
      approvePlanImport(owner, secondCommand, JSON.stringify(response)),
    ])
    expect(results.filter((r) => r.approved)).toHaveLength(1)
    const failed = results.find((r) => !r.approved)
    expect(
      failed &&
        !failed.approved &&
        !failed.validation.valid &&
        failed.validation.errors[0].expected,
    ).toContain('Reload')
    expect(await listPlanRevisions(owner, s.approved.planId)).toHaveLength(2)
  })
  it('RUN-38 scopes selected plans, revision history, publication previews and approved readers to the owner', async () => {
    const s = await richRefreshScenario()
    const input = { planId: s.approved.planId, expectedRevisionId: s.approved.revisionId }
    expect((await listApprovedPlans(other)).some((p) => p.id === input.planId)).toBe(false)
    await expect(getPlanRevision(other, input.planId, input.expectedRevisionId)).rejects.toThrow()
    await expect(listPlanRevisions(other, input.planId)).rejects.toThrow()
    await expect(previewRevisionPublication(other, input)).rejects.toThrow()
    await expect(openPlanExport(other, { goalId: s.goal.id }, input)).rejects.toThrow()
    await expect(
      openPlanExport(owner, { goalId: s.goal.id }, { ...input, expectedRevisionId: randomUUID() }),
    ).rejects.toThrow('changed')
    const command = await approvalCommand(s)
    expect((await approvePlanImport(other, command, JSON.stringify(s.response))).approved).toBe(
      false,
    )
    expect(
      await prisma.$transaction((tx) => readApprovedPlanWorkout(tx, other, s.ids[1])),
    ).toBeNull()
    const locked = await prisma.$transaction((tx) => readApprovedPlanWorkout(tx, owner, s.ids[4]))
    expect(locked?.locked).toBe(true)
    await expect(previewRevisionPublication({ userId: owner.userId }, input)).rejects.toThrow(
      'Verified owner',
    )
    const edited = await updatePlanDraftConstraints(
      owner,
      s.draft.id,
      { ...s.request.draft.constraints, maxSessionMinutes: 90 },
      0,
    )
    const reopened = await openPlanExport(owner, { goalId: s.goal.id }, input)
    expect(reopened.mode).toBe('refresh')
    expect(reopened.constraints).toEqual(s.request.draft.constraints)
    expect(reopened.draftId).not.toBe(edited.id)
    expect(
      (await prisma.planDraft.findUniqueOrThrow({ where: { id: edited.id } })).maxSessionMinutes,
    ).toBe(90)
  })
  it('RUN-38 previews remote creates/reschedules/cancels from local receipts, with no provider access or writes', async () => {
    const s = await richRefreshScenario()
    for (const index of [1, 2, 3]) {
      const approved = await prisma.$transaction((tx) =>
        readApprovedPlanWorkout(tx, owner, s.ids[index]),
      )
      if (!approved) throw new Error('Approved workout missing')
      const payload = publicationPayloadSchema.parse({
        localWorkoutId: approved.localWorkoutId,
        revisionId: approved.revisionId,
        approved: approved.approved,
        cancelled: approved.cancelled,
        locked: approved.locked,
        workout: approved.workout,
        schedule: approved.schedule,
      })
      await prisma.workoutPublication.create({
        data: {
          userId: owner.userId,
          localWorkoutId: s.ids[index],
          approvedRevisionId: s.approved.revisionId,
          publishRevision: 1,
          operation: 'CREATE',
          status: 'PUBLISHED',
          externalId: publicationExternalId(owner.userId, s.ids[index]),
          payloadHash: publicationPayloadHash(payload),
          payload,
        },
      })
    }
    const next = await approvePlanImport(
      owner,
      await approvalCommand(s),
      JSON.stringify(s.response),
    )
    if (!next.approved) throw new Error('Refresh failed')
    const input = { planId: next.planId, expectedRevisionId: next.revisionId }
    const before = await prisma.workoutPublication.findMany({ where: { userId: owner.userId } })
    const preview = await previewRevisionPublication(owner, input)
    expect(preview.changes.find((c) => c.workoutId === s.ids[1])?.operation).toBe('RESCHEDULE')
    expect(preview.changes.find((c) => c.workoutId === s.ids[2])?.operation).toBe('CANCEL')
    expect(preview.changes.find((c) => c.workoutId === s.ids[3])).toBeUndefined()
    expect(preview.changes.some((c) => c.operation === 'CREATE')).toBe(true)
    expect(preview.changes.some((c) => [s.ids[0], s.ids[4]].includes(c.workoutId))).toBe(false)
    const change = preview.changes[0]
    await expect(
      sendRevisionPublication(owner, {
        ...input,
        workoutId: change.workoutId,
        reviewToken: change.reviewToken,
      }),
    ).rejects.toThrow()
    await expect(
      sendRevisionPublication(owner, {
        ...input,
        workoutId: change.workoutId,
        reviewToken: '0'.repeat(64),
        confirm: true,
      }),
    ).rejects.toThrow('changed')
    expect(await prisma.workoutPublication.findMany({ where: { userId: owner.userId } })).toEqual(
      before,
    )
  })
  async function withLocalPublicationProvider(
    check: (provider: Awaited<ReturnType<typeof publicationProviderFixture>>) => Promise<void>,
  ) {
    const provider = await publicationProviderFixture()
    const previousVersion = process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
    const previousKey = process.env.CREDENTIAL_ENCRYPTION_KEY_V1
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(String(input))
      if (url.hostname === 'intervals.icu') return provider.fetcher(input, init)
      if (url.hostname === '127.0.0.1') return originalFetch(input, init)
      throw new Error('Unexpected external HTTP request')
    })
    try {
      process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1'
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 38).toString('base64')
      await check(provider)
    } finally {
      fetchSpy.mockRestore()
      await provider.close()
      if (previousVersion === undefined) delete process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
      else process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = previousVersion
      if (previousKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1
      else process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = previousKey
    }
  }
  it('RUN-38 sends a separately confirmed create and refresh cancellation through the persisted reader and real outbox to local HTTP only', async () =>
    withLocalPublicationProvider(async (provider) => {
      const s = await scenario()
      if (s.response.mode !== 'initial') throw new Error('Wrong fixture')
      s.response.workouts[0].definition = {
        ...definitionFixture,
        steps: [
          {
            type: 'step',
            termination: { type: 'time', durationSeconds: 600 },
            target: { type: 'free' },
          },
        ],
      }
      const approved = await approvePlanImport(
        owner,
        await approvalCommand(s),
        JSON.stringify(s.response),
      )
      if (!approved.approved) throw new Error('Initial approval failed')
      const key = `synthetic-run38-${randomUUID()}`
      await saveProviderApiKey(owner, 'INTERVALS', key)
      const input = { planId: approved.planId, expectedRevisionId: approved.revisionId }
      const review = await previewRevisionPublication(owner, input)
      expect(provider.calls).toHaveLength(0)
      const change = review.changes[0]
      const receipt = await sendRevisionPublication(owner, {
        ...input,
        workoutId: change.workoutId,
        reviewToken: change.reviewToken,
        confirm: true,
      })
      expect(receipt).toMatchObject({
        status: 'PUBLISHED',
        operation: 'CREATE',
        watch: 'UNVERIFIED',
        garminConnect: 'UNVERIFIED',
      })
      expect(provider.events.get(key)?.size).toBe(1)
      // Model an interrupted runner after an acknowledged write.
      await prisma.workoutPublication.update({
        where: { id: receipt.id },
        data: { status: 'UNCERTAIN' },
      })
      const draft = await createPlanRefreshDraft(owner, {
        planId: approved.planId,
        baseRevisionId: approved.revisionId,
      })
      const request = await issue(draft.id, 0)
      const response = responseFor(request)
      const refresh = { ...s, draft, request, response, command: commandFor(request, s.goal.id) }
      const callsBeforeApproval = provider.calls.length
      const next = await approvePlanImport(
        owner,
        await approvalCommand(refresh),
        JSON.stringify(response),
      )
      if (!next.approved) throw new Error('Refresh approval failed')
      expect(provider.calls).toHaveLength(callsBeforeApproval)
      const nextInput = { planId: next.planId, expectedRevisionId: next.revisionId }
      const pending = await previewRevisionPublication(owner, nextInput)
      expect(pending.changes[0].operation).toBe('CANCEL')
      expect(provider.calls).toHaveLength(callsBeforeApproval)
      expect(pending.changes[0].recovery).toEqual({ publicationId: receipt.id, publishRevision: 1 })
      const recovered = await sendRevisionPublication(owner, {
        ...nextInput,
        workoutId: pending.changes[0].workoutId,
        reviewToken: pending.changes[0].reviewToken,
        confirm: true,
      })
      expect(recovered.status).toBe('SUPERSEDED')
      expect(provider.events.get(key)?.size).toBe(1)
      const reviewedAgain = await previewRevisionPublication(owner, nextInput)
      expect(reviewedAgain.changes[0].recovery).toBeUndefined()
      const canceled = await sendRevisionPublication(owner, {
        ...nextInput,
        workoutId: reviewedAgain.changes[0].workoutId,
        reviewToken: reviewedAgain.changes[0].reviewToken,
        confirm: true,
      })
      expect(canceled).toMatchObject({
        status: 'CANCELLED',
        operation: 'CANCEL',
        watch: 'UNVERIFIED',
      })
      expect(provider.events.get(key)?.size).toBe(0)
    }))
  it.each(['read_failure', 'write_rejected', 'lost_response'] as const)(
    'keeps the confirmed A-to-B reschedule diff after %s and advances the baseline only on confirmation',
    async (failure) =>
      withLocalPublicationProvider(async (provider) => {
        const s = await scenario()
        if (s.response.mode !== 'initial') throw new Error('Wrong fixture')
        const definition = {
          ...definitionFixture,
          steps: [
            {
              type: 'step' as const,
              termination: { type: 'time' as const, durationSeconds: 600 },
              target: { type: 'free' as const },
            },
          ],
        }
        s.response.workouts[0].definition = definition
        const initial = await approvePlanImport(
          owner,
          await approvalCommand(s),
          JSON.stringify(s.response),
        )
        if (!initial.approved) throw new Error('Initial approval failed')
        const key = `synthetic-baseline-${randomUUID()}`
        await saveProviderApiKey(owner, 'INTERVALS', key)
        const initialInput = { planId: initial.planId, expectedRevisionId: initial.revisionId }
        const first = (await previewRevisionPublication(owner, initialInput)).changes[0]
        await sendRevisionPublication(owner, {
          ...initialInput,
          workoutId: first.workoutId,
          reviewToken: first.reviewToken,
          confirm: true,
        })
        const dateA = s.response.workouts[0].scheduledDate
        const dateB = addHealthDays(today, 4)
        async function approveMove(baseRevisionId: string, date: string) {
          const draft = await createPlanRefreshDraft(owner, {
            planId: initial.planId,
            baseRevisionId,
          })
          const request = await issue(draft.id, 0)
          const response = responseFor(request)
          if (response.mode !== 'refresh') throw new Error('Expected refresh')
          response.operations = [
            { operation: 'update', workoutId: first.workoutId, scheduledDate: date, definition },
          ]
          const next = { ...s, draft, request, response, command: commandFor(request, s.goal.id) }
          const approved = await approvePlanImport(
            owner,
            await approvalCommand(next),
            JSON.stringify(response),
          )
          if (!approved.approved) throw new Error('Refresh failed')
          return approved
        }
        const next = await approveMove(initial.revisionId, dateB)
        const input = { planId: next.planId, expectedRevisionId: next.revisionId }
        const change = (await previewRevisionPublication(owner, input)).changes[0]
        expect(change).toMatchObject({
          operation: 'RESCHEDULE',
          baselineStatus: 'confirmed',
          before: { scheduledDate: dateA },
          after: { scheduledDate: dateB },
        })
        if (failure === 'read_failure') provider.control.failReads = true
        if (failure === 'write_rejected') provider.control.rejectNextWrite = true
        if (failure === 'lost_response') provider.control.loseWriteResponse = true
        const failed = await sendRevisionPublication(owner, {
          ...input,
          workoutId: change.workoutId,
          reviewToken: change.reviewToken,
          confirm: true,
        })
        expect(failed.status).toBe('UNCERTAIN')
        provider.control.failReads = false
        const saved = await prisma.workoutPublication.findUniqueOrThrow({
          where: { id: failed.id },
        })
        expect(publicationPayloadSchema.parse(saved.payload).schedule.localDate).toBe(dateB)
        expect(publicationPayloadSchema.parse(saved.lastConfirmedPayload).schedule.localDate).toBe(
          dateA,
        )
        const retry = (await previewRevisionPublication(owner, input)).changes[0]
        expect(retry).toMatchObject({
          operation: 'RESCHEDULE',
          kind: 'changed',
          baselineStatus: 'confirmed',
          remoteStateUncertain: true,
          before: { scheduledDate: dateA },
          after: { scheduledDate: dateB },
        })
        expect([...provider.events.get(key)!.values()][0].start_date_local?.slice(0, 10)).toBe(
          failure === 'lost_response' ? dateB : dateA,
        )
        await expect(
          sendRevisionPublication(other, {
            ...input,
            workoutId: retry.workoutId,
            reviewToken: retry.reviewToken,
            confirm: true,
          }),
        ).rejects.toThrow()
        expect(
          (
            await sendRevisionPublication(owner, {
              ...input,
              workoutId: retry.workoutId,
              reviewToken: retry.reviewToken,
              confirm: true,
            })
          ).status,
        ).toBe('PUBLISHED')
        expect(
          publicationPayloadSchema.parse(
            (await prisma.workoutPublication.findUniqueOrThrow({ where: { id: failed.id } }))
              .lastConfirmedPayload,
          ).schedule.localDate,
        ).toBe(dateB)
        expect((await previewRevisionPublication(owner, input)).changes).toHaveLength(0)
        expect(provider.calls.filter((call) => call.method === 'POST')).toHaveLength(
          failure === 'write_rejected' ? 3 : 2,
        )
        const final = await approveMove(next.revisionId, addHealthDays(today, 6))
        const latest = (
          await previewRevisionPublication(owner, {
            planId: final.planId,
            expectedRevisionId: final.revisionId,
          })
        ).changes[0]
        expect(latest.before?.scheduledDate).toBe(dateB)
      }),
  )
  it.each(['locked', 'completed', 'past'] as const)(
    'reconciles an uncertain %s workout without another remote write',
    async (protection) =>
      withLocalPublicationProvider(async (provider) => {
        const s = await scenario()
        if (s.response.mode !== 'initial') throw new Error('Wrong fixture')
        s.response.workouts[0].definition = {
          ...definitionFixture,
          steps: [
            {
              type: 'step',
              termination: { type: 'time', durationSeconds: 600 },
              target: { type: 'free' },
            },
          ],
        }
        const approved = await approvePlanImport(
          owner,
          await approvalCommand(s),
          JSON.stringify(s.response),
        )
        if (!approved.approved) throw new Error('Initial approval failed')
        const key = `synthetic-run38-recovery-${randomUUID()}`
        await saveProviderApiKey(owner, 'INTERVALS', key)
        const input = { planId: approved.planId, expectedRevisionId: approved.revisionId }
        const initial = (await previewRevisionPublication(owner, input)).changes[0]
        provider.control.loseWriteResponse = true
        const uncertain = await sendRevisionPublication(owner, {
          ...input,
          workoutId: initial.workoutId,
          reviewToken: initial.reviewToken,
          confirm: true,
        })
        expect(uncertain.status).toBe('UNCERTAIN')
        const snapshot = await getPlanRevision(owner, input.planId, input.expectedRevisionId)
        if (protection !== 'past')
          await lockPlannedWorkout(owner, {
            planId: input.planId,
            expectedRevisionId: input.expectedRevisionId,
            workoutId: initial.workoutId,
            completed: protection === 'completed',
          })
        try {
          if (protection === 'past') {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(new Date(`${addHealthDays(today, 3)}T12:00:00Z`))
          }
          const writesBefore = provider.calls.filter((call) => call.method !== 'GET').length
          const review = await previewRevisionPublication(owner, input)
          const change = review.changes[0]
          expect(change).toMatchObject({
            recoveryOnly: true,
            recovery: { publicationId: uncertain.id, publishRevision: uncertain.publishRevision },
          })
          await expect(
            sendRevisionPublication(other, {
              ...input,
              workoutId: change.workoutId,
              reviewToken: change.reviewToken,
              confirm: true,
            }),
          ).rejects.toThrow()
          const result = await sendRevisionPublication(owner, {
            ...input,
            workoutId: change.workoutId,
            reviewToken: change.reviewToken,
            confirm: true,
          })
          expect(result.status).toBe('SUPERSEDED')
          expect(provider.calls.filter((call) => call.method !== 'GET')).toHaveLength(writesBefore)
          expect(provider.events.get(key)?.size).toBe(1)
          expect(await getPlanRevision(owner, input.planId, input.expectedRevisionId)).toEqual(
            snapshot,
          )
          const receipt = await prisma.workoutPublication.findUniqueOrThrow({
            where: { id: uncertain.id },
          })
          expect(receipt.pendingWrite).toBeNull()
          expect((await previewRevisionPublication(owner, input)).changes).toHaveLength(0)
        } finally {
          vi.useRealTimers()
        }
      }),
  )
})
