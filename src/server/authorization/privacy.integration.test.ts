import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { config } from 'dotenv'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep authentication, authorization, services and PostgreSQL real. Only supply
// Next's request context/cache hooks, and fail closed on unexpected provider I/O.
vi.mock('server-only', () => ({}))
const requestContext = vi.hoisted(() => ({ cookie: '' }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ Cookie: requestContext.cookie }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { getPrismaClient } from '@/server/db/client'
import { getAuth } from '@/server/auth/better-auth'
import { getCurrentUser } from '@/server/auth/current-user'
import {
  getOwnerContext,
  InvalidOwnerContextError,
  OwnedResourceNotFoundError,
  requireOwnedConnection,
  type OwnerContext,
} from './ownership'
import { getGoal, listGoals } from '@/server/goals/goals'
import { createPlanDraft, getPlanDraft } from '@/server/plans/drafts'
import {
  approvePlanDraft,
  getPlanRevision,
  getTrainingPlan,
  listPlanRevisions,
  saveGeneratedPlan,
  validateGeneratedPlan,
} from '@/server/plans/revisions'
import { constraintsFixture, contentFixture } from '@/server/plans/fixtures'
import { getIssuedPlanExport, issuePlanExport } from '@/server/plans/exchange/export'
import { getPlanReminders, respondToPlanReminder } from '@/server/plans/reminders'
import { previewRevisionPublication, readApprovedPlanWorkout } from '@/server/plans/publication'
import { createIntervalsPublicationService } from '@/server/intervals/publication'
import { getHealthTrendRows, listHealthHistory } from '@/server/health/history'
import { getActivityDetail } from '@/server/activity/detail'
import { linkActivityAction } from '@/app/(auth)/app/training/[id]/match/actions'
import { readProviderApiKey, saveProviderApiKey } from '@/server/provider/vault'
import { defaultExportConsent } from '@/lib/plan-export'
import { addHealthDays, healthLocalDay } from '@/lib/health-history'
import { exchangeRequestSchema, type ExchangeResponse } from '@/schemas/plan-exchange.v1'
import { GET as getMe } from '@/app/api/me/route'
import { GET as exportAccount } from '@/app/api/account/export/route'
import { DELETE as deleteAccount } from '@/app/api/account/route'
import { POST as signup } from '@/app/api/auth/[...all]/route'
import { GET as listActivities } from '@/app/api/activities/route'
import { GET as getActivity } from '@/app/api/activities/[id]/route'
import { POST as importActivity } from '@/app/api/activities/import/route'
import { GET as getWeight } from '@/app/api/athlete/weight/route'
import { PATCH as updateProfile } from '@/app/api/athlete/profile/route'
import {
  GET as getGarmin,
  PUT as putGarmin,
  DELETE as disconnectGarmin,
} from '@/app/api/integrations/garmin/route'
import { POST as syncHealth } from '@/app/api/integrations/garmin/health/route'
import { GET as getInvitations, POST as createInvite } from '@/app/api/admin/invitations/route'
import { DELETE as revokeInvite } from '@/app/api/admin/invitations/[id]/route'
import { POST as regenerateInvite } from '@/app/api/admin/invitations/[id]/regenerate/route'
import { POST as checkInvite } from '@/app/api/admin/invitations/[id]/status/route'
import { GET as getUsers } from '@/app/api/admin/users/route'
import { archiveGoalAction, deleteGoalAction, saveGoalAction } from '@/app/(auth)/app/goals/actions'
import {
  openPlanExportAction,
  previewPlanExportAction,
  saveExportScheduleAction,
} from '@/app/(auth)/app/goals/[id]/export/actions'
import { previewPlanImportAction } from '@/app/(auth)/app/goals/[id]/import/actions'
import {
  approveWizardPlanAction,
  openRefreshDraftAction,
  previewRevisionPublicationAction,
  sendRevisionPublicationAction,
} from '@/app/(auth)/app/training/plan/new/actions'
import { rescheduleWorkoutAction } from '@/app/(auth)/app/calendar/actions'
import { respondToPlanReminderAction } from '@/app/(auth)/app/plan-reminders/actions'

const requested = ['test:db', 'test:privacy:db'].includes(process.env.npm_lifecycle_event ?? '')
if (requested) config()
const enabled =
  requested &&
  ['test', 'development'].includes(process.env.APP_DATABASE_ENV ?? '') &&
  Boolean(process.env.DATABASE_URL && process.env.DIRECT_URL && process.env.BETTER_AUTH_SECRET) &&
  !process.env.VERCEL_ENV
if (requested && !enabled)
  throw new Error('Privacy tests require an isolated development/test DB and Better Auth secret')

const origin = 'http://localhost:3000'
const publication = createIntervalsPublicationService(readApprovedPlanWorkout)
const today = healthLocalDay(new Date().toISOString(), 'UTC')
const observationDate = addHealthDays(today, -1)
const startDate = addHealthDays(today, 1)
const detailEnd = addHealthDays(today, 28)
const endDate = addHealthDays(today, 90)
const fetcher = vi.fn<typeof fetch>()

function request(path: string, method = 'GET', body?: unknown) {
  return new Request(`${origin}${path}`, {
    method,
    headers: { Origin: origin, Cookie: requestContext.cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe.skipIf(!enabled)('RUN-50 real-session privacy regression', () => {
  let prisma: PrismaClient
  const prefix = `run50-${randomUUID()}`
  const invitationIds: string[] = []
  const authIds: string[] = []
  const actors = new Map<string, Awaited<ReturnType<typeof createActor>>>()
  let invitationId: string

  async function session(name: string): Promise<OwnerContext> {
    const actor = actors.get(name)
    if (!actor) throw new Error('Missing synthetic actor')
    requestContext.cookie = actor.cookie
    const user = await getCurrentUser()
    if (!user) throw new Error('Synthetic session was not authenticated')
    return getOwnerContext(user)
  }

  async function createActor(name: string, role: 'USER' | 'ADMIN') {
    const token = randomBytes(32).toString('hex')
    const invitation = await prisma.authInvitation.create({
      data: {
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 300_000),
      },
    })
    invitationIds.push(invitation.id)
    const signupRequest = request('/api/auth/sign-up/email', 'POST', {
      email: `${prefix}-${name}@example.test`,
      name: `Synthetic ${name}`,
      password: `Synthetic-${randomUUID()}-passphrase`,
      invitationToken: token,
      role: 'ADMIN',
      userId: randomUUID(),
    })
    // Independent synthetic clients keep signup throttling enabled as the suite grows.
    signupRequest.headers.set('x-forwarded-for', `198.51.100.${authIds.length + 20}`)
    const response = await signup(signupRequest)
    expect(response.status).toBe(200)
    const signedUp = await response.json()
    const authId: string = signedUp.user.id
    authIds.push(authId)
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    expect(cookie).toContain('session_token=')
    requestContext.cookie = cookie
    const user = await getCurrentUser()
    if (!user) throw new Error('Signup failed to create a session')
    expect(user.role).toBe('USER')
    await prisma.user.update({ where: { id: user.id }, data: { role } })
    const verified = await getCurrentUser()
    if (!verified) throw new Error('Missing verified actor')
    const owner = getOwnerContext(verified)
    const restingHrBpm = name === 'owner' ? 53 : name === 'other' ? 63 : 73
    const activityHrBpm = restingHrBpm + 90
    const distanceMeters = name === 'owner' ? 5000 : name === 'other' ? 7000 : 9000
    const sleepDurationMs = BigInt(7 + (restingHrBpm - 53) / 10) * BigInt(3_600_000)
    const accountId = String(7_000_000_000 + Math.floor(Math.random() * 1_000_000_000))
    const key = `synthetic-${prefix}-${name}-credential`
    await saveProviderApiKey(owner, 'GARMIN', key, { verifiedGarminAccountId: accountId })
    const connection = await prisma.integrationConnection.findUniqueOrThrow({
      where: { userId_provider: { userId: owner.userId, provider: 'GARMIN' } },
    })
    const health = await prisma.dailyHealthMetric.create({
      data: {
        userId: owner.userId,
        sourceProvider: 'GARMIN',
        garminAccountId: accountId,
        localDate: new Date(observationDate),
        sourceTimezone: 'UTC',
        sleepSourceTimezone: 'UTC',
        restingHrBpm,
        hrvMs: 47,
        sleepDurationMs,
        summaryFetchedAt: new Date(),
        sleepFetchedAt: new Date(),
      },
    })
    const weight = await prisma.bodyMeasurement.create({
      data: {
        userId: owner.userId,
        measuredAt: new Date(),
        measuredOn: new Date(today),
        measurementType: 'WEIGHT',
        value: name === 'owner' ? 65 : name === 'other' ? 75 : 85,
        unit: 'KG',
        source: 'MANUAL',
      },
    })
    const activity = await prisma.activity.create({
      data: {
        userId: owner.userId,
        sourceProvider: 'GARMIN',
        garminAccountId: accountId,
        sourceRecordType: 'API_ACTIVITY_SUMMARY',
        sportType: 'RUNNING',
        activityTitle: `${prefix}-${name}-private-activity`,
        startedAt: new Date(`${observationDate}T12:00:00Z`),
        listStartedAt: new Date(`${observationDate}T12:00:00Z`),
        distanceMeters,
        totalMs: BigInt(1_800_000),
        movingMs: BigInt(1_800_000),
        elapsedMs: BigInt(1_900_000),
        avgHrBpm: activityHrBpm,
        laps: {
          create: {
            lapIndex: 0,
            sourceRecordType: 'FIT_LAP',
            avgHrBpm: activityHrBpm,
            distanceMeters,
            movingMs: BigInt(1_800_000),
            elapsedMs: BigInt(1_900_000),
          },
        },
      },
    })
    const goal = await prisma.goal.create({
      data: {
        userId: owner.userId,
        name: `${prefix}-${name}-private-goal`,
        type: 'COMPLETION',
        distanceMeters: 12345,
        surface: 'ANY',
        targetDate: new Date(endDate),
      },
    })
    const constraints = { ...constraintsFixture, startDate }
    const draft = await createPlanDraft(owner, { goalId: goal.id, constraints })
    const selection = {
      draftId: draft.id,
      expectedVersion: draft.version,
      allowedDetailWindow: { startDate, endDate: detailEnd },
      consent: defaultExportConsent,
    }
    const artifact = await issuePlanExport(owner, selection)
    const exported = exchangeRequestSchema.parse(JSON.parse(artifact.json).request)
    const content = contentFixture()
    content.macroPlan = {
      ...content.macroPlan,
      startDate,
      endDate,
      phases: [{ startDate, endDate, label: 'Base', notes: 'Synthetic progression' }],
    }
    content.detailWindow = selection.allowedDetailWindow
    content.workouts[0].scheduledDate = addHealthDays(today, 2)
    const responseText = JSON.stringify({
      schemaVersion: 1,
      mode: 'initial',
      requestId: exported.requestId,
      draftVersion: draft.version,
      macroPlan: content.macroPlan,
      detailWindow: content.detailWindow,
      workouts: content.workouts.map(({ workoutId, scheduledDate, definition }) => ({
        workoutId,
        scheduledDate,
        definition,
      })),
    } satisfies ExchangeResponse)
    const command = { goalId: goal.id, draftId: draft.id, requestId: artifact.requestId }
    // A separate approved plan leaves the exchange draft available for import tests.
    content.workouts[0].workoutId = randomUUID()
    const planDraft = await createPlanDraft(owner, { goalId: goal.id, constraints })
    const generated = await saveGeneratedPlan(
      owner,
      { draftId: planDraft.id, expectedVersion: 0 },
      content,
    )
    const validated = await validateGeneratedPlan(owner, {
      draftId: planDraft.id,
      expectedVersion: generated.version,
    })
    const revision = await approvePlanDraft(owner, {
      draftId: planDraft.id,
      expectedVersion: validated.version,
      expectedRevisionId: null,
      approve: true,
    })
    const receipt = await publication.queue(owner, {
      localWorkoutId: content.workouts[0].workoutId,
      expectedRevisionId: revision.id,
      expectedPublishRevision: 0,
    })
    return {
      cookie,
      authId,
      owner,
      key,
      connection,
      health,
      weight,
      activity,
      goal,
      draft,
      constraints,
      selection,
      artifact,
      command,
      responseText,
      revision,
      receipt,
      workoutId: content.workouts[0].workoutId,
    }
  }

  async function victimState(name = 'owner') {
    const victim = actors.get(name)!
    const where = { userId: victim.owner.userId }
    return Promise.all([
      prisma.goal.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.planDraft.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.trainingPlan.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.planRevision.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.plannedWorkout.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.planRevisionWorkout.findMany({ where, orderBy: { workoutId: 'asc' } }),
      prisma.planExchangeRequest.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.workoutPublication.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.workoutPublicationAttempt.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.planReminderState.findMany({
        where,
        orderBy: [{ planId: 'asc' }, { fingerprint: 'asc' }],
      }),
      prisma.activity.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.dailyHealthMetric.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.bodyMeasurement.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.activityLap.findMany({ where, orderBy: { id: 'asc' } }),
      prisma.integrationConnection.findMany({
        where,
        include: { credential: true },
        orderBy: { id: 'asc' },
      }),
      prisma.syncRun.findMany({ where, orderBy: { id: 'asc' } }),
    ])
  }

  beforeAll(async () => {
    vi.stubEnv('BETTER_AUTH_URL', origin)
    vi.stubEnv('CREDENTIAL_ENCRYPTION_ACTIVE_VERSION', '1')
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY_V1', randomBytes(32).toString('base64'))
    vi.stubGlobal('fetch', fetcher)
    fetcher.mockRejectedValue(new Error('Unexpected network request in privacy regression'))
    prisma = await getPrismaClient()
    for (const [name, role] of [
      ['owner', 'USER'],
      ['other', 'USER'],
      ['admin', 'ADMIN'],
    ] as const)
      actors.set(name, await createActor(name, role))
    const invitation = await prisma.authInvitation.create({
      data: {
        label: prefix,
        tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
        expiresAt: new Date(Date.now() + 300_000),
      },
    })
    invitationId = invitation.id
    invitationIds.push(invitationId)
    expect(fetcher).not.toHaveBeenCalled()
  }, 60_000)

  beforeEach(() => {
    requestContext.cookie = ''
    fetcher.mockClear()
  })

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { authSubject: { in: authIds } } })
      await prisma.authUser.deleteMany({ where: { id: { in: authIds } } })
      await prisma.authInvitation.deleteMany({
        where: { OR: [{ id: { in: invitationIds } }, { label: prefix }] },
      })
      await prisma.accountDeletionReceipt.deleteMany({
        where: { userId: { in: [...actors.values()].map((actor) => actor.owner.userId) } },
      })
      await prisma.$disconnect()
    }
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  }, 30_000)

  it.each(['anonymous', 'other'])(
    'denies %s on every invitation/admin endpoint without side effects',
    async (name) => {
      if (name !== 'anonymous') await session(name)
      const before = await prisma.authInvitation.findUniqueOrThrow({ where: { id: invitationId } })
      const count = await prisma.authInvitation.count()
      const context = { params: Promise.resolve({ id: invitationId }) }
      const path = `/api/admin/invitations/${invitationId}`
      for (const response of [
        await getInvitations(request('/api/admin/invitations')),
        await createInvite(
          request('/api/admin/invitations', 'POST', { label: prefix, role: 'ADMIN' }),
        ),
        await revokeInvite(request(path, 'DELETE'), context),
        await regenerateInvite(request(`${path}/regenerate`, 'POST'), context),
        await checkInvite(request(`${path}/status`, 'POST'), context),
        await getUsers(request('/api/admin/users')),
      ]) {
        expect(response.status).toBe(name === 'anonymous' ? 401 : 403)
        expect(await response.text()).toBe('')
      }
      expect(
        await prisma.authInvitation.findUniqueOrThrow({ where: { id: invitationId } }),
      ).toEqual(before)
      expect(await prisma.authInvitation.count()).toBe(count)
    },
  )

  it('allows ADMIN invitations, rechecks demotion with the same session, and exposes no health fields in users', async () => {
    const owner = await session('admin')
    const response = await createInvite(
      request('/api/admin/invitations', 'POST', { label: prefix }),
    )
    expect(response.status).toBe(201)
    const invite = await response.json()
    invitationIds.push(invite.id)
    const users = await getUsers(request('/api/admin/users'))
    expect(users.status).toBe(200)
    const body = await users.text()
    for (const field of ['restingHrBpm', 'hrvMs', 'sleepDurationMs', 'credential', 'ciphertext'])
      expect(body).not.toContain(`"${field}"`)
    await prisma.user.update({ where: { id: owner.userId }, data: { role: 'USER' } })
    try {
      expect((await getInvitations(request('/api/admin/invitations'))).status).toBe(403)
    } finally {
      await prisma.user.update({ where: { id: owner.userId }, data: { role: 'ADMIN' } })
    }
  })

  it('cannot self-promote or change tenant identity through Better Auth or athlete profile updates', async () => {
    const owner = await session('other')
    const actor = actors.get('other')!
    const victim = actors.get('owner')!
    const before = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } })
    const auth = await getAuth()
    const response = await auth.handler(
      request('/api/auth/update-user', 'POST', {
        name: 'Synthetic updated name',
        role: 'ADMIN',
        userId: victim.owner.userId,
        id: victim.authId,
        authSubject: victim.authId,
      }),
    )
    expect(response.status).toBe(200)
    expect((await getMe()).status).toBe(200)
    expect(await (await getMe()).json()).toMatchObject({ id: owner.userId, role: 'USER' })
    expect(
      (
        await updateProfile(
          request('/api/athlete/profile', 'PATCH', {
            role: 'ADMIN',
            userId: victim.owner.userId,
          }),
        )
      ).status,
    ).toBe(400)
    expect(await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } })).toEqual(before)
    expect((await prisma.authUser.findUniqueOrThrow({ where: { id: actor.authId } })).name).toBe(
      'Synthetic updated name',
    )
    expect(
      (await createInvite(request('/api/admin/invitations', 'POST', { label: prefix }))).status,
    ).toBe(403)
  })

  it.each(['owner', 'other', 'admin'])(
    'returns only %s data in lists, health history and consented exports',
    async (name) => {
      const owner = await session(name)
      const actor = actors.get(name)!
      expect((await listGoals(owner)).map((goal) => goal.id)).toEqual([actor.goal.id])
      expect((await listHealthHistory(owner)).map((row) => row.id)).toEqual([actor.health.id])
      expect(await getHealthTrendRows(owner, observationDate, observationDate)).toMatchObject([
        {
          date: observationDate,
          restingHrBpm: actor.health.restingHrBpm,
          sleepDurationMs: Number(actor.health.sleepDurationMs),
        },
      ])
      const weights = await getWeight(
        request(
          `/api/athlete/weight?view=history&page=1&userId=${actors.get('owner')!.owner.userId}`,
        ),
      )
      expect(weights.status).toBe(200)
      expect(weights.headers.get('Cache-Control')).toBe('private, no-store')
      expect(await weights.json()).toMatchObject({ total: 1, items: [{ id: actor.weight.id }] })
      const activities = await listActivities(request('/api/activities'))
      expect(activities.status).toBe(200)
      const text = await activities.text()
      expect(text).toContain(actor.activity.id)
      const withheld = await getIssuedPlanExport(owner, actor.artifact.requestId)
      expect(withheld.trainingContext.recentRunSamples).toEqual([])
      expect(withheld.trainingContext.recoveryContext).toBeUndefined()
      const artifact = await issuePlanExport(owner, {
        ...actor.selection,
        consent: {
          ...defaultExportConsent,
          recordedActivityMetrics: true,
          activityHeartRate: true,
          recordedLaps: true,
          recovery: true,
        },
      })
      expect(artifact.json).toContain(actor.goal.name)
      const exported = exchangeRequestSchema.parse(JSON.parse(artifact.json).request)
      expect(exported.trainingContext.recentRunSamples).toMatchObject([
        {
          activityId: actor.activity.id,
          localDate: observationDate,
          distance: { value: Number(actor.activity.distanceMeters) },
          averageHr: { value: actor.activity.avgHrBpm },
          lapSamples: [
            {
              lapIndex: 0,
              distance: { value: Number(actor.activity.distanceMeters) },
              averageHr: { value: actor.activity.avgHrBpm },
            },
          ],
        },
      ])
      expect(exported.trainingContext.recoveryContext?.days).toMatchObject([
        {
          date: observationDate,
          restingHr: { value: actor.health.restingHrBpm },
          sleepDuration: { value: Number(actor.health.sleepDurationMs) / 1000 },
        },
      ])
      actor.artifact = artifact
      actor.command.requestId = artifact.requestId
      actor.responseText = JSON.stringify({
        ...JSON.parse(actor.responseText),
        requestId: artifact.requestId,
      })
      for (const [otherName, other] of actors) {
        expect(artifact.json).not.toContain(other.key)
        if (otherName === name) continue
        expect(text).not.toContain(other.activity.id)
        expect(artifact.json).not.toContain(other.goal.name)
        expect(artifact.json).not.toContain(other.activity.id)
      }
      for (const field of ['ciphertext', 'nonce', 'authTag', 'apiKey', 'credential', 'rawMetadata'])
        expect(artifact.json).not.toContain(`"${field}"`)
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  describe.each(['other', 'admin'])('%s attacking another athlete', (name) => {
    it('denies guessed read/update/delete and nested draft/revision IDs and leaves the victim unchanged', async () => {
      const attacker = await session(name)
      const victim = actors.get('owner')!
      const own = actors.get(name)!
      const before = await victimState()
      for (const read of [
        () => getGoal(attacker, victim.goal.id),
        () => getPlanDraft(attacker, victim.draft.id),
        () => getTrainingPlan(attacker, victim.revision.planId),
        () => listPlanRevisions(attacker, victim.revision.planId),
        () => getPlanRevision(attacker, victim.revision.planId, victim.revision.id),
        () => getPlanRevision(attacker, own.revision.planId, victim.revision.id),
        () =>
          createPlanDraft(attacker, { goalId: victim.goal.id, constraints: victim.constraints }),
      ])
        await expect(read()).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
      const foreign = await getActivity(request(`/api/activities/${victim.activity.id}`), {
        params: Promise.resolve({ id: victim.activity.id }),
      })
      const missing = await getActivity(request('/api/activities/missing'), {
        params: Promise.resolve({ id: randomUUID() }),
      })
      expect(foreign.status).toBe(404)
      expect(await foreign.text()).toBe(await missing.text())
      expect(foreign.headers.get('Cache-Control')).toBe('private, no-store')
      const goalInput = {
        name: 'Forbidden edit',
        type: 'COMPLETION',
        distanceMeters: 12345,
        targetTimeSeconds: null,
        targetCount: null,
        measurementWindow: null,
        targetDate: endDate,
        surface: 'ANY',
        elevationGainM: null,
      }
      expect(await saveGoalAction(goalInput, victim.goal.id)).toEqual({
        success: false,
        error: 'Goal not found.',
      })
      expect((await archiveGoalAction(victim.goal.id, true)).success).toBe(false)
      expect((await deleteGoalAction(victim.goal.id)).success).toBe(false)
      expect(await getActivityDetail(attacker, victim.activity.id)).toBeNull()
      expect(await getActivityDetail(victim.owner, victim.activity.id)).toMatchObject({
        laps: [{ index: 0, avgHrBpm: 143 }],
      })
      for (const activityId of [own.activity.id, victim.activity.id]) {
        expect(
          await linkActivityAction({
            activityId,
            expectedWorkoutId: null,
            planId: own.revision.planId,
            expectedRevisionId: own.revision.id,
            workoutId: victim.workoutId,
          }),
        ).toEqual({ success: false, error: 'Activity or session not found.' })
      }
      expect(
        (
          await saveExportScheduleAction({
            draftId: victim.draft.id,
            expectedVersion: victim.draft.version,
            constraints: victim.constraints,
          })
        ).success,
      ).toBe(false)
      expect(
        (
          await rescheduleWorkoutAction({
            planId: own.revision.planId,
            expectedRevisionId: own.revision.id,
            workoutId: victim.workoutId,
            scheduledDate: addHealthDays(today, 3),
            timezone: 'UTC',
          })
        ).success,
      ).toBe(false)
      expect(await victimState()).toEqual(before)
    })

    it('denies foreign exports, import request IDs and explicit approval without disclosing a repair payload', async () => {
      const victim = actors.get('owner')!
      const own = actors.get(name)!
      await session('owner')
      const ownerPreview = await previewPlanImportAction(victim.command, victim.responseText)
      expect(ownerPreview, JSON.stringify(ownerPreview)).toMatchObject({
        success: true,
        value: { valid: true },
      })
      if (!ownerPreview.success || !ownerPreview.value.valid)
        throw new Error('Expected valid owner import')
      const approval = {
        ...victim.command,
        acknowledgedWarningIds: ownerPreview.value.preview.warnings.map((warning) => warning.id),
        warningRationale: 'Synthetic regression fixture reviewed explicitly',
      }
      expect(await previewPlanImportAction(approval, victim.responseText)).toMatchObject({
        success: true,
        value: { valid: true, preview: { review: { readyForExplicitApproval: true } } },
      })
      const attacker = await session(name)
      const before = await victimState()
      await expect(getIssuedPlanExport(attacker, victim.artifact.requestId)).rejects.toBeInstanceOf(
        OwnedResourceNotFoundError,
      )
      expect((await openPlanExportAction({ goalId: victim.goal.id })).success).toBe(false)
      expect((await previewPlanExportAction(victim.selection)).success).toBe(false)
      for (const command of [
        victim.command,
        { ...own.command, requestId: victim.artifact.requestId },
        { ...own.command, draftId: victim.draft.id },
      ]) {
        const preview = await previewPlanImportAction(command, victim.responseText)
        expect(preview).toMatchObject({
          success: true,
          value: { valid: false, repairPrompt: null },
        })
        expect(JSON.stringify(preview)).not.toContain(victim.goal.name)
        expect(
          await approveWizardPlanAction(
            { ...approval, ...command, approve: true },
            victim.responseText,
          ),
        ).toMatchObject({
          success: true,
          value: {
            approved: false,
            validation: { valid: false, errors: [{ code: 'request_unavailable' }] },
          },
        })
      }
      expect(await victimState()).toEqual(before)
      expect(fetcher).not.toHaveBeenCalled()
    })

    it('cannot suppress another plan reminder or refresh it, even with its valid fingerprint/revision', async () => {
      const victim = actors.get('owner')!
      const own = actors.get(name)!
      const now = new Date(`${addHealthDays(detailEnd, -6)}T12:00:00Z`)
      const sessions = await prisma.authSession.findMany({
        where: { userId: { in: [victim.authId, own.authId] } },
      })
      try {
        // Keep real authentication valid at the reminder date; only Date is
        // controlled, so database/network timers continue to run normally.
        await prisma.authSession.updateMany({
          where: { id: { in: sessions.map((saved) => saved.id) } },
          data: { expiresAt: new Date(now.getTime() + 86_400_000) },
        })
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(now)
        await session('owner')
        const [event] = await getPlanReminders(victim.owner)
        expect(event.planId).toBe(victim.revision.planId)
        const command = { planId: event.planId, fingerprint: event.fingerprint, action: 'dismiss' }
        expect(await respondToPlanReminderAction(command)).toEqual({ success: true })
        expect(await getPlanReminders(victim.owner)).not.toContainEqual(event)
        // Reset only this synthetic plan's positive-control dismissal before
        // sending the identical command from another authenticated account.
        await prisma.planReminderState.deleteMany({
          where: {
            userId: victim.owner.userId,
            planId: event.planId,
            fingerprint: event.fingerprint,
          },
        })
        expect(await getPlanReminders(victim.owner)).toContainEqual(event)
        const attacker = await session(name)
        expect((await getPlanReminders(attacker)).map((item) => item.planId)).not.toContain(
          event.planId,
        )
        const before = await victimState()
        await expect(respondToPlanReminder(attacker, command)).rejects.toBeInstanceOf(
          OwnedResourceNotFoundError,
        )
        expect((await respondToPlanReminderAction(command)).success).toBe(false)
        expect(
          (
            await openRefreshDraftAction({
              goalId: victim.goal.id,
              planId: victim.revision.planId,
              expectedRevisionId: victim.revision.id,
            })
          ).success,
        ).toBe(false)
        expect(await victimState()).toEqual(before)
        expect(await getPlanReminders(victim.owner)).toContainEqual(event)
      } finally {
        vi.useRealTimers()
        await prisma.planReminderState.deleteMany({
          where: { userId: victim.owner.userId, planId: victim.revision.planId },
        })
        for (const saved of sessions)
          await prisma.authSession.update({
            where: { id: saved.id },
            data: { expiresAt: saved.expiresAt, updatedAt: saved.updatedAt },
          })
      }
    })

    it('isolates credentials, ignores forged provider targets and denies publication/retry before any provider call', async () => {
      const attacker = await session(name)
      const own = actors.get(name)!
      const victim = actors.get('owner')!
      const before = await victimState()
      expect(await readProviderApiKey(attacker, 'GARMIN')).toBe(own.key)
      await expect(requireOwnedConnection(attacker, victim.connection.id)).rejects.toBeInstanceOf(
        OwnedResourceNotFoundError,
      )
      const status = await getGarmin()
      expect(status.status).toBe(200)
      const statusText = await status.text()
      for (const secret of [
        own.key,
        victim.key,
        victim.connection.id,
        'ciphertext',
        'nonce',
        'authTag',
      ])
        expect(statusText).not.toContain(secret)
      expect(
        (
          await putGarmin(
            request('/api/integrations/garmin', 'PUT', {
              apiKey: 'synthetic-replacement',
              userId: victim.owner.userId,
              connectionId: victim.connection.id,
            }),
          )
        ).status,
      ).toBe(400)
      expect(
        (
          await syncHealth(
            request('/api/integrations/garmin/health', 'POST', {
              browserTimezone: 'UTC',
              userId: victim.owner.userId,
            }),
          )
        ).status,
      ).toBe(400)
      expect(
        (
          await importActivity(
            request('/api/activities/import', 'POST', {
              date: today,
              userId: victim.owner.userId,
              connectionId: victim.connection.id,
            }),
          )
        ).status,
      ).toBe(400)
      // This endpoint intentionally ignores target query parameters and disconnects only the actor.
      expect(
        (
          await disconnectGarmin(
            request(
              `/api/integrations/garmin?userId=${victim.owner.userId}&connectionId=${victim.connection.id}`,
              'DELETE',
            ),
          )
        ).status,
      ).toBe(204)
      expect((await getGarmin()).status).toBe(200)
      expect(await (await getGarmin()).json()).toMatchObject({ status: 'DISCONNECTED' })
      const revision = { planId: victim.revision.planId, expectedRevisionId: victim.revision.id }
      const preview = await previewRevisionPublication(victim.owner, revision)
      const change = preview.changes.find((entry) => entry.workoutId === victim.workoutId)
      if (!change) throw new Error('Expected a publishable synthetic workout')
      expect((await previewRevisionPublicationAction(revision)).success).toBe(false)
      expect(
        (
          await sendRevisionPublicationAction({
            ...revision,
            workoutId: victim.workoutId,
            reviewToken: change.reviewToken,
            confirm: true,
          })
        ).success,
      ).toBe(false)
      await expect(
        publication.dispatch(attacker, {
          publicationId: victim.receipt.id,
          publishRevision: victim.receipt.publishRevision,
        }),
      ).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
      expect((await publication.list(attacker)).map((row) => row.id)).not.toContain(
        victim.receipt.id,
      )
      expect(fetcher).not.toHaveBeenCalled()
      expect(await victimState()).toEqual(before)
    })
  })

  it('rejects forged owner objects and unauthenticated personal entry points before mutations', async () => {
    const victim = actors.get('owner')!
    const before = await victimState()
    expect(() => getOwnerContext({ id: victim.owner.userId, role: 'ADMIN', email: null })).toThrow(
      InvalidOwnerContextError,
    )
    await expect(getGoal({ userId: victim.owner.userId }, victim.goal.id)).rejects.toBeInstanceOf(
      InvalidOwnerContextError,
    )
    expect((await getMe()).status).toBe(401)
    expect((await listActivities(request('/api/activities'))).status).toBe(401)
    expect(
      (
        await getActivity(request('/api/activities/guessed'), {
          params: Promise.resolve({ id: victim.activity.id }),
        })
      ).status,
    ).toBe(401)
    expect((await getWeight(request('/api/athlete/weight?view=history&page=1'))).status).toBe(401)
    expect((await getGarmin()).status).toBe(401)
    expect(
      (await importActivity(request('/api/activities/import', 'POST', { date: today }))).status,
    ).toBe(401)
    expect(
      (await putGarmin(request('/api/integrations/garmin', 'PUT', { apiKey: 'synthetic-key' })))
        .status,
    ).toBe(401)
    expect((await disconnectGarmin(request('/api/integrations/garmin', 'DELETE'))).status).toBe(401)
    expect(
      (
        await syncHealth(
          request('/api/integrations/garmin/health', 'POST', { browserTimezone: 'UTC' }),
        )
      ).status,
    ).toBe(401)
    for (const result of [
      await openPlanExportAction({ goalId: victim.goal.id }),
      await previewPlanExportAction(victim.selection),
      await previewPlanImportAction(victim.command, victim.responseText),
      await approveWizardPlanAction({ ...victim.command, approve: true }, victim.responseText),
      await respondToPlanReminderAction({}),
      await rescheduleWorkoutAction({}),
      await previewRevisionPublicationAction({}),
      await sendRevisionPublicationAction({}),
      await saveGoalAction({}),
      await deleteGoalAction(victim.goal.id),
    ])
      expect(result.success).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
    expect(await victimState()).toEqual(before)
  })

  it.each(['forged', 'expired', 'SUSPENDED', 'DELETING'] as const)(
    'denies %s sessions/accounts using current server state',
    async (state) => {
      await session('owner')
      const victim = actors.get('owner')!
      const before = await victimState()
      const sessions = await prisma.authSession.findMany({ where: { userId: victim.authId } })
      if (state === 'forged') requestContext.cookie = victim.cookie.replace(/=.+$/, '=forged-token')
      else if (state === 'expired')
        await prisma.authSession.updateMany({
          where: { userId: victim.authId },
          data: { expiresAt: new Date(Date.now() - 1000) },
        })
      else await prisma.user.update({ where: { id: victim.owner.userId }, data: { status: state } })
      try {
        const status = state === 'forged' || state === 'expired' ? 401 : 403
        expect((await getMe()).status).toBe(status)
        expect((await exportAccount()).status).toBe(status)
        expect(
          (
            await deleteAccount(
              request('/api/account', 'DELETE', {
                confirmation: 'DELETE',
                providerAccessRevoked: true,
              }),
            )
          ).status,
        ).toBe(status)
        expect((await getGarmin()).status).toBe(status)
        expect(
          (
            await getActivity(request(`/api/activities/${victim.activity.id}`), {
              params: Promise.resolve({ id: victim.activity.id }),
            })
          ).status,
        ).toBe(status)
        expect(
          (await approveWizardPlanAction({ ...victim.command, approve: true }, victim.responseText))
            .success,
        ).toBe(false)
        expect(
          (await createInvite(request('/api/admin/invitations', 'POST', { label: prefix }))).status,
        ).toBe(status)
        expect(fetcher).not.toHaveBeenCalled()
        expect(await victimState()).toEqual(before)
      } finally {
        await prisma.user.update({ where: { id: victim.owner.userId }, data: { status: 'ACTIVE' } })
        for (const saved of sessions)
          await prisma.authSession.upsert({
            where: { id: saved.id },
            create: saved,
            update: { expiresAt: saved.expiresAt },
          })
      }
    },
  )

  it('still permits explicit owner approval after the attacks, without automatic provider publication', async () => {
    const owner = await session('owner')
    const victim = actors.get('owner')!
    const preview = await previewPlanImportAction(victim.command, victim.responseText)
    if (!preview.success || !preview.value.valid) throw new Error('Expected valid owner import')
    const before = await prisma.planRevision.count({ where: { userId: owner.userId } })
    const outbox = await publication.list(owner)
    expect(
      await approveWizardPlanAction(
        {
          ...victim.command,
          approve: true,
          acknowledgedWarningIds: preview.value.preview.warnings.map((warning) => warning.id),
          warningRationale: 'Synthetic regression fixture reviewed explicitly',
        },
        victim.responseText,
      ),
    ).toMatchObject({ success: true, value: { approved: true } })
    expect(await prisma.planRevision.count({ where: { userId: owner.userId } })).toBe(before + 1)
    expect(await publication.list(owner)).toEqual(outbox)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['USER', 'ADMIN'] as const)(
    'RUN-51 exports and deletes only the %s owner, including immutable history and auth tokens',
    async (role) => {
      const name = `deletion-${role}`
      const actor = await createActor(name, role)
      actors.set(name, actor)
      await saveProviderApiKey(actor.owner, 'INTERVALS', `${actor.key}-intervals`)
      await saveProviderApiKey(actor.owner, 'OPENAI', `${actor.key}-openai`)
      await prisma.dailyHealthMetric.update({
        where: { id: actor.health.id },
        data: {
          rawMetadata: {
            garminDailySummaryV1: { schemaVersion: 1, steps: 10000, accessToken: 'PRIVATE' },
            unexpected: 'PRIVATE',
          },
        },
      })
      const otherBefore = await victimState()
      const ownBefore = await victimState(name)
      const { userId } = actor.owner
      await session(name)
      const archiveResponse = await exportAccount()
      expect(archiveResponse.status).toBe(200)
      const archive = await archiveResponse.json()
      expect(archive.account.id).toBe(userId)
      expect(archive.revisions).toHaveLength(1)
      expect(archive.revisionWorkouts).toHaveLength(1)
      expect(archive.health[0].sleepDurationMs).toBe('32400000')
      expect(archive.activities[0].distanceMeters).toBe('9000')
      expect(archive.connections).toHaveLength(3)
      expect(archive.health[0].providerMetrics.dailySummary.steps).toBe(10000)
      const text = JSON.stringify(archive)
      for (const field of [
        'password',
        'token',
        'ciphertext',
        'nonce',
        'authTag',
        'credentialNonce',
        'authSubject',
        'rawObjectRef',
        'gpsAssetRef',
      ])
        expect(text).not.toContain(`"${field}"`)
      expect(text).not.toContain(actor.key)
      expect(text).not.toContain('PRIVATE')
      expect(text).not.toContain(actors.get('owner')!.goal.id)

      // Neither role can submit a different tenant in the deletion body.
      expect(
        (
          await deleteAccount(
            request('/api/account', 'DELETE', {
              confirmation: 'DELETE',
              providerAccessRevoked: true,
              userId: actors.get('owner')!.owner.userId,
            }),
          )
        ).status,
      ).toBe(400)
      const command = { confirmation: 'DELETE', providerAccessRevoked: true }
      await prisma.syncCursor.create({
        data: {
          userId,
          connectionId: actor.connection.id,
          dataType: 'run51-test',
          cursorOrCheckpoint: {},
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      })
      expect((await deleteAccount(request('/api/account', 'DELETE', command))).status).toBe(409)
      expect(await prisma.accountDeletionReceipt.count({ where: { userId } })).toBe(0)
      expect(await victimState(name)).toEqual(ownBefore)
      await prisma.syncCursor.updateMany({ where: { userId }, data: { leaseExpiresAt: null } })
      await prisma.workoutPublication.update({
        where: { id: actor.receipt.id },
        data: {
          status: 'RUNNING',
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      })
      expect((await deleteAccount(request('/api/account', 'DELETE', command))).status).toBe(409)
      await prisma.workoutPublication.update({
        where: { id: actor.receipt.id },
        data: {
          status: 'QUEUED',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      })

      const settledBefore = await victimState(name)

      // Failure after marking DELETING rolls back credentials, sessions and status.
      await prisma.accountDeletionReceipt.create({
        data: {
          userId,
          authSubjectHash: createHash('sha256').update(actor.authId).digest('hex'),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      })
      expect((await deleteAccount(request('/api/account', 'DELETE', command))).status).toBe(503)
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).status).toBe('ACTIVE')
      expect(await victimState(name)).toEqual(settledBefore)
      await prisma.accountDeletionReceipt.delete({ where: { userId } })

      expect((await deleteAccount(request('/api/account', 'DELETE', command))).status).toBe(204)
      expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull()
      expect(await prisma.authUser.findUnique({ where: { id: actor.authId } })).toBeNull()
      expect(await prisma.authSession.count({ where: { userId: actor.authId } })).toBe(0)
      expect(await prisma.authAccount.count({ where: { userId: actor.authId } })).toBe(0)
      expect(await victimState(name)).toEqual(ownBefore.map(() => []))
      for (const count of await Promise.all([
        prisma.syncCursor.count({ where: { userId } }),
        prisma.garminImportRateLimit.count({ where: { userId } }),
        prisma.integrationCredential.count({ where: { userId } }),
        prisma.activityDuplicateCandidate.count({ where: { userId } }),
      ]))
        expect(count).toBe(0)
      const receipt = await prisma.accountDeletionReceipt.findUniqueOrThrow({ where: { userId } })
      expect(receipt.authSubjectHash).toBe(createHash('sha256').update(actor.authId).digest('hex'))
      expect(receipt.expiresAt.getTime() - receipt.deletedAt.getTime()).toBe(90 * 86_400_000)
      expect((await getMe()).status).toBe(401)
      expect((await exportAccount()).status).toBe(401)
      expect(await victimState()).toEqual(otherBefore)
      expect(fetcher).not.toHaveBeenCalled()
    },
    30_000,
  )

  it('RUN-51 replays current deletion receipts on restored rows and purges only expired evidence', async () => {
    const actor = await createActor('restored-deletion', 'USER')
    actors.set('restored-deletion', actor)
    const { userId } = actor.owner
    const before = await victimState()
    await prisma.accountDeletionReceipt.create({
      data: {
        userId,
        authSubjectHash: createHash('sha256').update(actor.authId).digest('hex'),
        expiresAt: new Date(Date.now() + 90 * 86_400_000),
      },
    })
    const statements = readFileSync('prisma/scripts/replay-account-deletions.sql', 'utf8')
      .replace(/^--.*$/gm, '')
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement && !['BEGIN', 'COMMIT'].includes(statement))
    for (let attempt = 0; attempt < 2; attempt++) {
      await prisma.$transaction(async (tx) => {
        for (const statement of statements) await tx.$executeRawUnsafe(statement)
      })
      expect(await victimState('restored-deletion')).toEqual(before.map(() => []))
      expect(await prisma.authUser.count({ where: { id: actor.authId } })).toBe(0)
      expect(await victimState()).toEqual(before)
    }
    await prisma.accountDeletionReceipt.update({
      where: { userId },
      data: {
        deletedAt: new Date(Date.now() - 91 * 86_400_000),
        expiresAt: new Date(Date.now() - 86_400_000),
      },
    })
    await prisma.$executeRawUnsafe(
      readFileSync('prisma/scripts/prune-account-deletion-receipts.sql', 'utf8'),
    )
    expect(await prisma.accountDeletionReceipt.findUnique({ where: { userId } })).toBeNull()
    expect(
      await prisma.accountDeletionReceipt.count({
        where: {
          userId: {
            in: ['deletion-USER', 'deletion-ADMIN'].map((name) => actors.get(name)!.owner.userId),
          },
        },
      }),
    ).toBe(2)
  }, 30_000)
})
