'use client'

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Plus, Repeat2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { FormField } from '@/components/ui/FormField'
import { Select } from '@/components/ui/Select'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { WORKOUT_LIMITS, type WorkoutDefinition } from '@/schemas/workout-definition.v1'
import {
  draftFromDefinition,
  newStep,
  validateDraft,
  type DraftNode,
  type WorkoutDraft,
} from './workout-draft'
import { WorkoutPreview } from './WorkoutPreview'
import styles from './workout-builder.module.scss'

export type WorkoutBuilderProps = {
  initialDefinition?: unknown
  locked?: boolean
  onApply?: (definition: WorkoutDefinition) => Promise<void> | void
}

const sports = [
  { value: 'RUNNING', label: 'Running' },
  { value: 'CYCLING', label: 'Cycling' },
  { value: 'SWIMMING', label: 'Swimming' },
  { value: 'WALKING', label: 'Walking' },
  { value: 'OTHER', label: 'Other' },
] as const
const endings = [
  { value: 'time', label: 'Time' },
  { value: 'distance', label: 'Distance' },
  { value: 'lap', label: 'Lap press' },
] as const
const targets = [
  { value: 'free', label: 'Free' },
  { value: 'pace', label: 'Pace' },
  { value: 'heartRate', label: 'Heart rate' },
] as const

function initialize(initial?: unknown): { draft: WorkoutDraft; error?: string } {
  if (initial === undefined) return { draft: { name: 'New workout', sport: 'RUNNING', steps: [] } }
  try {
    return { draft: draftFromDefinition(initial) }
  } catch {
    return {
      draft: { name: '', sport: 'RUNNING', steps: [] },
      error:
        'This workout uses an unsupported format, structure or target and cannot be edited. Supported targets are free, absolute pace and HR in bpm.',
    }
  }
}

