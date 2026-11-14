import type { GoalWithProgress } from './goal-progress'

export type GoalSnapshot = {
  ownerId: string
  snapshot: string
  observedAt: string
  goals: GoalWithProgress[]
}

export type GoalMutationReceipt = {
  ownerId: string
  transactionId: string
  snapshot: string
}

export type GoalMutation<T> = { value: T; receipt: GoalMutationReceipt }
