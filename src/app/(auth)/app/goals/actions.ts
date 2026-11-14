'use server'

import { z } from 'zod'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext, OwnedResourceNotFoundError } from '@/server/authorization/ownership'
import {
  archiveGoalWithReceipt,
  deleteGoalWithReceipt,
  GoalInUseError,
  GoalReadOnlyError,
  saveGoalWithReceipt,
} from '@/server/goals/goals'
import type { GoalMutation } from '@/lib/goal-snapshot'

export type GoalActionResult<T> =
  ({ success: true } & GoalMutation<T>) | { success: false; error: string }

async function mutate<T>(
  operation: (owner: ReturnType<typeof getOwnerContext>) => Promise<GoalMutation<T>>,
): Promise<GoalActionResult<T>> {
  try {
    const user = await getCurrentUser()
    if (!user) return { success: false, error: 'Sign in to manage your goals.' }
    const result = await operation(getOwnerContext(user))
    return { success: true, ...result }
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return { success: false, error: 'This account is unavailable.' }
    if (error instanceof z.ZodError)
      return { success: false, error: 'Check the goal fields and try again.' }
    if (error instanceof OwnedResourceNotFoundError)
      return { success: false, error: 'Goal not found.' }
    if (error instanceof GoalInUseError) return { success: false, error: error.message }
    if (error instanceof GoalReadOnlyError) return { success: false, error: error.message }
    return { success: false, error: 'Your goal could not be updated. Please try again.' }
  }
}

export async function saveGoalAction(input: unknown, id?: string) {
  return mutate((owner) => saveGoalWithReceipt(owner, input, id))
}
export async function archiveGoalAction(id: string, archived: boolean) {
  return mutate((owner) => archiveGoalWithReceipt(owner, id, archived))
}
export async function deleteGoalAction(id: string) {
  return mutate((owner) => deleteGoalWithReceipt(owner, id))
}
