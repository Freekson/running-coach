'use client'

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { Button, ButtonLink } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { garminSyncStateSchema, type GarminSyncState } from '@/lib/garmin-sync-state'
import { garminAccountIssueMessage } from '@/lib/garmin-account-message'
import { formatLocalDateTime } from '@/lib/local-time'
import { useClientReady } from '@/lib/use-client-ready'
import styles from './activity-sync-panel.module.scss'

const endpoint = '/api/integrations/garmin/sync'
const syncErrorSchema = z.object({
  code: z.string(),
  retryAt: z.iso.datetime().nullable().optional(),
})

function pauseReason(code: string | null): string {
  if (code === 'RATE_LIMITED' || code === 'PROVIDER_PAUSED')
    return 'Garmin asked us to pause activity requests.'
  if (code === 'APP_RATE_LIMITED') return 'Too many Garmin sync requests in one minute.'
  if (code === 'TIMEOUT') return 'The activity request timed out.'
  if (code === 'NETWORK_ERROR') return 'Garmin could not be reached.'
  if (code === 'INVALID_RESPONSE' || code === 'INVALID_CHECKPOINT')
    return 'Activity sync could not validate the saved or received data.'
  return 'Activity sync is waiting before retrying.'
}
function retryMessage(code: string | null, retryAt: string | null, ready: boolean) {
  return `${pauseReason(code)}${retryAt && Number.isFinite(Date.parse(retryAt)) ? ` Retry after ${ready ? (formatLocalDateTime(retryAt) ?? 'the retry time') : 'the retry time'}.` : ' Try again later.'}`
}

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

