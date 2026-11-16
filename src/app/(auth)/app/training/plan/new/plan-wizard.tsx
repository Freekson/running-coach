'use client'

import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { FormField } from '@/components/ui/FormField'
import { Select } from '@/components/ui/Select'
import { LoadingState } from '@/components/ui/States'
import type { GoalRecord } from '@/lib/goals'
import type { PlanImportResult } from '@/lib/plan-import'
import type { ApprovedPlanChoice } from '@/lib/plan-refresh'
import { useClientReady } from '@/lib/use-client-ready'
import { EXCHANGE_LIMITS } from '@/schemas/plan-exchange.v1'
import { PlanExportScreen } from '../../../goals/[id]/export/plan-export'
import type { ExportFormState } from '../../../goals/[id]/export/plan-export-state'
import { GoalForm } from '../../../goals/goal-form'
import type { GoalFields } from '../../../goals/goal-view'
import { PlanReview } from './plan-review'
import { emptyWizard, readWizard, wizardStorageKey, type WizardState } from './wizard-state'
import styles from './plan-wizard.module.scss'
import { RevisionPublication, type PublicationActions } from '../revision-publication'

type Result<T> = { success: true; value: T } | { success: false; error: string }
type ExportProps = ComponentProps<typeof PlanExportScreen>
type ImportCommand = {
  goalId: string
  draftId: string
  requestId: string
  acknowledgedWarningIds: string[]
  warningRationale?: string
}
type ReviewedResponse = Pick<ImportCommand, 'goalId' | 'draftId' | 'requestId'> & {
  text: string
  generation: number
}
export type PlanWizardProps = {
  ownerId: string
  goals: GoalRecord[]
  refresh?: ApprovedPlanChoice
  publication?: PublicationActions
  onOpen: ExportProps['onOpen']
  onExport: ExportProps['onPreview']
  onSchedule: ExportProps['onSchedule']
  onCreateGoal: (fields: GoalFields) => Promise<GoalRecord>
  onPreview: (command: ImportCommand, text: string) => Promise<Result<PlanImportResult>>
  onApprove: (
    command: ImportCommand & { approve: true },
    text: string,
  ) => Promise<
    Result<
      | { approved: false; validation: PlanImportResult }
      | { approved: true; planId: string; revisionId: string; revisionNumber: number }
    >
  >
}

export function PlanWizard(props: PlanWizardProps) {
  const ready = useClientReady()
  return ready ? (
    <Wizard key={`${props.ownerId}:${props.refresh?.id ?? 'initial'}`} {...props} />
  ) : (
    <LoadingState label="Loading your plan draft" />
  )
}

