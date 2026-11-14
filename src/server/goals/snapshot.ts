import 'server-only'

import type { Prisma } from '@prisma/client'
import type { GoalMutationReceipt } from '@/lib/goal-snapshot'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'

export async function readGoalSnapshotMetadata(tx: Prisma.TransactionClient) {
  const [metadata] = await tx.$queryRaw<{ snapshot: string; observedAt: string }[]>`
    SELECT pg_current_snapshot()::text AS snapshot,
      ((extract(epoch FROM clock_timestamp()) * 1000000)::bigint)::text AS "observedAt"
  `
  if (!metadata) throw new Error('Goal snapshot unavailable')
  return metadata
}

export async function readGoalMutationReceipt(
  owner: OwnerContext,
  tx: Prisma.TransactionClient,
): Promise<GoalMutationReceipt> {
  const userId = ownerId(owner)
  const [receipt] = await tx.$queryRaw<{ transactionId: string; snapshot: string }[]>`
    SELECT pg_current_xact_id()::text AS "transactionId", pg_current_snapshot()::text AS snapshot
  `
  if (!receipt) throw new Error('Goal mutation receipt unavailable')
  return { ownerId: userId, ...receipt }
}