export function WorkoutBuilder({
  initialDefinition,
  locked = false,
  onApply,
}: WorkoutBuilderProps) {
  const id = useId()
  const [initial] = useState(() => initialize(initialDefinition))
  const [draft, setDraft] = useState(initial.draft)
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState('')
  const [submitError, setSubmitError] = useState('')
  const counter = useRef(0)
  const submitting = useRef(false)
  const focusNext = useRef<string | null>(null)
  const validation = validateDraft(draft)
  const disabled = locked || pending
  const errors = new Map<string, string>()
  if (!validation.success) {
    for (const issue of validation.error.issues) {
      errors.set(
        issue.path.join('.'),
        issue.code === 'invalid_type' && issue.expected === 'number'
          ? 'Enter a finite number.'
          : issue.message,
      )
    }
  }
  useEffect(() => {
    if (focusNext.current) {
      document.getElementById(focusNext.current)?.focus()
      focusNext.current = null
    }
  }, [draft])

  function update(next: WorkoutDraft) {
    if (disabled) return
    setDraft(next)
    setStatus('')
    setSubmitError('')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || submitting.current || !validation.success || initial.error) return
    submitting.current = true
    setPending(true)
    setSubmitError('')
    try {
      if (onApply) await onApply(validation.data)
      else {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(validation.data, null, 2)], { type: 'application/json' }),
        )
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = 'workout.v1.json'
        anchor.click()
        // Keep the URL alive until the browser has started the download.
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      setStatus(onApply ? 'Workout applied.' : 'Workout JSON downloaded.')
    } catch {
      setSubmitError(
        'The workout could not be applied or downloaded. Your edits are still here. Try again.',
      )
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  function nodeList(
    nodes: DraftNode[],
    path: string,
    depth: number,
    change: (next: DraftNode[]) => void,
  ) {
    const listId = `${id}-${path}`
    const fieldId = (node: DraftNode) =>
      `${id}-${node.id}-${node.type === 'repeat' ? 'count' : 'name'}`
    function add(name: string) {
      const nodeId = `new-${counter.current++}`
      const node: DraftNode =
        name === 'Repeat'
          ? {
              id: nodeId,
              type: 'repeat',
              count: '5',
              steps: [newStep(`${nodeId}-work`), newStep(`${nodeId}-recovery`, 'Recovery')],
            }
          : newStep(nodeId, name)
      focusNext.current = fieldId(node)
      change([...nodes, node])
    }
    return (
      <div className={styles.group}>
        {errors.has(path) && (
          <p className={styles.error} role="alert">
            {path === 'steps' && nodes.length === 0
              ? 'Add at least one step or repeat group.'
              : errors.get(path)}
          </p>
        )}
        <ol
          className={styles.editorSteps}
          aria-label={path === 'steps' ? 'Workout steps' : 'Repeat steps'}
        >
          {nodes.map((node, index) => {
            const nodePath = `${path}.${index}`
            const nodeId = `${id}-${node.id}`
            const label = `${node.type === 'repeat' ? 'Repeat' : node.name || 'Step'} ${index + 1}`
            const replace = (next: DraftNode) =>
              change(nodes.map((old) => (old.id === node.id ? next : old)))
            function move(direction: -1 | 1) {
              const next = [...nodes]
              const destination = index + direction
              if (destination < 0 || destination >= next.length) return
              ;[next[index], next[destination]] = [next[destination], next[index]]
              focusNext.current = fieldId(node)
              change(next)
            }
            return (
              <li key={node.id} className={styles.node}>
                <fieldset className={styles.nodeFields}>
                  <legend>{label}</legend>
                  <div className={styles.actions}>
                    <Button
                      variant="secondary"
                      size="compact"
                      disabled={disabled || index === 0}
                      aria-label={`Move ${label} up`}
                      onClick={() => move(-1)}
                    >
                      <ArrowUp size={16} strokeWidth={2} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="secondary"
                      size="compact"
                      disabled={disabled || index === nodes.length - 1}
                      aria-label={`Move ${label} down`}
                      onClick={() => move(1)}
                    >
                      <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="secondary"
                      size="compact"
                      disabled={disabled}
                      aria-label={`Remove ${label}`}
                      onClick={() => {
                        focusNext.current = nodes[index + 1]
                          ? fieldId(nodes[index + 1])
                          : nodes[index - 1]
                            ? fieldId(nodes[index - 1])
                            : `${listId}-add`
                        change(nodes.filter((old) => old.id !== node.id))
                      }}
                    >
                      <Trash2 size={16} strokeWidth={2} aria-hidden="true" />
                      <span>Remove</span>
                    </Button>
                  </div>
                  {node.type === 'repeat' ? (
                    <>
                      <FormField
                        id={`${nodeId}-count`}
                        label="Repeat count"
                        type="number"
                        min={1}
                        max={WORKOUT_LIMITS.maxRepeatCount}
                        step={1}
                        value={node.count}
                        error={errors.get(`${nodePath}.count`)}
                        onChange={(event) => replace({ ...node, count: event.target.value })}
                      />
                      {nodeList(node.steps, `${nodePath}.steps`, depth + 1, (steps) =>
                        replace({ ...node, steps }),
                      )}
                    </>
                  ) : (
                    <>
                      <FormField
                        id={`${nodeId}-name`}
                        label="Step name"
                        optional
                        maxLength={160}
                        value={node.name}
                        error={errors.get(`${nodePath}.name`)}
                        onChange={(event) => replace({ ...node, name: event.target.value })}
                      />
                      <div className={styles.fieldGrid}>
                        <Select
                          id={`${nodeId}-ending`}
                          label="End step by"
                          options={endings}
                          value={node.ending}
                          disabled={disabled}
                          onChange={(ending) => replace({ ...node, ending })}
                        />
                        {node.ending === 'time' && (
                          <FormField
                            id={`${nodeId}-duration`}
                            label="Duration (seconds)"
                            hint="600 seconds = 10 minutes."
                            type="number"
                            step="any"
                            max={WORKOUT_LIMITS.maxDurationSeconds}
                            value={node.durationSeconds}
                            error={errors.get(`${nodePath}.termination.durationSeconds`)}
                            onChange={(event) =>
                              replace({ ...node, durationSeconds: event.target.value })
                            }
                          />
                        )}
                        {node.ending === 'distance' && (
                          <FormField
                            id={`${nodeId}-distance`}
                            label="Distance (meters)"
                            type="number"
                            step="any"
                            max={WORKOUT_LIMITS.maxDistanceMeters}
                            value={node.distanceMeters}
                            error={errors.get(`${nodePath}.termination.distanceMeters`)}
                            onChange={(event) =>
                              replace({ ...node, distanceMeters: event.target.value })
                            }
                          />
                        )}
                        <Select
                          id={`${nodeId}-target`}
                          label="Target"
                          options={targets}
                          value={node.target}
                          disabled={disabled}
                          onChange={(target) => replace({ ...node, target })}
                        />
                        {node.target === 'pace' && (
                          <>
                            <FormField
                              id={`${nodeId}-fast`}
                              label="Fast pace (seconds/km)"
                              hint="300 seconds/km = 5:00 /km."
                              type="number"
                              step="any"
                              max={WORKOUT_LIMITS.maxPaceSecondsPerKm}
                              value={node.minSecondsPerKm}
                              error={errors.get(`${nodePath}.target.minSecondsPerKm`)}
                              onChange={(event) =>
                                replace({ ...node, minSecondsPerKm: event.target.value })
                              }
                            />
                            <FormField
                              id={`${nodeId}-slow`}
                              label="Slow pace (seconds/km)"
                              hint="Must be at least the fast pace."
                              type="number"
                              step="any"
                              max={WORKOUT_LIMITS.maxPaceSecondsPerKm}
                              value={node.maxSecondsPerKm}
                              error={errors.get(`${nodePath}.target.maxSecondsPerKm`)}
                              onChange={(event) =>
                                replace({ ...node, maxSecondsPerKm: event.target.value })
                              }
                            />
                          </>
                        )}
                        {node.target === 'heartRate' && (
                          <>
                            <FormField
                              id={`${nodeId}-minHr`}
                              label="Minimum HR (bpm)"
                              type="number"
                              min={1}
                              max={WORKOUT_LIMITS.maxHeartRateBpm}
                              step={1}
                              value={node.minBpm}
                              error={errors.get(`${nodePath}.target.minBpm`)}
                              onChange={(event) => replace({ ...node, minBpm: event.target.value })}
                            />
                            <FormField
                              id={`${nodeId}-maxHr`}
                              label="Maximum HR (bpm)"
                              type="number"
                              min={1}
                              max={WORKOUT_LIMITS.maxHeartRateBpm}
                              step={1}
                              value={node.maxBpm}
                              error={errors.get(`${nodePath}.target.maxBpm`)}
                              onChange={(event) => replace({ ...node, maxBpm: event.target.value })}
                            />
                          </>
                        )}
                      </div>
                    </>
                  )}
                </fieldset>
              </li>
            )
          })}
        </ol>
        <div
          className={styles.actions}
          aria-label={path === 'steps' ? 'Add workout steps' : 'Add repeat steps'}
        >
          {['Warmup', 'Work', 'Recovery', 'Cooldown', 'Repeat'].map((name, index) => (
            <Button
              key={name}
              id={index === 0 ? `${listId}-add` : undefined}
              variant="secondary"
              size="compact"
              disabled={
                disabled ||
                nodes.length >= WORKOUT_LIMITS.maxStepsPerGroup ||
                (name === 'Repeat' && depth >= WORKOUT_LIMITS.maxRepeatDepth)
              }
              onClick={() => add(name)}
            >
              {name === 'Repeat' ? (
                <Repeat2 size={16} strokeWidth={2} aria-hidden="true" />
              ) : (
                <Plus size={16} strokeWidth={2} aria-hidden="true" />
              )}
              Add {name.toLowerCase()}
            </Button>
          ))}
        </div>
        {depth >= WORKOUT_LIMITS.maxRepeatDepth && (
          <p className={styles.hint}>
            Maximum of {WORKOUT_LIMITS.maxRepeatDepth} repeat levels reached.
          </p>
        )}
        {nodes.length >= WORKOUT_LIMITS.maxStepsPerGroup && (
          <p className={styles.hint}>
            Maximum of {WORKOUT_LIMITS.maxStepsPerGroup} steps per group reached.
          </p>
        )}
      </div>
    )
  }

  if (initial.error)
    return (
      <Card className={styles.panel}>
        <p role="alert" className={styles.error}>
          {initial.error}
        </p>
      </Card>
    )

  return (
    <div className={styles.builder}>
      <form onSubmit={submit} noValidate className={styles.form} aria-label="Workout builder">
        <Card className={styles.panel}>
          <SectionHeading
            icon={Repeat2}
            title="Workout builder"
            subtitle="Build steps in the order you will perform them."
          />
          {locked && (
            <p role="status">
              This session is locked. Its approved definition cannot be changed here.
            </p>
          )}
          <fieldset disabled={disabled} className={styles.fields}>
            <legend className={styles.srOnly}>Workout definition</legend>
            <FormField
              id={`${id}-workout-name`}
              label="Workout name"
              required
              maxLength={160}
              value={draft.name}
              error={errors.get('name')}
              onChange={(event) => update({ ...draft, name: event.target.value })}
            />
            <Select
              id={`${id}-sport`}
              label="Sport"
              options={sports}
              value={draft.sport}
              disabled={disabled}
              onChange={(sport) => update({ ...draft, sport })}
            />
            <p className={styles.hint}>
              Supported targets: free, absolute pace and HR in bpm. Power, HR zones and relative
              targets are not supported.
            </p>
            {nodeList(draft.steps, 'steps', 0, (steps) => update({ ...draft, steps }))}
          </fieldset>
          {!validation.success && (
            <p className={styles.error} role="status">
              Resolve the inline errors to use this workout. Preview is unavailable until it is
              valid.
            </p>
          )}
          {submitError && (
            <p className={styles.error} role="alert">
              {submitError}
            </p>
          )}
          <Button type="submit" loading={pending} disabled={locked || !validation.success}>
            {onApply ? 'Use workout' : 'Download workout JSON'}
          </Button>
          {status && <p role="status">{status}</p>}
          {!onApply && (
            <p className={styles.hint}>
              Edits stay in this page until you download the JSON. Reloading or leaving discards
              them. Downloading does not save or publish a training plan.
            </p>
          )}
        </Card>
      </form>
      {validation.success && <WorkoutPreview definition={validation.data} />}
    </div>
  )
}
