import 'server-only'

import { createHash, randomBytes } from 'node:crypto'
import { getPrismaClient } from '@/server/db/client'
import { getCanonicalAppOrigin } from './public-origin'
import { reconcileStaleInvitationClaim } from './invitations'

const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

export type InvitationStatus = 'pending' | 'processing' | 'used' | 'expired' | 'revoked'

export function invitationStatus(
  invitation: {
    consumedAt: Date | null
    revokedAt: Date | null
    claimedAt: Date | null
    expiresAt: Date
  },
  now = new Date(),
): InvitationStatus {
  if (invitation.consumedAt) return 'used'
  if (invitation.revokedAt) return 'revoked'
  if (invitation.expiresAt <= now) return 'expired'
  return invitation.claimedAt ? 'processing' : 'pending'
}

export async function createInvitation(label: string | null) {
  const origin = getCanonicalAppOrigin(process.env)

  const token = randomBytes(32).toString('hex')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS)
  const prisma = await getPrismaClient()
  const invitation = await prisma.authInvitation.create({
    data: { tokenHash, label, expiresAt },
    select: { id: true, createdAt: true, expiresAt: true, label: true },
  })
  const link = new URL('/sign-up', origin)
  link.hash = `token=${token}`
  return { ...invitation, url: link.toString() }
}

export async function listInvitations() {
  const prisma = await getPrismaClient()
  const query = {
    select: {
      id: true,
      label: true,
      createdAt: true,
      expiresAt: true,
      consumedAt: true,
      revokedAt: true,
      claimedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  } as const
  const invitations = await prisma.authInvitation.findMany(query)
  const now = new Date()
  return invitations.map(({ consumedAt, revokedAt, claimedAt, ...invitation }) => ({
    ...invitation,
    status: invitationStatus(
      { consumedAt, revokedAt, claimedAt, expiresAt: invitation.expiresAt },
      now,
    ),
  }))
}

export async function checkInvitationStatus(id: string): Promise<InvitationStatus | null> {
  await reconcileStaleInvitationClaim(id)
  const prisma = await getPrismaClient()
  const invitation = await prisma.authInvitation.findUnique({
    where: { id },
    select: { consumedAt: true, revokedAt: true, claimedAt: true, expiresAt: true },
  })
  return invitation ? invitationStatus(invitation) : null
}

export async function revokeInvitation(id: string): Promise<boolean> {
  const prisma = await getPrismaClient()
  await reconcileStaleInvitationClaim(id)
  const now = new Date()
  const result = await prisma.authInvitation.updateMany({
    where: { id, claimedAt: null, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now },
  })
  return result.count === 1
}

export async function listRegisteredUsers() {
  const prisma = await getPrismaClient()
  const registered = await prisma.authUser.findMany({
    select: { id: true, email: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
  const localUsers = await prisma.user.findMany({
    where: { authSubject: { in: registered.map((user) => user.id) } },
    select: { authSubject: true, role: true, status: true },
  })
  const bySubject = new Map(localUsers.map((user) => [user.authSubject, user]))
  return registered.map((user) => ({
    ...user,
    role: bySubject.get(user.id)?.role ?? ('USER' as const),
    status: bySubject.get(user.id)?.status ?? null,
  }))
}
