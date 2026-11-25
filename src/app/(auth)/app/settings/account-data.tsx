'use client'

import { useState } from 'react'
import { Shield } from 'lucide-react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Dialog } from '@/components/ui/Dialog'
import { FormField } from '@/components/ui/FormField'
import { SectionHeading } from '@/components/ui/SectionHeading'
import styles from './account-data.module.scss'

export function AccountData() {
  const [open, setOpen] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [revoked, setRevoked] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  function close() {
    setOpen(false)
    setConfirmation('')
    setRevoked(false)
    setMessage('')
  }
  async function remove() {
    setPending(true)
    setMessage('')
    try {
      const response = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation, providerAccessRevoked: revoked }),
      })
      if (!response.ok) {
        setMessage(
          response.status === 409
            ? 'Wait for current sync or publication to finish, then retry.'
            : 'Could not delete your account. If you lost the response, reload to check whether you are signed out before retrying.',
        )
        return
      }
      // A full navigation discards private client state and the router cache.
      window.location.replace('/sign-in')
    } catch {
      setMessage('Connection lost. Reload to check whether you are signed out before retrying.')
    } finally {
      setPending(false)
    }
  }
  return (
    <Card as="section" className={styles.section} aria-labelledby="account-data-heading">
      <SectionHeading
        id="account-data-heading"
        icon={Shield}
        title="Account & data"
        subtitle="Download your private records or permanently delete your account."
      />
      <p>
        Your JSON archive includes your profile, activities, health, goals, plans and delivery
        history. It contains sensitive personal data. Keep the file private; credentials and session
        tokens are excluded.
      </p>
      <div className={styles.actions}>
        <ButtonLink
          href="/api/account/export"
          prefetch={false}
          download="running-coach-account.json"
          variant="secondary"
        >
          Download account data
        </ButtonLink>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Delete account
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={close}
        pending={pending}
        title="Permanently delete account"
        description="This removes your profile, activities, health, goals, all plan revisions, saved keys and sign-in sessions. It cannot be undone in the app."
        actions={
          <>
            <Button variant="secondary" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button
              onClick={() => void remove()}
              loading={pending}
              disabled={confirmation !== 'DELETE' || !revoked}
            >
              Permanently delete account
            </Button>
          </>
        }
      >
        <div className={styles.content}>
          <p>
            First revoke or regenerate any keys you saved here in your Garmin Personal API account,
            Intervals.icu Developer Settings and OpenAI API key settings. Deleting here removes
            local keys; provider revocation is performed by you.
          </p>
          <p>
            Published workouts and provider data remain in Intervals.icu, Garmin Connect and on your
            watch. Remove them there and disable onward forwarding if needed. Close other app tabs
            and wait for sync or publishing to finish.
          </p>
          <p>
            Backups expire under the operator&apos;s retention policy (maximum 30 days). A minimal
            deletion receipt is retained for 90 days to prevent recovery from restoring deleted
            data. There is no account recovery or undo.
          </p>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={revoked}
              disabled={pending}
              onChange={(event) => setRevoked(event.target.checked)}
            />
            <span>I have revoked all provider keys I saved here, or I have never saved any.</span>
          </label>
          <FormField
            id="account-deletion-confirmation"
            label="Type DELETE to confirm"
            value={confirmation}
            autoComplete="off"
            disabled={pending}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          {message && <p role="alert">{message}</p>}
        </div>
      </Dialog>
    </Card>
  )
}
