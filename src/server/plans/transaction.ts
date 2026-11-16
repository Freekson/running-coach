import 'server-only'

import { Prisma } from '@prisma/client'
import { getPrismaClient } from '@/server/db/client'
import {
  ownedIdWhere,
  type OwnerContext,
  OwnedResourceNotFoundError,
} from '@/server/authorization/ownership'

export class PlanConflictError extends Error {
  constructor(message = 'Plan or draft changed; reload before continuing') {
    super(message)
  }
}

export class RefreshGoalConflictError extends PlanConflictError {
  constructor() {
    super(
      'The goal date changed since this plan was approved. Create a new training plan for the updated goal; your approved revisions are preserved.',
    )
  }
}

export class RefreshWindowError extends Error {
  constructor(startDate: string, endDate: string) {
    super(
      `Choose a future 14–28 day window within the approved macro period (${startDate} to ${endDate}), or create a new training plan to use different dates. No new request was issued; your previous request and approved revisions are preserved.`,
    )
  }
}

export class PlanStateError extends Error {
  constructor() {
    super('This operation is not allowed in the current draft state')
  }
}

export async function planTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
  const prisma = await getPrismaClient()
  // Only aborted DB work is retried. Every retry rechecks the caller's versions;
  // a committed concurrent edit still produces a conflict, never an overwrite.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034')
        throw error
      if (attempt === 2) throw new PlanConflictError()
    }
  }
  throw new PlanConflictError()
}

export async function requireDraft(tx: Prisma.TransactionClient, owner: OwnerContext, id: string) {
  const draft = await tx.planDraft.findFirst({ where: ownedIdWhere(owner, id) })
  if (!draft) throw new OwnedResourceNotFoundError()
  return draft
}

export function requireDraftVersion(draft: { version: number; state: string }, expected: number) {
  if (draft.version !== expected) throw new PlanConflictError()
  if (draft.state === 'APPROVED') throw new PlanStateError()
}
