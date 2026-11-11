'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Clock3,
  Download,
  FileText,
  Info,
  Layers,
  LoaderCircle,
  Moon,
  Play,
  RotateCw,
  Square,
} from 'lucide-react'
import { z } from 'zod'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import type { GarminImportStreamState, ImportStreamId } from '@/server/garmin/data-import'
import { useToast } from '@/components/ui/Toast'
import { useClientReady } from '@/lib/use-client-ready'
import { GARMIN_HISTORY_YEARS } from '@/lib/garmin-import-window'
import { formatLocalDateTime } from '@/lib/local-time'
import { nextGarminRateLimitRetryAt } from './garmin-import-retry'
import styles from './garmin-data-import.module.scss'

const names: Record<ImportStreamId, string> = {
  daily_summary: 'Daily summaries',
  sleep: 'Sleep',
  activities: 'Activities',
}
const labels: Record<GarminImportStreamState['status'], string> = {
  not_started: 'Not imported',
  running: 'Importing',
  waiting_retry: 'Waiting / backoff',
  paused: 'Paused / needs attention',
  completed_with_warnings: 'Completed with warnings',
  completed: 'Completed',
}
const streamDescriptions: Record<ImportStreamId, string> = {
  daily_summary: 'Wellness and daily metrics (resting HR, steps, calories, etc.).',
  sleep: 'Sleep duration, stages (Deep, Light, REM) and sleep score.',
  activities: 'Activity import will be available in a future update.',
}
const streamIcons = { daily_summary: FileText, sleep: Moon, activities: Activity }
const statusIcons = {
  not_started: Circle,
  running: LoaderCircle,
  waiting_retry: CirclePause,
  paused: CircleAlert,
  completed_with_warnings: CircleAlert,
  completed: CircleCheck,
}
const statusTones = {
  not_started: 'neutral',
  running: 'neutral',
  waiting_retry: 'warning',
  paused: 'error',
  completed_with_warnings: 'warning',
  completed: 'success',
} as const
const streamStateSchema = z.object({
  streamId: z.enum(['daily_summary', 'sleep', 'activities']),
  status: z.enum([
    'not_started',
    'running',
    'waiting_retry',
    'paused',
    'completed_with_warnings',
    'completed',
  ]),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  nextDate: z.string().nullable(),
  lastCheckedDate: z.string().nullable(),
  checkedDays: z.number().int().nonnegative(),
  totalDays: z.number().int().positive().nullable(),
  failedDateCount: z.number().int().nonnegative(),
  retryAfter: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  generation: z.number().int().positive().nullable(),
  activityCount: z.number().int().nonnegative().optional(),
  currentRange: z.object({ start: z.string(), end: z.string() }).nullable().optional(),
})
type ImportAction = 'import' | 'resume' | 'retry' | 'reimport'
type ImportItem = { streamId: ImportStreamId; action: ImportAction }
type ImportResult =
  | { kind: 'states'; states: GarminImportStreamState[] }
  | { kind: 'rate_limit'; retryAt: string | null }
  | { kind: 'error' }
const maxConsecutiveStalls = 3
const rateLimitMessage = 'Garmin import rate limit reached. Please try again a little later.'

const accountErrors = new Set([
  'NOT_CONNECTED',
  'ACCOUNT_MISMATCH',
  'ACCOUNT_UNVERIFIABLE',
  'ACCOUNT_VERIFICATION_REQUIRED',
  'INVALID_CHECKPOINT',
])

function requiresAttention(code: string | null): boolean {
  return Boolean(code && (accountErrors.has(code) || /^(?:SLEEP|SUMMARY)_HTTP_40[13]$/.test(code)))
}

async function waitForRetry(retryAt: string, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.parse(retryAt)
  if (!Number.isFinite(deadline)) return false
  while (!signal.aborted && Date.now() < deadline) {
    const remaining = Math.min(60_000, deadline - Date.now())
    const elapsed = await new Promise<boolean>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer)
        resolve(false)
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(true)
      }, remaining)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    if (!elapsed) return false
  }
  return !signal.aborted
}

