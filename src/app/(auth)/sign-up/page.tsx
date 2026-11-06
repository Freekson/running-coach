'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { retainInvitationToken } from '@/lib/invitation-link'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { useToast } from '@/components/ui/Toast'
import { toastRedirectPath } from '@/components/ui/toast-redirect'

type Field = 'name' | 'email' | 'password'
type FieldErrors = Partial<Record<Field, string>>
type InvitationState = 'checking' | 'valid' | 'unavailable' | 'retry' | 'processing'
const invitationStorageKey = 'running-coach:signup-invitation'
const invitationHistoryKey = 'runningCoachSignupInvitation'

const invitationMessages: Record<string, string> = {
  invalid: 'This invitation link is invalid. Ask the operator for a new link.',
  expired: 'This invitation has expired. Ask the operator for a new link.',
  revoked: 'This invitation was revoked. Ask the operator for a new link.',
  used: 'This invitation has already been used. Sign in or ask for a new link.',
}

function statusMessage(status: string): string {
  return Object.hasOwn(invitationMessages, status)
    ? invitationMessages[status]
    : invitationMessages.invalid
}

function currentInvitationMarker(): string | null {
  const state: unknown = window.history.state
  if (!state || typeof state !== 'object' || !(invitationHistoryKey in state)) return null
  const marker = state[invitationHistoryKey]
  return typeof marker === 'string' ? marker : null
}

function storedInvitationToken(): string {
  const marker = currentInvitationMarker()
  if (!marker) return ''
  try {
    return window.sessionStorage.getItem(`${invitationStorageKey}:${marker}`) ?? ''
  } catch {
    return ''
  }
}

function rememberInvitationToken(token: string) {
  try {
    const marker = `${Date.now()}-${Math.random()}`
    window.sessionStorage.setItem(`${invitationStorageKey}:${marker}`, token)
    window.history.replaceState(
      { ...window.history.state, [invitationHistoryKey]: marker },
      '',
      `${window.location.pathname}${window.location.search}`,
    )
  } catch {
    // Keep the fragment available for refresh when browser storage is blocked.
  }
}

function clearStoredInvitationToken() {
  const marker = currentInvitationMarker()
  if (!marker) return
  try {
    window.sessionStorage.removeItem(`${invitationStorageKey}:${marker}`)
  } catch {
    // The in-memory token is still cleared when this tab closes.
  }
}

function focusField(form: HTMLFormElement, field: Field) {
  const input = form.elements.namedItem(field)
  if (input instanceof HTMLElement) input.focus()
}

function localErrors(form: HTMLFormElement): FieldErrors {
  const name = form.elements.namedItem('name')
  const email = form.elements.namedItem('email')
  const password = form.elements.namedItem('password')
  return {
    ...(name instanceof HTMLInputElement && !name.value.trim() && { name: 'Enter your name.' }),
    ...(email instanceof HTMLInputElement &&
      (!email.value.trim() || !email.validity.valid) && {
        email: 'Enter a valid email address.',
      }),
    ...(password instanceof HTMLInputElement &&
      (password.value.length < 12 || password.value.length > 128) && {
        password: 'Use a password with 12 to 128 characters.',
      }),
  }
}

function serverFieldErrors(value: unknown): FieldErrors {
  if (!value || typeof value !== 'object' || !('errors' in value)) return {}
  const errors = value.errors
  if (!errors || typeof errors !== 'object') return {}
  return {
    ...('name' in errors && { name: 'Enter your name.' }),
    ...('email' in errors && { email: 'Enter a valid email address.' }),
    ...('password' in errors && { password: 'Use a password with 12 to 128 characters.' }),
  }
}

