'use client'

import { useRef, useState } from 'react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { Upload } from 'lucide-react'
import type { RevisionPublicationPreview } from '@/lib/plan-publication'
import {
  intervalsDownstreamGuidance,
  publicationStatusLabels,
  type PublicationSummary,
} from '@/lib/workout-publication'
import { RefreshChanges } from './new/plan-review'
import styles from './new/plan-wizard.module.scss'

type Result<T> = { success: true; value: T } | { success: false; error: string }
export type PublicationActions = {
  onPreview: (input: {
    planId: string
    expectedRevisionId: string
  }) => Promise<Result<RevisionPublicationPreview>>
  onSend: (input: {
    planId: string
    expectedRevisionId: string
    workoutId: string
    reviewToken: string
    confirm: true
  }) => Promise<Result<PublicationSummary>>
}
export function RevisionPublication({
  planId,
  revisionId,
  onPreview,
  onSend,
}: PublicationActions & { planId: string; revisionId: string }) {
  const [preview, setPreview] = useState<RevisionPublicationPreview>()
  const [confirmed, setConfirmed] = useState<string[]>([])
  const [receipts, setReceipts] = useState<(PublicationSummary & { recoveryOnly?: true })[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  async function review() {
    const result = await onPreview({ planId, expectedRevisionId: revisionId })
    setConfirmed([])
    setPreview(result.success ? result.value : undefined)
    if (!result.success) setError(result.error)
  }
  async function act(workoutId?: string) {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError('')
    try {
      if (workoutId) {
        const change = preview?.changes.find((entry) => entry.workoutId === workoutId)
        if (!change || !confirmed.includes(change.reviewToken)) return
        const result = await onSend({
          planId,
          expectedRevisionId: revisionId,
          workoutId,
          reviewToken: change.reviewToken,
          confirm: true,
        })
        setConfirmed([])
        if (!result.success) {
          setError(result.error)
          setPreview(undefined)
          return
        }
        setReceipts((previous) => [
          ...previous.filter((entry) => entry.localWorkoutId !== workoutId),
          { ...result.value, ...(change.recoveryOnly ? { recoveryOnly: true as const } : {}) },
        ])
      }
      await review()
    } catch {
      setError(
        'Publication could not be checked. Review the changes again before retrying. Your approved plan is preserved.',
      )
      setPreview(undefined)
      setConfirmed([])
    } finally {
      setPending(false)
      busy.current = false
    }
  }
  return (
    <Card className={styles.stack}>
      <SectionHeading icon={Upload} title="Separate Intervals.icu publication" />
      <p>
        Review each proposed remote change before confirming it. Before shows the last confirmed
        publication, retained separately from pending changes. This preview does not read the live
        remote calendar. The outbox rechecks remote state when sending.
      </p>
      <p>{intervalsDownstreamGuidance}</p>
      <ButtonLink href="/app/settings" variant="secondary" disabled={pending}>
        Manage Intervals.icu connection
      </ButtonLink>
      <Button variant="secondary" loading={pending} onClick={() => void act()}>
        Review Intervals.icu changes
      </Button>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {receipts.map((receipt) => (
        <p role="status" key={receipt.id}>
          {receipt.recoveryOnly && receipt.status === 'SUPERSEDED'
            ? 'Previous publication reconciled; the protected workout was not sent again. Garmin Connect and watch delivery remain unverified.'
            : publicationStatusLabels[receipt.status]}
          {receipt.errorCode ? ` · ${receipt.errorCode.replaceAll('_', ' ')}` : ''}
        </p>
      ))}
      {preview && !preview.changes.length && (
        <p>No pending changes to publish for editable future workouts.</p>
      )}
      {preview?.changes.map((change) => (
        <section className={styles.day} key={change.workoutId}>
          <h3>
            {change.operation} · {change.after.definition.name}
          </h3>
          {change.recovery && (
            <p>
              {change.recoveryOnly
                ? 'This workout is past, completed or locked. Only the earlier publication can be reconciled; its prescription will not be sent again.'
                : 'An earlier publication needs reconciliation before this change can be queued. Confirm a recovery check first, then review the resulting pending change separately.'}
            </p>
          )}
          {change.status && <p>Previous outbox status: {publicationStatusLabels[change.status]}</p>}
          {change.baselineStatus === 'confirmed' && (
            <p>Before: last confirmed publication. After: proposed approved schedule.</p>
          )}
          {change.baselineStatus === 'not_published' && (
            <p>No earlier publication is recorded for this workout.</p>
          )}
          {change.baselineStatus === 'unknown' && (
            <p role="status">
              The previous confirmed schedule is unknown. The pending intent is not evidence of the
              remote schedule.
            </p>
          )}
          {change.remoteStateUncertain && (
            <p role="status">
              The remote outcome is uncertain. An earlier write may already have taken effect; the
              last confirmed schedule is a historical reference only.
            </p>
          )}
          <RefreshChanges changes={[change]} />
          <label className={styles.choice}>
            <input
              type="checkbox"
              disabled={pending}
              checked={confirmed.includes(change.reviewToken)}
              onChange={(event) =>
                setConfirmed((previous) =>
                  event.target.checked
                    ? [...previous, change.reviewToken]
                    : previous.filter((token) => token !== change.reviewToken),
                )
              }
            />
            I reviewed and confirm this{' '}
            {change.recovery ? 'recovery check' : change.operation.toLowerCase()} in Intervals.icu
            for {change.after.definition.name}.
          </label>
          <Button
            disabled={!confirmed.includes(change.reviewToken)}
            loading={pending}
            onClick={() => void act(change.workoutId)}
          >
            Confirm {change.recovery ? 'recovery check' : change.operation.toLowerCase()} in
            Intervals.icu
          </Button>
        </section>
      ))}
    </Card>
  )
}
