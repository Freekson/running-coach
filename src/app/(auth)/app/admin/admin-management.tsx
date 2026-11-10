'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react'
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock3,
  Info,
  Mail,
  Plus,
  RotateCcw,
  TriangleAlert,
  UsersRound,
} from 'lucide-react'
import { AdminBadge } from '@/components/ui/AdminBadge'
import { Badge, type BadgeProps } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { CopyableField } from '@/components/ui/CopyableField'
import { Dialog } from '@/components/ui/Dialog'
import { FormField } from '@/components/ui/FormField'
import { LoadingState } from '@/components/ui/States'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { useToast } from '@/components/ui/Toast'
import styles from './admin-management.module.scss'

type Status = 'pending' | 'processing' | 'used' | 'expired' | 'revoked'
type Filter = 'all' | Status
type Invitation = {
  id: string
  label: string | null
  createdAt: string
  expiresAt: string
  status: Status
  revision: string
}
type RegisteredUser = {
  id: string
  email: string | null
  role: 'ADMIN' | 'USER'
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | null
  createdAt: string
}
type Counts = Record<Filter, number>
type InvitePage = { invitations: Invitation[]; page: number; total: number; counts: Counts }
type UserPage = { users: RegisteredUser[]; page: number; total: number }
type OneTimeLink = { id: string; url: string; expiresAt: string }
const PAGE_SIZE = 5
const filters: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'processing', label: 'Processing' },
  { value: 'used', label: 'Used' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'expired', label: 'Expired' },
]
const tones: Record<Status, BadgeProps['tone']> = {
  pending: 'warning',
  processing: 'warning',
  used: 'success',
  revoked: 'error',
  expired: 'neutral',
}
const toastKey = 'admin-invite-activity'
const subscribeNoop = () => () => {}

function LocalTime({ value, short = false }: { value: string; short?: boolean }) {
  const browser = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  )
  return (
    <time dateTime={value}>
      {browser
        ? new Intl.DateTimeFormat(
            undefined,
            short
              ? {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hourCycle: 'h23',
                }
              : { dateStyle: 'medium', timeStyle: 'short' },
          ).format(new Date(value))
        : 'Loading local time…'}
    </time>
  )
}

