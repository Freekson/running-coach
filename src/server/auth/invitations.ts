import 'server-only'

import { createHash } from 'node:crypto'
import { getPrismaClient } from '@/server/db/client'

const tokenPattern = /^[a-f0-9]{64}$/

export function hashInviteToken(token: string): string | null {
  return tokenPattern.test(token) ? createHash('sha256').update(token, 'utf8').digest('hex') : null
}

export type InvitationClaim = { tokenHash: string; claimedAt: Date }

// Atomic compare-and-set: only one request can use a token at a time across
// Vercel instances. A successful signup retains consumedAt permanently.
export async function consumeInvitation(token: string): Promise<InvitationClaim | null> {
  const tokenHash = hashInviteToken(token)
  if (!tokenHash) return null
  const prisma = await getPrismaClient()
  const claimedAt = new Date()
  const result = await prisma.authInvitation.updateMany({
    where: {
      tokenHash,
      consumedAt: null,
      revokedAt: null,
      expiresAt: { gt: claimedAt },
    },
    data: { consumedAt: claimedAt },
  })
  return result.count === 1 ? { tokenHash, claimedAt } : null
}

// Better Auth rolls back failed 4xx signup attempts. Release only that exact
// claim; unknown server failures remain fail-closed for manual reissuance.
export async function releaseInvitation(claim: InvitationClaim): Promise<void> {
  const prisma = await getPrismaClient()
  await prisma.authInvitation.updateMany({
    where: { tokenHash: claim.tokenHash, consumedAt: claim.claimedAt },
    data: { consumedAt: null },
  })
}
