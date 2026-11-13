'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Activity,
  ArrowRight,
  BedDouble,
  CalendarDays,
  Circle,
  CircleAlert,
  CircleCheck,
  Clock3,
  Footprints,
  RefreshCw,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import {
  incrementalSnapshotSchema,
  incrementalStreamLabels,
  type IncrementalStreamId,
  type IncrementalSyncResult,
  type IncrementalSyncSnapshot,
} from '@/lib/garmin-incremental-sync'
import { formatLocalDay, formatLocalTime } from '@/lib/local-time'
import { useClientReady } from '@/lib/use-client-ready'
import styles from './garmin-sync-panel.module.scss'
import {
  preserveDashboardSyncHistory,
  runDashboardGarminSync,
  type DashboardSyncProgress,
  type DashboardSyncHistory,
} from './garmin-sync-session'

const settingsUrl = '/app/settings#garmin-data-import-heading'
const icons = { activities: Footprints, daily_summary: CalendarDays, sleep: BedDouble }
type Operation = DashboardSyncProgress & {
  kind: 'sync' | 'retry'
}
const blocked = (stream: IncrementalSyncResult, now: number) =>
  stream.retryAt !== null && Date.parse(stream.retryAt) > now
const activeSnapshot = (snapshot: IncrementalSyncSnapshot | null) =>
  Boolean(snapshot?.busy || snapshot?.streams.some((stream) => stream.status === 'syncing'))

function upToDate(stream: IncrementalSyncResult, now: number): boolean {
  if (stream.status !== 'completed' || !stream.lastSuccessAt) return false
  const age = now - Date.parse(stream.lastSuccessAt)
  return age >= 0 && age <= 86_400_000
}

function explanation(stream: IncrementalSyncResult): string {
  switch (stream.reason) {
    case 'CONNECTION_ERROR':
      return 'Check the Garmin connection in Settings before synchronizing again.'
    case 'BACKOFF':
      return 'Requests are paused until the recorded retry time.'
    default:
      return 'Sync could not finish. Saved data remains available. Retry this stream to continue.'
  }
}

