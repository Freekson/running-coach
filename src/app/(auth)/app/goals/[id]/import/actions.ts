'use server'

import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import { previewPlanImport } from '@/server/plans/exchange/import'

/** RUN-37 can compose this action into its review UI; it has no approval side effects. */
export async function previewPlanImportAction(command: unknown, text: unknown) {
  try {
    const user = await getCurrentUser()
    if (!user) return { success: false as const, error: 'Sign in to preview a plan response.' }
    if (typeof text !== 'string')
      return { success: false as const, error: 'Choose a JSON text response.' }
    return {
      success: true as const,
      value: await previewPlanImport(getOwnerContext(user), command, text),
    }
  } catch (error) {
    if (error instanceof AccountUnavailableError)
      return { success: false as const, error: 'This account is unavailable.' }
    return {
      success: false as const,
      error: 'The response could not be checked. Please try again.',
    }
  }
}
