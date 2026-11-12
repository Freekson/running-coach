'use client'

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/States'
import { useToast } from '@/components/ui/Toast'
import { garminSyncStateSchema, type GarminSyncState } from '@/lib/garmin-sync-state'
import { garminAccountIssueMessage } from '@/lib/garmin-account-message'
import { formatLocalDateTime } from '@/lib/local-time'
import { useClientReady } from '@/lib/use-client-ready'
import styles from './health-sync-panel.module.scss'

const syncErrorSchema = z.object({
  code: z.string(),
  retryAt: z.string().nullable().optional(),
})
const pendingSleepMessage =
  'Some Garmin sleep dates could not be verified. Other dates were saved; use Sync now to retry them.'

function localDateTime(value: string, ready: boolean): string {
  return ready ? (formatLocalDateTime(value) ?? 'Time unavailable') : 'Loading local time…'
}

function retrySuffix(value: string | null | undefined, ready = true): string {
  if (!value || !Number.isFinite(Date.parse(value))) return ' Try again later.'
  return ` Retry after ${localDateTime(value, ready)}.`
}

function pausedMessage(state: GarminSyncState, ready: boolean): string {
  const reason = failureMessage(state.errorCode)
  return `${reason}${retrySuffix(state.nextAttemptAt, ready)}`
}

function failureMessage(code: string | null): string {
  const accountIssue = garminAccountIssueMessage(code)
  if (accountIssue) return accountIssue
  if (code === 'RATE_LIMITED') return 'Garmin asked us to pause health requests.'
  if (code?.startsWith('SLEEP_')) {
    if (code === 'SLEEP_TIMEOUT' || code === 'SLEEP_NETWORK')
      return 'Garmin sleep did not respond. Saved daily summaries are safe; sleep can be retried.'
    if (code === 'SLEEP_INVALID_RESPONSE' || code === 'SLEEP_DATE_MISMATCH')
      return 'Garmin sleep data could not be verified. Saved daily summaries are safe; sleep can be retried.'
    return 'The Garmin sleep request failed. Saved daily summaries are safe; sleep can be retried.'
  }
  if (code?.startsWith('SUMMARY_')) return 'The Garmin daily summary request failed.'
  return 'A Garmin health request failed. Saved readings remain available.'
}

function responseFailureMessage(
  status: number,
  code: string | null,
  retryAt: string | null,
): string {
  const accountIssue = garminAccountIssueMessage(code)
  if (accountIssue) return accountIssue
  if (code === 'INVALID_KEY') return 'The saved Garmin key was rejected. Replace it in Settings.'
  if (code === 'UNVERIFIABLE')
    return 'Garmin account identity could not be verified. Try again later or replace the key.'
  if (code === 'CREDENTIAL_CHANGED')
    return 'The Garmin key changed during verification. Refresh and try again.'
  if (code === 'KEY_STORAGE_UNCONFIGURED')
    return 'Key storage is not configured. Contact the site administrator.'
  if (status === 429) {
    if (code === 'APP_RATE_LIMITED')
      return `Too many Garmin sync requests in one minute.${retrySuffix(retryAt)}`
    if (code === 'PROVIDER_PAUSED') return `Garmin asked us to pause.${retrySuffix(retryAt)}`
    return `Health sync is paused.${retrySuffix(retryAt)}`
  }
  if (status === 409) return 'A health sync is already running, or the Garmin key needs attention.'
  return 'Health sync could not finish. Try again later.'
}

