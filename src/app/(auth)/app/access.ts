import { cache } from 'react'
import { redirect } from 'next/navigation'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'

// Pages verify access themselves: a shared layout may be reused on client navigation.
// React cache avoids repeating this lookup when a page and layout render together.
export const verifyAppAccess = cache(async (): Promise<boolean> => {
  let user
  try {
    user = await getCurrentUser()
  } catch (error) {
    if (error instanceof AccountUnavailableError) return false
    throw error
  }

  if (!user) redirect('/sign-in?next=%2Fapp%2Fdashboard')
  return true
})
