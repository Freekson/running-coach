'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarArrowUp, ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog'
import { FormField } from '@/components/ui/FormField'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { useToast } from '@/components/ui/Toast'
import type { ProviderConnectionStatus } from '@/lib/provider-connection-status'
import styles from './intervals-connection.module.scss'

const endpoint = '/api/integrations/intervals'
const disconnected: ProviderConnectionStatus = {
  provider: 'INTERVALS',
  status: 'DISCONNECTED',
  createdAt: null,
  updatedAt: null,
}

async function errorMessage(response: Response) {
  if (response.status === 401) return 'Your session expired. Sign in again.'
  if (response.status === 403) return 'The request was blocked. Refresh the page and try again.'
  if (response.status === 400) return 'Enter a valid API key without spaces (8–2048 characters).'
  if (response.status === 413) return 'The API key is too long.'
  if (response.status === 422)
    return 'Intervals.icu rejected this key. It may be invalid or revoked. Replace it with a key from your own account.'
  if (response.status === 429) return 'Intervals.icu is rate limiting requests. Try again later.'
  try {
    const body: unknown = await response.json()
    if (
      body &&
      typeof body === 'object' &&
      'code' in body &&
      body.code === 'KEY_STORAGE_UNCONFIGURED'
    )
      return 'Key storage is not configured. Contact the site administrator.'
    if (
      response.status === 409 &&
      body &&
      typeof body === 'object' &&
      'code' in body &&
      body.code === 'CONNECTION_CHANGED'
    )
      return 'Your connection changed while this key was being checked. Refresh the page and try again.'
  } catch {
    // A provider outage may not return JSON.
  }
  if (response.status === 409)
    return 'Your saved Intervals.icu key is missing or unavailable. Connect or replace the key.'
  return 'The connection is temporarily unavailable. Try again later.'
}

export function IntervalsConnection({ initial }: { initial?: ProviderConnectionStatus }) {
  const connection = initial?.provider === 'INTERVALS' ? initial : disconnected
  return (
    <IntervalsConnectionPanel
      key={`${connection.status}:${connection.updatedAt}`}
      initial={connection}
    />
  )
}