function Pager({
  label,
  page,
  total,
  loading,
  onPage,
}: {
  label: string
  page: number
  total: number
  loading: boolean
  onPage: (page: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const last = Math.min(page * PAGE_SIZE, total)
  return (
    <nav className={styles.pager} aria-label={`${label} pages`}>
      <span role="status" aria-live="polite">
        {first}–{last} of {total}
      </span>
      <div className={styles.pagerActions}>
        <Button
          variant="secondary"
          size="compact"
          className={styles.pagerButton}
          aria-label={`Previous ${label.toLowerCase()} page`}
          disabled={loading || page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
        </Button>
        <span className={styles.pagerNumber}>
          {page} / {pages}
        </span>
        <Button
          variant="secondary"
          size="compact"
          className={styles.pagerButton}
          aria-label={`Next ${label.toLowerCase()} page`}
          disabled={loading || page >= pages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
        </Button>
      </div>
    </nav>
  )
}

export function AdminManagement({
  invitations,
  invitationPage,
  invitationTotal,
  invitationCounts,
  users,
  userPage,
  userTotal,
}: {
  invitations: Invitation[]
  invitationPage: number
  invitationTotal: number
  invitationCounts: Counts
  users: RegisteredUser[]
  userPage: number
  userTotal: number
}) {
  const toast = useToast()
  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [newLink, setNewLink] = useState<OneTimeLink | null>(null)
  const [inviteData, setInviteData] = useState<InvitePage>({
    invitations,
    page: invitationPage,
    total: invitationTotal,
    counts: invitationCounts,
  })
  const [userData, setUserData] = useState<UserPage>({ users, page: userPage, total: userTotal })
  const [filter, setFilter] = useState<Filter>('all')
  const [inviteLoading, setInviteLoading] = useState(false)
  const [userLoading, setUserLoading] = useState(false)
  const [inviteError, setInviteError] = useState(false)
  const [userError, setUserError] = useState(false)
  const [dialog, setDialog] = useState<{
    kind: 'revoke' | 'regenerate'
    invitation: Invitation
  } | null>(null)
  const [pending, setPending] = useState(false)
  const [regenerated, setRegenerated] = useState<OneTimeLink | null>(null)
  const inviteRequest = useRef(0)
  const userRequest = useRef(0)
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), 0)
    return () => clearTimeout(timer)
  }, [])
  const loadInvites = useCallback(async (page: number, status: Filter) => {
    const requestId = ++inviteRequest.current
    setInviteLoading(true)
    setInviteError(false)
    try {
      const response = await fetch(`/api/admin/invitations?page=${page}&status=${status}`, {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('Could not load invitations')
      const data: InvitePage = await response.json()
      if (requestId === inviteRequest.current) setInviteData(data)
    } catch {
      if (requestId === inviteRequest.current) setInviteError(true)
    } finally {
      if (requestId === inviteRequest.current) setInviteLoading(false)
    }
  }, [])
  const loadUsers = useCallback(async (page: number) => {
    const requestId = ++userRequest.current
    setUserLoading(true)
    setUserError(false)
    try {
      const response = await fetch(`/api/admin/users?page=${page}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('Could not load users')
      const data: UserPage = await response.json()
      if (requestId === userRequest.current) setUserData(data)
    } catch {
      if (requestId === userRequest.current) setUserError(true)
    } finally {
      if (requestId === userRequest.current) setUserLoading(false)
    }
  }, [])
  useEffect(() => {
    const next = Math.min(
      ...inviteData.invitations
        .filter((item) => item.status === 'pending' || item.status === 'processing')
        .map((item) => Date.parse(item.expiresAt))
        .filter((time) => time > (now ?? Date.now())),
    )
    if (!Number.isFinite(next)) return
    const timer = setTimeout(
      () => {
        setNow(Date.now())
        void loadInvites(inviteData.page, filter)
      },
      Math.max(0, Math.min(next - Date.now(), 2_147_483_647)),
    )
    return () => clearTimeout(timer)
  }, [inviteData.invitations, inviteData.page, now, filter, loadInvites])
  function closeDialog() {
    if (!pending) {
      setDialog(null)
      setRegenerated(null)
    }
  }
  function effectiveStatus(item: Invitation): Status {
    return (item.status === 'pending' || item.status === 'processing') &&
      now !== null &&
      Date.parse(item.expiresAt) <= now
      ? 'expired'
      : item.status
  }
  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (creating) return
    setCreating(true)
    setNewLink(null)
    try {
      const response = await fetch('/api/admin/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || null }),
      })
      if (!response.ok) throw new Error('Could not create invitation')
      const created: OneTimeLink = await response.json()
      setNewLink(created)
      setLabel('')
      await loadInvites(1, filter)
    } catch {
      toast(
        'error',
        'Could not show the invite link. Check the list before trying again; revoke a lost link.',
        toastKey,
      )
      await loadInvites(inviteData.page, filter)
    } finally {
      setCreating(false)
    }
  }
  async function checkStatus(id: string) {
    try {
      const response = await fetch(`/api/admin/invitations/${id}/status`, {
        method: 'POST',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('Status unavailable')
      const result: { status: Status } = await response.json()
      if (result.status !== 'pending')
        setNewLink((current) => (current?.id === id ? null : current))
      toast('info', `Invite is ${result.status}.`, toastKey)
    } catch {
      toast('error', 'Could not verify invite status. Try again.', toastKey)
    }
    await loadInvites(inviteData.page, filter)
  }
  async function confirmAction() {
    if (!dialog || pending) return
    const { kind, invitation } = dialog
    setPending(true)
    try {
      const response = await fetch(
        `/api/admin/invitations/${invitation.id}${kind === 'regenerate' ? '/regenerate' : ''}`,
        kind === 'regenerate'
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ revision: invitation.revision }),
            }
          : { method: 'DELETE' },
      )
      if (response.status === 409) {
        toast(
          'warning',
          'This invite is no longer pending. Its status has been refreshed.',
          toastKey,
        )
        setNewLink((current) => (current?.id === invitation.id ? null : current))
        setDialog(null)
      } else if (!response.ok) throw new Error('Action failed')
      else if (kind === 'regenerate') {
        const link: OneTimeLink = await response.json()
        setRegenerated(link)
        setNewLink((current) => (current?.id === invitation.id ? null : current))
        toast('success', 'New invitation link ready to copy.', toastKey)
      } else {
        setNewLink((current) => (current?.id === invitation.id ? null : current))
        setDialog(null)
        toast('success', 'Invite revoked. Generate a new link if you need a replacement.', toastKey)
      }
      await loadInvites(inviteData.page, filter)
    } catch {
      toast(
        'error',
        kind === 'regenerate'
          ? 'Could not regenerate the link. Refresh the list before retrying.'
          : 'Could not confirm revocation. Check invite status before sharing.',
        toastKey,
      )
      await loadInvites(inviteData.page, filter)
    } finally {
      setPending(false)
    }
  }
  const freshLink =
    newLink &&
    (now === null || Date.parse(newLink.expiresAt) > now) &&
    (inviteData.invitations.find((item) => item.id === newLink.id)?.status ?? 'pending') ===
      'pending'
  return (
    <div className={styles.page}>
      <header>
        <h1>Admin</h1>
        <p>Manage invite links and registered users.</p>
      </header>
      <Card
        as="section"
        className={`${styles.section} ${styles.generateSection}`}
        aria-labelledby="generate-title"
      >
        <SectionHeading
          icon={Plus}
          id="generate-title"
          title="Generate invite link"
          subtitle="Create a single-use invitation valid for 7 days."
        />
        <form onSubmit={generate} className={styles.form}>
          <FormField
            id="invite-label"
            label="Description"
            optional
            placeholder="e.g. Invitation for John"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={120}
          />
          <Button type="submit" size="compact" className={styles.generate} loading={creating}>
            <Plus size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
            Generate link
          </Button>
        </form>
        {freshLink && (
          <div className={styles.created} role="status">
            <div className={styles.createdHeading}>
              <CircleCheck size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
              <strong>Invitation created</strong>
            </div>
            <div className={styles.linkField}>
              <CopyableField
                id="new-invite-link"
                label="Link to share"
                value={newLink.url}
                onCopySuccess={() => toast('success', 'Invite link copied.', toastKey)}
                onCopyError={() =>
                  toast('error', 'Copy failed. Select and copy the link manually.', toastKey)
                }
              />
            </div>
            <div className={styles.createdDetails}>
              <p className={styles.createdMeta}>
                <Clock3 size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
                <span>
                  Expires <LocalTime value={newLink.expiresAt} />
                </span>
              </p>
              <p className={styles.createdMeta}>
                <Info size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
                <span>
                  Save this link now. It won&apos;t be shown again after you leave this page.
                </span>
              </p>
            </div>
          </div>
        )}
      </Card>
      <Card as="section" className={styles.section} aria-labelledby="invitations-title">
        <div className={styles.sectionHeading}>
          <SectionHeading icon={Mail} id="invitations-title" title="Invitations" />
          <span>{inviteData.counts.all} invitations</span>
        </div>
        <div className={styles.filters} role="group" aria-label="Filter invitations by status">
          {filters.map(({ value, label: name }) => (
            <button
              key={value}
              type="button"
              className={styles.filter}
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value)
                void loadInvites(1, value)
              }}
            >
              {name} <span className={styles.filterCount}>{inviteData.counts[value]}</span>
            </button>
          ))}
        </div>
        <div
          className={`${styles.tableRegion} ${styles.invitationTableRegion}`}
          role="region"
          aria-label="Invitation rows"
          aria-busy={inviteLoading || undefined}
        >
          <table className={`${styles.dataTable} ${styles.invitationTable}`}>
            <thead>
              <tr>
                <th scope="col">Invitation</th>
                <th scope="col">Created</th>
                <th scope="col">Expires</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!inviteLoading &&
                !inviteError &&
                inviteData.invitations.map((item) => {
                  const status = effectiveStatus(item)
                  return (
                    <tr key={item.id}>
                      <td className={styles.primaryCell}>
                        <strong>{item.label || 'Unlabeled invite'}</strong>
                      </td>
                      <td className={styles.dateCell}>
                        <LocalTime value={item.createdAt} short />
                      </td>
                      <td className={styles.dateCell}>
                        <LocalTime value={item.expiresAt} short />
                      </td>
                      <td>
                        <Badge className={styles.tableBadge} tone={tones[status]}>
                          {status[0].toUpperCase() + status.slice(1)}
                        </Badge>
                      </td>
                      <td className={styles.actionCell}>
                        {status === 'pending' && (
                          <div className={styles.tableActions}>
                            <Button
                              variant="secondary"
                              size="compact"
                              className={styles.iconAction}
                              aria-label="Regenerate invitation link"
                              title="Regenerate invitation link"
                              onClick={() => {
                                setRegenerated(null)
                                setDialog({ kind: 'regenerate', invitation: item })
                              }}
                            >
                              <RotateCcw
                                size={18}
                                strokeWidth={2}
                                aria-hidden="true"
                                focusable="false"
                              />
                            </Button>
                            <Button
                              variant="secondary"
                              size="compact"
                              className={styles.iconAction}
                              aria-label={`Revoke invitation: ${item.label || 'unlabeled invite'}`}
                              title="Revoke invitation"
                              onClick={() => setDialog({ kind: 'revoke', invitation: item })}
                            >
                              <Ban size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                            </Button>
                          </div>
                        )}
                        {status === 'processing' && (
                          <Button
                            variant="secondary"
                            size="compact"
                            onClick={() => void checkStatus(item.id)}
                            aria-label={`Check status for ${item.label || 'unlabeled invite'}`}
                          >
                            Check status
                          </Button>
                        )}
                        {status !== 'pending' && status !== 'processing' && (
                          <span aria-label="No actions">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              {Array.from(
                {
                  length: Math.max(
                    0,
                    PAGE_SIZE -
                      (!inviteLoading && !inviteError ? inviteData.invitations.length : 0),
                  ),
                },
                (_, index) => (
                  <tr
                    key={`empty-invitation-${index}`}
                    className={styles.placeholderRow}
                    aria-hidden="true"
                  >
                    <td colSpan={5} />
                  </tr>
                ),
              )}
            </tbody>
          </table>
          {inviteLoading && (
            <div className={styles.tableOverlay}>
              <LoadingState label="Loading invitations…" />
            </div>
          )}
          {inviteError && (
            <div className={styles.tableOverlay} role="alert">
              Could not load invitations.{' '}
              <Button
                variant="secondary"
                size="compact"
                onClick={() => void loadInvites(inviteData.page, filter)}
              >
                Retry
              </Button>
            </div>
          )}
          {!inviteLoading && !inviteError && inviteData.invitations.length === 0 && (
            <div className={styles.tableOverlay} role="status">
              {filter === 'all'
                ? 'No invitations yet. Generate a link to invite someone.'
                : `No ${filter} invitations.`}
            </div>
          )}
        </div>
        <Pager
          label="Invitations"
          page={inviteData.page}
          total={inviteData.total}
          loading={inviteLoading}
          onPage={(page) => void loadInvites(page, filter)}
        />
      </Card>
      <Card as="section" className={styles.section} aria-labelledby="users-title">
        <div className={styles.sectionHeading}>
          <SectionHeading icon={UsersRound} id="users-title" title="Registered users" />
          <span>{userData.total} users</span>
        </div>
        <div
          className={`${styles.tableRegion} ${styles.userTableRegion}`}
          role="region"
          aria-label="Registered user rows"
          aria-busy={userLoading || undefined}
        >
          <table className={`${styles.dataTable} ${styles.userTable}`}>
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Joined</th>
                <th scope="col">Role</th>
              </tr>
            </thead>
            <tbody>
              {!userLoading &&
                !userError &&
                userData.users.map((user) => (
                  <tr key={user.id}>
                    <td className={styles.primaryCell}>
                      <strong>{user.email || `Account ${user.id.slice(0, 8)}`}</strong>
                    </td>
                    <td className={styles.dateCell}>
                      <LocalTime value={user.createdAt} short />
                    </td>
                    <td>
                      {user.role === 'ADMIN' ? (
                        <AdminBadge />
                      ) : (
                        <Badge className={styles.tableBadge}>USER</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              {Array.from(
                {
                  length: Math.max(
                    0,
                    PAGE_SIZE - (!userLoading && !userError ? userData.users.length : 0),
                  ),
                },
                (_, index) => (
                  <tr
                    key={`empty-user-${index}`}
                    className={styles.placeholderRow}
                    aria-hidden="true"
                  >
                    <td colSpan={3} />
                  </tr>
                ),
              )}
            </tbody>
          </table>
          {userLoading && (
            <div className={styles.tableOverlay}>
              <LoadingState label="Loading registered users…" />
            </div>
          )}
          {userError && (
            <div className={styles.tableOverlay} role="alert">
              Could not load registered users.{' '}
              <Button
                variant="secondary"
                size="compact"
                onClick={() => void loadUsers(userData.page)}
              >
                Retry
              </Button>
            </div>
          )}
          {!userLoading && !userError && userData.users.length === 0 && (
            <div className={styles.tableOverlay} role="status">
              No registered users.
            </div>
          )}
        </div>
        <Pager
          label="Registered users"
          page={userData.page}
          total={userData.total}
          loading={userLoading}
          onPage={(page) => void loadUsers(page)}
        />
      </Card>
      {dialog && (
        <Dialog
          open
          title={
            regenerated
              ? 'Invitation regenerated'
              : dialog.kind === 'revoke'
                ? 'Revoke invitation?'
                : 'Regenerate invitation?'
          }
          description={
            regenerated
              ? 'Your new link is ready. The previous link is no longer valid.'
              : dialog.kind === 'revoke'
                ? 'This invitation link will stop working immediately. This action cannot be undone.'
                : 'A new invitation link will be generated.'
          }
          icon={
            dialog.kind === 'revoke' ? (
              <Ban size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
            ) : regenerated ? (
              <CircleCheck size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
            ) : (
              <RotateCcw size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
            )
          }
          iconTone={dialog.kind === 'revoke' ? 'error' : 'success'}
          size={regenerated ? 'wide' : 'default'}
          onClose={closeDialog}
          pending={pending}
          actions={
            regenerated ? (
              <Button
                key={pending ? 'pending' : 'ready'}
                onClick={closeDialog}
                disabled={pending}
                autoFocus={!pending}
              >
                Done
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={closeDialog} disabled={pending}>
                  Cancel
                </Button>
                <Button
                  className={dialog.kind === 'revoke' ? styles.revokeAction : undefined}
                  onClick={() => void confirmAction()}
                  loading={pending}
                >
                  {dialog.kind === 'regenerate' && (
                    <RotateCcw size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
                  )}
                  {dialog.kind === 'revoke' ? 'Revoke invitation' : 'Regenerate link'}
                </Button>
              </>
            )
          }
        >
          {regenerated ? (
            <div className={styles.regeneratedContent}>
              <strong className={styles.regeneratedLabel}>New invitation link</strong>
              <div className={styles.linkField}>
                <CopyableField
                  id="regenerated-invite-link"
                  label="Link to share"
                  value={regenerated.url}
                  onCopySuccess={() => toast('success', 'Invite link copied.', toastKey)}
                  onCopyError={() =>
                    toast('error', 'Copy failed. Select and copy the link manually.', toastKey)
                  }
                />
              </div>
              <div className={styles.createdDetails}>
                <p className={styles.createdMeta}>
                  <Clock3 size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
                  <span>
                    Expires <LocalTime value={regenerated.expiresAt} />
                  </span>
                </p>
                <p className={styles.createdMeta}>
                  <Info size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
                  <span>Copy this link now. Closing this dialog clears it.</span>
                </p>
              </div>
            </div>
          ) : dialog.kind === 'regenerate' ? (
            <p className={styles.regenerationWarning}>
              <TriangleAlert size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
              <span>
                The previous link will stop working immediately. The expiration date stays the same.
              </span>
            </p>
          ) : null}
        </Dialog>
      )}
    </div>
  )
}
