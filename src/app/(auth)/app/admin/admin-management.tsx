'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { FormField } from '@/components/ui/FormField'
import { CopyableField } from '@/components/ui/CopyableField'
import { useToast } from '@/components/ui/Toast'
import styles from './admin-management.module.scss'

type Invitation = {
  id: string
  label: string | null
  createdAt: string
  expiresAt: string
  status: 'pending' | 'used' | 'expired' | 'revoked'
}

type RegisteredUser = {
  id: string
  email: string | null
  role: 'ADMIN' | 'USER'
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | null
  createdAt: string
}

function displayDate(value: string) {
  return (
    new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(new Date(value)) + ' UTC'
  )
}

export function AdminManagement({
  invitations,
  users,
}: {
  invitations: Invitation[]
  users: RegisteredUser[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [label, setLabel] = useState('')
  const [newLink, setNewLink] = useState<{ url: string; expiresAt: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setNewLink(null)
    try {
      const response = await fetch('/api/admin/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || null }),
      })
      if (!response.ok) throw new Error('Generate failed')
      const created: { url: string; expiresAt: string } = await response.json()
      setNewLink(created)
      setLabel('')
      router.refresh()
    } catch {
      toast(
        'error',
        'Could not show the invite link. Check the list for a new pending invite before trying again; revoke it if the link was lost.',
      )
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    setRevoking(id)
    try {
      const response = await fetch(`/api/admin/invitations/${id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Revoke failed')
      toast('success', 'Invite revoked. Generate a new link if you need a replacement.')
      router.refresh()
    } catch {
      toast('error', 'Could not revoke the invite. Refresh and try again.')
    } finally {
      setRevoking(null)
    }
  }

  return (
    <div className={styles.page}>
      <header>
        <h1>Admin</h1>
        <p>Manage invite links and registered users.</p>
      </header>
      <Card as="section" className={styles.section} aria-labelledby="generate-title">
        <h2 id="generate-title">Generate invite link</h2>
        <p>Each link can register one user and expires after seven days. Share it privately.</p>
        <form onSubmit={generate} className={styles.form}>
          <FormField
            id="invite-label"
            label="Description (optional)"
            hint="For your reference only. This does not verify the recipient's identity."
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={120}
          />
          <Button type="submit" loading={busy}>
            Generate invite link
          </Button>
        </form>
        {newLink && (
          <div className={styles.created} role="status">
            <strong>New invite link</strong>
            <p>Copy this link now. It cannot be shown again after you leave this page.</p>
            <CopyableField
              id="new-invite-link"
              label="New invite link"
              value={newLink.url}
              onCopyError={() => toast('error', 'Copy failed. Select and copy the link manually.')}
            />
            <p>Expires {displayDate(newLink.expiresAt)}</p>
          </div>
        )}
      </Card>
      <Card as="section" className={styles.section} aria-labelledby="invitations-title">
        <h2 id="invitations-title">Invitations</h2>
        {invitations.length === 0 ? (
          <p>No invitations yet.</p>
        ) : (
          <ul className={styles.list}>
            {invitations.map((invitation) => (
              <li key={invitation.id} className={styles.row}>
                <div className={styles.details}>
                  <strong>{invitation.label || 'Unlabeled invite'}</strong>
                  <span>Created {displayDate(invitation.createdAt)}</span>
                  <span>Expires {displayDate(invitation.expiresAt)}</span>
                </div>
                <Badge
                  tone={
                    invitation.status === 'pending'
                      ? 'success'
                      : invitation.status === 'expired'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {invitation.status}
                </Badge>
                {invitation.status === 'pending' && (
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={revoking !== null}
                    loading={revoking === invitation.id}
                    onClick={() => revoke(invitation.id)}
                    aria-label={`Revoke ${invitation.label || 'unlabeled invite'}`}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card as="section" className={styles.section} aria-labelledby="users-title">
        <h2 id="users-title">Registered users</h2>
        {users.length === 0 ? (
          <p>No registered users.</p>
        ) : (
          <ul className={styles.list}>
            {users.map((user) => (
              <li key={user.id} className={styles.row}>
                <div className={styles.details}>
                  <strong>{user.email || `Account ${user.id.slice(0, 8)}`}</strong>
                  <span>Joined {displayDate(user.createdAt)}</span>
                </div>
                <Badge>{user.role}</Badge>
                {user.status && <span>{user.status.toLowerCase()}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
