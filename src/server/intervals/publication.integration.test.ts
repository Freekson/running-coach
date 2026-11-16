import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { config } from 'dotenv'
import type { PrismaClient } from '@prisma/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
import { getPrismaClient } from '@/server/db/client'
import {
  getOwnerContext,
  InvalidOwnerContextError,
  OwnedResourceNotFoundError,
} from '@/server/authorization/ownership'
import { saveProviderApiKey, disconnectProvider } from '@/server/provider/vault'
import { createIntervalsPublicationService } from './publication'
import {
  publicationMapping,
  publicationPayloadSchema,
  publicationPayloadHash,
  publicationWriteTag,
  type ApprovedPublicationWorkout,
  type ApprovedWorkoutReader,
} from './publication-contract'
import { intervalsPublicationClient } from './publication-client'
import { approvedPublicationFixture, publicationProviderFixture } from './publication.fixtures'

const requested = process.env.npm_lifecycle_event === 'test:db'
if (requested) config()
const enabled =
  requested &&
  ['development', 'test'].includes(process.env.APP_DATABASE_ENV ?? '') &&
  Boolean(process.env.DATABASE_URL && process.env.DIRECT_URL) &&
  !process.env.VERCEL_ENV
if (requested && !enabled) throw new Error('Isolated development/test database required')