function IntervalsConnectionPanel({ initial }: { initial: ProviderConnectionStatus }) {
  const router = useRouter()
  const toast = useToast()
  const [connection, setConnection] = useState(initial)
  const [apiKey, setApiKey] = useState('')
  const [keyOpen, setKeyOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [pending, setPending] = useState<'connect' | 'test' | 'disconnect' | null>(null)
  const [error, setError] = useState('')
  const saved = connection.status !== 'DISCONNECTED'
  const connected = connection.status === 'CONNECTED'
  const label = connected
    ? 'Connected'
    : connection.status === 'KEY_SAVED'
      ? 'Key saved'
      : saved
        ? 'Connection issue'
        : 'Not configured'

  function closeKey() {
    if (pending) return
    setKeyOpen(false)
    setApiKey('')
    setError('')
  }

  async function run(action: 'connect' | 'test' | 'disconnect') {
    if (pending) return
    setPending(action)
    setError('')
    try {
      const response = await fetch(endpoint, {
        method: action === 'connect' ? 'PUT' : action === 'test' ? 'POST' : 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
        ...(action === 'connect'
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ apiKey }),
            }
          : {}),
      })
      if (!response.ok) {
        setError(await errorMessage(response))
        if (action === 'test' && response.status === 422) {
          setConnection({ ...connection, status: 'ERROR' })
          router.refresh()
        }
        return
      }
      if (action === 'disconnect') {
        setConnection(disconnected)
        setRemoveOpen(false)
      } else {
        const status: ProviderConnectionStatus = await response.json()
        if (status.provider !== 'INTERVALS') throw new Error('Unexpected provider')
        setConnection(status)
        setKeyOpen(false)
        setApiKey('')
        if (action === 'test' && status.status !== 'CONNECTED') {
          setError(
            'Your connection changed during the test. Test the current key again or reconnect.',
          )
          router.refresh()
          return
        }
      }
      toast(
        'success',
        action === 'connect'
          ? 'Intervals.icu key saved. Test the connection to confirm access.'
          : action === 'test'
            ? 'Intervals.icu calendar access verified. Garmin watch delivery is not verified.'
            : 'Intervals.icu disconnected from Running Coach.',
        'intervals-connection',
      )
      router.refresh()
    } catch {
      setError('Unable to reach the server. Check your connection and try again.')
    } finally {
      setPending(null)
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (apiKey.length < 8 || apiKey.length > 2048 || !/^[\x21-\x7e]+$/.test(apiKey)) {
      setError('Enter a valid API key without spaces (8–2048 characters).')
      return
    }
    void run('connect')
  }

  return (
    <Card as="section" className={styles.card} aria-label="Intervals.icu workout delivery">
      <div className={styles.header}>
        <SectionHeading
          icon={CalendarArrowUp}
          title="Intervals.icu"
          subtitle="Outbound scheduled workout delivery"
          level={2}
        />
        <Badge
          tone={
            connected
              ? 'success'
              : saved && connection.status !== 'KEY_SAVED'
                ? 'warning'
                : 'neutral'
          }
        >
          {label}
        </Badge>
      </div>
      <p>
        {connected
          ? 'Calendar access verified. Garmin forwarding settings and watch delivery are not verified.'
          : connection.status === 'KEY_SAVED'
            ? 'Key saved. Test the connection to confirm calendar access.'
            : saved
              ? 'The saved key was rejected or is unavailable. It may be invalid, expired or revoked. Replace it to reconnect.'
              : 'Add a key from your own account to enable connection testing.'}
      </p>
      <p>
        Connect your own Intervals.icu account for planned workouts. Garmin Activity/Health Sync now
        imports completed data independently and requires no Intervals.icu account.
      </p>
      <div className={styles.actions}>
        <Button
          variant={saved ? 'secondary' : 'primary'}
          disabled={Boolean(pending)}
          onClick={() => {
            setError('')
            setKeyOpen(true)
          }}
        >
          {saved ? 'Replace Intervals.icu key' : 'Connect Intervals.icu'}
        </Button>
        <Button
          variant="secondary"
          disabled={Boolean(pending) || !saved}
          loading={pending === 'test'}
          onClick={() => void run('test')}
        >
          Test connection
        </Button>
        {saved && (
          <Button
            variant="secondary"
            disabled={Boolean(pending)}
            onClick={() => {
              setError('')
              setRemoveOpen(true)
            }}
          >
            Disconnect Intervals.icu
          </Button>
        )}
      </div>
      {error && !keyOpen && !removeOpen && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <details className={styles.guide}>
        <summary>Set up Garmin workout forwarding</summary>
        <ol>
          <li>
            Sign in to your own Intervals.icu account. In Settings, find Developer Settings and
            generate or copy your personal API key. Connect it here. Personal keys grant broad
            access; Running Coach uses only the planned-workout calendar.
          </li>
          <li>
            In Intervals.icu Settings → Connections → Garmin Connect, connect your own Garmin
            account and enable <strong>Upload planned workouts</strong>. Approve the Garmin
            permission to upload planned workouts. Activity import is a separate setting and is not
            required by Running Coach.
          </li>
          <li>
            Use Test connection here to check calendar access. This does not verify your Garmin
            settings or watch.
          </li>
        </ol>
        <p>
          Connecting, testing and approving a plan do not publish workouts. Running Coach →
          Intervals.icu publication requires a separate explicit Publish action, available in a
          later release.
        </p>
        <p>
          Once published, Intervals.icu → Garmin may forward scheduled workouts automatically within
          approximately the next 7 days. Workouts outside that window may wait. Sync your watch with
          Garmin Connect and check the session on the watch; calendar access or publication is not
          proof of watch delivery.
        </p>
        <p>
          Garmin Activity/Health Sync now stays manually initiated. Running Coach does not import
          completed activities or health data through Intervals.icu.
        </p>
        <a href="https://intervals.icu/settings" target="_blank" rel="noopener noreferrer">
          Open Intervals.icu settings <ExternalLink size={16} strokeWidth={2} aria-hidden="true" />
        </a>
      </details>
      {keyOpen && (
        <Dialog
          open
          title={saved ? 'Replace Intervals.icu key' : 'Connect Intervals.icu'}
          description="Use a personal API key from your own Intervals.icu account."
          onClose={closeKey}
          pending={Boolean(pending)}
          actions={
            <>
              <Button variant="secondary" onClick={closeKey} disabled={Boolean(pending)}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="intervals-key-form"
                loading={pending === 'connect'}
                disabled={!apiKey}
              >
                Connect
              </Button>
            </>
          }
        >
          <form id="intervals-key-form" onSubmit={save} className={styles.form} noValidate>
            <FormField
              id="intervals-api-key"
              label="Intervals.icu API key"
              type="password"
              autoComplete="off"
              autoFocus
              spellCheck={false}
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value)
                setError('')
              }}
              minLength={8}
              maxLength={2048}
              required
              disabled={Boolean(pending)}
              error={error}
            />
            <p>
              Stored encrypted. Saved keys cannot be viewed again. Replacing a key resets its tested
              status. Disconnect removes the key from Running Coach; to revoke it at Intervals.icu,
              clear or regenerate it in Developer Settings.
            </p>
          </form>
        </Dialog>
      )}
      {removeOpen && (
        <ConfirmDialog
          open
          title="Disconnect Intervals.icu?"
          description={
            error ||
            'Remove your saved key from Running Coach. Previously published workouts and Garmin forwarding settings remain in Intervals.icu. Clear or regenerate the key there to revoke it at the provider.'
          }
          confirmText="Disconnect"
          variant="destructive"
          pending={Boolean(pending)}
          onConfirm={() => run('disconnect')}
          onClose={() => setRemoveOpen(false)}
        />
      )}
    </Card>
  )
}
