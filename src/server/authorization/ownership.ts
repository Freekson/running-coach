import 'server-only'

import { getPrismaClient } from '@/server/db/client'
import { isVerifiedCurrentUser, type CurrentUser } from '@/server/auth/current-user'

const issuedContexts = new WeakSet<object>()

export type OwnerContext = Readonly<{ userId: string }>

export function getOwnerContext(user: CurrentUser): OwnerContext {
  if (!isVerifiedCurrentUser(user)) throw new InvalidOwnerContextError()
  const owner = Object.freeze({ userId: user.id })
  issuedContexts.add(owner)
  return owner
}

export class InvalidOwnerContextError extends Error {
  constructor() {
    super('Verified owner context required')
  }
}

export function ownerId(owner: OwnerContext): string {
  if (!issuedContexts.has(owner)) throw new InvalidOwnerContextError()
  return owner.userId
}

export function ownedWhere<T extends object>(owner: OwnerContext, filters: T & { userId?: never }) {
  return { ...filters, userId: ownerId(owner) }
}

export function ownedIdWhere(owner: OwnerContext, id: string) {
  return ownedWhere(owner, { id })
}

export class OwnedResourceNotFoundError extends Error {
  constructor() {
    super('Resource not found')
  }
}

// Check a parent before creating a child that points at it. A missing parent and
// another owner's parent are deliberately indistinguishable to callers.
export async function requireOwnedConnection(owner: OwnerContext, connectionId: string) {
  const where = ownedIdWhere(owner, connectionId)
  const prisma = await getPrismaClient()
  const connection = await prisma.integrationConnection.findFirst({
    where,
    select: { id: true },
  })
  if (!connection) throw new OwnedResourceNotFoundError()
  return connection
}