function safeFailure(code: string | null): string | null {
  if (!code) return null
  if (code === 'ACCOUNT_VERIFICATION_REQUIRED')
    return 'Verify the saved Garmin account before importing.'
  if (code === 'INVALID_CHECKPOINT') return 'Saved import progress needs attention.'
  if (code === 'ACCOUNT_MISMATCH') return 'The saved key belongs to a different Garmin account.'
  if (code === 'NOT_CONNECTED') return 'The Garmin key was rejected. Replace it to continue.'
  if (code === 'RATE_LIMITED') return rateLimitMessage
  if (/^(?:SLEEP|SUMMARY)_HTTP_40[13]$/.test(code))
    return 'Garmin denied this data stream. Check the key and account permissions.'
  if (code === 'SUMMARY_EMPTY_BODY')
    return 'Garmin returned an empty response body for a date. Its coverage could not be verified.'
  if (code === 'SUMMARY_NULL_DATA')
    return 'Garmin returned null data for a date. Its coverage could not be verified.'
  if (code === 'SUMMARY_INVALID_ENVELOPE')
    return 'Garmin returned an unrecognized daily-summary response format.'
  if (code === 'SUMMARY_MULTIPLE_RECORDS')
    return 'Garmin returned multiple daily summaries for one requested date.'
  if (code === 'SUMMARY_INVALID_RECORD')
    return 'Garmin returned a daily summary with invalid or missing fields.'
  if (code === 'SUMMARY_DATE_MISMATCH')
    return 'Garmin returned a daily summary for a different date.'
  if (code === 'SUMMARY_TOO_LARGE')
    return 'Garmin returned a daily-summary response larger than the import limit.'
  if (code === 'SUMMARY_INVALID_JSON')
    return 'Garmin returned unreadable daily-summary JSON. Retry after the wait period.'
  if (code.startsWith('SLEEP_')) return 'Some sleep dates could not be verified.'
  if (code.startsWith('SUMMARY_')) return 'Some daily summaries could not be verified.'
  return 'The import stopped. Try again when the retry time has passed.'
}