describe.skipIf(!enabled)('RUN-41 durable outbox on PostgreSQL and local provider HTTP', () => {
  let prisma: PrismaClient
  const prefix = `run41-${randomUUID()}`
  const oldVersion = process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
  const oldKey = process.env.CREDENTIAL_ENCRYPTION_KEY_V1
  const cleanup: (() => Promise<void>)[] = []
  beforeAll(async () => {
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1'
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 41).toString('base64')
    prisma = await getPrismaClient()
  })
  afterEach(async () => {
    for (const close of cleanup.splice(0)) await close()
  })
  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { authSubject: { startsWith: prefix } } })
      await prisma.$disconnect()
    }
    if (oldVersion === undefined) delete process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
    else process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = oldVersion
    if (oldKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1
    else process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = oldKey
  })

  async function setup(options: { timeoutMs?: number } = {}) {
    const user = await prisma.user.create({ data: { authSubject: `${prefix}-${randomUUID()}` } })
    const otherUser = await prisma.user.create({
      data: { authSubject: `${prefix}-${randomUUID()}`, role: 'ADMIN' },
    })
    const owner = getOwnerContext({ id: user.id, role: 'USER', email: null })
    const other = getOwnerContext({ id: otherUser.id, role: 'ADMIN', email: null })
    const source = approvedPublicationFixture(user.id)
    const reader: ApprovedWorkoutReader = async (tx, context, workoutId) => {
      // Synthetic stand-in for RUN-33 only; exercise the supplied real transaction.
      await tx.user.findUniqueOrThrow({ where: { id: context.userId }, select: { id: true } })
      return workoutId === source.localWorkoutId ? structuredClone(source) : null
    }
    const provider = await publicationProviderFixture()
    cleanup.push(provider.close)
    const service = createIntervalsPublicationService(reader, {
      fetcher: provider.fetcher,
      ...options,
    })
    const key = `synthetic-${randomUUID()}`
    await saveProviderApiKey(owner, 'INTERVALS', key)
    const queue = (expectedPublishRevision = 0) =>
      service.queue(owner, {
        localWorkoutId: source.localWorkoutId,
        expectedRevisionId: source.revisionId,
        expectedPublishRevision,
      })
    const dispatch = (row: { id: string; publishRevision: number }) =>
      service.dispatch(owner, { publicationId: row.id, publishRevision: row.publishRevision })
    return { user, owner, other, otherUser, source, provider, service, queue, dispatch, key }
  }

  it('serializes repeated Publish/Update/Reschedule/Cancel with one event per owner/workout', async () => {
    const ctx = await setup()
    const before = JSON.stringify(ctx.source)
    const queued = await Promise.all([ctx.queue(), ctx.queue(), ctx.queue()])
    expect(new Set(queued.map((row) => row.id)).size).toBe(1)
    expect(await ctx.dispatch(queued[0])).toMatchObject({
      status: 'PUBLISHED',
      attemptCount: 1,
      watch: 'UNVERIFIED',
      garminConnect: 'UNVERIFIED',
    })
    expect(await ctx.dispatch(queued[0])).toMatchObject({ status: 'PUBLISHED', attemptCount: 1 })
    const remoteId = (await ctx.service.list(ctx.owner))[0].remoteEventId
    expect(JSON.stringify(ctx.source)).toBe(before)
    ctx.source.revisionId = randomUUID()
    ctx.source.workout.name = 'Updated synthetic run'
    const update = await ctx.queue(1)
    expect(update).toMatchObject({ operation: 'UPDATE', publishRevision: 2 })
    expect(await ctx.dispatch(update)).toMatchObject({
      status: 'PUBLISHED',
      remoteEventId: remoteId,
    })
    ctx.source.revisionId = randomUUID()
    ctx.source.schedule.localDate = '2027-03-22'
    const reschedule = await ctx.queue(2)
    expect(reschedule.operation).toBe('RESCHEDULE')
    expect(await ctx.dispatch(reschedule)).toMatchObject({
      status: 'PUBLISHED',
      remoteEventId: remoteId,
    })
    expect(await ctx.dispatch(reschedule)).toMatchObject({
      status: 'PUBLISHED',
      remoteEventId: remoteId,
    })
    expect(ctx.provider.events.get(ctx.key)?.size).toBe(1)
    ctx.source.revisionId = randomUUID()
    ctx.source.cancelled = true
    const cancel = await ctx.queue(3)
    expect(cancel.operation).toBe('CANCEL')
    expect(await ctx.dispatch(cancel)).toMatchObject({ status: 'CANCELLED' })
    await ctx.dispatch(cancel)
    expect(ctx.provider.events.get(ctx.key)?.size).toBe(0)
    const attempts = await prisma.workoutPublicationAttempt.findMany({
      where: { userId: ctx.user.id },
    })
    expect(attempts).toHaveLength(4)
    expect(attempts.every((attempt) => attempt.finishedAt !== null)).toBe(true)
    expect(ctx.provider.calls.filter((call) => call.method === 'POST')).toHaveLength(3)
    const confirmed = await prisma.workoutPublication.findUniqueOrThrow({
      where: { id: cancel.id },
    })
    expect(publicationPayloadSchema.parse(confirmed.lastConfirmedPayload).cancelled).toBe(true)
  })

  it('backfills only settled receipts and leaves unknown legacy outcomes nullable', async () => {
    const migration = await readFile(
      'prisma/migrations/20261116020000_publication_confirmed_baseline/migration.sql',
      'utf8',
    )
    await prisma.$transaction(async (tx) => {
      // A temporary table shadows the production name only in this transaction.
      await tx.$executeRawUnsafe(
        'CREATE TEMP TABLE workout_publications (status TEXT, payload JSONB, pending_write JSONB, lease_token UUID) ON COMMIT DROP',
      )
      for (const status of [
        'PUBLISHED',
        'CANCELLED',
        'UNCERTAIN',
        'FAILED',
        'RUNNING',
        'QUEUED',
        'SUPERSEDED',
      ])
        await tx.$executeRaw`INSERT INTO workout_publications (status, payload) VALUES (${status}, '{"synthetic":"baseline"}'::jsonb)`
      for (const statement of migration.split(';').filter((part) => part.trim()))
        await tx.$executeRawUnsafe(statement)
      const rows = await tx.$queryRaw<
        { status: string; confirmed: unknown }[]
      >`SELECT status, last_confirmed_payload AS confirmed FROM workout_publications`
      for (const row of rows)
        expect(row.confirmed).toEqual(
          ['PUBLISHED', 'CANCELLED'].includes(row.status) ? { synthetic: 'baseline' } : null,
        )
    })
  })

  it('retains confirmed payload through queue and failed dispatch, advancing it only after successful reconciliation', async () => {
    const ctx = await setup()
    const initial = await ctx.queue()
    await ctx.dispatch(initial)
    const before = await prisma.workoutPublication.findUniqueOrThrow({ where: { id: initial.id } })
    const baseline = publicationPayloadSchema.parse(before.lastConfirmedPayload)
    ctx.source.revisionId = randomUUID()
    ctx.source.schedule.localDate = '2027-03-23'
    const queued = await ctx.queue(1)
    expect(
      (await prisma.workoutPublication.findUniqueOrThrow({ where: { id: queued.id } }))
        .lastConfirmedPayload,
    ).toEqual(baseline)
    ctx.provider.control.failReads = true
    await ctx.dispatch(queued)
    expect(
      (await prisma.workoutPublication.findUniqueOrThrow({ where: { id: queued.id } }))
        .lastConfirmedPayload,
    ).toEqual(baseline)
    ctx.provider.control.failReads = false
    ctx.provider.control.loseWriteResponse = true
    await ctx.dispatch(queued)
    expect(
      (await prisma.workoutPublication.findUniqueOrThrow({ where: { id: queued.id } }))
        .lastConfirmedPayload,
    ).toEqual(baseline)
    expect(await ctx.dispatch(queued)).toMatchObject({ status: 'PUBLISHED' })
    expect(
      publicationPayloadSchema.parse(
        (await prisma.workoutPublication.findUniqueOrThrow({ where: { id: queued.id } }))
          .lastConfirmedPayload,
      ).schedule.localDate,
    ).toBe('2027-03-23')
    expect(ctx.provider.calls.filter((call) => call.method === 'POST')).toHaveLength(2)
  })

  it('recovers a committed create whose response was lost without issuing a second create', async () => {
    const ctx = await setup()
    const queued = await ctx.queue()
    ctx.provider.control.loseWriteResponse = true
    const failed = await ctx.dispatch(queued)
    expect(failed).toMatchObject({
      status: 'UNCERTAIN',
      remoteEventId: null,
      errorCode: 'PROVIDER_UNAVAILABLE',
    })
    expect(ctx.provider.events.get(ctx.key)?.size).toBe(1)
    expect(await ctx.queue()).toMatchObject({ id: queued.id, status: 'UNCERTAIN' })
    const recovered = await ctx.dispatch(queued)
    expect(recovered).toMatchObject({ status: 'PUBLISHED', attemptCount: 2 })
    expect(recovered.remoteEventId).not.toBeNull()
    expect(ctx.provider.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    expect(
      (await prisma.workoutPublication.findUniqueOrThrow({ where: { id: queued.id } })).payloadHash,
    ).toMatch(/^[0-9a-f]{64}$/)
  })

  it('retains local approval and queued intent through offline/disconnected failures and explicit retry', async () => {
    const ctx = await setup()
    const queued = await ctx.queue()
    const before = JSON.stringify(ctx.source)
    await disconnectProvider(ctx.owner, 'INTERVALS')
    expect(await ctx.dispatch(queued)).toMatchObject({ status: 'FAILED' })
    expect(ctx.provider.calls).toHaveLength(0)
    expect(JSON.stringify(ctx.source)).toBe(before)
    await saveProviderApiKey(ctx.owner, 'INTERVALS', ctx.key)
    ctx.provider.control.failReads = true
    expect(await ctx.dispatch(queued)).toMatchObject({ status: 'UNCERTAIN' })
    ctx.provider.control.failReads = false
    expect(await ctx.dispatch(queued)).toMatchObject({ status: 'PUBLISHED' })
    expect(JSON.stringify(ctx.source)).toBe(before)
  })

  it('recovers an interrupted expired lease and durably closes its unfinished attempt', async () => {
    const ctx = await setup()
    const queued = await ctx.queue()
    const row = await prisma.workoutPublication.findUniqueOrThrow({ where: { id: queued.id } })
    const payload = publicationPayloadSchema.parse(row.payload)
    const writeToken = randomUUID()
    const remote = await intervalsPublicationClient(ctx.key, {
      fetcher: ctx.provider.fetcher,
    }).upsert({
      ...publicationMapping(payload, row.externalId).event,
      tags: [publicationWriteTag(writeToken)],
    })
    const token = randomUUID()
    await prisma.workoutPublication.update({
      where: { id: row.id },
      data: {
        status: 'RUNNING',
        remoteAthleteId: ctx.key,
        attemptCount: 1,
        leaseToken: token,
        leaseExpiresAt: new Date(0),
        pendingWrite: { kind: 'UPSERT', token: writeToken },
        attempts: {
          create: {
            id: token,
            publishRevision: 1,
            payloadHash: row.payloadHash,
            status: 'RUNNING',
          },
        },
      },
    })
    expect(await ctx.dispatch(queued)).toMatchObject({
      status: 'PUBLISHED',
      remoteEventId: remote.id,
      attemptCount: 2,
    })
    expect(
      await prisma.workoutPublicationAttempt.findUnique({ where: { id: token } }),
    ).toMatchObject({ status: 'INTERRUPTED', errorCode: 'RECOVERY_REQUIRED' })
    expect(ctx.provider.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('rejects stale revisions, forged owner contexts, other users and client approval data', async () => {
    const ctx = await setup()
    const queued = await ctx.queue()
    await expect(
      ctx.service.queue(ctx.owner, {
        localWorkoutId: ctx.source.localWorkoutId,
        expectedRevisionId: randomUUID(),
        expectedPublishRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
    await expect(
      ctx.service.queue(ctx.other, {
        localWorkoutId: ctx.source.localWorkoutId,
        expectedRevisionId: ctx.source.revisionId,
        expectedPublishRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'NOT_APPROVED' })
    await expect(
      ctx.service.dispatch(ctx.other, { publicationId: queued.id, publishRevision: 1 }),
    ).rejects.toBeInstanceOf(OwnedResourceNotFoundError)
    await expect(ctx.service.list({ userId: ctx.user.id })).rejects.toBeInstanceOf(
      InvalidOwnerContextError,
    )
    await expect(
      ctx.service.queue(ctx.owner, {
        localWorkoutId: ctx.source.localWorkoutId,
        expectedRevisionId: ctx.source.revisionId,
        expectedPublishRevision: 0,
        approved: true,
        workout: ctx.source.workout,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await ctx.service.list(ctx.other)).toEqual([])
    expect(ctx.provider.calls).toHaveLength(0)
    await expect(
      prisma.workoutPublicationAttempt.create({
        data: {
          id: randomUUID(),
          userId: ctx.otherUser.id,
          publicationId: queued.id,
          publishRevision: 1,
          payloadHash: 'a'.repeat(64),
          status: 'RUNNING',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' })
  })

  it('blocks concurrent dispatch and prevents a newer intent overtaking an uncertain effect', async () => {
    const ctx = await setup()
    const queued = await ctx.queue()
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    ctx.provider.control.beforeWrite = async () => {
      started?.()
      await gate
    }
    const running = ctx.dispatch(queued)
    await entered
    try {
      await expect(ctx.dispatch(queued)).rejects.toMatchObject({ code: 'BUSY' })
      ctx.source.revisionId = randomUUID()
      await expect(ctx.queue(1)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    } finally {
      release?.()
    }
    expect(await running).toMatchObject({ status: 'SUPERSEDED', errorCode: 'STALE_REVISION' })
    const next = await ctx.queue(1)
    await expect(ctx.dispatch(queued)).rejects.toMatchObject({ code: 'STALE_REVISION' })
    expect(next.publishRevision).toBe(2)
  })

  it('supersedes stale interrupted intent by reconciliation without publishing the old revision', async () => {
    const ctx = await setup()
    const queued = await ctx.queue()
    const oldWorkoutName = ctx.source.workout.name
    ctx.provider.control.loseWriteResponse = true
    expect(await ctx.dispatch(queued)).toMatchObject({ status: 'UNCERTAIN' })
    ctx.source.revisionId = randomUUID()
    ctx.source.workout.name = 'Current approved run'
    await expect(ctx.queue(1)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(await ctx.dispatch(queued)).toMatchObject({
      status: 'SUPERSEDED',
      errorCode: 'STALE_REVISION',
    })
    const reconciled = await prisma.workoutPublication.findUniqueOrThrow({
      where: { id: queued.id },
    })
    expect(publicationPayloadSchema.parse(reconciled.lastConfirmedPayload).workout.name).toBe(
      oldWorkoutName,
    )
    const next = await ctx.queue(1)
    expect(await ctx.dispatch(next)).toMatchObject({ status: 'PUBLISHED' })
    expect(ctx.provider.events.get(ctx.key)?.size).toBe(1)
    expect(ctx.provider.calls.filter((call) => call.method === 'POST')).toHaveLength(2)
  })

  it('binds retries to the original athlete but permits same-athlete credential rotation', async () => {
    const ctx = await setup()
    const queued = await ctx.queue()
    ctx.provider.control.loseWriteResponse = true
    await ctx.dispatch(queued)
    const replacementKey = `replacement-${randomUUID()}`
    await saveProviderApiKey(ctx.owner, 'INTERVALS', replacementKey)
    expect(await ctx.dispatch(queued)).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: 'ACCOUNT_CHANGED',
    })
    expect(ctx.provider.events.get(replacementKey)?.size ?? 0).toBe(0)
    ctx.provider.control.accountOverride = ctx.key
    expect(await ctx.dispatch(queued)).toMatchObject({ status: 'PUBLISHED' })
    expect(ctx.provider.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('does not report provider success until FIT prescription verification succeeds', async () => {
    const ctx = await setup()
    const queued = await ctx.queue()
    ctx.provider.control.invalidExport = true
    const failed = await ctx.dispatch(queued)
    expect(failed).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: 'EXPORT_UNVERIFIED',
      publishedAt: null,
    })
    expect(failed.remoteEventId).not.toBeNull()
    ctx.provider.control.invalidExport = false
    expect(await ctx.dispatch(queued)).toMatchObject({ status: 'PUBLISHED' })
    expect(ctx.provider.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('keeps two owners independent even when they connect the same provider athlete', async () => {
    const ctx = await setup()
    await saveProviderApiKey(ctx.other, 'INTERVALS', ctx.key)
    const otherSource: ApprovedPublicationWorkout = {
      ...approvedPublicationFixture(ctx.otherUser.id),
      localWorkoutId: ctx.source.localWorkoutId,
    }
    const otherService = createIntervalsPublicationService(async () => otherSource, {
      fetcher: ctx.provider.fetcher,
    })
    const own = await ctx.queue()
    const theirs = await otherService.queue(ctx.other, {
      localWorkoutId: otherSource.localWorkoutId,
      expectedRevisionId: otherSource.revisionId,
      expectedPublishRevision: 0,
    })
    await ctx.dispatch(own)
    await otherService.dispatch(ctx.other, { publicationId: theirs.id, publishRevision: 1 })
    expect(ctx.provider.events.get(ctx.key)?.size).toBe(2)
    expect(await ctx.service.list(ctx.owner)).toHaveLength(1)
    expect(await ctx.service.list(ctx.other)).toHaveLength(1)
  })

  it('fails closed when the source is missing, locked or unapproved', async () => {
    const ctx = await setup()
    ctx.source.locked = true
    await expect(ctx.queue()).rejects.toMatchObject({ code: 'NOT_APPROVED' })
    const service = createIntervalsPublicationService(async () => null)
    await expect(
      service.queue(ctx.owner, {
        localWorkoutId: ctx.source.localWorkoutId,
        expectedRevisionId: ctx.source.revisionId,
        expectedPublishRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'NOT_APPROVED' })
    expect(ctx.provider.calls).toHaveLength(0)
  })

  it.each(['UPDATE', 'RESCHEDULE', 'CANCEL'] as const)(
    'reconciles a lost %s response without repeating the external effect',
    async (operation) => {
      const ctx = await setup()
      const first = await ctx.queue()
      const original = await ctx.dispatch(first)
      ctx.source.revisionId = randomUUID()
      if (operation === 'UPDATE') ctx.source.workout.name = 'New approved title'
      if (operation === 'RESCHEDULE') ctx.source.schedule.localDate = '2027-03-23'
      if (operation === 'CANCEL') ctx.source.cancelled = true
      const next = await ctx.queue(1)
      expect(next.operation).toBe(operation)
      ctx.provider.control.loseWriteResponse = true
      expect(await ctx.dispatch(next)).toMatchObject({ status: 'UNCERTAIN' })
      const writesBeforeRetry = ctx.provider.calls.filter((call) => call.method !== 'GET').length
      expect(await ctx.dispatch(next)).toMatchObject({
        status: operation === 'CANCEL' ? 'CANCELLED' : 'PUBLISHED',
        remoteEventId: original.remoteEventId,
      })
      expect(ctx.provider.calls.filter((call) => call.method !== 'GET')).toHaveLength(
        writesBeforeRetry,
      )
      expect(ctx.provider.events.get(ctx.key)?.size).toBe(operation === 'CANCEL' ? 0 : 1)
    },
  )

  it('does not acknowledge an in-flight effect after its credentials were replaced', async () => {
    const ctx = await setup()
    const queued = await ctx.queue()
    ctx.provider.control.beforeWrite = async () => {
      await saveProviderApiKey(ctx.owner, 'INTERVALS', `replacement-${randomUUID()}`)
    }
    expect(await ctx.dispatch(queued)).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: 'PROVIDER_UNAVAILABLE',
    })
    expect(ctx.provider.events.get(ctx.key)?.size).toBe(1)
    expect(await ctx.dispatch(queued)).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: 'ACCOUNT_CHANGED',
    })
    expect(ctx.provider.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('reuses owner-bound Run pace preflight and verifies absolute pace targets before publication', async () => {
    const ctx = await setup()
    ctx.source.workout.steps = [
      {
        type: 'step',
        termination: { type: 'time', durationSeconds: 600 },
        target: { type: 'pace', minSecondsPerKm: 300, maxSecondsPerKm: 330 },
      },
    ]
    ctx.provider.control.paceExport = true
    const queued = await ctx.queue()
    expect(await ctx.dispatch(queued)).toMatchObject({ status: 'PUBLISHED', watch: 'UNVERIFIED' })
    expect(
      ctx.provider.calls.some((call) => call.path === '/sport-settings' && call.method === 'GET'),
    ).toBe(true)
    expect(
      ctx.provider.calls.some(
        (call) => call.path.startsWith('/sport-settings') && call.method !== 'GET',
      ),
    ).toBe(false)
  })

  it('can cancel an existing event without converting a tombstone definition to provider format', async () => {
    const ctx = await setup()
    await ctx.dispatch(await ctx.queue())
    ctx.source.revisionId = randomUUID()
    ctx.source.cancelled = true
    ctx.source.workout.sport = 'CYCLING'
    expect(await ctx.dispatch(await ctx.queue(1))).toMatchObject({ status: 'CANCELLED' })
    expect(ctx.provider.events.get(ctx.key)?.size).toBe(0)
  })

  it('cancels the recreated event after its create response was lost and a newer cancellation was approved', async () => {
    const ctx = await setup()
    const first = await ctx.dispatch(await ctx.queue())
    ctx.source.revisionId = randomUUID()
    ctx.source.cancelled = true
    expect(await ctx.dispatch(await ctx.queue(1))).toMatchObject({ status: 'CANCELLED' })

    ctx.source.revisionId = randomUUID()
    ctx.source.cancelled = false
    const recreate = await ctx.queue(2)
    ctx.provider.control.loseWriteResponse = true
    expect(await ctx.dispatch(recreate)).toMatchObject({
      status: 'UNCERTAIN',
      remoteEventId: first.remoteEventId,
    })
    const calendar = ctx.provider.events.get(ctx.key)
    const recreatedId = [...(calendar?.values() ?? [])][0]?.id
    expect(recreatedId).toBeTypeOf('number')
    expect(recreatedId).not.toBe(first.remoteEventId)

    ctx.source.revisionId = randomUUID()
    ctx.source.cancelled = true
    expect(await ctx.dispatch(recreate)).toMatchObject({
      status: 'SUPERSEDED',
      remoteEventId: recreatedId,
    })
    const cancellation = await ctx.queue(3)
    const sourceBefore = JSON.stringify(ctx.source)
    expect(await ctx.dispatch(cancellation)).toMatchObject({
      status: 'CANCELLED',
      remoteEventId: recreatedId,
    })
    expect(calendar?.size).toBe(0)
    await ctx.dispatch(cancellation)
    expect(ctx.provider.calls.filter((call) => call.method === 'POST')).toHaveLength(2)
    expect(ctx.provider.calls.filter((call) => call.path === '/events/bulk-delete')).toHaveLength(2)
    expect(JSON.stringify(ctx.source)).toBe(sourceBefore)
  })

  it('publishes alongside unrelated calendar workouts with nullable provider fields', async () => {
    const ctx = await setup()
    const calendar = new Map([
      [
        'unrelated',
        {
          id: 987,
          external_id: null,
          category: 'WORKOUT',
          type: 'Run',
          target: null,
          name: null,
          description: null,
          start_date_local: `${ctx.source.schedule.localDate}T00:00:00`,
        },
      ],
    ])
    ctx.provider.events.set(ctx.key, calendar)
    const sourceBefore = JSON.stringify(ctx.source)
    expect(await ctx.dispatch(await ctx.queue())).toMatchObject({
      status: 'PUBLISHED',
      watch: 'UNVERIFIED',
    })
    expect(calendar.size).toBe(2)
    expect(calendar.get('unrelated')).toMatchObject({ id: 987, target: null, description: null })
    expect(JSON.stringify(ctx.source)).toBe(sourceBefore)
  })

  it('publishes valid optional undefined fields after JSONB storage and repeated queue requests', async () => {
    const ctx = await setup()
    ctx.source.workout.steps = [
      {
        type: 'step',
        name: undefined,
        termination: { type: 'time', durationSeconds: 600 },
        target: { type: 'free' },
      },
    ]
    const queued = await ctx.queue()
    const row = await prisma.workoutPublication.findUniqueOrThrow({ where: { id: queued.id } })
    expect(row.payloadHash).toBe(
      publicationPayloadHash(publicationPayloadSchema.parse(row.payload)),
    )
    expect(await ctx.queue()).toMatchObject({ id: queued.id, publishRevision: 1 })
    expect(await ctx.dispatch(queued)).toMatchObject({ status: 'PUBLISHED', errorCode: null })
    expect(await ctx.dispatch(queued)).toMatchObject({ status: 'PUBLISHED', attemptCount: 1 })
  })

  it.each(['CREATE', 'UPDATE', 'RESCHEDULE', 'CANCEL'] as const)(
    'keeps newer publication blocked until a delayed timed-out %s is established',
    async (operation) => {
      const ctx = await setup({ timeoutMs: 250 })
      let publishRevision = 0
      if (operation !== 'CREATE') {
        await ctx.dispatch(await ctx.queue())
        publishRevision = 1
        ctx.source.revisionId = randomUUID()
        if (operation === 'UPDATE') ctx.source.workout.name = 'Intermediate update'
        if (operation === 'RESCHEDULE') ctx.source.schedule.localDate = '2027-03-22'
        if (operation === 'CANCEL') ctx.source.cancelled = true
      }
      const queued = await ctx.queue(publishRevision)
      let release: (() => void) | undefined
      let entered: (() => void) | undefined
      let committed: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const writeEntered = new Promise<void>((resolve) => {
        entered = resolve
      })
      const writeCommitted = new Promise<void>((resolve) => {
        committed = resolve
      })
      ctx.provider.control.beforeWrite = async () => {
        entered?.()
        await gate
      }
      ctx.provider.control.afterWrite = () => committed?.()
      const running = ctx.dispatch(queued)
      try {
        await writeEntered
        expect(await running).toMatchObject({ status: 'UNCERTAIN' })
        const unresolved = await prisma.workoutPublication.findUniqueOrThrow({
          where: { id: queued.id },
        })
        expect(unresolved.pendingWrite).not.toBeNull()
        ctx.source.revisionId = randomUUID()
        ctx.source.cancelled = false
        ctx.source.workout.name = 'Latest approved workout'
        const newerPayload = JSON.stringify(ctx.source)
        const writes = ctx.provider.calls.filter((call) => call.method !== 'GET').length
        expect(await ctx.dispatch(queued)).toMatchObject({
          status: 'UNCERTAIN',
          errorCode: 'RECOVERY_REQUIRED',
        })
        await expect(ctx.queue(publishRevision + 1)).rejects.toMatchObject({
          code: 'RECOVERY_REQUIRED',
        })
        expect(ctx.provider.calls.filter((call) => call.method !== 'GET')).toHaveLength(writes)
        release?.()
        await writeCommitted
        ctx.provider.control.beforeWrite = undefined
        ctx.provider.control.afterWrite = undefined
        expect(await ctx.dispatch(queued)).toMatchObject({ status: 'SUPERSEDED' })
        const reconciled = await prisma.workoutPublication.findUniqueOrThrow({
          where: { id: queued.id },
        })
        expect(reconciled.pendingWrite).toBeNull()
        const latest = await ctx.queue(publishRevision + 1)
        expect(await ctx.dispatch(latest)).toMatchObject({ status: 'PUBLISHED' })
        const remote = [...(ctx.provider.events.get(ctx.key)?.values() ?? [])]
        expect(remote).toHaveLength(1)
        expect(remote[0]).toMatchObject({
          name: ctx.source.workout.name,
          start_date_local: `${ctx.source.schedule.localDate}T00:00:00`,
        })
        expect(JSON.stringify(ctx.source)).toBe(newerPayload)
      } finally {
        release?.()
        await running
      }
    },
  )

  it('does not issue a second upsert when unchanged approval is retried before a timed-out write commits', async () => {
    const ctx = await setup({ timeoutMs: 250 })
    const queued = await ctx.queue()
    let release: (() => void) | undefined
    let committed: (() => void) | undefined
    let entered: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const writeEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const writeCommitted = new Promise<void>((resolve) => {
      committed = resolve
    })
    ctx.provider.control.beforeWrite = async () => {
      entered?.()
      await gate
    }
    ctx.provider.control.afterWrite = () => committed?.()
    const running = ctx.dispatch(queued)
    try {
      await writeEntered
      expect(await running).toMatchObject({ status: 'UNCERTAIN' })
      expect(await ctx.dispatch(queued)).toMatchObject({
        status: 'UNCERTAIN',
        errorCode: 'RECOVERY_REQUIRED',
      })
      expect(ctx.provider.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
      release?.()
      await writeCommitted
      ctx.provider.control.beforeWrite = undefined
      expect(await ctx.dispatch(queued)).toMatchObject({ status: 'PUBLISHED' })
      expect(ctx.provider.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    } finally {
      release?.()
      await running
    }
  })

  it('does not resolve a pending upsert from an identical prescription bearing an older marker', async () => {
    const ctx = await setup()
    const queued = await ctx.queue()
    await ctx.dispatch(queued)
    const pending = { kind: 'UPSERT', token: randomUUID() }
    await prisma.workoutPublication.update({
      where: { id: queued.id },
      data: { status: 'UNCERTAIN', pendingWrite: pending },
    })
    expect(await ctx.dispatch(queued)).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: 'RECOVERY_REQUIRED',
    })
    const stored = await prisma.workoutPublication.findUniqueOrThrow({ where: { id: queued.id } })
    expect(stored.pendingWrite).toEqual(pending)
    expect(ctx.provider.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('keeps pre-marker legacy uncertainty blocked instead of guessing its outcome', async () => {
    const ctx = await setup()
    const queued = await ctx.queue()
    await prisma.workoutPublication.update({
      where: { id: queued.id },
      data: { status: 'UNCERTAIN', pendingWrite: { kind: 'LEGACY' } },
    })
    expect(await ctx.dispatch(queued)).toMatchObject({
      status: 'UNCERTAIN',
      errorCode: 'RECOVERY_REQUIRED',
    })
    ctx.source.revisionId = randomUUID()
    await expect(ctx.queue(1)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(ctx.provider.calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('allows manual retry after an explicit rejected calendar write without leaving an unresolved marker', async () => {
    const ctx = await setup()
    const queued = await ctx.queue()
    ctx.provider.control.rejectNextWrite = true
    expect(await ctx.dispatch(queued)).toMatchObject({
      status: 'FAILED',
      errorCode: 'RATE_LIMITED',
    })
    expect(
      (await prisma.workoutPublication.findUniqueOrThrow({ where: { id: queued.id } }))
        .pendingWrite,
    ).toBeNull()
    expect(ctx.provider.events.get(ctx.key)?.size ?? 0).toBe(0)
    expect(await ctx.dispatch(queued)).toMatchObject({ status: 'PUBLISHED' })
    expect(ctx.provider.events.get(ctx.key)?.size).toBe(1)
  })
})
