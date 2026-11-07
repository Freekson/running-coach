'use client'

import { useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { FormField } from '@/components/ui/FormField'
import type { ProviderConnectionStatus } from '@/lib/provider-connection-status'
import styles from './provider-credentials.module.scss'

const disconnected: ProviderConnectionStatus = {
  provider: 'OPENAI',
  status: 'DISCONNECTED',
  createdAt: null,
  updatedAt: null,
}

export function ProviderCredentials({
  initial = disconnected,
}: {
  initial?: ProviderConnectionStatus
}) {
  const version = `${initial.provider}:${initial.status}:${initial.createdAt}:${initial.updatedAt}`
  return <ProviderCredentialsForm key={version} initial={initial} />
}

function ProviderCredentialsForm({ initial }: { initial: ProviderConnectionStatus }) {
  const [connection, setConnection] = useState(initial)
  const [key, setKey] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setMessage('')
    try {
      const response = await fetch('/api/integrations/openai', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ apiKey: key }),
      })
      if (!response.ok) {
        setMessage(response.status === 400 ? 'Enter a valid API key.' : 'Could not save the key.')
        return
      }
      const status: ProviderConnectionStatus = await response.json()
      setConnection(status)
      setKey('')
      setMessage('API key saved locally.')
    } catch {
      setMessage('Could not save the key.')
    } finally {
      setPending(false)
    }
  }

  async function disconnect() {
    if (pending) return
    setPending(true)
    setMessage('')
    try {
      const response = await fetch('/api/integrations/openai', {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok) {
        setMessage('Could not disconnect the key.')
        return
      }
      setConnection(disconnected)
      setKey('')
      setMessage('Key removed from Running Coach. Revoke it separately in your OpenAI account.')
    } catch {
      setMessage('Could not disconnect the key.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Card as="section" className={styles.card} aria-labelledby="openai-credential-heading">
      <div className={styles.heading}>
        <KeyRound size={20} strokeWidth={2} aria-hidden="true" />
        <div>
          <h2 id="openai-credential-heading">OpenAI API key</h2>
          <p>For future automatic plan generation. Automatic generation is not available yet.</p>
        </div>
        <Badge tone={connection.status === 'CONNECTED' ? 'success' : 'neutral'}>
          {connection.status === 'CONNECTED' ? 'Key stored' : connection.status.toLowerCase()}
        </Badge>
      </div>
      {connection.updatedAt && (
        <p className={styles.meta}>Connection updated {connection.updatedAt.slice(0, 10)}</p>
      )}
      <form onSubmit={save} className={styles.form}>
        <FormField
          id="openai-api-key"
          label={connection.status !== 'DISCONNECTED' ? 'Replacement API key' : 'API key'}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          minLength={8}
          maxLength={2048}
          required
          disabled={pending}
          hint="Your key is stored encrypted. It is never shown again after saving."
        />
        <div className={styles.actions}>
          <Button type="submit" loading={pending} disabled={!key}>
            {connection.status !== 'DISCONNECTED' ? 'Replace key' : 'Add key'}
          </Button>
          {connection.status !== 'DISCONNECTED' && (
            <Button type="button" variant="secondary" onClick={disconnect} disabled={pending}>
              Disconnect
            </Button>
          )}
        </div>
      </form>
      <p className={styles.note}>
        The planned manual ChatGPT workflow will not require an API key. Disconnect removes the
        local key; it does not revoke the key at OpenAI.
      </p>
      <p role="status" aria-live="polite" className={styles.message}>
        {message}
      </p>
    </Card>
  )
}
