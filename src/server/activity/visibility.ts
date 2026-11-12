import 'server-only'
import type { Prisma } from '@prisma/client'
import { getPrismaClient } from '@/server/db/client'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'

/** Saved records remain visible after disconnect; unverified or replaced accounts do not. */
export async function activityReadScope(owner: OwnerContext): Promise<Prisma.ActivityWhereInput> {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  const garmin = await prisma.integrationConnection.findUnique({
    where: { userId_provider: { userId, provider: 'GARMIN' } },
    select: { externalAccountId: true },
  })
  return {
    userId,
    OR: [
      { sourceProvider: { not: 'GARMIN' } },
      ...(garmin?.externalAccountId
        ? [{ sourceProvider: 'GARMIN' as const, garminAccountId: garmin.externalAccountId }]
        : []),
    ],
  }
}