function SignUpForm() {
  const token = useRef('')
  const submitting = useRef(false)
  const linkGeneration = useRef(0)
  const formRef = useRef<HTMLFormElement>(null)
  const focusAfterSubmit = useRef<Field | null>(null)
  const router = useRouter()
  const notify = useToast()
  const [fields, setFields] = useState<FieldErrors>({})
  const [pending, setPending] = useState(false)
  const [state, setState] = useState<InvitationState>('checking')
  const [invitationMessage, setInvitationMessage] = useState('')
  const [checkAttempt, setCheckAttempt] = useState(0)
  const [linkVersion, setLinkVersion] = useState(0)

  useEffect(() => {
    function onHistoryChange() {
      linkGeneration.current += 1
      token.current = ''
      submitting.current = false
      setPending(false)
      setFields({})
      setInvitationMessage('')
      setState('checking')
      setLinkVersion((version) => version + 1)
    }
    window.addEventListener('hashchange', onHistoryChange)
    window.addEventListener('popstate', onHistoryChange)
    return () => {
      window.removeEventListener('hashchange', onHistoryChange)
      window.removeEventListener('popstate', onHistoryChange)
    }
  }, [])

  useEffect(() => {
    if (!pending && focusAfterSubmit.current && formRef.current) {
      focusField(formRef.current, focusAfterSubmit.current)
      focusAfterSubmit.current = null
    }
  }, [pending, fields])

  useEffect(() => {
    const controller = new AbortController()
    const hash = window.location.hash
    const inviteToken = hash
      ? retainInvitationToken(hash, '')
      : retainInvitationToken('', '', storedInvitationToken())
    if (!inviteToken) {
      token.current = ''
      if (!hash) {
        router.replace(toastRedirectPath('/', 'missing-invite'))
      } else {
        queueMicrotask(() => {
          if (controller.signal.aborted) return
          setInvitationMessage(statusMessage('invalid'))
          setState('unavailable')
          notify('error', statusMessage('invalid'), 'signup-invitation')
        })
      }
      return () => controller.abort()
    }
    token.current = inviteToken
    if (hash) rememberInvitationToken(inviteToken)
    const checkedGeneration = linkGeneration.current
    async function checkInvitation() {
      try {
        const response = await fetch('/api/invitations/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: inviteToken }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('Invitation check failed')
        const result: unknown = await response.json()
        if (controller.signal.aborted || checkedGeneration !== linkGeneration.current) return
        const status =
          result &&
          typeof result === 'object' &&
          'status' in result &&
          typeof result.status === 'string'
            ? result.status
            : 'invalid'
        if (status === 'valid') {
          setInvitationMessage('')
          setState('valid')
        } else if (status === 'processing') {
          setState('processing')
        } else {
          const message = statusMessage(status)
          token.current = ''
          clearStoredInvitationToken()
          setInvitationMessage(message)
          setState('unavailable')
          notify('error', message, 'signup-invitation')
        }
      } catch {
        if (controller.signal.aborted || checkedGeneration !== linkGeneration.current) return
        setState('retry')
        notify('error', 'Could not check this invitation. Try again.', 'signup-invitation')
      }
    }
    void checkInvitation()
    return () => controller.abort()
  }, [checkAttempt, linkVersion, notify, router])

  function discardInvitation() {
    token.current = ''
    clearStoredInvitationToken()
  }

  function clearField(field: Field) {
    setFields((current) => ({ ...current, [field]: undefined }))
  }

  async function signUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || state !== 'valid') return
    const form = event.currentTarget
    const errors = localErrors(form)
    setFields(errors)
    const firstError = (['name', 'email', 'password'] as const).find((field) => errors[field])
    if (firstError) {
      focusField(form, firstError)
      return
    }
    if (!token.current) {
      setState('unavailable')
      setInvitationMessage(statusMessage('invalid'))
      return
    }
    submitting.current = true
    setPending(true)
    const submittedToken = token.current
    const submittedGeneration = linkGeneration.current
    const data = new FormData(form)
    try {
      const response = await fetch('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: String(data.get('name')).trim(),
          email: String(data.get('email')).trim(),
          password: String(data.get('password')),
          invitationToken: submittedToken,
        }),
      })
      if (submittedGeneration !== linkGeneration.current || token.current !== submittedToken) return
      if (response.ok) {
        discardInvitation()
        router.replace('/app/dashboard')
        router.refresh()
      } else if (response.headers.get('x-running-coach-error') === 'duplicate-email') {
        setFields({ email: 'An account with this email already exists.' })
        focusAfterSubmit.current = 'email'
      } else if (response.headers.get('x-running-coach-error') === 'invalid-invitation') {
        discardInvitation()
        const message = statusMessage(
          response.headers.get('x-running-coach-invitation-status') ?? 'invalid',
        )
        setInvitationMessage(message)
        setState('unavailable')
        notify('error', message, 'signup-invitation')
      } else if (response.headers.get('x-running-coach-error') === 'registration-outcome-unknown') {
        discardInvitation()
        setState('unavailable')
        setInvitationMessage(
          'Registration may have completed. Sign in or ask the operator for a new invitation.',
        )
        notify(
          'error',
          'Registration may have completed. Try signing in or ask for a new invitation.',
          'signup-error',
        )
      } else if (response.status === 400) {
        const body: unknown = await response.json().catch(() => null)
        const fieldErrors = serverFieldErrors(body)
        const firstField = (['name', 'email', 'password'] as const).find(
          (field) => fieldErrors[field],
        )
        if (firstField) {
          setFields(fieldErrors)
          focusAfterSubmit.current = firstField
        } else notify('error', 'Registration could not finish. Try again.', 'signup-error')
      } else if (response.status === 429) {
        notify('error', 'Too many attempts. Wait and try again.', 'signup-error')
      } else {
        notify('error', 'Registration could not finish. Try again.', 'signup-error')
      }
    } catch {
      if (submittedGeneration !== linkGeneration.current || token.current !== submittedToken) return
      setInvitationMessage(
        'Registration may have completed. Sign in or check this invitation before trying again.',
      )
      setState('retry')
      notify('error', 'Connection lost. Check whether registration completed.', 'signup-error')
    } finally {
      if (submittedGeneration === linkGeneration.current) {
        submitting.current = false
        setPending(false)
      }
    }
  }

  if (state === 'checking') return <p role="status">Checking your invitation…</p>
  if (state === 'retry' || state === 'processing') {
    return (
      <section className="auth-page">
        <h1>Check your invitation</h1>
        <p>
          {state === 'processing'
            ? 'A registration with this invitation is in progress. Try checking again shortly.'
            : invitationMessage || 'We could not check this invitation right now.'}
        </p>
        {state === 'retry' && invitationMessage && (
          <p>
            <Link href="/sign-in">Sign in instead</Link>
          </p>
        )}
        <Button
          onClick={() => {
            setState('checking')
            setCheckAttempt((attempt) => attempt + 1)
          }}
        >
          {state === 'retry' && invitationMessage ? 'Check invitation' : 'Try again'}
        </Button>
      </section>
    )
  }
  if (state === 'unavailable') {
    return (
      <section className="auth-page">
        <h1>Invitation unavailable</h1>
        <p>{invitationMessage}</p>
        <p>
          <Link href="/sign-in">Sign in instead</Link>
        </p>
      </section>
    )
  }

  return (
    <section className="auth-page" aria-labelledby="sign-up-heading">
      <h1 id="sign-up-heading">Create your account</h1>
      <p>A valid, unused invitation link is required.</p>
      <form
        ref={formRef}
        className="auth-form"
        onSubmit={signUp}
        noValidate
        aria-busy={pending || undefined}
      >
        <FormField
          id="name"
          label="Name"
          name="name"
          autoComplete="name"
          required
          disabled={pending}
          error={fields.name}
          onChange={() => clearField('name')}
        />
        <FormField
          id="email"
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={pending}
          error={fields.email}
          onChange={() => clearField('email')}
        />
        {fields.email === 'An account with this email already exists.' && (
          <Link href="/sign-in">Sign in instead</Link>
        )}
        <FormField
          id="password"
          label="Password (at least 12 characters)"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          disabled={pending}
          error={fields.password}
          onChange={() => clearField('password')}
        />
        <Button type="submit" loading={pending}>
          Create account
        </Button>
      </form>
    </section>
  )
}

export default function SignUpPage() {
  return <SignUpForm />
}
