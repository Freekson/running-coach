'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext, OwnedResourceNotFoundError } from '@/server/authorization/ownership'
import { archiveGoal, deleteGoal, GoalInUseError, saveGoal } from '@/server/goals/goals'

export type GoalActionResult = { success: true } | { success: false; error: string }

async function mutate(
  operation: (owner: ReturnType<typeof getOwnerContext>) => Promise<unknown>,
): Promise<GoalActionResult> {
  try {
    const user = await getCurrentUser()
    if (!user) return { success: false, error: 'Sign in to manage your goals.' }
    await operation(getOwnerContext(user))
    revalidatePath('/app/goals', 'layout')
    return { success: true }
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return { success: false, error: 'This account is unavailable.' }
    if (error instanceof z.ZodError)
      return { success: false, error: 'Check the goal fields and try again.' }
    if (error instanceof OwnedResourceNotFoundError)
      return { success: false, error: 'Goal not found.' }
    if (error instanceof GoalInUseError) return { success: false, error: error.message }
    return { success: false, error: 'Your goal could not be updated. Please try again.' }
  }
}

export async function saveGoalAction(input: unknown, id?: string): Promise<GoalActionResult> {
  return mutate((owner) => saveGoal(owner, input, id))
}
export async function archiveGoalAction(id: string, archived: boolean): Promise<GoalActionResult> {
  return mutate((owner) => archiveGoal(owner, id, archived))
}
export async function deleteGoalAction(id: string): Promise<GoalActionResult> {
  return mutate((owner) => deleteGoal(owner, id))
}
