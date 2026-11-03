'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { retainInvitationToken } from '@/lib/invitation-link'

function SignUpForm() {
  const token = useRef('')
  const submitting = useRef(false)
  const router = useRouter()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  useEffect(() => {
    const inviteToken = retainInvitationToken(window.location.hash, token.current)
    if (inviteToken) {
      token.current = inviteToken
      window.history.replaceState(window.history.state, '', window.location.pathname)
    }
  }, [])

  async function signUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setPending(true)
    setError('')
    const form = new FormData(event.currentTarget)
    try {
      const response = await fetch('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: String(form.get('name')),
          email: String(form.get('email')),
          password: String(form.get('password')),
          invitationToken: token.current,
        }),
      })
      if (response.ok) {
        router.replace('/app')
        router.refresh()
      } else if (response.status === 403) {
        setError('Invitation is invalid or already used. Ask the operator for a new link.')
      } else if (response.status === 429) {
        setError('Too many attempts. Wait and retry with this link.')
      } else if (response.status < 500) {
        setError('Check your details and retry with this link.')
      } else {
        setError('Registration could not finish. Try signing in, or ask for a new link.')
      }
    } catch {
      setError('Connection lost. Try signing in, or ask for a new link.')
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  return (
    <section className="auth-page">
      <h1>Create your account</h1>
      <p>A valid, unused invitation link is required.</p>
      <form className="auth-form" onSubmit={signUp}>
        <label htmlFor="name">Name</label>
        <input id="name" name="name" autoComplete="name" required />
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <label htmlFor="password">Password (at least 12 characters)</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
        {error && <p role="alert">{error}</p>}
        <button className="button" type="submit" disabled={pending}>
          {pending ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </section>
  )
}

export default function SignUpPage() {
  return <SignUpForm />
}
