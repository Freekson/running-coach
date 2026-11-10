'use client'

import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState, LoadingState } from '@/components/ui/States'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { useToast } from '@/components/ui/Toast'
import { garminSyncStateSchema, type GarminSyncState } from '@/lib/garmin-sync-state'
import { garminAccountIssueMessage } from '@/lib/garmin-account-message'
import { formatLocalDateTime } from '@/lib/local-time'
import { useClientReady } from '@/lib/use-client-ready'
import styles from './activity-sync-panel.module.scss'

const endpoint = '/api/integrations/garmin/sync'
const syncErrorSchema = z.object({ code: z.string() })

function syncFailureMessage(status: number, code: string | null): string {
  const accountIssue = garminAccountIssueMessage(code)
  if (accountIssue) return accountIssue
  if (code === 'INVALID_KEY') return 'The saved Garmin key was rejected. Replace it in Settings.'
  if (code === 'UNVERIFIABLE')
    return 'Garmin account identity could not be verified. Try again later or replace the key.'
  if (code === 'CREDENTIAL_CHANGED')
    return 'The Garmin key changed during verification. Refresh and try again.'
  if (code === 'KEY_STORAGE_UNCONFIGURED')
    return 'Key storage is not configured. Contact the site administrator.'
  if (status === 429) return 'Garmin asked us to pause. Try again later.'
  if (status === 403) return 'Garmin activity sync is unavailable for this deployment.'
  return 'Activity sync could not start. Try again later.'
}

export function ActivitySyncPanel({ initial }: { initial: GarminSyncState }) {
  const router = useRouter()
  const toast = useToast()
  const clientReady = useClientReady()
  const [override, setOverride] = useState<{
    initial: GarminSyncState
    value: GarminSyncState
  } | null>(null)
  const state = override?.initial === initial ? override.value : initial
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    if (state.status !== 'SYNCING' && state.status !== 'PAUSED') return
    const retryAt = state.nextAttemptAt ? Date.parse(state.nextAttemptAt) : NaN
    const delay =
      state.status === 'SYNCING'
        ? 5_000
        : Number.isFinite(retryAt)
          ? Math.max(5_000, Math.min(60_000, retryAt - Date.now() + 1_000))
          : 60_000
    let active = true
    const timer = window.setTimeout(() => {
      void fetch(endpoint, { credentials: 'same-origin', cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) return
          const parsed = garminSyncStateSchema.safeParse(await response.json())
          if (active && parsed.success) setOverride({ initial, value: parsed.data })
        })
        .catch(() => {})
        .finally(() => {
          if (active) setRefreshTick((tick) => tick + 1)
        })
    }, delay)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [state.status, state.nextAttemptAt, initial, refreshTick])

  async function sync(extendDays?: number) {
    if (pending) return
    setPending(true)
    setError('')
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify(extendDays ? { extendDays } : {}),
      })
      if (!response.ok) {
        let code: string | null = null
        try {
          const parsed = syncErrorSchema.safeParse(await response.json())
          if (parsed.success) code = parsed.data.code
        } catch {
          // Failed responses may have no JSON body.
        }
        const message = syncFailureMessage(response.status, code)
        setError(message)
        toast('error', message, 'garmin-activity-sync')
        return
      }
      const parsed = garminSyncStateSchema.safeParse(await response.json())
      if (!parsed.success) throw new Error('Invalid sync response')
      const next = parsed.data
      setOverride({ initial, value: next })
      router.refresh()
      if (next.status === 'SUCCESS')
        toast('success', 'Garmin activities are up to date.', 'garmin-activity-sync')
      else if (next.status === 'PARTIAL')
        toast('info', 'Activity sync progress was saved.', 'garmin-activity-sync')
      else if (next.status === 'PAUSED')
        toast('warning', 'Garmin activity sync is paused.', 'garmin-activity-sync')
      else if (next.status === 'ACTION_REQUIRED')
        toast(
          'error',
          garminAccountIssueMessage(next.errorCode) ?? 'Check your Garmin connection in Settings.',
          'garmin-activity-sync',
        )
      else toast('error', 'Activity sync stopped before finishing.', 'garmin-activity-sync')
    } catch {
      const message = 'Activity sync could not finish. Try again later.'
      setError(message)
      toast('error', message, 'garmin-activity-sync')
    } finally {
      setPending(false)
    }
  }

  if (state.status === 'ACTION_REQUIRED' && state.errorCode === 'ACCOUNT_VERIFICATION_REQUIRED')
    return (
      <EmptyState
        title="Verify your saved Garmin key"
        description="This key has no verified Garmin account identity. Verify it before importing activities."
        action={
          <div className={styles.verificationActions}>
            <Button type="button" onClick={() => void sync()} loading={pending}>
              Verify &amp; import
            </Button>
            <Link href="/app/settings">Open Settings</Link>
            {error && <p role="alert">{error}</p>}
          </div>
        }
      />
    )
  if (state.status === 'NOT_CONNECTED' || state.status === 'ACTION_REQUIRED')
    return (
      <EmptyState
        title={
          state.status === 'NOT_CONNECTED'
            ? 'Connect Garmin to import activities'
            : 'Garmin connection needs attention'
        }
        description={
          garminAccountIssueMessage(state.errorCode) ??
          'Add or check your Garmin key in Settings, then return here.'
        }
        action={<Link href="/app/settings">Open Settings</Link>}
      />
    )

  return (
    <Card as="section" className={styles.panel} aria-labelledby="activity-sync-heading">
      <SectionHeading
        icon={Activity}
        id="activity-sync-heading"
        title="Garmin activities"
        subtitle="Import completed runs and resume saved backfill progress."
      />
      {state.status === 'UNAVAILABLE' ? (
        <p role="status">Garmin activity sync is unavailable for this deployment.</p>
      ) : (
        <div className={styles.actions}>
          <Button
            type="button"
            onClick={() => void sync()}
            loading={pending}
            disabled={pending || state.status === 'SYNCING' || state.status === 'PAUSED'}
          >
            {state.status === 'PARTIAL' ? 'Continue sync' : 'Sync activities'}
          </Button>
          {state.status === 'SUCCESS' && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void sync(7)}
              disabled={pending}
            >
              Import 7 older days
            </Button>
          )}
        </div>
      )}
      {pending && <LoadingState label="Syncing Garmin activities…" />}
      {!pending && state.status === 'SYNCING' && (
        <p role="status">An activity sync is already running.</p>
      )}
      {!pending && state.status === 'PAUSED' && (
        <p role="status">Garmin asked us to pause. Sync will be available after the retry time.</p>
      )}
      {!pending && !error && (state.status === 'ERROR' || state.status === 'PARTIAL_FAILURE') && (
        <p role="alert">The last activity sync stopped early. You can retry when available.</p>
      )}
      {state.nextDate && <p role="status">Next day to check: {state.nextDate}</p>}
      {state.lastAttemptAt && <p>Last batch processed {state.processed} activities.</p>}
      {state.lastSuccessAt && (
        <p>
          Last completed window:{' '}
          {clientReady
            ? (formatLocalDateTime(state.lastSuccessAt) ?? 'Time unavailable')
            : 'Loading local time…'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </Card>
  )
}
