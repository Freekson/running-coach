import { SignOutButton } from '../sign-out-button'

export function AccountUnavailable() {
  return (
    <section className="auth-page">
      <h1>Account unavailable</h1>
      <p>Contact the application administrator for help.</p>
      <SignOutButton />
    </section>
  )
}
