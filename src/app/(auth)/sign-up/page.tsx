'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { retainInvitationToken } from '@/lib/invitation-link'

const invitationStorageKey = 'running-coach:signup-invitation'

function SignUpForm() {
  const token = useRef('')
  const submitting = useRef(false)
  const router = useRouter()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [hasInvitation, setHasInvitation] = useState(false)

  useEffect(() => {
    function captureInvitation() {
      let stored = ''
      try {
        stored = window.sessionStorage.getItem(invitationStorageKey) ?? ''
      } catch {
        // Keep the fragment if browser storage is unavailable.
      }
      const hash = window.location.hash
      const inviteToken = retainInvitationToken(hash, token.current, stored)
      if (!inviteToken) {
        token.current = ''
        setHasInvitation(false)
        setError('Open the full invitation link to create an account.')
        return
      }
      token.current = inviteToken
      setHasInvitation(true)
      setError('')
      try {
        window.sessionStorage.setItem(invitationStorageKey, inviteToken)
        if (hash) window.history.replaceState(window.history.state, '', window.location.pathname)
      } catch {
        // The fragment remains available across remounts when storage is blocked.
      }
    }
    captureInvitation()
    window.addEventListener('hashchange', captureInvitation)
    return () => window.removeEventListener('hashchange', captureInvitation)
  }, [])

  function discardInvitation() {
    token.current = ''
    setHasInvitation(false)
    try {
      window.sessionStorage.removeItem(invitationStorageKey)
    } catch {
      // The tab will discard the in-memory token when it closes.
    }
  }

  async function signUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token.current) {
      setError('Open the full invitation link to create an account.')
      return
    }
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
        discardInvitation()
        router.replace('/app/dashboard')
        router.refresh()
      } else if (response.status === 403) {
        if (response.headers.get('x-running-coach-error') === 'invalid-invitation') {
          discardInvitation()
          setError('Invitation is invalid or already used. Ask the operator for a new link.')
        } else {
          setError('Registration was blocked. Check the app URL and retry with this link.')
        }
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
        <button className="button" type="submit" disabled={pending || !hasInvitation}>
          {pending ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </section>
  )
}

export default function SignUpPage() {
  return <SignUpForm />
}
