import 'server-only'

import { Prisma } from '@prisma/client'

export type GoalTransactionRunner<T> = (
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { isolationLevel: Prisma.TransactionIsolationLevel },
) => Promise<T>

/** Retrying an aborted transaction is safe: neither the goal nor its receipt committed. */
export async function goalTransaction<T>(
  prisma: { $transaction: GoalTransactionRunner<NoInfer<T>> },
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2034' ||
        attempt === 4
      )
        throw error
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt))
    }
  }
  throw new Error('Goal transaction retry exhausted')
}
