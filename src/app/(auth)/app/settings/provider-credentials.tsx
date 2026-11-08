'use client'

import { useState, type FormEvent } from 'react'
import {
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock3,
  ExternalLink,
  Eye,
  EyeOff,
  LockKeyhole,
  PlugZap,
  Plus,
  Sparkles,
  Watch,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/FormField'
import { useToast } from '@/components/ui/Toast'
import type { ProviderConnectionStatus } from '@/lib/provider-connection-status'
import styles from './provider-credentials.module.scss'

const endpoint = '/api/integrations/garmin'
const helpUrl = 'https://developer.garmin.com/gc-developer-program/personal/personal-api'

function disconnected(): ProviderConnectionStatus {
  return { provider: 'GARMIN', status: 'DISCONNECTED', createdAt: null, updatedAt: null }
}

function displayStatus(status: ProviderConnectionStatus['status']) {
  switch (status) {
    case 'CONNECTED':
      return { label: 'Connected', tone: 'success' as const, icon: CircleCheck }
    case 'KEY_SAVED':
      return { label: 'Key saved', tone: 'success' as const, icon: CircleCheck }
    case 'ERROR':
      return { label: 'Invalid key', tone: 'error' as const, icon: CircleX }
    case 'EXPIRED':
      return { label: 'Expired', tone: 'warning' as const, icon: Clock3 }
    default:
      return { label: 'Not configured', tone: 'neutral' as const, icon: CircleMinus }
  }
}

async function saveError(response: Response): Promise<string> {
  if (response.status === 400) return 'Enter a valid API key without spaces (8–2048 characters).'
  if (response.status === 401) return 'Your session expired. Sign in again.'
  if (response.status === 403) return 'The request was blocked. Refresh the page and try again.'
  if (response.status === 413) return 'The API key is too long.'
  if (response.status === 415) return 'The request format was rejected. Refresh and try again.'
  if (response.status === 503) {
    try {
      const body: unknown = await response.json()
      if (
        body &&
        typeof body === 'object' &&
        'code' in body &&
        body.code === 'KEY_STORAGE_UNCONFIGURED'
      )
        return 'Key storage is not configured. Contact the site administrator.'
    } catch {
      // An unavailable server may not return JSON.
    }
    return 'Key storage is temporarily unavailable. Try again later.'
  }
  return 'Unable to save the key. Try again.'
}

export function ProviderCredentials({
  initial,
  openaiInitial,
}: {
  initial?: ProviderConnectionStatus
  openaiInitial?: ProviderConnectionStatus
}) {
  const connection = initial?.provider === 'GARMIN' ? initial : disconnected()
  const version = `${connection.status}:${connection.createdAt}:${connection.updatedAt}:${openaiInitial?.status}:${openaiInitial?.updatedAt}`
  return (
    <ProviderCredentialsPanel key={version} initial={connection} openaiInitial={openaiInitial} />
  )
}

function ProviderCredentialsPanel({
  initial,
  openaiInitial,
}: {
  initial: ProviderConnectionStatus
  openaiInitial?: ProviderConnectionStatus
}) {
  const toast = useToast()
  const [connection, setConnection] = useState(initial)
  const [key, setKey] = useState('')
  const [visible, setVisible] = useState(false)
  const [fieldError, setFieldError] = useState('')
  const [keyOpen, setKeyOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [openaiRemoveOpen, setOpenaiRemoveOpen] = useState(false)
  const [openaiSaved, setOpenaiSaved] = useState(
    openaiInitial?.provider === 'OPENAI' && openaiInitial.status !== 'DISCONNECTED',
  )
  const [pending, setPending] = useState(false)
  const saved = connection.status !== 'DISCONNECTED'
  const display = displayStatus(connection.status)
  const StatusIcon = display.icon

  function closeKey() {
    if (pending) return
    setKey('')
    setVisible(false)
    setFieldError('')
    setKeyOpen(false)
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    if (key.length < 8 || key.length > 2048 || !/^[\x21-\x7e]+$/.test(key)) {
      const message = 'Enter a valid API key without spaces (8–2048 characters).'
      setFieldError(message)
      toast('error', message, 'garmin-key')
      return
    }
    setPending(true)
    setFieldError('')
    let receivedResponse = false
    try {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ apiKey: key }),
      })
      receivedResponse = true
      if (!response.ok) {
        const message = await saveError(response)
        setFieldError(message)
        toast('error', message, 'garmin-key')
        return
      }
      const status: ProviderConnectionStatus = await response.json()
      if (status.provider !== 'GARMIN') throw new Error('Unexpected provider response')
      setConnection(status)
      setKey('')
      setVisible(false)
      setKeyOpen(false)
      toast('success', 'Garmin key saved.', 'garmin-key')
    } catch {
      const message = receivedResponse
        ? 'The server returned an unexpected response. Try again.'
        : 'Network error. Check your connection and try again.'
      setFieldError(message)
      toast('error', message, 'garmin-key')
    } finally {
      setPending(false)
    }
  }

  async function remove() {
    if (pending) return
    setPending(true)
    try {
      const response = await fetch(endpoint, {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok) {
        toast(
          'error',
          response.status === 401
            ? 'Your session expired. Sign in again.'
            : 'Could not remove the Garmin key. Try again.',
          'garmin-key',
        )
        return
      }
      setConnection(disconnected())
      setRemoveOpen(false)
      toast('success', 'Garmin key removed from Running Coach.', 'garmin-key')
    } catch {
      toast('error', 'Network error. Check your connection and try again.', 'garmin-key')
    } finally {
      setPending(false)
    }
  }

  async function removeOpenai() {
    if (pending) return
    setPending(true)
    try {
      const response = await fetch('/api/integrations/openai', {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok) {
        toast('error', 'Could not remove the OpenAI key. Try again.', 'openai-key')
        return
      }
      setOpenaiSaved(false)
      setOpenaiRemoveOpen(false)
      toast('success', 'OpenAI key removed from Running Coach.', 'openai-key')
    } catch {
      toast('error', 'Network error. Check your connection and try again.', 'openai-key')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Card as="section" className={styles.card} aria-labelledby="integrations-heading">
        <div className={styles.heading}>
          <PlugZap size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
          <div>
            <h2 id="integrations-heading">Integrations &amp; API keys</h2>
            <p>Manage external services connected to Running Coach.</p>
          </div>
        </div>
        <div className={styles.provider}>
          <span className={styles.providerIcon} aria-hidden="true">
            <Watch size={22} strokeWidth={2} focusable="false" />
          </span>
          <div className={styles.details}>
            <h3>Garmin Connect</h3>
            <p>Import your running activities.</p>
            <Badge tone={display.tone} className={styles.status}>
              <StatusIcon size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
              {display.label}
            </Badge>
          </div>
          <div className={styles.actions}>
            <Button onClick={() => setKeyOpen(true)}>
              {!saved && <Plus size={18} strokeWidth={2} aria-hidden="true" focusable="false" />}
              {saved ? 'Replace key' : 'Add key'}
            </Button>
            {saved && (
              <Button variant="secondary" onClick={() => setRemoveOpen(true)}>
                Remove key
              </Button>
            )}
          </div>
        </div>
        <div className={styles.provider}>
          <span className={`${styles.providerIcon} ${styles.openaiIcon}`} aria-hidden="true">
            <Sparkles size={22} strokeWidth={2} focusable="false" />
          </span>
          <div className={styles.details}>
            <h3>OpenAI</h3>
            <p>Automatic training plan generation.</p>
            <Badge tone="neutral" className={styles.status}>
              <Clock3 size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
              Coming soon
            </Badge>
          </div>
          {openaiSaved && (
            <div className={styles.actions}>
              <Button variant="secondary" onClick={() => setOpenaiRemoveOpen(true)}>
                Remove saved key
              </Button>
            </div>
          )}
        </div>
      </Card>

      {keyOpen && (
        <Dialog
          open
          title={`${saved ? 'Replace' : 'Add'} Garmin API key`}
          description="Enter your personal Garmin Connect API key to import activities."
          onClose={closeKey}
          pending={pending}
          actions={
            <>
              <Button variant="secondary" onClick={closeKey} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" form="garmin-key-form" loading={pending} disabled={!key}>
                Save key
              </Button>
            </>
          }
        >
          <form id="garmin-key-form" onSubmit={save} className={styles.keyForm} noValidate>
            <label htmlFor="garmin-api-key">API key</label>
            <div className={styles.inputWrap}>
              <Input
                id="garmin-api-key"
                type={visible ? 'text' : 'password'}
                autoComplete="off"
                autoFocus
                spellCheck={false}
                placeholder="Paste your API key"
                value={key}
                onChange={(event) => {
                  setKey(event.target.value)
                  if (fieldError) setFieldError('')
                }}
                minLength={8}
                maxLength={2048}
                required
                disabled={pending}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? 'garmin-api-key-error' : undefined}
              />
              <button
                type="button"
                className={styles.visibility}
                onClick={() => setVisible((current) => !current)}
                aria-label={visible ? 'Hide API key' : 'Show API key'}
                disabled={pending}
              >
                {visible ? (
                  <EyeOff size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                ) : (
                  <Eye size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                )}
              </button>
            </div>
            {fieldError && (
              <p id="garmin-api-key-error" className={styles.fieldError} role="alert">
                {fieldError}
              </p>
            )}
            <p className={styles.keyNote}>
              <LockKeyhole size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
              Stored encrypted. The saved key cannot be viewed again. Removing it here does not
              revoke it in Garmin Connect.
            </p>
            <a href={helpUrl} target="_blank" rel="noopener noreferrer" className={styles.help}>
              How to get a Garmin API key
              <ExternalLink size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
            </a>
          </form>
        </Dialog>
      )}
      {removeOpen && (
        <ConfirmDialog
          open
          title="Remove Garmin API key?"
          description="Activity imports will stop until you add a key again. Removing it here does not revoke it in Garmin Connect."
          confirmText="Remove key"
          variant="destructive"
          onConfirm={remove}
          onClose={() => setRemoveOpen(false)}
          pending={pending}
        />
      )}
      {openaiRemoveOpen && (
        <ConfirmDialog
          open
          title="Remove saved OpenAI key?"
          description="The stored key will be deleted from Running Coach. It must be revoked separately in your OpenAI account."
          confirmText="Remove key"
          variant="destructive"
          onConfirm={removeOpenai}
          onClose={() => setOpenaiRemoveOpen(false)}
          pending={pending}
        />
      )}
    </>
  )
}
