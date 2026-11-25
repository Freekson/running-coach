import 'server-only'

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AccountUnavailableError } from '@/server/auth/current-user'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'

export const accountDeletionSchema = z.strictObject({
  confirmation: z.literal('DELETE'),
  providerAccessRevoked: z.literal(true),
})

export class AccountBusyError extends Error {}

/** One atomic cascade, including append-only revisions via their account-delete exception. */
export async function deleteAccount(owner: OwnerContext, input: unknown): Promise<void> {
  const userId = ownerId(owner)
  accountDeletionSchema.parse(input)
  const prisma = await getPrismaClient()
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } })
    if (!user || user.status !== 'ACTIVE') throw new AccountUnavailableError()

    // Same lock order as lazy identity provisioning. A session read before deletion
    // cannot recreate the application identity after the auth identity is removed.
    await tx.$queryRaw`SELECT id FROM auth_users WHERE id = ${user.authSubject} FOR UPDATE`
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${userId}::uuid AND status = 'ACTIVE' FOR UPDATE
    `
    if (locked.length !== 1) throw new AccountUnavailableError()
    await tx.$queryRaw`
      SELECT id FROM integration_connections WHERE user_id = ${userId}::uuid ORDER BY id FOR UPDATE
    `
    const now = new Date()
    const activeLease = { userId, leaseExpiresAt: { gt: now } }
    if (
      (await tx.syncCursor.count({ where: activeLease })) > 0 ||
      (await tx.workoutPublication.count({ where: activeLease })) > 0
    )
      throw new AccountBusyError('Wait for current sync or publication to finish')

    await tx.user.update({ where: { id: userId }, data: { status: 'DELETING' } })
    await tx.accountDeletionReceipt.create({
      data: {
        userId,
        authSubjectHash: createHash('sha256').update(user.authSubject).digest('hex'),
        deletedAt: now,
        expiresAt: new Date(now.getTime() + 90 * 86_400_000),
      },
    })
    // Invitation claims and verification identifiers are not FK children.
    const authUser = await tx.authUser.findUnique({
      where: { id: user.authSubject },
      select: { email: true, invitationClaimNonce: true },
    })
    if (authUser) {
      await tx.authVerification.deleteMany({ where: { identifier: authUser.email } })
      if (authUser.invitationClaimNonce)
        await tx.authInvitation.deleteMany({
          where: { claimedNonce: authUser.invitationClaimNonce },
        })
    }
    await tx.user.delete({ where: { id: userId } })
    await tx.authUser.deleteMany({ where: { id: user.authSubject } })
  })
}
