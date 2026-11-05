import { cache } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { APP_PATH_HEADER, safeAppDestination } from '@/lib/app-destination'
import {
  AccountUnavailableError,
  getCurrentUser,
  type CurrentUser,
} from '@/server/auth/current-user'

// Pages verify access themselves: a shared layout may be reused on client navigation.
// React cache avoids repeating this lookup when a page and layout render together.
export const getAppUser = cache(async (): Promise<CurrentUser | null> => {
  let user
  try {
    user = await getCurrentUser()
  } catch (error) {
    if (error instanceof AccountUnavailableError) return null
    throw error
  }

  if (!user) {
    const destination = safeAppDestination((await headers()).get(APP_PATH_HEADER))
    redirect(`/sign-in?next=${encodeURIComponent(destination)}`)
  }
  return user
})

export async function verifyAppAccess(): Promise<boolean> {
  return (await getAppUser()) !== null
}
