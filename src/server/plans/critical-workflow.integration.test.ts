import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import type { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const context = vi.hoisted(() => ({ cookie: '' }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ Cookie: context.cookie }),
}))

import { getPrismaClient } from '@/server/db/client'
import { getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import { POST as signup } from '@/app/api/auth/[...all]/route'
import { POST as invite } from '@/app/api/admin/invitations/route'
import { saveGoal } from '@/server/goals/goals'
import { saveProviderApiKey, disconnectProvider } from '@/server/provider/vault'
import {
  publicationFitFixture,
  publicationProviderFixture,
} from '@/server/intervals/publication.fixtures'
import { testGarminAccountId } from '@/server/garmin/test-identity'
import { runGarminSync } from '@/server/garmin/sync'
import { importCanonicalActivity } from '@/server/activity/import'
import { getActivityMatching, linkActivity } from '@/server/activity/matching'
import { addHealthDays, healthLocalDay } from '@/lib/health-history'
import { defaultExportConsent } from '@/lib/plan-export'
import { exchangeRequestSchema, type ExchangeResponse } from '@/schemas/plan-exchange.v1'
import { createPlanDraft } from './drafts'
import { issuePlanExport } from './exchange/export'
import { previewPlanImport } from './exchange/import'
import { approvePlanImport } from './exchange/approve'
import { getPlanRevision } from './revisions'
import { previewRevisionPublication, sendRevisionPublication } from './publication'

const requested = process.env.npm_lifecycle_event === 'test:db'
if (requested) config()
const enabled =
  requested &&
  ['development', 'test'].includes(process.env.APP_DATABASE_ENV ?? '') &&
  Boolean(process.env.DATABASE_URL && process.env.DIRECT_URL && process.env.BETTER_AUTH_SECRET) &&
  !process.env.VERCEL_ENV
if (requested && !enabled) throw new Error('RUN-52 requires an isolated development/test database')

const origin = 'http://localhost:3000'
function request(path: string, body: unknown) {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: context.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe.skipIf(!enabled)(
  'RUN-52 connected manual workflow on PostgreSQL and local Intervals HTTP',
  () => {
    let prisma: PrismaClient
    let provider: Awaited<ReturnType<typeof publicationProviderFixture>>
    const prefix = `run52-${randomUUID()}`
    const authIds: string[] = []
    const invitationIds: string[] = []
    const originalFetch = globalThis.fetch

    async function register(token: string, name: string) {
      context.cookie = ''
      const req = request('/api/auth/sign-up/email', {
        email: `${prefix}-${name}@example.test`,
        name: `Synthetic ${name}`,
        password: `Synthetic-${randomUUID()}-passphrase`,
        invitationToken: token,
      })
      req.headers.set('x-forwarded-for', `198.51.100.${authIds.length + 100}`)
      const response = await signup(req)
      expect(response.status).toBe(200)
      const result = await response.json()
      authIds.push(result.user.id)
      const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
      expect(cookie).toContain('session_token=')
      context.cookie = cookie
      const user = await getCurrentUser()
      if (!user) throw new Error('Missing authenticated synthetic user')
      expect(user.role).toBe('USER')
      return { cookie, owner: getOwnerContext(user) }
    }

    beforeAll(async () => {
      vi.stubEnv('BETTER_AUTH_URL', origin)
      vi.stubEnv('CREDENTIAL_ENCRYPTION_ACTIVE_VERSION', '1')
      vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY_V1', randomBytes(32).toString('base64'))
      prisma = await getPrismaClient()
      provider = await publicationProviderFixture()
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const url = new URL(String(input))
        if (url.hostname === 'intervals.icu') return provider.fetcher(input, init)
        if (url.hostname === '127.0.0.1') return originalFetch(input, init)
        throw new Error('Unexpected external HTTP request in RUN-52')
      })
    })
    afterAll(async () => {
      vi.restoreAllMocks()
      if (provider) await provider.close()
      if (prisma) {
        await prisma.user.deleteMany({ where: { authSubject: { in: authIds } } })
        await prisma.authUser.deleteMany({ where: { id: { in: authIds } } })
        await prisma.authInvitation.deleteMany({ where: { id: { in: invitationIds } } })
        await prisma.$disconnect()
      }
      vi.unstubAllEnvs()
    })

    it('onboards two athletes, repairs/imports/approves independently, recovers publication and matches manual Garmin imports', async () => {
      // Bootstrap only the synthetic administrator; subsequent invitations use the real ADMIN route.
      const token = randomBytes(32).toString('hex')
      const bootstrap = await prisma.authInvitation.create({
        data: {
          tokenHash: createHash('sha256').update(token).digest('hex'),
          expiresAt: new Date(Date.now() + 300_000),
        },
      })
      invitationIds.push(bootstrap.id)
      const admin = await register(token, 'admin')
      await prisma.user.update({ where: { id: admin.owner.userId }, data: { role: 'ADMIN' } })
      const actors = []
      for (const name of ['first', 'second']) {
        context.cookie = admin.cookie
        const response = await invite(request('/api/admin/invitations', { label: prefix }))
        expect(response.status).toBe(201)
        const invitation = await response.json()
        invitationIds.push(invitation.id)
        const inviteToken = new URLSearchParams(new URL(invitation.url).hash.slice(1)).get('token')
        if (!inviteToken) throw new Error('Missing invitation token')
        actors.push(await register(inviteToken, name))
      }
      context.cookie = ''
      expect((await invite(request('/api/admin/invitations', { label: prefix }))).status).toBe(401)
      context.cookie = actors[0].cookie
      expect((await invite(request('/api/admin/invitations', { label: prefix }))).status).toBe(403)

      const today = healthLocalDay(new Date().toISOString(), 'Asia/Tokyo')
      const startDate = addHealthDays(today, 1)
      const workoutDate = addHealthDays(today, 2)
      for (const [index, actor] of actors.entries()) {
        context.cookie = actor.cookie
        const current = await getCurrentUser()
        if (!current) throw new Error('Session disappeared')
        const owner = getOwnerContext(current)
        const foreign = actors[1 - index].owner
        const key = `synthetic-${prefix}-${index}`
        const accountId = testGarminAccountId(owner)
        await saveProviderApiKey(owner, 'GARMIN', `${key}-garmin`, {
          verifiedGarminAccountId: accountId,
        })
        await saveProviderApiKey(owner, 'INTERVALS', key)
        const goal = await saveGoal(owner, {
          name: 'Synthetic completion goal',
          type: 'COMPLETION',
          distanceMeters: 12000,
          targetTimeSeconds: null,
          targetCount: null,
          measurementWindow: null,
          targetDate: addHealthDays(today, 90),
          surface: 'ANY',
          elevationGainM: null,
        })
        const draft = await createPlanDraft(owner, {
          goalId: goal.id,
          constraints: {
            sessionsPerWeek: 3,
            availableWeekdays: [0, 1, 2, 3, 4, 5, 6],
            maxSessionMinutes: 60 + index * 10,
            startDate,
            timezone: 'Asia/Tokyo',
          },
        })
        const exportInput = {
          draftId: draft.id,
          expectedVersion: 0,
          allowedDetailWindow: { startDate, endDate: addHealthDays(today, 28) },
          consent: defaultExportConsent,
        }
        const stale = await issuePlanExport(owner, exportInput)
        const artifact = await issuePlanExport(owner, exportInput)
        expect(artifact.prompt).toContain(artifact.json)
        const exported = exchangeRequestSchema.parse(JSON.parse(artifact.json).request)
        const response: ExchangeResponse = {
          schemaVersion: 1,
          mode: 'initial',
          requestId: exported.requestId,
          draftVersion: 0,
          macroPlan: {
            startDate,
            endDate: addHealthDays(today, 90),
            strategy: 'Synthetic progression',
            phases: [{ startDate, endDate: addHealthDays(today, 90), label: 'Base', notes: '' }],
          },
          detailWindow: exported.allowedDetailWindow,
          workouts: [
            {
              workoutId: randomUUID(),
              scheduledDate: workoutDate,
              definition: {
                schemaVersion: 1,
                name: 'Synthetic nested running session',
                sport: 'RUNNING',
                steps: [
                  {
                    type: 'repeat',
                    count: 2,
                    steps: [
                      {
                        type: 'repeat',
                        count: 3,
                        steps: [
                          {
                            type: 'step',
                            termination: { type: 'time', durationSeconds: 300 },
                            target: { type: 'free' },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }
        const command = { goalId: goal.id, draftId: draft.id, requestId: exported.requestId }
        const text = JSON.stringify(response)
        expect((await previewPlanImport(owner, command, '{broken')).valid).toBe(false)
        expect((await previewPlanImport(foreign, command, text)).valid).toBe(false)
        expect(
          (await previewPlanImport(owner, { ...command, requestId: stale.requestId }, text)).valid,
        ).toBe(false)
        const preview = await previewPlanImport(owner, command, text)
        if (!preview.valid) throw new Error(JSON.stringify(preview.errors))
        const beforeCalls = provider.calls.length
        const approved = await approvePlanImport(
          owner,
          {
            ...command,
            approve: true,
            acknowledgedWarningIds: preview.preview.warnings.map((warning) => warning.id),
          },
          text,
        )
        if (!approved.approved) throw new Error('Plan approval failed')
        expect(provider.calls).toHaveLength(beforeCalls)
        expect(await prisma.workoutPublication.count({ where: { userId: owner.userId } })).toBe(0)
        const input = { planId: approved.planId, expectedRevisionId: approved.revisionId }
        const snapshot = await getPlanRevision(owner, input.planId, input.expectedRevisionId)
        await expect(previewRevisionPublication(foreign, input)).rejects.toThrow()

        async function publish() {
          const change = (await previewRevisionPublication(owner, input)).changes[0]
          return sendRevisionPublication(owner, {
            ...input,
            workoutId: change.workoutId,
            reviewToken: change.reviewToken,
            confirm: true,
          })
        }
        await disconnectProvider(owner, 'INTERVALS')
        expect((await publish()).status).not.toBe('PUBLISHED')
        expect(await getPlanRevision(owner, input.planId, input.expectedRevisionId)).toEqual(
          snapshot,
        )
        await saveProviderApiKey(owner, 'INTERVALS', key)
        provider.control.loseWriteResponse = true
        expect((await publish()).status).toBe('UNCERTAIN')
        const writes = provider.calls.filter(
          (call) => call.method === 'POST' && call.athlete === key,
        ).length
        expect(await publish()).toMatchObject({
          status: 'UNCERTAIN',
          errorCode: 'EXPORT_UNVERIFIED',
        })
        provider.control.fitExport = publicationFitFixture(false, {
          stepCount: 6,
          durationSeconds: 300,
        })
        expect(await publish()).toMatchObject({
          status: 'PUBLISHED',
          watch: 'UNVERIFIED',
          garminConnect: 'UNVERIFIED',
        })
        expect(
          provider.calls.filter((call) => call.method === 'POST' && call.athlete === key),
        ).toHaveLength(writes)
        expect(provider.events.get(key)?.size).toBe(1)
        expect([...provider.events.get(key)!.values()][0].start_date_local?.slice(0, 10)).toBe(
          workoutDate,
        )
        expect((await previewRevisionPublication(owner, input)).changes).toHaveLength(0)

        // Inject only the Garmin page adapter. The sync lease/checkpoint, canonical persistence,
        // matching and revision reader remain real; this does not verify the live Garmin API.
        let clock = new Date(`${workoutDate}T12:00:00Z`)
        const payload = {
          source: {
            userId: owner.userId,
            provider: 'GARMIN',
            externalActivityId: '52001',
            externalActivityUuid: null,
            recordType: 'API_ACTIVITY',
          },
          sportType: 'RUNNING',
          sourceSportType: 'running',
          startedAt: `${workoutDate}T01:00:00Z`,
          sourceTimezone: 'Asia/Tokyo',
          gpsAssetRef: null,
          distanceMeters: 5000 + index * 1000,
          totalMs: 1800000,
          elapsedMs: 1900000,
          movingMs: 1800000,
          avgSpeedMps: null,
          avgHrBpm: null,
          maxHrBpm: null,
          cadenceStepsPerMinute: null,
          elevationGainMeters: null,
          elevationLossMeters: null,
          laps: null,
        }
        const imported: string[] = []
        const importPage = vi.fn(async () => {
          const activity = await importCanonicalActivity(owner, payload, {
            garminAccountId: accountId,
          })
          imported.push(activity.id)
          clock = new Date(clock.getTime() + 21000)
          return { imported: [activity], providerIds: ['52001'], hasMore: true, nextStart: 1 }
        })
        expect(await prisma.syncRun.count({ where: { userId: owner.userId } })).toBe(0)
        await runGarminSync(owner, {}, { now: () => clock, importPage })
        expect(importPage).toHaveBeenCalledOnce()
        expect(importPage).toHaveBeenNthCalledWith(
          1,
          owner,
          expect.objectContaining({ start: 0 }),
          expect.anything(),
        )
        expect(await getActivityMatching(owner, { activityId: imported[0] })).toMatchObject({
          linked: null,
        })
        await runGarminSync(owner, {}, { now: () => clock, importPage })
        expect(importPage).toHaveBeenNthCalledWith(
          2,
          owner,
          expect.objectContaining({ start: 1 }),
          expect.anything(),
        )
        expect(new Set(imported).size).toBe(1)
        expect(await prisma.activity.count({ where: { userId: owner.userId } })).toBe(1)
        await expect(getActivityMatching(foreign, { activityId: imported[0] })).rejects.toThrow()
        const matchCommand = {
          activityId: imported[0],
          ...input,
          workoutId: response.workouts[0].workoutId,
          expectedWorkoutId: null,
        }
        await expect(linkActivity(foreign, matchCommand)).rejects.toThrow()
        await linkActivity(owner, matchCommand)
        expect(await getActivityMatching(owner, { activityId: imported[0] })).toMatchObject({
          actual: { distanceMeters: 5000 + index * 1000, durationSeconds: 1800, avgHrBpm: null },
          laps: [],
          linked: {
            workoutId: response.workouts[0].workoutId,
            comparison: {
              revisionId: approved.revisionId,
              estimate: { durationSeconds: { min: 1800, max: 1800, incomplete: false } },
            },
          },
        })
        expect(await getPlanRevision(owner, input.planId, input.expectedRevisionId)).toEqual(
          snapshot,
        )
        expect(
          await prisma.activity.count({
            where: { userId: owner.userId, sourceProvider: 'INTERVALS' },
          }),
        ).toBe(0)
        provider.control.fitExport = undefined
      }
      expect(provider.events.size).toBe(2)
    }, 120000)
  },
)
