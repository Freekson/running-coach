'use client'

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Ban } from 'lucide-react'
import { z } from 'zod'
import { Badge, type BadgeProps } from '@/components/ui/Badge'
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

const invitationTones: Record<Invitation['status'], BadgeProps['tone']> = {
  pending: 'warning',
  used: 'success',
  revoked: 'error',
  expired: 'neutral',
}
const inviteToastKey = 'admin-invite-activity'
const invitationListSchema = z.object({
  invitations: z.array(
    z.object({ id: z.string(), status: z.enum(['pending', 'used', 'expired', 'revoked']) }),
  ),
})
type DisplayStatus = Invitation['status'] | 'checking' | 'checking-nonpending'
type InvitationFilter = 'all' | Invitation['status']
const invitationFilters: { value: InvitationFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'used', label: 'Used' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'expired', label: 'Expired' },
]

function LocalTime({ value }: { value: string }) {
  const isBrowser = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  )
  const formatted = isBrowser
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : 'Loading local time…'
  return (
    <time dateTime={value} title={new Date(value).toISOString()}>
      {formatted}
    </time>
  )
}

function subscribeNoop() {
  return () => {}
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
  const [newLink, setNewLink] = useState<{ id: string; url: string; expiresAt: string } | null>(
    null,
  )
  const [busy, setBusy] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokedIds, setRevokedIds] = useState<string[]>([])
  const [statusOverrides, setStatusOverrides] = useState<Record<string, DisplayStatus>>({})
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [filter, setFilter] = useState<InvitationFilter>('all')
  const filterSelection = useRef(0)
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    if (now === null) {
      const timer = setTimeout(() => setNow(Date.now()), 0)
      return () => clearTimeout(timer)
    }
    const pendingExpiries = invitations
      .filter((invitation) => invitation.status === 'pending')
      .map((invitation) => Date.parse(invitation.expiresAt))
    if (newLink) pendingExpiries.push(Date.parse(newLink.expiresAt))
    const nextExpiry = Math.min(...pendingExpiries.filter((expiry) => expiry > now))
    if (!Number.isFinite(nextExpiry)) return
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(nextExpiry - Date.now(), 2_147_483_647)),
    )
    return () => clearTimeout(timer)
  }, [invitations, newLink, now])
  function displayStatus(invitation: Invitation): DisplayStatus {
    if (invitation.status !== 'pending') return invitation.status
    if (revokedIds.includes(invitation.id)) return 'revoked'
    const confirmedStatus = statusOverrides[invitation.id]
    if (
      confirmedStatus === 'used' ||
      confirmedStatus === 'revoked' ||
      confirmedStatus === 'expired'
    ) {
      return confirmedStatus
    }
    if (now !== null && Date.parse(invitation.expiresAt) <= now) return 'expired'
    return confirmedStatus ?? 'pending'
  }

  const invitationRows = invitations.map((invitation) => ({
    invitation,
    status: displayStatus(invitation),
  }))
  const filterCounts = {
    all: invitationRows.length,
    pending: invitationRows.filter(({ status }) => status === 'pending').length,
    used: invitationRows.filter(({ status }) => status === 'used').length,
    revoked: invitationRows.filter(({ status }) => status === 'revoked').length,
    expired: invitationRows.filter(({ status }) => status === 'expired').length,
  }
  const visibleInvitations = invitationRows.filter(
    ({ status }) => filter === 'all' || status === filter,
  )

  const listedNewLink = invitations.find((invitation) => invitation.id === newLink?.id)
  const newLinkStatus = listedNewLink
    ? displayStatus(listedNewLink)
    : newLink && (statusOverrides[newLink.id] ?? 'pending')
  const showNewLink =
    newLink &&
    !revokedIds.includes(newLink.id) &&
    (newLinkStatus === 'pending' || newLinkStatus === 'checking') &&
    (now === null || Date.parse(newLink.expiresAt) > now)

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
      const created: { id: string; url: string; expiresAt: string } = await response.json()
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

  async function checkStatus(
    id: string,
    knownNonPending: boolean,
    filterSelectionAtStart = filterSelection.current,
  ) {
    setCheckingId(id)
    try {
      const response = await fetch('/api/admin/invitations', { cache: 'no-store' })
      if (!response.ok) throw new Error('Status check failed')
      const parsed = invitationListSchema.safeParse(await response.json())
      const status = parsed.success
        ? parsed.data.invitations.find((invitation) => invitation.id === id)?.status
        : undefined
      if (!status || (knownNonPending && status === 'pending')) {
        throw new Error('Invitation status unavailable')
      }
      setStatusOverrides((current) => ({ ...current, [id]: status }))
      if (status !== 'pending') setNewLink((current) => (current?.id === id ? null : current))
      toast(
        status === 'revoked' ? 'success' : 'info',
        status === 'pending' ? 'Invite is still pending.' : `Invite is ${status}.`,
        inviteToastKey,
      )
    } catch {
      // Keep a retry reachable unless the admin chose another filter while the request ran.
      if (filterSelection.current === filterSelectionAtStart) setFilter('all')
      toast('error', 'Could not verify invite status. Check again before sharing.', inviteToastKey)
    } finally {
      setCheckingId(null)
      router.refresh()
    }
  }

  async function revoke(id: string) {
    if (!window.confirm('Revoke this invite link? It will stop working immediately.')) return
    const filterSelectionAtStart = filterSelection.current
    setRevoking(id)
    try {
      const response = await fetch(`/api/admin/invitations/${id}`, { method: 'DELETE' })
      if (response.status === 409) {
        setStatusOverrides((current) => ({ ...current, [id]: 'checking-nonpending' }))
        setNewLink((current) => (current?.id === id ? null : current))
        toast('warning', 'This invite is no longer pending. Checking its status.', inviteToastKey)
        await checkStatus(id, true, filterSelectionAtStart)
        return
      }
      if (!response.ok) throw new Error('Revoke failed')
      setRevokedIds((current) => [...current, id])
      setNewLink((current) => (current?.id === id ? null : current))
      toast(
        'success',
        'Invite revoked. Generate a new link if you need a replacement.',
        inviteToastKey,
      )
      router.refresh()
    } catch {
      setStatusOverrides((current) => ({ ...current, [id]: 'checking' }))
      toast('warning', 'Could not confirm revocation. Checking the invite status.', inviteToastKey)
      await checkStatus(id, false, filterSelectionAtStart)
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
          <Button type="submit" size="compact" className={styles.generate} loading={busy}>
            Generate invite link
          </Button>
        </form>
        {showNewLink && (
          <div className={styles.created} role="status">
            <strong>New invite link</strong>
            <p>Copy this link now. It cannot be shown again after you leave this page.</p>
            <CopyableField
              id="new-invite-link"
              label="Link to share"
              value={newLink.url}
              disabled={revoking === newLink.id || newLinkStatus !== 'pending'}
              onCopySuccess={() => toast('success', 'Invite link copied.', inviteToastKey)}
              onCopyError={() =>
                toast('error', 'Copy failed. Select and copy the link manually.', inviteToastKey)
              }
            />
            {newLinkStatus === 'checking' && <p>Checking this link before it can be shared.</p>}
            <p>
              Expires <LocalTime value={newLink.expiresAt} />
            </p>
          </div>
        )}
      </Card>
      <Card as="section" className={styles.section} aria-labelledby="invitations-title">
        <h2 id="invitations-title">Invitations</h2>
        <div className={styles.filters} role="group" aria-label="Filter invitations by status">
          {invitationFilters.map(({ value, label: filterLabel }) => (
            <button
              key={value}
              type="button"
              className={styles.filter}
              aria-pressed={filter === value}
              onClick={() => {
                filterSelection.current += 1
                setFilter(value)
              }}
            >
              {filterLabel} <span className={styles.filterCount}>{filterCounts[value]}</span>
            </button>
          ))}
        </div>
        {visibleInvitations.length === 0 ? (
          <p className={styles.empty} role="status">
            {filter === 'all'
              ? 'No invitations yet. Generate a link to invite someone.'
              : `No ${filter} invitations in this list.`}
          </p>
        ) : (
          <ul className={styles.list}>
            {visibleInvitations.map(({ invitation, status }) => {
              const checking = status === 'checking' || status === 'checking-nonpending'
              return (
                <li key={invitation.id} className={`${styles.row} ${styles.invitationRow}`}>
                  <div className={styles.details}>
                    <strong>{invitation.label || 'Unlabeled invite'}</strong>
                    <span>
                      Created <LocalTime value={invitation.createdAt} />
                    </span>
                    <span>
                      Expires <LocalTime value={invitation.expiresAt} />
                    </span>
                  </div>
                  <div className={styles.invitationStatus}>
                    <Badge tone={checking ? 'neutral' : invitationTones[status]}>
                      {checking ? 'Checking status' : status[0].toUpperCase() + status.slice(1)}
                    </Badge>
                  </div>
                  <div className={styles.invitationAction}>
                    {status === 'pending' && (
                      <Button
                        variant="secondary"
                        size="compact"
                        className={styles.revoke}
                        disabled={revoking !== null}
                        loading={revoking === invitation.id}
                        onClick={() => revoke(invitation.id)}
                        aria-label={`Revoke invitation: ${invitation.label || 'unlabeled invite'}`}
                        title="Revoke invitation"
                      >
                        {revoking !== invitation.id && (
                          <Ban size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                        )}
                      </Button>
                    )}
                    {checking && (
                      <Button
                        variant="secondary"
                        size="compact"
                        disabled={checkingId !== null}
                        loading={checkingId === invitation.id}
                        onClick={() => checkStatus(invitation.id, status === 'checking-nonpending')}
                        aria-label={`Check status for ${invitation.label || 'unlabeled invite'}`}
                      >
                        Check status
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
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
                  <span>
                    Joined <LocalTime value={user.createdAt} />
                  </span>
                </div>
                <div className={styles.actions}>
                  <Badge>{user.role}</Badge>
                  {user.status && (
                    <Badge
                      tone={
                        user.status === 'ACTIVE'
                          ? 'success'
                          : user.status === 'SUSPENDED'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {user.status[0] + user.status.slice(1).toLowerCase()}
                    </Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
