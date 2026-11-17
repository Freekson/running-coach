'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser, AccountUnavailableError } from '@/server/auth/current-user'
import { getOwnerContext, OwnedResourceNotFoundError } from '@/server/authorization/ownership'
import { respondToPlanReminder } from '@/server/plans/reminders'
import { PlanConflictError } from '@/server/plans/transaction'
import type { PlanReminderResult } from '@/lib/plan-reminders'

export async function respondToPlanReminderAction(input: unknown): Promise<PlanReminderResult> {
  try {
    const user = await getCurrentUser()
    if (!user) return { success: false, error: 'Sign in to manage plan reminders.' }
    await respondToPlanReminder(getOwnerContext(user), input)
    revalidatePath('/app', 'layout')
    return { success: true }
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return { success: false, error: 'This account is unavailable.' }
    if (error instanceof PlanConflictError || error instanceof OwnedResourceNotFoundError)
      return { success: false, error: 'This reminder changed. Reload to see your current plans.' }
    return { success: false, error: 'The reminder could not be saved. Please try again.' }
  }
}
