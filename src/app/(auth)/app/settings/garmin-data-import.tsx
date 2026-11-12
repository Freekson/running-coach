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
import type { GarminImportStreamState, ImportStreamId } from '@/lib/garmin-import-state'
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
  activities: 'Workouts and activities (running, cycling, walking, etc.) with summary metrics.',
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
const baseStreamStateSchema = z.object({
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
  pagesFetched: z.number().int().nonnegative().optional(),
  currentRange: z.object({ start: z.string(), end: z.string() }).nullable().optional(),
})
const lapStateSchema = z.object({
  status: baseStreamStateSchema.shape.status,
  eligible: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  retryable: z.number().int().nonnegative(),
  totalLaps: z.number().int().nonnegative(),
  retryAfter: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  errorCode: z.string().nullable(),
})
const streamStateSchema = baseStreamStateSchema.extend({
  summaryStatus: baseStreamStateSchema.shape.status.optional(),
  summaryErrorCode: z.string().nullable().optional(),
  summaryRetryAfter: z.string().nullable().optional(),
  laps: lapStateSchema.optional(),
  recentSync: baseStreamStateSchema.optional(),
})
type ImportAction = 'import' | 'resume' | 'retry' | 'reimport'
type ImportItem = { streamId: ImportStreamId; action: ImportAction; stage?: 'summaries' | 'laps' }
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
  'INVALID_KEY',
  'ACCESS_DENIED',
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
  if (code === 'INVALID_KEY' || code === 'NOT_CONNECTED')
    return 'The Garmin key was rejected. Replace it to continue.'
  if (code === 'TOKEN_REJECTED')
    return 'Garmin rejected the temporary access token. Retry the import to request a new token.'
  if (code === 'ACCESS_DENIED') return 'Garmin denied activity access. Check the key permissions.'
  if (code === 'INVALID_RESPONSE')
    return 'Garmin returned invalid or changing activity data. Progress is saved; retry the page.'
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
    stream.streamId === 'activities' ||
    stream.totalDays !== null ||
    stream.startDate ||
    stream.currentRange ||
    stream.lastCheckedDate ||
    stream.lastSyncAt ||
    stream.failedDateCount > 0 ||
    stream.errorCode,
  )
}

function reimportRetryAfter(stream: GarminImportStreamState): string | null {
  return stream.streamId === 'activities' && stream.summaryRetryAfter !== undefined
    ? stream.summaryRetryAfter
    : stream.retryAfter
}

