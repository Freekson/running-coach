'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { safeAppDestination } from '@/lib/app-destination'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'

export default function SignInPage() {
  const router = useRouter()
  const [error, setError] = useState('')

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const form = new FormData(event.currentTarget)
    const result = await authClient.signIn.email({
      email: String(form.get('email')),
      password: String(form.get('password')),
    })
    if (result.error) setError('Sign in failed. Check your email and password.')
    else {
      const next = new URLSearchParams(window.location.search).get('next')
      router.replace(safeAppDestination(next))
      router.refresh()
    }
  }

  return (
    <section className="auth-page" aria-labelledby="sign-in-heading">
      <h1 id="sign-in-heading">Sign in</h1>
      <p>Running Coach is available to invited athletes only.</p>
      <form className="auth-form" onSubmit={signIn}>
        <FormField
          id="email"
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
        <FormField
          id="password"
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        {error && <p role="alert">{error}</p>}
        <Button type="submit">Sign in</Button>
      </form>
      <p>
        Have an invitation? <Link href="/sign-up">Create your account</Link>.
      </p>
    </section>
  )
}
