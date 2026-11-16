'use server'

import { z } from 'zod'
import { exportScheduleSchema } from '@/lib/plan-export'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import {
  getOwnerContext,
  OwnedResourceNotFoundError,
  type OwnerContext,
} from '@/server/authorization/ownership'
import { issuePlanExport, openPlanExport } from '@/server/plans/exchange/export'
import { updatePlanDraftConstraints } from '@/server/plans/drafts'
import {
  PlanConflictError,
  PlanStateError,
  RefreshGoalConflictError,
  RefreshWindowError,
} from '@/server/plans/transaction'

async function run<T>(operation: (owner: OwnerContext) => Promise<T>) {
  try {
    const user = await getCurrentUser()
    if (!user) return { success: false as const, error: 'Sign in to export a plan request.' }
    return { success: true as const, value: await operation(getOwnerContext(user)) }
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return { success: false as const, error: 'This account is unavailable.' }
    if (error instanceof OwnedResourceNotFoundError)
      return { success: false as const, error: 'Goal or draft not found.' }
    if (error instanceof RefreshGoalConflictError || error instanceof RefreshWindowError)
      return { success: false as const, error: error.message }
    if (error instanceof PlanConflictError)
      return {
        success: false as const,
        error: 'The draft or plan changed. Reopen the request and try again.',
      }
    if (error instanceof PlanStateError || error instanceof z.ZodError)
      return {
        success: false as const,
        error:
          'Check your schedule, future 14–28 day window and optional fields. The request may also exceed the export size limit.',
      }
    return {
      success: false as const,
      error: 'The request could not be prepared. Please try again.',
    }
  }
}

export async function openPlanExportAction(input: unknown) {
  return run((owner) => openPlanExport(owner, input))
}
export async function previewPlanExportAction(input: unknown) {
  return run((owner) => issuePlanExport(owner, input))
}
export async function saveExportScheduleAction(input: unknown) {
  return run(async (owner) => {
    const parsed = exportScheduleSchema.parse(input)
    const draft = await updatePlanDraftConstraints(
      owner,
      parsed.draftId,
      parsed.constraints,
      parsed.expectedVersion,
    )
    return { version: draft.version, constraints: draft.constraints }
  })
}
