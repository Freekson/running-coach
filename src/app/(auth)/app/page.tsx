import { redirect } from 'next/navigation'
import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { SignOutButton } from '../sign-out-button'

export default async function AppPage() {
  let user
  try {
    user = await getCurrentUser()
  } catch (error) {
    if (!(error instanceof AccountUnavailableError)) throw error
    return (
      <section className="auth-page">
        <h1>Account unavailable</h1>
        <p>Contact the application administrator for help.</p>
        <SignOutButton />
      </section>
    )
  }

  if (!user) redirect('/sign-in')

  return (
    <section className="auth-page">
      <h1>Your training space</h1>
      <p>Your account is ready. Training features are coming soon.</p>
      <SignOutButton />
    </section>
  )
}
