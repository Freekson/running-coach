'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import {
  CircleCheck,
  CircleMinus,
  Clock3,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Watch,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/FormField'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { useToast } from '@/components/ui/Toast'
import type { ProviderConnectionStatus } from '@/lib/provider-connection-status'
import { garminAccountIssueMessage } from '@/lib/garmin-account-message'
import type { GarminImportStreamState } from '@/server/garmin/data-import'
import { GarminDataImport } from './garmin-data-import'
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
      return { label: 'Key saved', tone: 'neutral' as const, icon: KeyRound }
    case 'VERIFICATION_REQUIRED':
      return { label: 'Verification needed', tone: 'warning' as const, icon: TriangleAlert }
    case 'ERROR':
      return { label: 'Connection issue', tone: 'warning' as const, icon: TriangleAlert }
    case 'EXPIRED':
      return { label: 'Expired', tone: 'warning' as const, icon: Clock3 }
    default:
      return { label: 'Not configured', tone: 'neutral' as const, icon: CircleMinus }
  }
}

function garminDescription(status: ProviderConnectionStatus['status']) {
  switch (status) {
    case 'CONNECTED':
      return 'Garmin access verified. Activity and health imports are available.'
    case 'KEY_SAVED':
      return 'Garmin account verified. Choose streams below to import your data.'
    case 'VERIFICATION_REQUIRED':
      return 'This saved key has no verified Garmin account ID. Verify it here or replace the key.'
    case 'ERROR':
      return 'Garmin access could not be verified. Replace the key to resume imports.'
    case 'EXPIRED':
      return 'Garmin access has expired. Replace the key to resume imports.'
    default:
      return 'Connect Garmin to import activities and health data.'
  }
}

async function saveError(response: Response): Promise<string> {
  if (response.status === 409) return garminAccountIssueMessage('ACCOUNT_MISMATCH')!
  if (response.status === 422) return garminAccountIssueMessage('ACCOUNT_UNVERIFIABLE')!
  if (response.status === 429) return 'Garmin is rate limiting requests. Try again later.'
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
  garminImports = [],
}: {
  initial?: ProviderConnectionStatus
  garminImports?: GarminImportStreamState[]
}) {
  const connection = initial?.provider === 'GARMIN' ? initial : disconnected()
  const version = `${connection.status}:${connection.createdAt}:${connection.updatedAt}`
  return (
    <ProviderCredentialsPanel key={version} initial={connection} garminImports={garminImports} />
  )
}

