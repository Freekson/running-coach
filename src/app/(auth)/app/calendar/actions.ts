'use server'

import { z } from 'zod'
import type { RescheduleResult } from '@/lib/training-calendar'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext, OwnedResourceNotFoundError } from '@/server/authorization/ownership'
import { CalendarEditError, rescheduleCalendarWorkout } from '@/server/plans/calendar'
import { PlanConflictError } from '@/server/plans/transaction'

export async function rescheduleWorkoutAction(input: unknown): Promise<RescheduleResult> {
  try {
    const user = await getCurrentUser()
    if (!user) return { success: false, code: 'unauthorized', error: 'Sign in to move a session.' }
    await rescheduleCalendarWorkout(getOwnerContext(user), input)
    return { success: true }
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return { success: false, code: 'unauthorized', error: 'This account is unavailable.' }
    if (error instanceof z.ZodError)
      return { success: false, code: 'invalid', error: 'Choose a valid date and timezone.' }
    if (error instanceof OwnedResourceNotFoundError)
      return { success: false, code: 'missing', error: 'Session not found.' }
    if (error instanceof PlanConflictError)
      return {
        success: false,
        code: 'conflict',
        error: 'The plan changed. Reload the calendar before moving this session.',
      }
    if (error instanceof CalendarEditError)
      return { success: false, code: 'locked', error: error.message }
    return {
      success: false,
      code: 'unavailable',
      error: 'The session could not be moved. Please try again.',
    }
  }
}
