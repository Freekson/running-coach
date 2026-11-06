import 'server-only'

import { createHash, randomBytes } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { getPrismaClient } from '@/server/db/client'
import { getCanonicalAppOrigin } from './public-origin'
import { reconcileStaleInvitationClaim } from './invitations'

const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
export const ADMIN_PAGE_SIZE = 5
export type InvitationFilter = 'all' | InvitationStatus
const invitationRevision = (tokenHash: string) =>
  createHash('sha256').update(tokenHash).digest('hex')

function invitationWhere(status: InvitationFilter, now: Date): Prisma.AuthInvitationWhereInput {
  switch (status) {
    case 'all':
      return {}
    case 'used':
      return { consumedAt: { not: null } }
    case 'revoked':
      return { consumedAt: null, revokedAt: { not: null } }
    case 'expired':
      return { consumedAt: null, revokedAt: null, expiresAt: { lte: now } }
    case 'processing':
      return { consumedAt: null, revokedAt: null, expiresAt: { gt: now }, claimedAt: { not: null } }
    case 'pending':
      return { consumedAt: null, revokedAt: null, expiresAt: { gt: now }, claimedAt: null }
  }
}

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

export async function listInvitations(page = 1, filter: InvitationFilter = 'all') {
  const prisma = await getPrismaClient()
  const now = new Date()
  const statuses: InvitationFilter[] = [
    'all',
    'pending',
    'processing',
    'used',
    'revoked',
    'expired',
  ]
  const counts = Object.fromEntries(
    await Promise.all(
      statuses.map(
        async (status) =>
          [
            status,
            await prisma.authInvitation.count({ where: invitationWhere(status, now) }),
          ] as const,
      ),
    ),
  ) as Record<InvitationFilter, number>
  const currentPage = Math.min(
    Math.max(1, page),
    Math.max(1, Math.ceil(counts[filter] / ADMIN_PAGE_SIZE)),
  )
  const invitations = await prisma.authInvitation.findMany({
    where: invitationWhere(filter, now),
    select: {
      id: true,
      tokenHash: true,
      label: true,
      createdAt: true,
      expiresAt: true,
      consumedAt: true,
      revokedAt: true,
      claimedAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (currentPage - 1) * ADMIN_PAGE_SIZE,
    take: ADMIN_PAGE_SIZE,
  })
  const items = invitations.map(
    ({ consumedAt, revokedAt, claimedAt, tokenHash, ...invitation }) => ({
      ...invitation,
      revision: invitationRevision(tokenHash),
      status: invitationStatus(
        { consumedAt, revokedAt, claimedAt, expiresAt: invitation.expiresAt },
        now,
      ),
    }),
  )
  return { invitations: items, page: currentPage, total: counts[filter], counts }
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

export async function regenerateInvitation(
  id: string,
  expectedRevision: string,
): Promise<{ id: string; url: string; expiresAt: Date } | null> {
  const origin = getCanonicalAppOrigin(process.env)
  const prisma = await getPrismaClient()
  const token = randomBytes(32).toString('hex')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const now = new Date()
  // One conditional SQL update serializes regeneration with claim, redeem and revoke.
  // A stale concurrent regeneration cannot overwrite the winner's hash.
  const candidates = await prisma.authInvitation.findMany({
    where: { id, claimedAt: null, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
    select: { tokenHash: true, expiresAt: true },
  })
  if (candidates.length !== 1 || invitationRevision(candidates[0].tokenHash) !== expectedRevision)
    return null
  const updated = await prisma.authInvitation.updateMany({
    where: {
      id,
      tokenHash: candidates[0].tokenHash,
      claimedAt: null,
      consumedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { tokenHash },
  })
  if (updated.count !== 1) return null
  const link = new URL('/sign-up', origin)
  link.hash = `token=${token}`
  return { id, url: link.toString(), expiresAt: candidates[0].expiresAt }
}

export async function listRegisteredUsers(page = 1) {
  const prisma = await getPrismaClient()
  const total = await prisma.authUser.count()
  const currentPage = Math.min(Math.max(1, page), Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE)))
  const registered = await prisma.authUser.findMany({
    select: { id: true, email: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (currentPage - 1) * ADMIN_PAGE_SIZE,
    take: ADMIN_PAGE_SIZE,
  })
  const localUsers = await prisma.user.findMany({
    where: { authSubject: { in: registered.map((user) => user.id) } },
    select: { authSubject: true, role: true, status: true },
  })
  const bySubject = new Map(localUsers.map((user) => [user.authSubject, user]))
  return {
    users: registered.map((user) => ({
      ...user,
      role: bySubject.get(user.id)?.role ?? ('USER' as const),
      status: bySubject.get(user.id)?.status ?? null,
    })),
    page: currentPage,
    total,
  }
}
