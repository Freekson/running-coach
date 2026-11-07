import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { getPrismaClient } from '@/server/db/client'

const tokenPattern = /^[a-f0-9]{64}$/
// The signup function is limited to 60 seconds. A later request may recover
// an abandoned claim only after twice that time has elapsed.
export const CLAIM_LEASE_MS = 120_000

export function hashInviteToken(token: string): string | null {
  return tokenPattern.test(token) ? createHash('sha256').update(token, 'utf8').digest('hex') : null
}

export type InvitationClaim = { tokenHash: string; claimedAt: Date; email: string; nonce: string }
export type InvitationStatus = 'valid' | 'invalid' | 'expired' | 'revoked' | 'used' | 'processing'

type Prisma = Awaited<ReturnType<typeof getPrismaClient>>

async function resolveCreatedUser(
  prisma: Prisma,
  user: { id: string; email: string; invitationClaimNonce: string | null },
): Promise<'usable' | 'removed' | 'uncertain'> {
  return prisma.$transaction(async (tx) => {
    // Lock the parent so a concurrent Better Auth account/session insert cannot
    // slip between the checks and the delete (both have a foreign key to it).
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "auth_users"
      WHERE "id" = ${user.id}
        AND "email" = ${user.email}
        AND "invitation_claim_nonce" = ${user.invitationClaimNonce}
      FOR UPDATE
    `
    if (locked.length !== 1) return 'uncertain'
    const credential = await tx.authAccount.findFirst({
      where: { userId: user.id, providerId: 'credential', password: { not: null } },
      select: { id: true },
    })
    if (credential) return 'usable'
    const [otherAccount, session, appUser] = await Promise.all([
      tx.authAccount.findFirst({ where: { userId: user.id }, select: { id: true } }),
      tx.authSession.findFirst({ where: { userId: user.id }, select: { id: true } }),
      tx.user.findFirst({ where: { authSubject: user.id }, select: { id: true } }),
    ])
    if (otherAccount || session || appUser) return 'uncertain'
    // Better Auth creates the user before linking the password account.
    await tx.authUser.delete({ where: { id: user.id } })
    return 'removed'
  })
}

async function reconcileStaleClaim(prisma: Prisma, tokenHash: string, now: Date): Promise<void> {
  const claim = await prisma.authInvitation.findUnique({
    where: { tokenHash },
    select: { claimedAt: true, claimedEmail: true, claimedNonce: true, consumedAt: true },
  })
  if (
    !claim?.claimedAt ||
    !claim.claimedEmail ||
    claim.consumedAt ||
    claim.claimedAt.getTime() > now.getTime() - CLAIM_LEASE_MS
  )
    return

  // A legacy claim without a nonce cannot be attributed to an auth user.
  if (!claim.claimedNonce) return
  const user = await prisma.authUser.findUnique({
    where: { invitationClaimNonce: claim.claimedNonce },
    select: { id: true, email: true, invitationClaimNonce: true },
  })
  if (user && user.email !== claim.claimedEmail) return
  const outcome = user ? await resolveCreatedUser(prisma, user) : 'removed'
  if (outcome === 'uncertain') return
  // Compare-and-set prevents a late response from changing a newer claim.
  await prisma.authInvitation.updateMany({
    where: {
      tokenHash,
      claimedAt: claim.claimedAt,
      claimedEmail: claim.claimedEmail,
      claimedNonce: claim.claimedNonce,
      consumedAt: null,
    },
    data: {
      claimedAt: null,
      claimedEmail: null,
      claimedNonce: null,
      ...(outcome === 'usable' && { consumedAt: now }),
    },
  })
}

// Admin revocation can reconcile an abandoned claim without possessing its raw token.
export async function reconcileStaleInvitationClaim(id: string): Promise<void> {
  const prisma = await getPrismaClient()
  const invitation = await prisma.authInvitation.findUnique({
    where: { id },
    select: { tokenHash: true },
  })
  if (invitation) await reconcileStaleClaim(prisma, invitation.tokenHash, new Date())
}

export async function invitationStatus(token: string): Promise<InvitationStatus> {
  const tokenHash = hashInviteToken(token)
  if (!tokenHash) return 'invalid'
  const prisma = await getPrismaClient()
  const now = new Date()
  await reconcileStaleClaim(prisma, tokenHash, now)
  const invitation = await prisma.authInvitation.findUnique({
    where: { tokenHash },
    select: { expiresAt: true, revokedAt: true, consumedAt: true, claimedAt: true },
  })
  if (!invitation) return 'invalid'
  if (invitation.revokedAt) return 'revoked'
  if (invitation.consumedAt) return 'used'
  if (invitation.expiresAt <= now) return 'expired'
  if (invitation.claimedAt) return 'processing'
  return 'valid'
}

// Atomic compare-and-set allows only one signup request across Vercel instances.
// Recovery runs on a later status/signup request; no background worker is needed.
export async function consumeInvitation(
  token: string,
  email: string,
): Promise<InvitationClaim | null> {
  const tokenHash = hashInviteToken(token)
  if (!tokenHash) return null
  const validTokenHash = tokenHash
  const prisma = await getPrismaClient()
  const claimedAt = new Date()
  const normalizedEmail = email.toLowerCase()
  const nonce = randomUUID()
  async function claim() {
    return prisma.authInvitation.updateMany({
      where: {
        tokenHash: validTokenHash,
        claimedAt: null,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: claimedAt },
      },
      data: { claimedAt, claimedEmail: normalizedEmail, claimedNonce: nonce },
    })
  }
  let result = await claim()
  if (result.count === 0) {
    await reconcileStaleClaim(prisma, tokenHash, claimedAt)
    result = await claim()
  }
  return result.count === 1 ? { tokenHash, claimedAt, email: normalizedEmail, nonce } : null
}

export async function completeInvitation(claim: InvitationClaim): Promise<boolean> {
  const prisma = await getPrismaClient()
  const result = await prisma.authInvitation.updateMany({
    where: {
      tokenHash: claim.tokenHash,
      claimedAt: claim.claimedAt,
      claimedEmail: claim.email,
      claimedNonce: claim.nonce,
      consumedAt: null,
    },
    data: { consumedAt: new Date(), claimedAt: null, claimedEmail: null, claimedNonce: null },
  })
  return result.count === 1
}

// Better Auth rejects duplicate emails before creating a user.
export async function releaseInvitation(claim: InvitationClaim): Promise<void> {
  const prisma = await getPrismaClient()
  await prisma.authInvitation.updateMany({
    where: {
      tokenHash: claim.tokenHash,
      claimedAt: claim.claimedAt,
      claimedEmail: claim.email,
      claimedNonce: claim.nonce,
    },
    data: { claimedAt: null, claimedEmail: null, claimedNonce: null },
  })
}

// A failed handler may have created the user before it returned an error.
// If verification fails, leave the claim for later reconciliation.
export async function recoverInvitationAfterFailedSignup(claim: InvitationClaim): Promise<boolean> {
  try {
    const prisma = await getPrismaClient()
    const user = await prisma.authUser.findUnique({
      where: { invitationClaimNonce: claim.nonce },
      select: { id: true, email: true, invitationClaimNonce: true },
    })
    if (user && user.email !== claim.email) return false
    if (user) {
      const outcome = await resolveCreatedUser(prisma, user)
      if (outcome === 'usable') {
        await completeInvitation(claim)
        return false
      }
      if (outcome === 'uncertain') return false
    }
    const result = await prisma.authInvitation.updateMany({
      where: {
        tokenHash: claim.tokenHash,
        claimedAt: claim.claimedAt,
        claimedEmail: claim.email,
        claimedNonce: claim.nonce,
      },
      data: { claimedAt: null, claimedEmail: null, claimedNonce: null },
    })
    return result.count === 1
  } catch {
    return false
  }
}