export function GarminSyncPanel({
  initial,
  asOfInstant,
}: {
  initial: IncrementalSyncSnapshot | null
  asOfInstant?: string
}) {
  const router = useRouter()
  const ready = useClientReady()
  const [override, setOverride] = useState<{
    initial: typeof initial
    value: typeof initial
  } | null>(null)
  const persisted = override?.initial === initial ? override.value : initial
  const [history, setHistory] = useState<DashboardSyncHistory | null>(null)
  const snapshot = persisted ? preserveDashboardSyncHistory(persisted, history) : persisted
  const [operation, setOperation] = useState<Operation | null>(null)
  const [completion, setCompletion] = useState<{
    connectionKey: IncrementalSyncSnapshot['connectionKey']
  } | null>(null)
  const [error, setError] = useState('')
  const [clock, setNow] = useState(() => (asOfInstant ? Date.parse(asOfInstant) : Date.now()))
  const now = Math.max(clock, asOfInstant ? Date.parse(asOfInstant) : clock)
  const outcome =
    completion && snapshot && completion.connectionKey === snapshot.connectionKey
      ? snapshot.streams.every((stream) => upToDate(stream, now))
        ? 'complete'
        : 'incomplete'
      : null
  const lock = useRef(false)
  const session = useRef<AbortController | null>(null)
  const active = activeSnapshot(snapshot)
  const busy = operation !== null || active
  const waiting = Boolean(operation?.waitingUntil)
  const localTime = (value: string) =>
    ready ? `${formatLocalDay(value)}, ${formatLocalTime(value)}` : 'Loading local time…'

  useEffect(
    () => () => {
      session.current?.abort()
    },
    [],
  )

  // Status reads alone never start synchronization; only an explicit click arms a session.
  useEffect(() => {
    if (!snapshot?.streams.some((stream) => stream.retryAt || stream.lastSuccessAt)) return
    const timer = window.setInterval(() => setNow(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [snapshot])

  // Observe other entry points using persisted reads only.
  useEffect(() => {
    if (operation || !active) return
    const controller = new AbortController()
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch('/api/integrations/garmin/incremental-sync', {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('State unavailable')
        const next = incrementalSnapshotSchema.parse(await response.json())
        setOverride({ initial, value: next })
        setNow(Date.now())
        setError('')
        if (!activeSnapshot(next)) router.refresh()
      } catch {
        if (!controller.signal.aborted)
          setError('Sync status is unavailable. Refresh to check progress.')
      }
    }, 5_000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [active, operation, router, initial])

  async function sync(target?: IncrementalStreamId) {
    if (lock.current || busy) return
    lock.current = true
    const controller = new AbortController()
    session.current = controller
    const kind =
      target &&
      snapshot?.streams.find((stream) => stream.streamId === target)?.reason !== 'REQUEST_BUDGET'
        ? 'retry'
        : 'sync'
    setOperation({ kind, activeId: null, queued: [], waitingUntil: null })
    setCompletion(null)
    setError('')
    try {
      const current = await runDashboardGarminSync({
        signal: controller.signal,
        target,
        history,
        onState: (value) => {
          setOverride({ initial, value })
          setNow(Date.now())
        },
        onProgress: (progress) => setOperation({ kind, ...progress }),
        onAttempt: (attempt, connectionKey) => {
          if (!connectionKey) return
          setHistory((previous) => ({
            connectionKey,
            attempts: {
              ...(previous?.connectionKey === connectionKey ? previous.attempts : {}),
              [attempt.result.streamId]: attempt,
            },
          }))
        },
      })
      if (!controller.signal.aborted) setCompletion({ connectionKey: current.connectionKey })
    } catch {
      if (!controller.signal.aborted) setError('Garmin sync could not finish. Try again.')
    } finally {
      if (session.current === controller) session.current = null
      lock.current = false
      if (!controller.signal.aborted) {
        setOperation(null)
        // Reload persisted metrics after all bounded continuations, including partial writes.
        router.refresh()
      }
    }
  }

  async function refreshStatus() {
    if (lock.current) return
    lock.current = true
    try {
      const response = await fetch('/api/integrations/garmin/incremental-sync', {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('State unavailable')
      setOverride({ initial, value: incrementalSnapshotSchema.parse(await response.json()) })
      setError('')
      setNow(Date.now())
    } catch {
      setError('Garmin sync status could not be loaded. Try again.')
    } finally {
      lock.current = false
    }
  }

  const failed = snapshot?.streams.filter((stream) => stream.status === 'failed').length ?? 0
  const paused = snapshot?.streams.some((stream) => stream.status === 'rate_limited')
  const issue = failed > 0 || Boolean(error) || snapshot?.connection === 'error'
  const incomplete =
    outcome === 'incomplete' ||
    snapshot?.streams.some((stream) => stream.reason === 'REQUEST_BUDGET')
  const connected = snapshot?.connection === 'connected'
  const badgeText = !snapshot
    ? 'Unavailable'
    : !connected
      ? snapshot.connection === 'disconnected'
        ? 'Not connected'
        : 'Connection issue'
      : busy
        ? operation?.kind === 'retry'
          ? waiting
            ? 'Waiting'
            : 'Retrying…'
          : waiting
            ? 'Waiting'
            : 'Syncing…'
        : issue
          ? 'Sync issue'
          : paused
            ? 'Waiting'
            : incomplete
              ? 'Incomplete'
              : 'Connected'
  const successfulTimes =
    snapshot?.streams
      .flatMap((stream) => (stream.lastSuccessAt ? [stream.lastSuccessAt] : []))
      .sort() ?? []
  const lastTime = successfulTimes.length === 3 ? successfulTimes[0] : successfulTimes.at(-1)
  const canSync =
    connected &&
    snapshot.streams.some(
      (stream) =>
        !['INITIAL_IMPORT_REQUIRED', 'NOT_CONNECTED', 'CONNECTION_ERROR'].includes(
          stream.reason ?? '',
        ),
    )

  return (
    <Card as="section" className={styles.panel} aria-labelledby="dashboard-garmin-heading">
      <div className={styles.header}>
        <div className={styles.copy}>
          <div className={styles.headingLine}>
            <SectionHeading icon={Activity} title="Garmin" id="dashboard-garmin-heading" />
            <Badge
              tone={
                waiting
                  ? 'warning'
                  : busy
                    ? 'neutral'
                    : issue
                      ? 'error'
                      : paused || incomplete
                        ? 'warning'
                        : connected
                          ? 'success'
                          : 'neutral'
              }
              className={busy && !waiting ? styles.activeBadge : undefined}
            >
              {badgeText}
            </Badge>
          </div>
          {lastTime && (
            <p>
              {`${successfulTimes.length === 3 ? 'Last sync' : 'Last stream sync'}: ${localTime(lastTime)}`}
              {!busy && failed > 0
                ? ` · ${failed} ${failed === 1 ? 'stream failed' : 'streams failed'}`
                : ''}
            </p>
          )}
        </div>
        {!snapshot ? (
          <Button variant="secondary" onClick={refreshStatus}>
            Refresh status
          </Button>
        ) : !connected ? (
          <ButtonLink href={settingsUrl} variant="secondary">
            {snapshot.connection === 'disconnected' ? 'Connect Garmin' : 'Connection settings'}
            <ArrowRight size={18} aria-hidden="true" />
          </ButtonLink>
        ) : (
          <Button variant="secondary" disabled={busy || !canSync} onClick={() => sync()}>
            <RefreshCw
              size={18}
              strokeWidth={2}
              aria-hidden="true"
              className={busy && !waiting ? styles.spinning : undefined}
            />
            {busy
              ? waiting
                ? 'Waiting…'
                : operation?.kind === 'retry'
                  ? 'Retrying…'
                  : 'Syncing…'
              : 'Sync now'}
          </Button>
        )}
      </div>
      {snapshot && (
        <ul className={styles.streams} aria-label="Garmin stream status">
          {snapshot.streams.map((stream) => {
            const Icon = icons[stream.streamId]
            const running =
              operation?.activeId === stream.streamId ||
              (stream.status === 'syncing' && stream.reason !== 'BUSY')
            const waiting =
              operation?.queued.includes(stream.streamId) ||
              (stream.status === 'syncing' && stream.reason === 'BUSY')
            const needsImport = stream.reason === 'INITIAL_IMPORT_REQUIRED'
            const retryable =
              stream.status === 'failed' ||
              stream.status === 'rate_limited' ||
              stream.reason === 'REQUEST_BUDGET'
            const success = upToDate(stream, now) && !running && !waiting
            const label = running
              ? operation?.kind === 'retry'
                ? 'Retrying…'
                : 'Syncing…'
              : waiting
                ? 'Waiting…'
                : stream.status === 'failed'
                  ? 'Failed'
                  : stream.status === 'rate_limited'
                    ? blocked(stream, now)
                      ? 'Waiting'
                      : 'Retry available'
                    : success
                      ? 'Up to date'
                      : stream.status === 'completed'
                        ? stream.lastSuccessAt
                          ? 'Outdated'
                          : 'Completed'
                        : stream.reason === 'REQUEST_BUDGET'
                          ? 'Incomplete'
                          : !connected
                            ? 'Not connected'
                            : 'Not synced'
            const StatusIcon = running
              ? RefreshCw
              : success
                ? CircleCheck
                : stream.status === 'failed'
                  ? CircleAlert
                  : waiting || stream.status === 'rate_limited'
                    ? Clock3
                    : Circle
            const tone =
              running || waiting
                ? styles.active
                : success
                  ? styles.success
                  : stream.status === 'failed'
                    ? styles.failure
                    : stream.status === 'rate_limited'
                      ? styles.warning
                      : styles.muted
            return (
              <li key={stream.streamId}>
                <Icon size={20} strokeWidth={2} aria-hidden="true" className={styles.streamIcon} />
                <strong>{incrementalStreamLabels[stream.streamId]}</strong>
                {needsImport ? (
                  <Link href={settingsUrl} className={styles.status}>
                    Import required
                    <ArrowRight size={16} aria-hidden="true" />
                  </Link>
                ) : retryable && stream.reason !== 'REQUEST_BUDGET' && !running && !waiting ? (
                  <details className={`${styles.errorDetails} ${tone}`}>
                    <summary title="View sync details">
                      <StatusIcon size={18} aria-hidden="true" />
                      {label}
                    </summary>
                    <p>
                      {explanation(stream)}
                      {stream.retryAt ? ` Retry after ${localTime(stream.retryAt)}.` : ''}
                      {stream.reason === 'CONNECTION_ERROR' && (
                        <>
                          {' '}
                          <Link href={settingsUrl}>
                            Connection settings
                            <ArrowRight size={16} aria-hidden="true" />
                          </Link>
                        </>
                      )}
                    </p>
                  </details>
                ) : (
                  <span
                    className={`${styles.status} ${tone}`}
                    title={
                      waiting && operation?.waitingUntil
                        ? `Resumes after ${localTime(operation.waitingUntil)} while Dashboard stays open.`
                        : undefined
                    }
                  >
                    <StatusIcon
                      size={18}
                      aria-hidden="true"
                      className={running ? styles.spinning : undefined}
                    />
                    {label}
                  </span>
                )}
                {retryable && stream.reason !== 'CONNECTION_ERROR' && !running && !waiting && (
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={busy || blocked(stream, now)}
                    aria-label={`${stream.reason === 'REQUEST_BUDGET' ? 'Continue' : 'Retry'} ${incrementalStreamLabels[stream.streamId]}`}
                    onClick={() => sync(stream.streamId)}
                  >
                    {stream.reason === 'REQUEST_BUDGET' ? 'Continue' : 'Retry'}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
        {waiting
          ? 'Waiting to resume synchronization while Dashboard stays open.'
          : busy
            ? 'Synchronization in progress.'
            : outcome === 'complete'
              ? 'All Garmin streams synchronized.'
              : outcome === 'incomplete'
                ? 'Synchronization incomplete. Review stream statuses.'
                : error}
      </span>
    </Card>
  )
}