function retryDeadline(
  retryAfter: string | null,
  rateLimitUntil: string | null,
  clientReady: boolean,
  nowMs: number,
): string | null {
  if (!clientReady) return retryAfter
  const parsed = retryAfter ? Date.parse(retryAfter) : 0
  const retryMs = Number.isFinite(parsed) ? parsed : 0
  return retryMs > nowMs || rateLimitUntil
    ? new Date(Math.max(retryMs, rateLimitUntil ? Date.parse(rateLimitUntil) : 0)).toISOString()
    : null
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
  const [activeStage, setActiveStage] = useState<'summaries' | 'laps' | null>(null)
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

  const externallyRunning =
    !pending &&
    streams.some((stream) => stream.status === 'running' || stream.recentSync?.status === 'running')
  useEffect(() => {
    if (!externallyRunning) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refreshProgress() {
      try {
        const response = await fetch('/api/integrations/garmin/import', {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        })
        if (response.ok) {
          const payload: unknown = await response.json()
          const parsed = z.array(streamStateSchema).safeParse(payload)
          if (parsed.success && !controller.signal.aborted && !activeRun.current)
            setOverride({ initial, value: parsed.data })
        }
      } catch {
        // A read-only refresh can retry without changing the saved import or starting a job.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refreshProgress(), 5_000)
      }
    }
    timer = setTimeout(() => void refreshProgress(), 5_000)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [externallyRunning, initial])

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

  async function act(
    streamId: ImportStreamId,
    action: ImportAction,
    stage?: ImportItem['stage'],
  ): Promise<ImportResult> {
    const response = await fetch('/api/integrations/garmin/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        streamId,
        action,
        stage,
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
    if (activeRun.current || items.length === 0) return
    if (
      rateLimitUntil ||
      items.some((item) => {
        const stream = streams.find((stream) => stream.streamId === item.streamId)
        const retryAt =
          stream && (item.action === 'reimport' ? reimportRetryAfter(stream) : stream.retryAfter)
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
      const queue = items.map((item): ImportItem => {
        if (item.streamId !== 'activities' || item.stage) return item
        const stream = streams.find((candidate) => candidate.streamId === 'activities')
        return {
          ...item,
          stage:
            item.action === 'reimport' || (stream?.summaryStatus ?? stream?.status) !== 'completed'
              ? 'summaries'
              : 'laps',
        }
      })
      for (const item of queue) {
        if (controller.signal.aborted) break
        setActiveStream(item.streamId)
        setActiveStage(item.stage ?? null)
        let action = item.action
        const progressState = (stream: GarminImportStreamState | undefined) => {
          if (!stream) return stream
          if (item.stage === 'laps' && stream.laps) {
            const laps = stream.laps
            return {
              ...stream,
              status: laps.status,
              // Internal loop sentinel; durable per-activity state supplies the remaining work.
              nextDate: (item.action === 'retry' ? laps.retryable > 0 : laps.pending > 0)
                ? 'pending'
                : null,
              checkedDays: laps.processed,
              failedDateCount: laps.failed,
              pagesFetched:
                item.action === 'retry' ? laps.eligible - laps.retryable : laps.processed,
              activityCount: laps.complete,
              retryAfter: laps.retryAfter,
              errorCode: laps.errorCode,
            }
          }
          return item.stage === 'summaries'
            ? {
                ...stream,
                status: stream.summaryStatus ?? stream.status,
                errorCode:
                  'summaryErrorCode' in stream
                    ? (stream.summaryErrorCode ?? null)
                    : stream.errorCode,
              }
            : stream
        }
        let previous = progressState(streams.find((stream) => stream.streamId === item.streamId))
        const retrying =
          action === 'retry' && (item.streamId !== 'activities' || item.stage === 'laps')
        let consecutiveStalls = 0
        for (;;) {
          if (controller.signal.aborted) break
          setWaitingUntil(null)
          setWaitingForRateLimit(false)
          const result = await act(item.streamId, action, item.stage)
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
          const current = progressState(
            result.states.find((stream) => stream.streamId === item.streamId),
          )
          if (!current) throw new Error('Import stream missing from response')
          if (requiresAttention(current.errorCode)) {
            unresolved = true
            break
          }
          if (item.stage === 'summaries' && current.status === 'completed') {
            const activities = result.states.find(
              (candidate) => candidate.streamId === 'activities',
            )
            if (
              activities?.laps &&
              (activities.laps.pending > 0 || activities.laps.status === 'not_started')
            )
              queue.push({ streamId: 'activities', action: 'import', stage: 'laps' })
          }
          const interruptedLapRetry =
            item.stage === 'laps' &&
            retrying &&
            current.failedDateCount > 0 &&
            current.status === 'waiting_retry' &&
            Boolean(current.retryAfter) &&
            (current.errorCode === 'RATE_LIMITED' || current.errorCode === 'TOKEN_REJECTED')
          // A provider/token pause makes the interrupted item temporarily ineligible, not finished.
          if (item.stage === 'laps' && current.nextDate === null && !interruptedLapRetry) {
            if (current.failedDateCount > 0) unresolved = true
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
              current.failedDateCount !== previous?.failedDateCount ||
              current.pagesFetched !== previous?.pagesFetched ||
              current.activityCount !== previous?.activityCount
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
            if (
              previous &&
              current.failedDateCount >= previous.failedDateCount &&
              (item.stage !== 'laps' || current.pagesFetched === previous.pagesFetched)
            ) {
              unresolved = true
              break
            }
            previous = current
            action = 'retry'
            continue
          }
          if (current.nextDate !== null && current.status !== 'completed') {
            if (
              previous &&
              current.nextDate === previous.nextDate &&
              current.pagesFetched === previous.pagesFetched
            ) {
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
            'Import paused with unresolved work. Review the stream status.',
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
        setActiveStage(null)
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
              <strong>Retry failed dates</strong> checks only unresolved dates. Retry summaries
              continues the saved activity page. Retry failed FITs downloads only failed activities.
            </li>
            <li>
              <strong>Reimport</strong> starts a new pass for that stream. Sync recent activities on
              Training. Older edits need Reimport; deleted Garmin activities remain saved. Unchanged
              summaries retain completed laps.
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
          const isActivities = stream.streamId === 'activities'
          const needsAccountAction = requiresAttention(stream.errorCode)
          const summaryStatus = stream.summaryStatus ?? stream.status
          const laps = stream.laps
          const lapsResumable =
            summaryStatus === 'completed' &&
            Boolean(
              laps &&
              (laps.pending > 0 || laps.status === 'not_started') &&
              laps.status !== 'running',
            )
          const canResume =
            (stream.status === 'paused' || stream.status === 'waiting_retry') &&
            (stream.nextDate !== null || lapsResumable) &&
            !needsAccountAction
          const canRetry =
            (isActivities
              ? Boolean(stream.errorCode && stream.nextDate && summaryStatus !== 'completed')
              : stream.failedDateCount > 0) &&
            !needsAccountAction &&
            stream.status !== 'running'
          const selectable = stream.status === 'not_started' || canResume
          const blockedUntil = retryDeadline(stream.retryAfter, rateLimitUntil, clientReady, nowMs)
          const blocked = Boolean(blockedUntil)
          const reimportBlockedUntil = retryDeadline(
            reimportRetryAfter(stream),
            rateLimitUntil,
            clientReady,
            nowMs,
          )
          const reimportBlocked = Boolean(reimportBlockedUntil)
          const separateReimportHint = reimportBlockedUntil && reimportBlockedUntil !== blockedUntil
          const activeStatus = pending && activeStream === stream.streamId
          const status = activeStatus ? (waitingUntil ? 'waiting_retry' : 'running') : stream.status
          const StatusIcon = statusIcons[status]
          const StreamIcon = streamIcons[stream.streamId]
          const hasDetails = hasStreamDetails(stream)
          const isExpanded = hasDetails && Boolean(expanded[stream.streamId])
          const detailsId = `garmin-${stream.streamId}-details`
          const retryHintId = `garmin-${stream.streamId}-retry-time`
          const reimportHintId = `garmin-${stream.streamId}-reimport-retry-time`
          const statusLabel =
            isActivities && status === 'completed' && !laps
              ? 'Summary complete \u00b7 Laps pending'
              : status === 'paused' && !stream.errorCode && (canResume || !isActivities || !laps)
                ? 'Ready to resume'
                : labels[status]
          const summaryDisplayStatus =
            activeStatus && activeStage !== 'laps' ? status : summaryStatus
          const lapDisplayStatus =
            activeStatus && activeStage === 'laps' ? status : (laps?.status ?? 'not_started')
          const checkedCount = stream.checkedDays.toLocaleString('en-US')
          const totalCount = stream.totalDays?.toLocaleString('en-US')
          return (
            <article key={stream.streamId} className={styles.stream}>
              <div className={styles.titleRow}>
                <label className={styles.select}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${names[stream.streamId]}`}
                    checked={
                      stream.status === 'completed' ||
                      stream.status === 'completed_with_warnings' ||
                      selected.includes(stream.streamId)
                    }
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
                  <Badge tone={statusTones[status]} className={styles.staticStatus}>
                    <StatusIcon
                      size={16}
                      strokeWidth={2}
                      className={status === 'running' ? styles.statusSpinner : undefined}
                      aria-hidden="true"
                      focusable="false"
                    />
                    {statusLabel}
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
                    <Badge
                      tone={
                        isActivities && status === 'completed' && !laps
                          ? 'warning'
                          : statusTones[status]
                      }
                      className={styles.status}
                    >
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
                  {!isActivities && stream.totalDays !== null && (
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
                  {isActivities && (
                    <div className={styles.stages}>
                      <section className={styles.stage} aria-labelledby="activity-summary-stage">
                        <span className={styles.stageNumber} aria-hidden="true">
                          1
                        </span>
                        <div className={styles.stageBody}>
                          <div className={styles.stageHeading}>
                            <h4 id="activity-summary-stage">Activity summaries</h4>
                            <Badge tone={statusTones[summaryDisplayStatus]}>
                              {summaryDisplayStatus === 'not_started'
                                ? 'Not started'
                                : labels[summaryDisplayStatus]}
                            </Badge>
                          </div>
                          <p>
                            Import all activity types and their available distance, time, heart rate
                            and other summary metrics.
                          </p>
                          <p className={styles.stageCount} role="status">
                            {(stream.activityCount ?? 0).toLocaleString('en-US')}
                            {summaryStatus === 'completed'
                              ? ` of ${(stream.activityCount ?? 0).toLocaleString('en-US')}`
                              : ''}{' '}
                            summaries imported {'\u00b7'}{' '}
                            {(stream.pagesFetched ?? 0).toLocaleString('en-US')} pages checked
                          </p>
                          {stream.totalDays !== null && (
                            <div className={styles.coverage}>
                              <progress
                                value={stream.checkedDays}
                                max={stream.totalDays}
                                aria-label="Activity summary date coverage"
                              />
                              <span className={styles.note}>
                                {checkedCount} of {totalCount} dates verified.
                                {summaryStatus === 'completed'
                                  ? ' Summary coverage complete.'
                                  : ' Activity total is known after traversal.'}
                              </span>
                            </div>
                          )}
                        </div>
                      </section>
                      <section className={styles.stage} aria-labelledby="activity-laps-stage">
                        <span className={styles.stageNumber} aria-hidden="true">
                          2
                        </span>
                        <div className={styles.stageBody}>
                          <div className={styles.stageHeading}>
                            <h4 id="activity-laps-stage">Normalized laps</h4>
                            <Badge tone={statusTones[lapDisplayStatus]}>
                              {lapDisplayStatus === 'not_started'
                                ? 'Not started'
                                : labels[lapDisplayStatus]}
                            </Badge>
                          </div>
                          <p>
                            Import ordered laps and their available time, distance, heart rate and
                            power metrics.
                          </p>
                          {laps ? (
                            <>
                              <div className={styles.coverage}>
                                <progress
                                  value={laps.processed}
                                  max={Math.max(1, laps.eligible)}
                                  aria-label="Normalized lap activity progress"
                                />
                                <div className={styles.coverageLabels}>
                                  <span>
                                    {laps.processed.toLocaleString('en-US')} of{' '}
                                    {laps.eligible.toLocaleString('en-US')} activities processed
                                  </span>
                                  <span>
                                    {laps.eligible
                                      ? Math.round((laps.processed / laps.eligible) * 100)
                                      : lapDisplayStatus === 'completed'
                                        ? 100
                                        : 0}
                                    %
                                  </span>
                                </div>
                              </div>
                              <p className={styles.note} role="status">
                                {laps.complete} complete; {laps.unavailable} unavailable;{' '}
                                {laps.failed} failed. {laps.totalLaps.toLocaleString('en-US')} laps
                                saved.
                              </p>
                              {laps.unavailable > 0 && (
                                <p className={styles.note}>
                                  Some FIT files have no supported lap data. Their activity
                                  summaries remain available.
                                </p>
                              )}
                              {laps.failed > 0 && (
                                <p className={styles.failure}>
                                  Failed FIT downloads are saved for retry; other activities
                                  continue.
                                </p>
                              )}
                            </>
                          ) : (
                            <p className={styles.note}>Ready after activity summaries finish.</p>
                          )}
                        </div>
                      </section>
                    </div>
                  )}
                  {isActivities && stream.recentSync && (
                    <p className={styles.note} role="status">
                      Recent sync: {labels[stream.recentSync.status]} {'\u00b7'}{' '}
                      {stream.recentSync.activityCount ?? 0} summaries imported {'\u00b7'}{' '}
                      {stream.recentSync.pagesFetched ?? 0} pages checked.
                      {stream.recentSync.startDate &&
                        ` Window: ${stream.recentSync.startDate} \u2013 ${stream.recentSync.endDate}.`}
                      {stream.recentSync.retryAfter &&
                        ` Retry after ${clientReady ? formatLocalDateTime(stream.recentSync.retryAfter) : 'the saved retry time'}.`}
                      {safeFailure(stream.recentSync.errorCode)}
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
                      {stream.currentRange && (
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
                      {isActivities && summaryStatus === 'completed' && Boolean(laps?.failed)
                        ? 'Failed FIT downloads are waiting before retry.'
                        : stream.errorCode === 'RATE_LIMITED' || rateLimitUntil
                          ? 'Garmin is rate limiting requests.'
                          : 'Import is waiting before the next request.'}{' '}
                      Try again after{' '}
                      {clientReady ? formatLocalDateTime(blockedUntil) : 'the retry time'}.
                    </p>
                  )}
                  {separateReimportHint && (
                    <p id={reimportHintId} className={styles.backoff} role="status">
                      Reimport is waiting before the next request. Try again after{' '}
                      {clientReady ? formatLocalDateTime(reimportBlockedUntil) : 'the retry time'}.
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
                        {lapsResumable ? 'Resume laps' : 'Resume import'}
                      </Button>
                    )}
                    {canRetry && (
                      <Button
                        size="compact"
                        variant="secondary"
                        disabled={pending || blocked}
                        aria-describedby={blocked ? retryHintId : undefined}
                        onClick={() => void run([{ streamId: stream.streamId, action: 'retry' }])}
                      >
                        <RotateCw size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                        {isActivities ? 'Retry summaries' : 'Retry failed dates'}
                        {stream.failedDateCount > 0 ? ` (${stream.failedDateCount})` : ''}
                      </Button>
                    )}
                    {isActivities && Boolean(laps && laps.failed > 0) && !needsAccountAction && (
                      <Button
                        size="compact"
                        variant="secondary"
                        disabled={pending || blocked || stream.status === 'running'}
                        aria-describedby={blocked ? retryHintId : undefined}
                        onClick={() =>
                          void run([{ streamId: 'activities', action: 'retry', stage: 'laps' }])
                        }
                      >
                        <RotateCw size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                        Retry failed FITs ({laps?.failed})
                      </Button>
                    )}
                    {stream.status !== 'not_started' && stream.status !== 'running' && (
                      <Button
                        size="compact"
                        variant="secondary"
                        disabled={pending || reimportBlocked}
                        aria-describedby={
                          reimportBlocked
                            ? separateReimportHint
                              ? reimportHintId
                              : retryHintId
                            : undefined
                        }
                        onClick={() =>
                          void run([{ streamId: stream.streamId, action: 'reimport' }])
                        }
                      >
                        <RotateCw size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
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
