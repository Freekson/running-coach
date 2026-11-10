import 'server-only'

import { randomUUID } from 'node:crypto'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'

const LEASE_MS = 100_000

/** One provider lease per owner/connection across activity and health jobs. */
export async function claimGarminProviderLease(
  owner: OwnerContext,
  connectionId: string,
  at: Date,
): Promise<string | null> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const key = { connectionId, dataType: 'GARMIN_REQUESTS' }
  await prisma.syncCursor.upsert({
    where: { connectionId_dataType: key },
    create: { userId, ...key, cursorOrCheckpoint: { version: 1 } },
    update: {},
  })
  const token = randomUUID()
  const claimed = await prisma.syncCursor.updateMany({
    where: {
      userId,
      ...key,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: at } }],
    },
    data: { leaseToken: token, leaseExpiresAt: new Date(at.getTime() + LEASE_MS) },
  })
  return claimed.count === 1 ? token : null
}

export async function releaseGarminProviderLease(
  owner: OwnerContext,
  connectionId: string,
  token: string,
): Promise<void> {
  const prisma = await getPrismaClient()
  await prisma.syncCursor.updateMany({
    where: { userId: ownerId(owner), connectionId, dataType: 'GARMIN_REQUESTS', leaseToken: token },
    data: { leaseToken: null, leaseExpiresAt: null },
  })
}
