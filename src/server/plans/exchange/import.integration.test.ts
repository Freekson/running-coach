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
import {
  exchangeRequestSchema,
  type ExchangeRequest,
  type ExchangeResponse,
} from '@/schemas/plan-exchange.v1'
import { createPlanDraft, updatePlanDraftConstraints } from '../drafts'
import {
  approvePlanDraft,
  createPlanRefreshDraft,
  lockPlannedWorkout,
  saveGeneratedPlan,
  validateGeneratedPlan,
} from '../revisions'
import { definitionFixture } from '../fixtures'
import { issuePlanExport, openPlanExport } from './export'
import { previewPlanImport } from './import'
import { approvePlanImport } from './approve'

const requested = process.env.npm_lifecycle_event === 'test:db'
if (requested) config()
const enabled =
  requested &&
  ['test', 'development'].includes(process.env.APP_DATABASE_ENV ?? '') &&
  !!process.env.DATABASE_URL &&
  !!process.env.DIRECT_URL &&
  !process.env.VERCEL_ENV
if (requested && !enabled) throw new Error('Isolated development/test database required')

describe.skipIf(!enabled)('RUN-36/37 PostgreSQL import, approval and owner isolation', () => {
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
    await expect(
      approvePlanImport(
        owner,
        { ...s.command, approve: true, acknowledgedWarningIds: [] },
        JSON.stringify(s.response),
      ),
    ).rejects.toThrow()
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
})