export function HealthSyncPanel({
  initial,
  initialImportReady = true,
}: {
  initial: GarminSyncState
  initialImportReady?: boolean
}) {
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
  const [notice, setNotice] = useState('')
  const hasSavedProgress =
    state.processed > 0 ||
    Boolean(state.sleepRetryDates?.length) ||
    Boolean(state.window && state.nextDate && state.nextDate > state.window.start)

  useEffect(() => {
    if (state.status !== 'SYNCING') return
    const timer = window.setInterval(() => router.refresh(), 5_000)
    return () => window.clearInterval(timer)
  }, [state.status, router])

  async function sync() {
    if (pending) return
    setPending(true)
    setError('')
    setNotice('')
    try {
      const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      // A complete initial window takes up to three bounded requests.
      for (let requestNumber = 0; requestNumber < 3; requestNumber++) {
        const response = await fetch('/api/integrations/garmin/health', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ browserTimezone }),
        })
        if (!response.ok) {
          let responseCode: string | null = null
          let retryAt: string | null = null
          try {
            const parsed = syncErrorSchema.safeParse(await response.json())
            if (parsed.success) {
              responseCode = parsed.data.code
              retryAt = parsed.data.retryAt ?? null
            }
          } catch {
            // A failed response may have no JSON body.
          }
          const message = responseFailureMessage(response.status, responseCode, retryAt)
          if (response.status === 429) {
            setNotice(message)
            toast('warning', message, 'garmin-health-sync')
          } else {
            setError(message)
            toast('error', message, 'garmin-health-sync')
          }
          router.refresh()
          break
        }
        const parsed = garminSyncStateSchema.safeParse(await response.json())
        if (!parsed.success) throw new Error('Invalid sync response')
        const next = parsed.data
        setOverride({ initial, value: next })
        router.refresh()
        if (
          next.status === 'ERROR' ||
          next.status === 'PARTIAL_FAILURE' ||
          next.status === 'PAUSED' ||
          next.status === 'ACTION_REQUIRED'
        ) {
          const message =
            next.status === 'PAUSED'
              ? pausedMessage(next, clientReady)
              : next.status === 'ACTION_REQUIRED'
                ? (garminAccountIssueMessage(next.errorCode) ??
                  'Check your Garmin key in Settings before syncing again.')
                : `${failureMessage(next.errorCode)} Try again after the retry time.`
          if (next.status === 'PAUSED') {
            setNotice(message)
            toast('warning', message, 'garmin-health-sync')
          } else {
            setError(message)
            toast('error', message, 'garmin-health-sync')
          }
          break
        }
        if (next.nextDate === null && !next.sleepRetryDates?.length) {
          toast('success', 'Health data is up to date.', 'garmin-health-sync')
          break
        }
        if (requestNumber === 2) {
          if (next.sleepFailedDates?.length) {
            setNotice(pendingSleepMessage)
            toast('warning', pendingSleepMessage, 'garmin-health-sync')
          } else {
            toast('info', 'Health sync progress was saved.', 'garmin-health-sync')
          }
        }
      }
    } catch {
      const message = 'Health sync could not finish. Try again later.'
      setError(message)
      toast('error', message, 'garmin-health-sync')
    } finally {
      setPending(false)
    }
  }

  if (!initialImportReady && state.status !== 'NOT_CONNECTED')
    return (
      <EmptyState
        title="Complete Garmin health import first"
        description="Import Daily summaries and Sleep in Settings before using incremental Sync now."
        action={<Link href="/app/settings">Open Settings</Link>}
      />
    )
  if (state.status === 'ACTION_REQUIRED' && state.errorCode === 'ACCOUNT_VERIFICATION_REQUIRED')
    return (
      <EmptyState
        title="Verify your saved Garmin key"
        description="This key has no verified Garmin account identity. Verify it before importing health data."
        action={
          <div className={styles.verificationActions} aria-busy={pending}>
            <Button type="button" onClick={() => void sync()} disabled={pending}>
              <RefreshCw
                size={16}
                strokeWidth={2}
                className={pending ? styles.spinning : undefined}
                aria-hidden="true"
              />{' '}
              Verify &amp; sync
            </Button>
            <Link href="/app/settings">Open Settings</Link>
            {error && <p role="alert">{error}</p>}
            {notice && <p role="status">{notice}</p>}
          </div>
        }
      />
    )
  if (state.status === 'NOT_CONNECTED' || state.status === 'ACTION_REQUIRED')
    return (
      <EmptyState
        title={
          state.status === 'NOT_CONNECTED'
            ? 'Connect Garmin to sync health data'
            : 'Garmin connection needs attention'
        }
        description={
          garminAccountIssueMessage(state.errorCode) ??
          'Add or check your Garmin key in Settings, then return here to sync.'
        }
        action={<Link href="/app/settings">Open Settings</Link>}
      />
    )
  return (
    <section className={styles.panel} aria-label="Garmin health sync">
      <div className={styles.topline} aria-busy={pending}>
        <span className={styles.syncSummary} data-status={state.status}>
          <i aria-hidden="true" />
          {state.lastSuccessAt
            ? `Synced · ${localDateTime(state.lastSuccessAt, clientReady)}`
            : state.status === 'SYNCING'
              ? 'Syncing Garmin health data'
              : hasSavedProgress
                ? 'Partial Garmin health data saved'
                : 'Garmin health data not synced yet'}
        </span>
        {state.status === 'UNAVAILABLE' ? (
          <p role="status">Garmin sync is currently unavailable.</p>
        ) : (
          <Button
            type="button"
            variant="secondary"
            onClick={() => void sync()}
            disabled={pending || state.status === 'SYNCING'}
          >
            <RefreshCw
              size={16}
              strokeWidth={2}
              className={pending ? styles.spinning : undefined}
              aria-hidden="true"
            />{' '}
            Sync now
          </Button>
        )}
      </div>
      {!pending && state.status === 'SYNCING' && (
        <p role="status">A health sync is already running.</p>
      )}
    </section>
  )
}