function retryAtFromHeader(value: string | null): string | null {
  if (!value) return null
  const seconds = Number(value)
  const timestamp =
    Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1_000 : Date.parse(value)
  const date = new Date(timestamp)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function hasStreamDetails(stream: GarminImportStreamState): boolean {
  return Boolean(
    stream.totalDays !== null ||
    stream.startDate ||
    stream.currentRange ||
    stream.lastCheckedDate ||
    stream.lastSyncAt ||
    stream.failedDateCount > 0 ||
    stream.errorCode,
  )
}

export function GarminDataImport({ initial }: { initial: GarminImportStreamState[] }) {
  const toast = useToast()
  const clientReady = useClientReady()
  const [override, setOverride] = useState<{
    initial: GarminImportStreamState[]
    value: GarminImportStreamState[]
  } | null>(null)
  const streams = override?.initial === initial ? override.value : initial
  const [selected, setSelected] = useState<ImportStreamId[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [activeStream, setActiveStream] = useState<ImportStreamId | null>(null)
  const [waitingUntil, setWaitingUntil] = useState<string | null>(null)
  const [waitingForRateLimit, setWaitingForRateLimit] = useState(false)
  const [providerRetryAt, setProviderRetryAt] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [howOpen, setHowOpen] = useState(false)
  const [expanded, setExpanded] = useState<Partial<Record<ImportStreamId, boolean>>>(() =>
    Object.fromEntries(initial.map((stream) => [stream.streamId, hasStreamDetails(stream)])),
  )
  const activeRun = useRef<AbortController | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeRun.current?.abort()
    }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 5_000)
    return () => clearInterval(timer)
  }, [])

  const rateLimitDeadlines = [
    providerRetryAt,
    ...streams
      .filter((stream) => stream.errorCode === 'RATE_LIMITED')
      .map((stream) => stream.retryAfter),
  ]
    .map((value) => (value ? Date.parse(value) : 0))
    .filter((value) => Number.isFinite(value) && value > nowMs)
  const rateLimitUntil =
    clientReady && rateLimitDeadlines.length
      ? new Date(Math.max(...rateLimitDeadlines)).toISOString()
      : null
  const visibleRateLimitUntil = waitingForRateLimit && waitingUntil ? waitingUntil : rateLimitUntil
  const selectedBlocked = selected.some((streamId) => {
    const retryAt = streams.find((stream) => stream.streamId === streamId)?.retryAfter
    return Boolean(retryAt && Date.parse(retryAt) > nowMs)
  })

  async function act(streamId: ImportStreamId, action: ImportAction): Promise<ImportResult> {
    const response = await fetch('/api/integrations/garmin/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        streamId,
        action,
        browserTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      }),
    })
    if (!response.ok) {
      let code = 'UNAVAILABLE'
      let retryAt: string | null = null
      try {
        const payload: unknown = await response.json()
        if (payload && typeof payload === 'object') {
          if ('code' in payload && typeof payload.code === 'string') code = payload.code
          if ('retryAt' in payload && typeof payload.retryAt === 'string') retryAt = payload.retryAt
        }
      } catch {
        /* A failed response can have no JSON body. */
      }
      if (response.status === 429)
        return {
          kind: 'rate_limit',
          retryAt:
            retryAt && Number.isFinite(Date.parse(retryAt))
              ? retryAt
              : retryAtFromHeader(response.headers?.get('Retry-After') ?? null),
        }
      const message = safeFailure(code) ?? 'Import unavailable.'
      if (mounted.current) {
        setError(message)
        toast('error', message, 'garmin-data-import')
      }
      return { kind: 'error' }
    }
    const next: unknown = await response.json()
    const parsed = z.array(streamStateSchema).safeParse(next)
    if (!parsed.success) throw new Error('Invalid import response')
    if (mounted.current) {
      setProviderRetryAt(null)
      setOverride({ initial, value: parsed.data })
    }
    return { kind: 'states', states: parsed.data }
  }

  async function run(items: ImportItem[]) {
    if (
      activeRun.current ||
      items.length === 0 ||
      items.some((item) => item.streamId === 'activities')
    )
      return
    if (
      rateLimitUntil ||
      items.some((item) => {
        const retryAt = streams.find((stream) => stream.streamId === item.streamId)?.retryAfter
        return retryAt && Date.parse(retryAt) > Date.now()
      })
    )
      return
    const controller = new AbortController()
    activeRun.current = controller
    setPending(true)
    setError('')
    try {
      let failed = false
      let unresolved = false
      let consecutiveRateLimits = 0
      for (const item of items) {
        if (controller.signal.aborted) break
        setActiveStream(item.streamId)
        let action = item.action
        let previous = streams.find((stream) => stream.streamId === item.streamId)
        const retrying = action === 'retry'
        let consecutiveStalls = 0
        for (;;) {
          if (controller.signal.aborted) break
          setWaitingUntil(null)
          setWaitingForRateLimit(false)
          const result = await act(item.streamId, action)
          if (controller.signal.aborted) {
            if (result.kind === 'rate_limit' && mounted.current)
              setProviderRetryAt(nextGarminRateLimitRetryAt(Date.now(), 1, result.retryAt))
            break
          }
          if (result.kind === 'error') {
            failed = true
            break
          }
          if (result.kind === 'rate_limit') {
            consecutiveRateLimits++
            const retryAt = nextGarminRateLimitRetryAt(
              Date.now(),
              consecutiveRateLimits,
              result.retryAt,
            )
            setWaitingForRateLimit(true)
            setWaitingUntil(retryAt)
            setProviderRetryAt(retryAt)
            if (!(await waitForRetry(retryAt, controller.signal))) break
            continue
          }
          const current = result.states.find((stream) => stream.streamId === item.streamId)
          if (!current) throw new Error('Import stream missing from response')
          if (requiresAttention(current.errorCode)) {
            unresolved = true
            break
          }
          if (retrying ? current.failedDateCount === 0 : current.nextDate === null) break
          if (
            current.errorCode === 'RATE_LIMITED' ||
            (current.status === 'waiting_retry' && current.errorCode === null && current.retryAfter)
          ) {
            consecutiveRateLimits++
            consecutiveStalls = 0
            previous = current
            if (!retrying) action = 'resume'
            const retryAt = nextGarminRateLimitRetryAt(
              Date.now(),
              consecutiveRateLimits,
              current.retryAfter,
            )
            setWaitingForRateLimit(true)
            setWaitingUntil(retryAt)
            setProviderRetryAt(retryAt)
            if (!(await waitForRetry(retryAt, controller.signal))) break
            continue
          }
          consecutiveRateLimits = 0
          if (current.retryAfter) {
            const advanced =
              current.nextDate !== previous?.nextDate ||
              current.checkedDays !== previous?.checkedDays ||
              current.failedDateCount !== previous?.failedDateCount
            consecutiveStalls = advanced ? 0 : consecutiveStalls + 1
            if (consecutiveStalls >= maxConsecutiveStalls) {
              unresolved = true
              break
            }
            previous = current
            if (!retrying) action = 'resume'
            const retryAt = new Date(Math.max(Date.parse(current.retryAfter), Date.now() + 1_000))
            setWaitingUntil(retryAt.toISOString())
            if (!(await waitForRetry(retryAt.toISOString(), controller.signal))) break
            continue
          }
          consecutiveStalls = 0
          if (controller.signal.aborted) break
          if (retrying) {
            if (current.failedDateCount === 0) break
            if (previous && current.failedDateCount >= previous.failedDateCount) {
              unresolved = true
              break
            }
            previous = current
            action = 'retry'
            continue
          }
          if (current.nextDate !== null && current.status !== 'completed') {
            if (previous && current.nextDate === previous.nextDate) {
              unresolved = true
              break
            }
            previous = current
            action = 'resume'
            continue
          }
          break
        }
        if (failed) break
      }
      if (mounted.current && !controller.signal.aborted) {
        if (!failed && unresolved)
          toast(
            'warning',
            'Import paused with unresolved dates. Review the stream status.',
            'garmin-data-import',
          )
        setSelected([])
      }
    } catch {
      if (mounted.current)
        setError('The import response could not be read. Reload Settings to see saved progress.')
    } finally {
      if (activeRun.current === controller) activeRun.current = null
      if (mounted.current) {
        setPending(false)
        setActiveStream(null)
        setWaitingUntil(null)
        setWaitingForRateLimit(false)
      }
    }
  }

  return (
    <Card as="section" className={styles.section} aria-labelledby="garmin-data-import-heading">
      <div className={styles.headingRow}>
        <SectionHeading
          icon={Download}
          id="garmin-data-import-heading"
          title="Garmin Data Import"
          level={2}
          subtitle={`Import each stream independently. Historical coverage spans ${GARMIN_HISTORY_YEARS} calendar years ending yesterday in your saved time zone.`}
        />
        <Button
          size="compact"
          variant="secondary"
          aria-expanded={howOpen}
          aria-controls={howOpen ? 'garmin-import-help' : undefined}
          onClick={() => setHowOpen((current) => !current)}
        >
          <Info size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
          How it works
        </Button>
      </div>
      {howOpen && (
        <div id="garmin-import-help" className={styles.infoStrip}>
          <Info size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
          <ul className={styles.helpList}>
            <li>
              Import continues automatically while Settings stays open. Each request saves a
              checkpoint; closing the page stops further requests.
            </li>
            <li>
              <strong>Resume import</strong> continues unchecked history.
            </li>
            <li>
              <strong>Retry failed dates</strong> checks only unresolved dates.
            </li>
            <li>
              <strong>Reimport</strong> starts a new pass for that stream.
            </li>
          </ul>
        </div>
      )}
      {visibleRateLimitUntil && (
        <div className={styles.runStatus}>
          <p className={styles.note} role="status">
            <RotateCw size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
            Garmin import rate limit reached.{' '}
            {pending && waitingForRateLimit
              ? 'Retrying automatically after'
              : 'Try again after'}{' '}
            {clientReady ? formatLocalDateTime(visibleRateLimitUntil) : 'the retry time'}.
          </p>
        </div>
      )}
      <div className={styles.streams}>
        {streams.map((stream) => {
          // TODO(RUN-76 follow-up): Enable Activities after its import flow is implemented.
          const activitiesUnavailable = stream.streamId === 'activities'
          const needsAccountAction = requiresAttention(stream.errorCode)
          const canResume =
            !activitiesUnavailable &&
            (stream.status === 'paused' || stream.status === 'waiting_retry') &&
            stream.nextDate !== null &&
            !needsAccountAction
          const canRetry =
            !activitiesUnavailable &&
            stream.failedDateCount > 0 &&
            !needsAccountAction &&
            stream.status !== 'running'
          const selectable =
            !activitiesUnavailable && (stream.status === 'not_started' || canResume)
          const parsedRetryMs = stream.retryAfter ? Date.parse(stream.retryAfter) : 0
          const streamRetryMs = Number.isFinite(parsedRetryMs) ? parsedRetryMs : 0
          const blockedUntil =
            clientReady && (streamRetryMs > nowMs || rateLimitUntil)
              ? new Date(
                  Math.max(streamRetryMs, rateLimitUntil ? Date.parse(rateLimitUntil) : 0),
                ).toISOString()
              : !clientReady && stream.retryAfter
                ? stream.retryAfter
                : null
          const blocked = Boolean(blockedUntil)
          const activeStatus = pending && activeStream === stream.streamId
          const status = activeStatus ? (waitingUntil ? 'waiting_retry' : 'running') : stream.status
          const StatusIcon = statusIcons[status]
          const StreamIcon = streamIcons[stream.streamId]
          const hasDetails = !activitiesUnavailable && hasStreamDetails(stream)
          const isExpanded = hasDetails && Boolean(expanded[stream.streamId])
          const detailsId = `garmin-${stream.streamId}-details`
          const retryHintId = `garmin-${stream.streamId}-retry-time`
          const statusLabel =
            status === 'paused' && !stream.errorCode ? 'Ready to resume' : labels[status]
          const checkedCount = stream.checkedDays.toLocaleString('en-US')
          const totalCount = stream.totalDays?.toLocaleString('en-US')
          return (
            <article
              key={stream.streamId}
              className={[styles.stream, activitiesUnavailable && styles.streamUnavailable]
                .filter(Boolean)
                .join(' ')}
            >
              <div className={styles.titleRow}>
                <label className={styles.select}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${names[stream.streamId]}`}
                    checked={selected.includes(stream.streamId)}
                    disabled={pending || blocked || !selectable}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, stream.streamId]
                          : current.filter((id) => id !== stream.streamId),
                      )
                    }
                  />
                </label>
                <span className={styles.streamIcon} aria-hidden="true">
                  <StreamIcon size={20} strokeWidth={2} focusable="false" />
                </span>
                <div className={styles.streamIdentity}>
                  <h3>{names[stream.streamId]}</h3>
                  <p>{streamDescriptions[stream.streamId]}</p>
                </div>
                {!hasDetails ? (
                  <Badge
                    tone={activitiesUnavailable ? 'neutral' : statusTones[status]}
                    className={styles.staticStatus}
                  >
                    {activitiesUnavailable ? (
                      <Clock3 size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
                    ) : (
                      <StatusIcon
                        size={16}
                        strokeWidth={2}
                        className={status === 'running' ? styles.statusSpinner : undefined}
                        aria-hidden="true"
                        focusable="false"
                      />
                    )}
                    {activitiesUnavailable ? 'Coming later' : statusLabel}
                  </Badge>
                ) : (
                  <button
                    type="button"
                    className={styles.expandButton}
                    aria-label={`${isExpanded ? 'Hide' : 'Show'} ${names[stream.streamId]} details`}
                    aria-expanded={isExpanded}
                    aria-controls={isExpanded ? detailsId : undefined}
                    onClick={() =>
                      setExpanded((current) => ({
                        ...current,
                        [stream.streamId]: !isExpanded,
                      }))
                    }
                  >
                    <Badge tone={statusTones[status]} className={styles.status}>
                      <StatusIcon
                        size={16}
                        strokeWidth={2}
                        className={status === 'running' ? styles.statusSpinner : undefined}
                        aria-hidden="true"
                        focusable="false"
                      />
                      {statusLabel}
                    </Badge>
                    {isExpanded ? (
                      <ChevronUp size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                    ) : (
                      <ChevronDown size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                    )}
                  </button>
                )}
              </div>
              {isExpanded && (
                <div id={detailsId} className={styles.streamDetails}>
                  {stream.totalDays !== null && (
                    <div className={styles.coverage}>
                      <progress
                        value={stream.checkedDays}
                        max={stream.totalDays}
                        aria-label={`${names[stream.streamId]} checked dates`}
                      />
                      <div className={styles.coverageLabels}>
                        <span>
                          {checkedCount} of {totalCount} dates checked
                          {stream.failedDateCount > 0 &&
                            `; ${(stream.checkedDays + stream.failedDateCount).toLocaleString('en-US')} reached, ${stream.failedDateCount} unresolved`}
                        </span>
                        <span>{Math.round((stream.checkedDays / stream.totalDays) * 100)}%</span>
                      </div>
                    </div>
                  )}
                  {stream.streamId === 'activities' && stream.lastSyncAt && (
                    <p className={styles.note}>
                      {stream.activityCount ?? 0} activities processed in the latest run. Total
                      history is unknown.
                    </p>
                  )}
                  {(stream.startDate ||
                    stream.currentRange ||
                    stream.lastCheckedDate ||
                    stream.lastSyncAt) && (
                    <div className={styles.metadata}>
                      {stream.startDate && stream.endDate && (
                        <div>
                          <CalendarDays
                            size={18}
                            strokeWidth={2}
                            aria-hidden="true"
                            focusable="false"
                          />
                          <span>
                            <small>Coverage</small>
                            <strong>
                              {stream.startDate} – {stream.endDate}
                            </strong>
                          </span>
                        </div>
                      )}
                      {stream.currentRange && stream.streamId !== 'activities' && (
                        <div>
                          <Layers size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                          <span>
                            <small>Current range</small>
                            <strong>
                              {stream.currentRange.start} – {stream.currentRange.end}
                            </strong>
                          </span>
                        </div>
                      )}
                      {stream.lastCheckedDate && (
                        <div>
                          <Layers size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                          <span>
                            <small>Last checkpoint</small>
                            <strong>{stream.lastCheckedDate}</strong>
                          </span>
                        </div>
                      )}
                      {stream.lastSyncAt && (
                        <div>
                          <Clock3 size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                          <span>
                            <small>Last sync</small>
                            <strong>
                              {clientReady
                                ? formatLocalDateTime(stream.lastSyncAt)
                                : 'Loading local time'}
                            </strong>
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                  {stream.failedDateCount > 0 && (
                    <p className={styles.failedCount}>
                      <CircleAlert size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                      {stream.failedDateCount} failed dates remain.
                    </p>
                  )}
                  {blockedUntil && (
                    <p id={retryHintId} className={styles.backoff} role="status">
                      {stream.errorCode === 'RATE_LIMITED' || rateLimitUntil
                        ? 'Garmin is rate limiting requests.'
                        : 'Import is waiting before the next request.'}{' '}
                      Try again after{' '}
                      {clientReady ? formatLocalDateTime(blockedUntil) : 'the retry time'}.
                    </p>
                  )}
                  {safeFailure(stream.errorCode) && !blockedUntil && (
                    <p className={styles.failure}>{safeFailure(stream.errorCode)}</p>
                  )}
                  <div className={styles.actions}>
                    {canResume && (
                      <Button
                        size="compact"
                        variant={stream.streamId === 'sleep' ? 'primary' : 'secondary'}
                        disabled={pending || blocked}
                        aria-describedby={blocked ? retryHintId : undefined}
                        onClick={() => void run([{ streamId: stream.streamId, action: 'resume' }])}
                      >
                        <Play size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                        Resume import
                      </Button>
                    )}
                    {stream.streamId !== 'activities' && canRetry && (
                      <Button
                        size="compact"
                        variant="secondary"
                        disabled={pending || blocked}
                        aria-describedby={blocked ? retryHintId : undefined}
                        onClick={() => void run([{ streamId: stream.streamId, action: 'retry' }])}
                      >
                        <RotateCw size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                        Retry failed dates
                        {stream.failedDateCount > 0 ? ` (${stream.failedDateCount})` : ''}
                      </Button>
                    )}
                    {stream.streamId !== 'activities' &&
                      stream.status !== 'not_started' &&
                      stream.status !== 'running' && (
                        <Button
                          size="compact"
                          variant="secondary"
                          disabled={pending || blocked}
                          aria-describedby={blocked ? retryHintId : undefined}
                          onClick={() =>
                            void run([{ streamId: stream.streamId, action: 'reimport' }])
                          }
                        >
                          <RotateCw
                            size={18}
                            strokeWidth={2}
                            aria-hidden="true"
                            focusable="false"
                          />
                          Reimport {names[stream.streamId]}
                        </Button>
                      )}
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>
      <div className={styles.footer}>
        <Button
          disabled={pending || selected.length === 0 || Boolean(rateLimitUntil) || selectedBlocked}
          loading={pending}
          onClick={() =>
            void run(
              selected.map((streamId) => ({
                streamId,
                action:
                  streams.find((stream) => stream.streamId === streamId)?.status === 'not_started'
                    ? 'import'
                    : 'resume',
              })),
            )
          }
        >
          <Download size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
          Import selected
        </Button>
        {pending && (
          <Button size="compact" variant="secondary" onClick={() => activeRun.current?.abort()}>
            <Square size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
            Stop import
          </Button>
        )}
        {!pending && <span className={styles.note}>Select one or more streams to import.</span>}
      </div>
      {error && (
        <p className={styles.failure} role="alert">
          {error}
        </p>
      )}
    </Card>
  )
}
