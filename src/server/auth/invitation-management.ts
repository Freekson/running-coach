import 'server-only'

import { createHash, randomBytes } from 'node:crypto'
import { getPrismaClient } from '@/server/db/client'

const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

export type InvitationStatus = 'pending' | 'used' | 'expired' | 'revoked'

export function invitationStatus(
  invitation: {
    consumedAt: Date | null
    revokedAt: Date | null
    expiresAt: Date
  },
  now = new Date(),
): InvitationStatus {
  if (invitation.consumedAt) return 'used'
  if (invitation.revokedAt) return 'revoked'
  return invitation.expiresAt <= now ? 'expired' : 'pending'
}

export async function createInvitation(label: string | null) {
  const baseURL = process.env.BETTER_AUTH_URL
  if (!baseURL) throw new Error('BETTER_AUTH_URL is required')
  const origin = new URL(baseURL)
  if (
    !['https:', 'http:'].includes(origin.protocol) ||
    (origin.protocol === 'http:' && origin.hostname !== 'localhost')
  )
    throw new Error('A secure BETTER_AUTH_URL is required')

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
  const invitations = await prisma.authInvitation.findMany({
    select: {
      id: true,
      label: true,
      createdAt: true,
      expiresAt: true,
      consumedAt: true,
      revokedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })
  const now = new Date()
  return invitations.map(({ consumedAt, revokedAt, ...invitation }) => ({
    ...invitation,
    status: invitationStatus({ consumedAt, revokedAt, expiresAt: invitation.expiresAt }, now),
  }))
}

export async function revokeInvitation(id: string): Promise<boolean> {
  const prisma = await getPrismaClient()
  const now = new Date()
  const result = await prisma.authInvitation.updateMany({
    where: { id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
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
