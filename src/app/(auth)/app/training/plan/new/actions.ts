'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import {
  getOwnerContext,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'
import { approvePlanImport } from '@/server/plans/exchange/approve'
import { openPlanExport } from '@/server/plans/exchange/export'
import {
  PlanConflictError,
  PlanStateError,
  RefreshGoalConflictError,
} from '@/server/plans/transaction'
import { openRefreshSchema } from '@/lib/plan-refresh'
import { previewRevisionPublication, sendRevisionPublication } from '@/server/plans/publication'
import { PublicationError } from '@/server/intervals/publication-contract'
import { IntervalsWorkoutMappingError } from '@/server/intervals/workout-mapping'

async function run<T>(operation: (owner: OwnerContext) => Promise<T>) {
  try {
    const user = await getCurrentUser()
    if (!user) return { success: false as const, error: 'Sign in to create a plan.' }
    return { success: true as const, value: await operation(getOwnerContext(user)) }
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return { success: false as const, error: 'This account is unavailable.' }
    if (error instanceof OwnedResourceNotFoundError)
      return { success: false as const, error: 'Goal or draft not found.' }
    if (error instanceof RefreshGoalConflictError)
      return { success: false as const, error: error.message }
    if (error instanceof PlanConflictError || error instanceof PlanStateError)
      return {
        success: false as const,
        error:
          'The draft or plan changed. Return to step 1, reopen the draft and export a fresh request. Your approved plans are preserved.',
      }
    if (error instanceof PublicationError)
      return {
        success: false as const,
        error: `Publication was not confirmed (${error.code.replaceAll('_', ' ')}). Review the current changes before retrying. An uncertain earlier publication must be reconciled before replacing it. Your approved local revision is preserved.`,
      }
    if (error instanceof IntervalsWorkoutMappingError)
      return {
        success: false as const,
        error: `This workout cannot be published to Intervals.icu. ${error.issues.map((issue) => issue.message).join(' ')} Your approved local revision is preserved. Refresh and explicitly approve a compatible workout before publishing again.`,
      }
    if (error instanceof z.ZodError)
      return {
        success: false as const,
        error: 'Check the response and explicitly confirm local approval.',
      }
    return {
      success: false as const,
      error: 'The plan could not be saved. Your draft is preserved. Please try again.',
    }
  }
}

export async function openWizardDraftAction(input: unknown) {
  return run((owner) => openPlanExport(owner, input, { initialOnly: true }))
}

export async function openRefreshDraftAction(input: unknown) {
  return run((owner) => {
    const { goalId, planId, expectedRevisionId } = openRefreshSchema.parse(input)
    return openPlanExport(owner, { goalId }, { planId, expectedRevisionId })
  })
}

export async function approveWizardPlanAction(command: unknown, text: unknown) {
  return run(async (owner) => {
    if (typeof text !== 'string') throw new PlanStateError()
    const result = await approvePlanImport(owner, command, text)
    if (result.approved) {
      revalidatePath('/app/calendar')
      revalidatePath('/app/training')
    }
    return result
  })
}

export async function previewRevisionPublicationAction(input: unknown) {
  return run((owner) => previewRevisionPublication(owner, input))
}

export async function sendRevisionPublicationAction(input: unknown) {
  return run((owner) => sendRevisionPublication(owner, input))
}
