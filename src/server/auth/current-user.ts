import 'server-only'

import { headers } from 'next/headers'
import type { UserRole } from '@prisma/client'
import { getPrismaClient } from '@/server/db/client'
import { getAuth } from './better-auth'

export class AccountUnavailableError extends Error {
  constructor() {
    super('Account is unavailable')
  }
}

export type CurrentUser = { id: string; role: UserRole }

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const auth = await getAuth()
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session || !session.user) return null

  const prisma = await getPrismaClient()
  const userId = session.user.id
  const existingUser = await prisma.user.findUnique({
    where: { authSubject: userId },
    select: { id: true, role: true, status: true },
  })
  if (existingUser) {
    if (existingUser.status !== 'ACTIVE') throw new AccountUnavailableError()
    return { id: existingUser.id, role: existingUser.role }
  }

  // Do not attach a Clerk-era athlete record by email. The operator must
  // verify identity and explicitly remap its auth_subject first.
  if (
    await prisma.user.findFirst({
      where: { email: { equals: session.user.email, mode: 'insensitive' } },
    })
  )
    throw new AccountUnavailableError()

  const user = await prisma.user.upsert({
    where: { authSubject: userId },
    create: { authSubject: userId, email: session.user.email, role: 'USER' },
    update: {},
    select: { id: true, role: true, status: true },
  })

  if (user.status !== 'ACTIVE') throw new AccountUnavailableError()
  return { id: user.id, role: user.role }
}
