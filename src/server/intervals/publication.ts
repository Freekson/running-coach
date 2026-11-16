import 'server-only'

import { randomUUID } from 'node:crypto'
import { Prisma, type WorkoutPublication } from '@prisma/client'
import { z } from 'zod'
import { publicationSummarySchema } from '@/lib/workout-publication'
import {
  ownerId,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import {
  assertProviderApiKeySnapshotCurrent,
  readProviderApiKeySnapshot,
} from '@/server/provider/vault'
import { preflightIntervalsPace } from './pace-preflight'
import { assertIntervalsWorkoutExport } from './workout-export'
import { intervalsPublicationClient, sameRemotePublication } from './publication-client'
import { confirmedPublicationPayload, publicationOperation } from './publication-baseline'
import {
  approvedWorkoutSchema,
  publicationCommandSchema,
  publicationExternalId,
  publicationMapping,
  publicationPayloadHash,
  publicationPayloadSchema,
  pendingPublicationWriteSchema,
  publicationWriteTag,
  PublicationError,
  type ApprovedWorkoutReader,
  type PublicationPayload,
  type PendingPublicationWrite,
} from './publication-contract'

const dispatchSchema = z.strictObject({
  publicationId: z.uuid(),
  publishRevision: z.number().int().positive(),
})
const leaseMs = 120_000

function summary(row: WorkoutPublication) {
  return publicationSummarySchema.parse({
    id: row.id,
    localWorkoutId: row.localWorkoutId,
    approvedRevisionId: row.approvedRevisionId,
    publishRevision: row.publishRevision,
    operation: row.operation,
    status:
      row.status === 'RUNNING' && row.leaseExpiresAt && row.leaseExpiresAt <= new Date()
        ? 'UNCERTAIN'
        : row.status,
    remoteEventId: row.remoteEventId,
    attemptCount: row.attemptCount,
    errorCode: row.errorCode,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    garminConnect: 'UNVERIFIED' as const,
    watch: 'UNVERIFIED' as const,
  })
}

async function lockWorkout(tx: Prisma.TransactionClient, userId: string, workoutId: string) {
  // Serializes first creation as well as updates across serverless instances.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${workoutId}`}, 0))`
}

function approvedPayload(raw: unknown, userId: string, workoutId: string): PublicationPayload {
  const parsed = approvedWorkoutSchema.safeParse(raw)
  if (!parsed.success || parsed.data.userId !== userId || parsed.data.localWorkoutId !== workoutId)
    throw new PublicationError('NOT_APPROVED')
  if (parsed.data.locked) throw new PublicationError('NOT_APPROVED')
  const { userId: verifiedUserId, ...payload } = parsed.data
  if (verifiedUserId !== userId) throw new PublicationError('NOT_APPROVED')
  return publicationPayloadSchema.parse(payload)
}

/** RUN-38 supplies the persisted approval reader from server/plans/publication.
 * Queue and dispatch require explicit actions; neither approval nor reads drain it. */
export function createIntervalsPublicationService(
  readApproved: ApprovedWorkoutReader,
  options: { fetcher?: typeof fetch; now?: () => Date; timeoutMs?: number } = {},
) {
  const now = options.now ?? (() => new Date())

  async function current(tx: Prisma.TransactionClient, owner: OwnerContext, workoutId: string) {
    return approvedPayload(await readApproved(tx, owner, workoutId), ownerId(owner), workoutId)
  }

  return {
    async queue(owner: OwnerContext, raw: unknown) {
      const userId = ownerId(owner)
      const command = publicationCommandSchema.safeParse(raw)
      if (!command.success) throw new PublicationError('INVALID_INPUT')
      const { localWorkoutId, expectedRevisionId, expectedPublishRevision } = command.data
      const prisma = await getPrismaClient()
      return prisma.$transaction(async (tx) => {
        await lockWorkout(tx, userId, localWorkoutId)
        const payload = await current(tx, owner, localWorkoutId)
        if (payload.revisionId !== expectedRevisionId) throw new PublicationError('STALE_REVISION')
        const externalId = publicationExternalId(userId, localWorkoutId)
        if (!payload.cancelled) publicationMapping(payload, externalId)
        const payloadHash = publicationPayloadHash(payload)
        const prior = await tx.workoutPublication.findUnique({
          where: {
            userId_provider_localWorkoutId: { userId, provider: 'INTERVALS', localWorkoutId },
          },
        })
        // Exact repeated clicks return the original receipt, including its failure state.
        if (prior?.payloadHash === payloadHash && prior.approvedRevisionId === expectedRevisionId)
          return summary(prior)
        if ((prior?.publishRevision ?? 0) !== expectedPublishRevision)
          throw new PublicationError('STALE_REVISION')
        if (
          prior?.leaseToken ||
          prior?.status === 'UNCERTAIN' ||
          (prior?.pendingWrite !== null && prior?.pendingWrite !== undefined)
        )
          throw new PublicationError('RECOVERY_REQUIRED')
        const baseline = prior ? confirmedPublicationPayload(prior) : null
        const operation = publicationOperation(payload, baseline, prior)
        const data = {
          approvedRevisionId: expectedRevisionId,
          publishRevision: expectedPublishRevision + 1,
          payload: { ...payload },
          payloadHash,
          operation,
          status: 'QUEUED',
          errorCode: null,
          publishedAt: null,
        }
        const saved = prior
          ? await tx.workoutPublication.update({
              where: { id: prior.id },
              data: { ...data, ...(baseline ? { lastConfirmedPayload: { ...baseline } } : {}) },
            })
          : await tx.workoutPublication.create({
              data: { ...data, userId, provider: 'INTERVALS', localWorkoutId, externalId },
            })
        return summary(saved)
      })
    },

    async list(owner: OwnerContext) {
      const prisma = await getPrismaClient()
      return (
        await prisma.workoutPublication.findMany({
          where: { userId: ownerId(owner), provider: 'INTERVALS' },
          orderBy: { updatedAt: 'desc' },
          take: 100,
        })
      ).map(summary)
    },

    async dispatch(owner: OwnerContext, raw: unknown) {
      const userId = ownerId(owner)
      const command = dispatchSchema.safeParse(raw)
      if (!command.success) throw new PublicationError('INVALID_INPUT')
      const prisma = await getPrismaClient()
      const token = randomUUID()
      const row = await prisma.$transaction(async (tx) => {
        const prior = await tx.workoutPublication.findFirst({
          where: { userId, id: command.data.publicationId, provider: 'INTERVALS' },
        })
        if (!prior) throw new OwnedResourceNotFoundError()
        await lockWorkout(tx, userId, prior.localWorkoutId)
        const saved = await tx.workoutPublication.findUniqueOrThrow({ where: { id: prior.id } })
        if (saved.publishRevision !== command.data.publishRevision)
          throw new PublicationError('STALE_REVISION')
        if (!saved.pendingWrite && ['PUBLISHED', 'CANCELLED', 'SUPERSEDED'].includes(saved.status))
          return saved
        if (saved.leaseExpiresAt && saved.leaseExpiresAt > now()) throw new PublicationError('BUSY')
        await tx.workoutPublicationAttempt.updateMany({
          where: { userId, publicationId: saved.id, finishedAt: null },
          data: { status: 'INTERRUPTED', errorCode: 'RECOVERY_REQUIRED', finishedAt: now() },
        })
        const claimed = await tx.workoutPublication.update({
          where: { id: saved.id },
          data: {
            status: 'RUNNING',
            leaseToken: token,
            leaseExpiresAt: new Date(now().getTime() + leaseMs),
            attemptCount: { increment: 1 },
            errorCode: null,
          },
        })
        await tx.workoutPublicationAttempt.create({
          data: {
            id: token,
            userId,
            publicationId: saved.id,
            publishRevision: saved.publishRevision,
            payloadHash: saved.payloadHash,
            status: 'RUNNING',
            startedAt: now(),
          },
        })
        return claimed
      })
      if (row.leaseToken !== token) return summary(row)
      let mutationStarted = false
      let remoteEventId = row.remoteEventId
      let pendingWrite: PendingPublicationWrite | null = null

      async function checkpoint(
        data: Prisma.WorkoutPublicationUpdateManyMutationInput,
        finish?: { status: string; errorCode: string | null },
        verifyCurrent?: (tx: Prisma.TransactionClient) => Promise<boolean>,
      ) {
        return prisma.$transaction(async (tx) => {
          if (verifyCurrent && !(await verifyCurrent(tx))) {
            data = { ...data, status: 'SUPERSEDED', publishedAt: null, errorCode: 'STALE_REVISION' }
            finish = { status: 'SUPERSEDED', errorCode: 'STALE_REVISION' }
          }
          const saved = await tx.workoutPublication.updateMany({
            where: {
              userId,
              id: row.id,
              publishRevision: row.publishRevision,
              leaseToken: token,
              leaseExpiresAt: { gt: now() },
            },
            data: { ...data, ...(finish ? { leaseToken: null, leaseExpiresAt: null } : {}) },
          })
          if (saved.count !== 1) throw new PublicationError('BUSY')
          if (finish)
            await tx.workoutPublicationAttempt.updateMany({
              where: { id: token, userId, publicationId: row.id },
              data: { ...finish, finishedAt: now() },
            })
          return summary(await tx.workoutPublication.findUniqueOrThrow({ where: { id: row.id } }))
        })
      }

      try {
        pendingWrite =
          row.pendingWrite === null ? null : pendingPublicationWriteSchema.parse(row.pendingWrite)
        const payload = publicationPayloadSchema.parse(row.payload)
        if (publicationPayloadHash(payload) !== row.payloadHash)
          throw new PublicationError('REMOTE_CONFLICT')
        const snapshot = await readProviderApiKeySnapshot(owner, 'INTERVALS')
        const client = intervalsPublicationClient(snapshot.key, options)
        const athleteId = await client.athleteId()
        // Bind BEFORE any calendar write. Never replay an uncertain old-account effect
        // into a different account after reconnecting with a different key.
        if (row.remoteAthleteId && row.remoteAthleteId !== athleteId)
          throw new PublicationError('ACCOUNT_CHANGED')
        await checkpoint({ remoteAthleteId: athleteId })
        const mapping = payload.cancelled ? null : publicationMapping(payload, row.externalId)
        let remote = await client.find(row.externalId, payload.schedule.localDate, remoteEventId)
        if (remote) {
          // The client verifies identity and may recover a replacement ID after 404.
          remoteEventId = remote.id
          await checkpoint({ remoteEventId })
        }

        if (pendingWrite) {
          // Neither an empty read nor a changed approval proves a timed-out
          // upsert finished. Only this unique write's marker can release it.
          const resolved =
            pendingWrite.kind === 'UPSERT'
              ? remote?.tags?.includes(publicationWriteTag(pendingWrite.token)) === true &&
                mapping !== null &&
                sameRemotePublication(remote, mapping.event)
              : pendingWrite.kind === 'CANCEL'
                ? await client.isAbsent(pendingWrite.remoteEventId, row.externalId)
                : false
          if (!resolved) throw new PublicationError('RECOVERY_REQUIRED')
          await checkpoint({ pendingWrite: Prisma.DbNull })
          pendingWrite = null
        }

        // A refresh can supersede intent while a request is interrupted. Reconcile
        // that old receipt, but never send an outdated prescription or cancellation.
        const isCurrent = await prisma.$transaction(async (tx) => {
          await lockWorkout(tx, userId, row.localWorkoutId)
          try {
            return (
              publicationPayloadHash(await current(tx, owner, row.localWorkoutId)) ===
              row.payloadHash
            )
          } catch (error) {
            if (error instanceof PublicationError && error.code === 'NOT_APPROVED') return false
            throw error
          }
        })
        if (!isCurrent)
          return checkpoint(
            {
              status: 'SUPERSEDED',
              errorCode: 'STALE_REVISION',
              ...((
                mapping ? remote && sameRemotePublication(remote, mapping.event) : remote === null
              )
                ? { lastConfirmedPayload: { ...payload } }
                : {}),
            },
            { status: 'SUPERSEDED', errorCode: 'STALE_REVISION' },
          )

        const needsWrite = mapping
          ? !remote || !sameRemotePublication(remote, mapping.event)
          : remote !== null
        if (needsWrite) {
          if (mapping?.requirements.runPaceConfiguration) {
            const prepared = await preflightIntervalsPace(owner, options)
            if (!Buffer.from(prepared.credentialNonce).equals(Buffer.from(snapshot.nonce)))
              throw new PublicationError('ACCOUNT_CHANGED')
          }
          const intent: PendingPublicationWrite = mapping
            ? { kind: 'UPSERT', token: randomUUID() }
            : remote
              ? { kind: 'CANCEL', remoteEventId: remote.id }
              : (() => {
                  throw new PublicationError('REMOTE_CONFLICT')
                })()
          pendingWrite = await prisma.$transaction(async (tx) => {
            await lockWorkout(tx, userId, row.localWorkoutId)
            await assertProviderApiKeySnapshotCurrent(tx, owner, 'INTERVALS', snapshot.nonce)
            if (
              publicationPayloadHash(await current(tx, owner, row.localWorkoutId)) !==
              row.payloadHash
            )
              throw new PublicationError('STALE_REVISION')
            const active = await tx.workoutPublication.updateMany({
              where: {
                userId,
                id: row.id,
                leaseToken: token,
                leaseExpiresAt: { gt: now() },
                pendingWrite: { equals: Prisma.DbNull },
              },
              data: { pendingWrite: { ...intent } },
            })
            if (active.count !== 1) throw new PublicationError('BUSY')
            return intent
          })
          // Remote calls occur only after commit, never within a DB transaction.
          mutationStarted = true
          if (pendingWrite?.kind === 'CANCEL') {
            await client.cancel(pendingWrite.remoteEventId)
          } else if (mapping && pendingWrite?.kind === 'UPSERT') {
            remote = await client.upsert({
              ...mapping.event,
              tags: [publicationWriteTag(pendingWrite.token)],
            })
            remoteEventId = remote.id
            await checkpoint({ remoteEventId })
            if (!remote.tags?.includes(publicationWriteTag(pendingWrite.token)))
              throw new PublicationError('RECOVERY_REQUIRED')
          } else {
            throw new PublicationError('RECOVERY_REQUIRED')
          }
          // An acknowledged call has finished, even if approval changed in flight.
          await checkpoint({ pendingWrite: Prisma.DbNull })
          pendingWrite = null
          remote = await client.find(row.externalId, payload.schedule.localDate, remoteEventId)
        }
        if (!mapping) {
          if (remote) throw new PublicationError('REMOTE_CONFLICT')
        } else {
          if (!remote || !sameRemotePublication(remote, mapping.event))
            throw new PublicationError('REMOTE_CONFLICT')
          try {
            assertIntervalsWorkoutExport(payload.workout, await client.exportFit(remote.id))
          } catch {
            throw new PublicationError('EXPORT_UNVERIFIED')
          }
        }
        const status = payload.cancelled ? 'CANCELLED' : 'PUBLISHED'
        return await checkpoint(
          {
            status,
            remoteEventId,
            publishedAt: now(),
            errorCode: null,
            lastConfirmedPayload: { ...payload },
          },
          { status, errorCode: null },
          async (tx) => {
            await lockWorkout(tx, userId, row.localWorkoutId)
            await assertProviderApiKeySnapshotCurrent(tx, owner, 'INTERVALS', snapshot.nonce)
            try {
              return (
                publicationPayloadHash(await current(tx, owner, row.localWorkoutId)) ===
                row.payloadHash
              )
            } catch (error) {
              if (error instanceof PublicationError && error.code === 'NOT_APPROVED') return false
              throw error
            }
          },
        )
      } catch (error) {
        if (
          mutationStarted &&
          pendingWrite &&
          error instanceof PublicationError &&
          error.writeRejected
        ) {
          // An explicit auth/rate-limit rejection is a completed request with no
          // calendar effect. Unlike a timeout, it is safe to retry manually.
          await checkpoint({ pendingWrite: Prisma.DbNull })
          pendingWrite = null
          mutationStarted = false
        }
        const code = error instanceof PublicationError ? error.code : 'PROVIDER_UNAVAILABLE'
        // An expired/interrupted runner is always uncertain, even before local code
        // observed an HTTP result. Keep the intent and remote ID for manual recovery.
        const status =
          mutationStarted ||
          row.pendingWrite !== null ||
          pendingWrite !== null ||
          row.attemptCount > 1 ||
          remoteEventId !== null
            ? 'UNCERTAIN'
            : 'FAILED'
        return checkpoint({ status, remoteEventId, errorCode: code }, { status, errorCode: code })
      }
    },
  }
}
