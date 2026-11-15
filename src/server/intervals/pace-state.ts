import 'server-only'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { IntervalsPaceStatus } from '@/lib/intervals-pace-status'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { assertProviderApiKeySnapshotCurrent } from '@/server/provider/vault'
import { IntervalsPaceError } from './pace-policy'
import { INTERVALS_PACE_REFERENCE_PREFIX, type PaceReference } from './pace-reference'

export const INTERVALS_PACE_CHECKPOINT = 'INTERVALS_PACE_PREFLIGHT_V1'
const leaseMs = 90_000

export const paceCheckpointSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(['CHECKING', 'READY', 'FAILED']),
  source: z.enum(['existing-user-configuration', 'technical-delivery-reference']).nullable(),
  referenceVersion: z.number().int().positive().nullable(),
  technicalReferenceMps: z.number().positive().nullable(),
  provisionedFields: z.array(z.enum(['threshold_pace', 'pace_zones', 'pace_zone_names'])),
  verifiedAt: z.iso.datetime().nullable(),
  readback: z.enum(['NOT_RUN', 'VERIFIED', 'FAILED']),
  failureCode: z.string().nullable(),
})
export type PaceCheckpoint = z.infer<typeof paceCheckpointSchema>
export type PaceLease = { connectionId: string; token: string; checkpoint: PaceCheckpoint }

export function paceStatus(checkpoint: PaceCheckpoint): IntervalsPaceStatus {
  return { status: checkpoint.status, source: checkpoint.source, verifiedAt: checkpoint.verifiedAt }
}

export async function claimIntervalsPaceLease(
  owner: OwnerContext,
  nonce: Uint8Array,
  now: Date,
): Promise<PaceLease> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  return prisma.$transaction(async (tx) => {
    await assertProviderApiKeySnapshotCurrent(tx, owner, 'INTERVALS', nonce)
    const connection = await tx.integrationConnection.findUniqueOrThrow({
      where: { userId_provider: { userId, provider: 'INTERVALS' } },
      select: { id: true },
    })
    const initial: PaceCheckpoint = {
      version: 1,
      status: 'CHECKING',
      source: null,
      referenceVersion: null,
      technicalReferenceMps: null,
      provisionedFields: [],
      verifiedAt: null,
      readback: 'NOT_RUN',
      failureCode: null,
    }
    const cursor = await tx.syncCursor.upsert({
      where: {
        connectionId_dataType: { connectionId: connection.id, dataType: INTERVALS_PACE_CHECKPOINT },
      },
      create: {
        userId,
        connectionId: connection.id,
        dataType: INTERVALS_PACE_CHECKPOINT,
        cursorOrCheckpoint: { ...initial },
      },
      update: {},
    })
    if (cursor.userId !== userId || (cursor.leaseExpiresAt && cursor.leaseExpiresAt > now))
      throw new IntervalsPaceError('BUSY')
    const parsed = paceCheckpointSchema.safeParse(cursor.cursorOrCheckpoint)
    if (!parsed.success) throw new IntervalsPaceError('CONFIGURATION_CONFLICT')
    const checkpoint: PaceCheckpoint = {
      ...parsed.data,
      status: 'CHECKING',
      readback: 'NOT_RUN',
      failureCode: null,
    }
    const token = randomUUID()
    await tx.syncCursor.update({
      where: { id: cursor.id },
      data: {
        leaseToken: token,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        cursorOrCheckpoint: { ...checkpoint },
      },
    })
    return { connectionId: connection.id, token, checkpoint }
  })
}

export async function saveIntervalsPaceLease(
  owner: OwnerContext,
  nonce: Uint8Array,
  lease: PaceLease,
  checkpoint: PaceCheckpoint,
  now: Date,
  release = false,
  reference?: PaceReference,
): Promise<void> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  await prisma.$transaction(async (tx) => {
    await assertProviderApiKeySnapshotCurrent(tx, owner, 'INTERVALS', nonce)
    const saved = await tx.syncCursor.updateMany({
      where: {
        userId,
        connectionId: lease.connectionId,
        dataType: INTERVALS_PACE_CHECKPOINT,
        leaseToken: lease.token,
        leaseExpiresAt: { gt: now },
      },
      data: {
        cursorOrCheckpoint: { ...checkpoint },
        ...(checkpoint.status === 'READY' ? { lastSyncedAt: now, consecutiveFailures: 0 } : {}),
        ...(release ? { leaseToken: null, leaseExpiresAt: null } : {}),
      },
    })
    if (saved.count !== 1) throw new IntervalsPaceError('CONNECTION_CHANGED')
    if (reference) {
      const dataType = `${INTERVALS_PACE_REFERENCE_PREFIX}${reference.settingsId}`
      await tx.syncCursor.upsert({
        where: { connectionId_dataType: { connectionId: lease.connectionId, dataType } },
        create: {
          userId,
          connectionId: lease.connectionId,
          dataType,
          cursorOrCheckpoint: { ...reference },
        },
        update: { cursorOrCheckpoint: { ...reference } },
      })
    }
  })
}

/** Local metadata only; visiting settings never calls the provider or configures it. */
export async function getIntervalsPaceStatus(owner: OwnerContext): Promise<IntervalsPaceStatus> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const row = await prisma.syncCursor.findFirst({
    where: {
      userId,
      dataType: INTERVALS_PACE_CHECKPOINT,
      connection: { userId, provider: 'INTERVALS', status: 'CONNECTED' },
    },
    select: { cursorOrCheckpoint: true, leaseExpiresAt: true },
  })
  const checkpoint = paceCheckpointSchema.safeParse(row?.cursorOrCheckpoint)
  if (!checkpoint.success) return { status: 'NOT_CHECKED', source: null, verifiedAt: null }
  const result = paceStatus(checkpoint.data)
  if (result.status === 'CHECKING' && (!row?.leaseExpiresAt || row.leaseExpiresAt <= new Date()))
    result.status = 'FAILED'
  return result
}