function ProviderCredentialsPanel({
  initial,
  garminImports,
}: {
  initial: ProviderConnectionStatus
  garminImports: GarminImportStreamState[]
}) {
  const toast = useToast()
  const router = useRouter()
  const [connection, setConnection] = useState(initial)
  const [key, setKey] = useState('')
  const [visible, setVisible] = useState(false)
  const [fieldError, setFieldError] = useState('')
  const [keyOpen, setKeyOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [deleteDataOpen, setDeleteDataOpen] = useState(false)
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
        return
      }
      const status: ProviderConnectionStatus = await response.json()
      if (status.provider !== 'GARMIN') throw new Error('Unexpected provider response')
      setConnection(status)
      setKey('')
      setVisible(false)
      setKeyOpen(false)
      toast('success', 'Garmin key saved.', 'garmin-key')
      router.refresh()
    } catch {
      const message = receivedResponse
        ? 'The server returned an unexpected response. Try again.'
        : 'Network error. Check your connection and try again.'
      setFieldError(message)
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
      const removed = disconnected()
      setConnection(removed)
      setRemoveOpen(false)
      toast('success', 'Garmin key removed from Running Coach.', 'garmin-key')
      router.refresh()
    } catch {
      toast('error', 'Network error. Check your connection and try again.', 'garmin-key')
    } finally {
      setPending(false)
    }
  }

  async function verifySavedKey() {
    if (pending) return
    setPending(true)
    try {
      const response = await fetch('/api/integrations/garmin/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          streamId: 'daily_summary',
          action: 'verify',
          browserTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        }),
      })
      if (!response.ok) {
        toast(
          'error',
          'The saved Garmin key could not be verified. Replace it or try again later.',
          'garmin-key',
        )
        return
      }
      toast('success', 'Garmin account verified. Choose streams to import.', 'garmin-key')
      router.refresh()
    } catch {
      toast('error', 'Network error. Check your connection and try again.', 'garmin-key')
    } finally {
      setPending(false)
    }
  }

  async function deleteGarminData() {
    if (pending) return
    setPending(true)
    try {
      const response = await fetch('/api/integrations/garmin/data', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ confirm: 'DELETE_ALL_GARMIN_DATA' }),
      })
      if (!response.ok) {
        toast('error', 'Could not delete imported Garmin data. Try again.', 'garmin-data')
        return
      }
      setConnection(disconnected())
      setDeleteDataOpen(false)
      toast('success', 'Imported Garmin data and account association deleted.', 'garmin-data')
      router.refresh()
    } catch {
      toast('error', 'Network error. Check your connection and try again.', 'garmin-data')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Card as="section" className={styles.card} aria-label="Garmin Connect">
        <div className={styles.provider}>
          <div className={styles.providerIdentity}>
            <SectionHeading
              icon={Watch}
              title="Garmin Connect"
              level={2}
              className={styles.providerHeading}
            />
            <div className={styles.statusLine}>
              <Badge tone={display.tone} className={styles.status}>
                <StatusIcon size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
                {display.label}
              </Badge>
            </div>
            <p className={styles.description}>{garminDescription(connection.status)}</p>
          </div>
          <div className={styles.actions}>
            <Button variant={saved ? 'secondary' : 'primary'} onClick={() => setKeyOpen(true)}>
              {saved ? (
                <RefreshCw size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
              ) : (
                <Plus size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
              )}
              {saved ? 'Replace key' : 'Add key'}
            </Button>
            {saved && (
              <Button
                variant="secondary"
                className={styles.removeButton}
                onClick={() => setRemoveOpen(true)}
              >
                <Trash2 size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                Remove key
              </Button>
            )}
            {connection.status === 'VERIFICATION_REQUIRED' && (
              <Button variant="secondary" onClick={() => void verifySavedKey()} disabled={pending}>
                Verify saved key
              </Button>
            )}
          </div>
        </div>
      </Card>
      {(connection.status === 'CONNECTED' || connection.status === 'KEY_SAVED') &&
        garminImports.length > 0 && <GarminDataImport initial={garminImports} />}
      <Card as="section" className={styles.card} aria-label="Delete imported Garmin data">
        <div className={styles.dangerZone}>
          <SectionHeading
            icon={Trash2}
            title="Delete imported Garmin data"
            subtitle="Remove Garmin activities, laps, health records and sync history, then reset the Garmin account association."
            level={2}
            className={styles.dangerDetails}
          />
          <Button
            variant="secondary"
            className={styles.dangerButton}
            onClick={() => setDeleteDataOpen(true)}
          >
            <Trash2 size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
            Delete all imported Garmin data
          </Button>
        </div>
      </Card>

      {keyOpen && (
        <Dialog
          open
          title={`${saved ? 'Replace' : 'Add'} Garmin API key`}
          description="Enter your personal Garmin Connect API key to import activities and health data."
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
      {deleteDataOpen && (
        <ConfirmDialog
          open
          title="Delete all imported Garmin data?"
          description="This permanently deletes imported Garmin activities, laps, health records and sync history. Your Garmin key and account association will also be removed. Other Running Coach data stays intact."
          confirmText="Delete all imported Garmin data"
          variant="destructive"
          onConfirm={deleteGarminData}
          onClose={() => setDeleteDataOpen(false)}
          pending={pending}
        />
      )}
    </>
  )
}