function Wizard({
  ownerId,
  goals: initialGoals,
  onOpen,
  onExport,
  onSchedule,
  onPreview,
  onApprove,
  onCreateGoal,
  refresh,
  publication,
}: PlanWizardProps) {
  const key = wizardStorageKey(ownerId, refresh?.id)
  const [state, setState] = useState<WizardState>(() => {
    try {
      const saved = readWizard(window.localStorage, key)
      return refresh ? { ...saved, goalId: refresh.goalId } : saved
    } catch {
      return { ...emptyWizard, goalId: refresh?.goalId ?? '' }
    }
  })
  const [goals, setGoals] = useState(initialGoals)
  const [creatingGoal, setCreatingGoal] = useState(false)
  const [operationPending, setPending] = useState(false)
  const [exportPending, setExportPending] = useState(false)
  const [readingFile, setReadingFile] = useState(false)
  const pending = operationPending || exportPending || readingFile
  const [openCount, setOpenCount] = useState(0)
  const busy = useRef(false)
  const reviewGeneration = useRef(0)
  const [storageFailed, setStorageFailed] = useState(false)
  const [error, setError] = useState('')
  const [validation, setValidation] = useState<PlanImportResult>()
  const [reviewedResponse, setReviewedResponse] = useState<ReviewedResponse>()
  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const [rationale, setRationale] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [approved, setApproved] = useState<{
    planId: string
    revisionId: string
    revisionNumber: number
  }>()
  const heading = useRef<HTMLHeadingElement>(null)
  const goal = goals.find((g) => g.id === state.goalId)
  const artifact = state.exportState?.result
  const reviewMatches =
    !!reviewedResponse &&
    reviewedResponse.text === state.text &&
    reviewedResponse.goalId === state.goalId &&
    reviewedResponse.draftId === state.setup?.draftId &&
    reviewedResponse.requestId === artifact?.requestId

  useEffect(() => {
    if (approved) return
    try {
      window.localStorage.setItem(key, JSON.stringify(state))
    } catch {
      queueMicrotask(() => setStorageFailed(true))
    }
  }, [state, key, approved])
  useEffect(() => {
    heading.current?.focus()
  }, [state.step])

  const invalidate = useCallback(() => {
    reviewGeneration.current++
    setValidation(undefined)
    setReviewedResponse(undefined)
    setAcknowledged([])
    setRationale('')
    setConfirm(false)
  }, [])
  const saveExportState = useCallback((exportState: ExportFormState) => {
    setState((previous) => ({ ...previous, exportState }))
  }, [])

  async function open(input: { goalId: string }) {
    const result = await onOpen(input)
    if (result.success) {
      invalidate()
      setState((previous) => ({
        ...previous,
        setup: result.value,
        exportState: previous.exportState
          ? {
              ...previous.exportState,
              result: undefined,
              constraints: result.value.constraints,
            }
          : undefined,
        step: 1,
      }))
      setOpenCount((previous) => previous + 1)
    }
    return result
  }
  async function start() {
    if (!goal || busy.current) return
    busy.current = true
    setPending(true)
    setError('')
    try {
      const result = await open({ goalId: goal.id })
      if (!result.success) setError(result.error)
    } catch {
      setError('The draft could not be opened. Please try again.')
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  function command(): ImportCommand | null {
    if (!state.setup || !artifact) return null
    return {
      goalId: state.goalId,
      draftId: state.setup.draftId,
      requestId: artifact.requestId,
      acknowledgedWarningIds: acknowledged,
      ...(rationale.trim() ? { warningRationale: rationale.trim() } : {}),
    }
  }
  async function inspect(approve = false) {
    const input = command()
    if (!input || busy.current || exportPending) return
    if (approve && (!reviewMatches || reviewedResponse?.generation !== reviewGeneration.current)) {
      invalidate()
      setError('The response or request changed. Validate and review it again before approval.')
      return
    }
    const generation = reviewGeneration.current
    const text = approve && reviewedResponse ? reviewedResponse.text : state.text
    busy.current = true
    setPending(true)
    setError('')
    if (!approve) {
      setReviewedResponse(undefined)
      setConfirm(false)
    }
    try {
      if (approve) {
        const result = await onApprove({ ...input, approve: true }, text)
        if (!result.success) {
          setError(result.error)
          return
        }
        if (!result.value.approved) {
          setValidation(result.value.validation)
          setConfirm(false)
          setError(
            'Approval was not saved. Review the current errors or warnings below and try again.',
          )
          return
        }
        setApproved(result.value)
        try {
          window.localStorage.removeItem(key)
        } catch {
          /* Approval is already saved on the server. */
        }
      } else {
        const result = await onPreview(input, text)
        if (generation !== reviewGeneration.current) return
        if (!result.success) {
          setError(result.error)
          return
        }
        setValidation(result.value)
        setReviewedResponse(
          result.value.valid
            ? {
                goalId: input.goalId,
                draftId: input.draftId,
                requestId: input.requestId,
                text,
                generation,
              }
            : undefined,
        )
        setConfirm(false)
        if (result.value.valid) setState((previous) => ({ ...previous, step: 3 }))
      }
    } catch {
      setError('The response could not be processed. Your draft is preserved. Please try again.')
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  async function readFile(file: File | undefined) {
    if (!file || busy.current || exportPending) return
    if (file.size > EXCHANGE_LIMITS.responseBytes) {
      setError(`Choose a JSON response no larger than ${EXCHANGE_LIMITS.responseBytes / 1024} KB.`)
      return
    }
    busy.current = true
    setReadingFile(true)
    invalidate()
    setError('')
    const generation = reviewGeneration.current
    try {
      const text = await file.text()
      if (generation !== reviewGeneration.current) return
      if (new TextEncoder().encode(text).byteLength > EXCHANGE_LIMITS.responseBytes)
        throw new Error()
      setState((previous) => ({ ...previous, text }))
    } catch {
      if (generation === reviewGeneration.current)
        setError('The file could not be read. Paste the JSON response below instead.')
    } finally {
      busy.current = false
      setReadingFile(false)
    }
  }

  if (approved)
    return (
      <main className={styles.screen}>
        <Card>
          <h1>Plan approved locally</h1>
          <p>
            Revision {approved.revisionNumber} is saved. Nothing has been sent to Intervals.icu or
            Garmin.
          </p>
          <p>Publication requires a separate explicit Publish to Intervals.icu action.</p>
          <ButtonLink href="/app/calendar">View training calendar</ButtonLink>
          <ButtonLink href={`/app/training/plan/${approved.planId}`} variant="secondary">
            Inspect saved revisions
          </ButtonLink>
          <ButtonLink href="/app/training" variant="secondary">
            Back to Training
          </ButtonLink>
        </Card>
        {refresh && publication && (
          <RevisionPublication
            {...publication}
            planId={approved.planId}
            revisionId={approved.revisionId}
          />
        )}
      </main>
    )

  return (
    <main className={styles.screen}>
      <ButtonLink href="/app/training" variant="secondary" disabled={pending}>
        Save and exit to Training
      </ButtonLink>
      <header>
        <h1>{refresh ? 'Refresh training plan' : 'Create training plan'}</h1>
        <p>
          Your work is kept in this browser for your account. Approved plans remain safe while you{' '}
          {refresh ? 'refresh near-term detail.' : 'create a new one.'}
        </p>
      </header>
      {storageFailed && (
        <p role="alert" className={styles.warning}>
          Browser storage is unavailable or full. Keep this tab open or copy your response before
          leaving. Saved server constraints and approved plans are preserved.
        </p>
      )}
      <ol className={styles.steps} aria-label="Plan creation steps">
        {(
          [
            refresh ? 'Approved plan & window' : 'Goal & Constraints',
            'Export / Chat / Import',
            'Preview / Approve',
          ] as const
        ).map((label, index) => (
          <li key={label} aria-current={state.step === index + 1 ? 'step' : undefined}>
            {index + 1}. {label}
          </li>
        ))}
      </ol>
      <h2 ref={heading} tabIndex={-1}>
        Step {state.step}:{' '}
        {
          [
            refresh ? 'Approved plan & window' : 'Goal & Constraints',
            'Export / Chat / Import',
            'Preview / Approve',
          ][state.step - 1]
        }
      </h2>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {state.step === 1 && (
        <Card className={styles.stack}>
          <p>
            {refresh
              ? `Refresh ${refresh.goalName}, revision ${refresh.revisionNumber}. Keep your goal, saved constraints and macro strategy; choose the next 14–28 detailed days.`
              : 'Choose an existing goal or create your first goal, then set when and how often you can train. The full strategy can extend to your goal date; the first request covers 14–28 detailed days.'}
          </p>
          {refresh && (
            <>
              <ButtonLink href="/app/training/plan/refresh" variant="secondary" disabled={pending}>
                Reload approved plans
              </ButtonLink>
              <ButtonLink href="/app/training/plan/new" variant="secondary" disabled={pending}>
                Create a new plan for an updated goal
              </ButtonLink>
              <ButtonLink
                href={`/app/training/plan/${refresh.id}`}
                variant="secondary"
                disabled={pending}
              >
                Inspect saved revisions
              </ButtonLink>
            </>
          )}
          {!refresh && (
            <>
              <Select
                id="wizard-goal"
                label="Training goal"
                value={goal?.id ?? ''}
                disabled={pending}
                options={[
                  { value: '', label: 'Choose a goal' },
                  ...goals.map((g) => ({ value: g.id, label: g.name })),
                ]}
                onChange={(goalId) => {
                  if (goalId === state.goalId) return
                  invalidate()
                  setState({ ...emptyWizard, goalId })
                  setError('')
                }}
              />
              <Button variant="secondary" onClick={() => setCreatingGoal(true)} disabled={pending}>
                Create goal
              </Button>
            </>
          )}
          {goal && (
            <>
              <p>
                {goal.type.toLowerCase()} · {goal.targetDate ?? 'No fixed date'}
                {goal.distanceMeters ? ` · ${goal.distanceMeters} m` : ''}
              </p>
              <Button onClick={() => void start()} loading={pending}>
                {state.setup ? 'Reopen saved draft' : 'Open plan draft'}
              </Button>
            </>
          )}
        </Card>
      )}
      {creatingGoal && (
        <GoalForm
          onClose={() => setCreatingGoal(false)}
          onSave={async (fields) => {
            const created = await onCreateGoal(fields)
            setGoals((previous) => [created, ...previous])
            invalidate()
            setState({ ...emptyWizard, goalId: created.id })
          }}
        />
      )}
      {state.setup && goal && (
        <div hidden={state.step === 3}>
          {state.step === 2 && (
            <Card>
              <h3>Manual ChatGPT exchange</h3>
              <p>
                1. Choose what to share and prepare the export. 2. Copy the prompt into ChatGPT or
                attach the downloaded JSON with its instructions. 3. Ask for the JSON response, save
                it, then upload or paste it below.
              </p>
              <p>
                No OpenAI API key is required. Automatic generation is not available in MVP; use
                Manual. Export and import use saved data and do not trigger Garmin sync.
              </p>
            </Card>
          )}
          <PlanExportScreen
            key={`${state.setup.draftId}:${state.setup.version}:${openCount}`}
            goalId={goal.id}
            goalName={goal.name}
            initialSetup={state.setup}
            initialState={state.exportState}
            stage={state.step === 1 ? 'constraints' : 'exchange'}
            preserveConstraints={!!refresh}
            onOpen={open}
            onPreview={onExport}
            onSchedule={onSchedule}
            onStateChange={saveExportState}
            onPendingChange={setExportPending}
            onInvalidate={invalidate}
            onContinue={(setup) => setState((previous) => ({ ...previous, setup, step: 2 }))}
          />
        </div>
      )}
      {state.step === 2 && (
        <Card className={styles.stack}>
          <h3>Import the ChatGPT response</h3>
          <p>
            Uploading only validates a proposal. You must review and approve it in step 3. Select
            the response JSON, not the exported request package.
          </p>
          <FormField
            id="plan-response-file"
            label="Response JSON file"
            type="file"
            accept=".json,application/json"
            disabled={pending || !artifact}
            onChange={(e) => {
              void readFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          {readingFile && <p role="status">Reading response file…</p>}
          <label htmlFor="plan-response">Or paste the JSON response</label>
          <textarea
            id="plan-response"
            className="field"
            rows={10}
            maxLength={EXCHANGE_LIMITS.responseBytes}
            value={state.text}
            disabled={pending}
            onChange={(e) => {
              invalidate()
              setState((previous) => ({ ...previous, text: e.target.value }))
            }}
          />
          {!artifact && <p>Prepare an export preview above before validating a response.</p>}
          <Button
            loading={pending}
            disabled={!artifact || !state.text.trim()}
            onClick={() => void inspect()}
          >
            Validate and preview
          </Button>
        </Card>
      )}
      {validation && !validation.valid && (
        <Card className={styles.stack}>
          <h3>Response needs changes</h3>
          {validation.errors.some((issue) => issue.code === 'goal_horizon_changed') && (
            <ButtonLink href="/app/training/plan/new" variant="secondary">
              Create a new plan for the updated goal
            </ButtonLink>
          )}
          <ul>
            {validation.errors.map((issue, index) => (
              <li key={index}>
                <strong>
                  {issue.path.join('.') || 'response'}: {issue.message}
                </strong>
                <p>{issue.expected}</p>
              </li>
            ))}
          </ul>
          {validation.repairPrompt ? (
            <>
              <p>
                Copy this repair prompt into the same ChatGPT conversation. Paste or upload its
                corrected JSON, then validate again.
              </p>
              <label htmlFor="repair-prompt">Repair prompt</label>
              <textarea
                id="repair-prompt"
                className="field"
                readOnly
                rows={8}
                value={validation.repairPrompt}
              />
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(validation.repairPrompt!)
                    setError('')
                  } catch {
                    setError('Select and copy the repair prompt manually.')
                  }
                }}
              >
                Copy repair prompt
              </Button>
            </>
          ) : (
            <p>
              {validation.errors.some((issue) => issue.code === 'goal_horizon_changed')
                ? 'Create a new plan for the updated goal. Your current response and approved revisions remain preserved.'
                : 'Return to step 1 and reopen the draft, then export a fresh request. Your current response and approved plans remain preserved.'}
            </p>
          )}
        </Card>
      )}
      {state.step === 3 && (
        <>
          {validation?.valid ? (
            <PlanReview
              preview={validation.preview}
              timezone={state.setup?.constraints.timezone ?? 'UTC'}
              acknowledged={acknowledged}
              onAcknowledge={(id, checked) => {
                setConfirm(false)
                setAcknowledged((previous) =>
                  checked ? [...previous, id] : previous.filter((value) => value !== id),
                )
              }}
              disabled={pending}
            />
          ) : (
            <Card>
              <p>
                Your response was restored. Validate it again against the current draft before
                approval.
              </p>
              <Button onClick={() => void inspect()} loading={pending}>
                Revalidate saved response
              </Button>
            </Card>
          )}
          {validation?.valid && (
            <Card className={styles.stack}>
              <h3>Explicit local approval</h3>
              <p>
                Approval saves an immutable revision in Running Coach. A separate explicit Publish
                to Intervals.icu action is required to send workouts onward.
              </p>
              <FormField
                id="warning-rationale"
                label="Review notes"
                optional
                maxLength={1000}
                value={rationale}
                disabled={pending}
                onChange={(e) => {
                  setRationale(e.target.value)
                  setConfirm(false)
                }}
              />
              <label className={styles.choice}>
                <input
                  type="checkbox"
                  checked={confirm}
                  disabled={pending}
                  onChange={(e) => setConfirm(e.target.checked)}
                />
                I have reviewed the phases, calendar and load warnings and want to approve this plan
                locally.
              </label>
              <Button
                loading={pending}
                disabled={
                  !confirm ||
                  !reviewMatches ||
                  validation.preview.response.mode !== (refresh ? 'refresh' : 'initial') ||
                  (refresh && !validation.preview.refresh) ||
                  validation.preview.warnings.some((warning) => !acknowledged.includes(warning.id))
                }
                onClick={() => void inspect(true)}
              >
                Approve locally
              </Button>
            </Card>
          )}
        </>
      )}
      {state.step > 1 && (
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setConfirm(false)
            setState((previous) => ({ ...previous, step: previous.step === 3 ? 2 : 1 }))
          }}
        >
          Back to step {state.step - 1}
        </Button>
      )}
    </main>
  )
}
