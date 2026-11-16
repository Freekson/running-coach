'use server'

import { z } from 'zod'
import type { MatchingResult } from '@/lib/activity-matching'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext, OwnedResourceNotFoundError } from '@/server/authorization/ownership'
import { ActivityMatchError, linkActivity, unlinkActivity } from '@/server/activity/matching'
import { PlanConflictError } from '@/server/plans/transaction'

async function mutate(
  operation: typeof linkActivity | typeof unlinkActivity,
  input: unknown,
): Promise<MatchingResult> {
  try {
    const user = await getCurrentUser()
    if (!user) return { success: false, error: 'Sign in to match an activity.' }
    await operation(getOwnerContext(user), input)
    return { success: true, data: undefined }
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return { success: false, error: 'This account is unavailable.' }
    if (error instanceof OwnedResourceNotFoundError)
      return { success: false, error: 'Activity or session not found.' }
    if (error instanceof z.ZodError)
      return { success: false, error: 'Choose a valid session and reload before trying again.' }
    if (error instanceof PlanConflictError || error instanceof ActivityMatchError)
      return { success: false, error: error.message }
    return { success: false, error: 'The activity link could not be saved. Reload and try again.' }
  }
}

export async function linkActivityAction(input: unknown) {
  return mutate(linkActivity, input)
}
export async function unlinkActivityAction(input: unknown) {
  return mutate(unlinkActivity, input)
}