export function ActivitySyncPanel({
  initial,
  savedAt = null,
}: {
  initial: GarminSyncState
  savedAt?: string | null
}) {
  const { refresh } = useRouter()
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
  const [observedAt, setObservedAt] = useState(() => Date.now())
  const retryAt = state.nextAttemptAt ? Date.parse(state.nextAttemptAt) : NaN
  const paused = state.status === 'PAUSED' && (!Number.isFinite(retryAt) || retryAt > observedAt)
  useEffect(() => {
    if (state.status !== 'PAUSED' || !Number.isFinite(retryAt) || retryAt <= observedAt) return
    const timer = window.setTimeout(
      () => {
        setObservedAt(Date.now())
        if (Date.now() >= retryAt) setError('')
      },
      Math.min(60_000, Math.max(1, retryAt - Date.now() + 50)),
    )
    return () => window.clearTimeout(timer)
  }, [state.status, retryAt, observedAt])

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
          if (active && parsed.success) {
            setOverride({ initial, value: parsed.data })
            // A completed or paused batch can have saved activities since the page loaded.
            if (parsed.data.status !== state.status) refresh()
          }
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
  }, [state.status, state.nextAttemptAt, initial, refreshTick, refresh])

  async function sync() {
    if (pending || paused || state.status === 'SYNCING') return
    setPending(true)
    setError('')
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          body: JSON.stringify({
            browserTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          }),
        })
        if (!response.ok) {
          let code: string | null = null
          let retryAt: string | null = null
          try {
            const parsed = syncErrorSchema.safeParse(await response.json())
            if (parsed.success) {
              code = parsed.data.code
              retryAt = parsed.data.retryAt ?? null
            }
          } catch {
            // Failed responses may have no JSON body.
          }
          const message =
            response.status === 429
              ? retryMessage(code, retryAt, clientReady)
              : syncFailureMessage(response.status, code)
          if (response.status === 429 && retryAt)
            setOverride({
              initial,
              value: { ...state, status: 'PAUSED', nextAttemptAt: retryAt, errorCode: code },
            })
          setError(message)
          toast(response.status === 429 ? 'warning' : 'error', message, 'garmin-activity-sync')
          return
        }
        const parsed = garminSyncStateSchema.safeParse(await response.json())
        if (!parsed.success) throw new Error('Invalid sync response')
        const next = parsed.data
        setOverride({ initial, value: next })
        refresh()
        if (next.status === 'PARTIAL' && next.nextDate !== null && attempt === 0) continue
        if (next.status === 'SUCCESS')
          toast('success', 'Garmin activities are up to date.', 'garmin-activity-sync')
        else if (next.status === 'PARTIAL')
          toast('info', 'Activity sync progress was saved.', 'garmin-activity-sync')
        else if (next.status === 'PAUSED')
          toast(
            'warning',
            retryMessage(next.errorCode, next.nextAttemptAt, clientReady),
            'garmin-activity-sync',
          )
        else if (next.status === 'ACTION_REQUIRED')
          toast(
            'error',
            garminAccountIssueMessage(next.errorCode) ??
              'Check your Garmin connection in Settings.',
            'garmin-activity-sync',
          )
        else toast('error', 'Activity sync stopped before finishing.', 'garmin-activity-sync')
        break
      }
    } catch {
      const message = 'Activity sync could not finish. Try again later.'
      setError(message)
      toast('error', message, 'garmin-activity-sync')
    } finally {
      setPending(false)
    }
  }

  const verify =
    state.status === 'ACTION_REQUIRED' && state.errorCode === 'ACCOUNT_VERIFICATION_REQUIRED'
  const needsConnection =
    state.status === 'NOT_CONNECTED' || (state.status === 'ACTION_REQUIRED' && !verify)
  const timestamp = state.lastSuccessAt ?? savedAt
  const stale =
    clientReady && timestamp != null && observedAt - Date.parse(timestamp) > 24 * 3_600_000
  return (
    <section className={styles.panel} aria-label="Garmin activity sync">
      <div className={styles.topline} aria-busy={pending}>
        <span className={styles.summary} data-status={state.status}>
          <i aria-hidden="true" />
          {state.status === 'NOT_CONNECTED'
            ? 'Garmin disconnected'
            : state.status === 'SYNCING' || pending
              ? 'Syncing Garmin activities'
              : timestamp
                ? `${state.lastSuccessAt ? 'Synced' : 'Saved'} · ${clientReady ? (formatLocalDateTime(timestamp) ?? 'Time unavailable') : 'Loading local time…'}`
                : 'Garmin activities not synced yet'}
        </span>
        {needsConnection ? (
          <ButtonLink href="/app/settings" variant="secondary">
            {state.status === 'NOT_CONNECTED' ? 'Connect Garmin' : 'Check Garmin settings'}
          </ButtonLink>
        ) : state.status === 'UNAVAILABLE' ? (
          <span>Activity sync unavailable</span>
        ) : (
          <Button
            variant="secondary"
            onClick={() => void sync()}
            disabled={pending || state.status === 'SYNCING' || paused}
          >
            <RefreshCw
              size={18}
              strokeWidth={2}
              className={pending ? styles.spinning : undefined}
              aria-hidden="true"
              focusable="false"
            />
            {verify ? 'Verify & sync' : 'Sync now'}
          </Button>
        )}
      </div>
      {stale && <p role="status">Saved history may be out of date.</p>}
      {verify && <p>Verify your saved Garmin key before importing activities.</p>}
      {!pending && state.status === 'SYNCING' && (
        <p role="status">An activity sync is already running.</p>
      )}
      {!pending && !error && state.status === 'PAUSED' && (
        <p role="status">
          {paused
            ? retryMessage(state.errorCode, state.nextAttemptAt, clientReady)
            : 'You can retry activity sync now.'}
        </p>
      )}
      {!pending && !error && (state.status === 'ERROR' || state.status === 'PARTIAL_FAILURE') && (
        <p role="status">
          The last activity sync stopped early. Saved activities remain available.
        </p>
      )}
      {state.status === 'ACTION_REQUIRED' && !verify && (
        <p role="status">
          {state.errorCode === 'INITIAL_IMPORT_REQUIRED'
            ? 'Complete the Activities import in Settings before syncing new workouts.'
            : (garminAccountIssueMessage(state.errorCode) ??
              'Check your Garmin connection in Settings. Saved activities remain available.')}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
