'use client'

import { useEffect, useState } from 'react'
import { Copy, Download, FileJson } from 'lucide-react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DateField } from '@/components/ui/DateField'
import { FormField } from '@/components/ui/FormField'
import { Select } from '@/components/ui/Select'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { addHealthDays } from '@/lib/health-history'
import {
  defaultExportConsent,
  type ExportArtifact,
  type ExportBackground,
  type ExportConsent,
  type ExportSetup,
  type ExportSelection,
} from '@/lib/plan-export'
import styles from './plan-export.module.scss'
import { ContextPreview } from './context-preview'
import type { ExportFormState } from './plan-export-state'

type Result<T> = { success: true; value: T } | { success: false; error: string }
type Props = {
  goalId: string
  goalName: string
  initialSetup?: ExportSetup
  stage?: 'all' | 'constraints' | 'exchange'
  preserveConstraints?: boolean
  initialState?: ExportFormState
  onStateChange?: (state: ExportFormState) => void
  onPendingChange?: (pending: boolean) => void
  onContinue?: (setup: ExportSetup) => void
  onInvalidate?: () => void
  onOpen: (input: { goalId: string }) => Promise<Result<ExportSetup>>
  onPreview: (input: ExportSelection) => Promise<Result<ExportArtifact>>
  onSchedule: (input: {
    draftId: string
    expectedVersion: number
    constraints: ExportSetup['constraints']
  }) => Promise<Result<{ version: number; constraints: ExportSetup['constraints'] }>>
}
const consentLabels: Record<keyof ExportConsent, string> = {
  recordedActivityMetrics: 'Include recorded running distance, duration, pace and continuity',
  activityHeartRate: 'Include heart rate paired with each run',
  recordedLaps: 'Include available stored lap splits',
  athleteReport: 'Include my optional training background and feedback',
  limitationsOrFatigue: 'Include my pain, fatigue and recovery limitations',
  recovery: 'Include stored sleep, resting heart rate and sufficiently covered HRV',
}
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function PlanExportScreen({
  goalId,
  goalName,
  initialSetup,
  onOpen,
  onPreview,
  onSchedule,
  stage = 'all',
  preserveConstraints = false,
  initialState,
  onStateChange,
  onPendingChange,
  onContinue,
  onInvalidate,
}: Props) {
  const [setup, setSetup] = useState(initialSetup)
  const keepConstraints = preserveConstraints || setup?.mode === 'refresh'
  const [constraints, setConstraints] = useState(
    preserveConstraints || initialSetup?.mode === 'refresh'
      ? initialSetup?.constraints
      : (initialState?.constraints ?? initialSetup?.constraints),
  )
  const [consent, setConsent] = useState<ExportConsent>(
    initialState?.consent ?? { ...defaultExportConsent },
  )
  const [background, setBackground] = useState<ExportBackground>(
    initialState?.background ?? {
      experience: 'unknown',
      firstWorkoutEver: null,
    },
  )
  const [start, setStart] = useState(
    initialState?.start ?? (initialSetup ? laterStart(initialSetup) : ''),
  )
  const [length, setLength] = useState<'14' | '21' | '28'>(initialState?.length ?? '28')
  const [result, setResult] = useState<ExportArtifact | undefined>(initialState?.result)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [race, setRace] = useState(
    initialState?.race ?? {
      date: '',
      distance: '',
      seconds: '',
      kind: 'race' as 'race' | 'test' | 'historical_pb',
    },
  )
  const Container = stage === 'all' ? 'main' : 'section'

  useEffect(() => {
    onStateChange?.({ constraints, consent, background, start, length, result, race })
  }, [constraints, consent, background, start, length, result, race, onStateChange])
  useEffect(() => {
    onPendingChange?.(pending)
  }, [pending, onPendingChange])

  function invalidate() {
    onInvalidate?.()
    setResult(undefined)
    setNotice('')
    setError('')
  }
  async function open() {
    setPending(true)
    setError('')
    try {
      const response = await onOpen({ goalId })
      if (!response.success) {
        setError(response.error)
        return
      }
      setSetup(response.value)
      setConstraints(response.value.constraints)
      setStart(laterStart(response.value))
      invalidate()
    } catch {
      setError('The request could not be opened. Please try again.')
    } finally {
      setPending(false)
    }
  }
  async function preview() {
    if (!setup || !constraints) return
    const constraintsChanged =
      !keepConstraints && JSON.stringify(constraints) !== JSON.stringify(setup.constraints)
    setPending(true)
    if (stage !== 'constraints' || constraintsChanged) invalidate()
    else setError('')
    try {
      let version = setup.version
      let currentSetup = setup
      if (constraintsChanged) {
        const saved = await onSchedule({
          draftId: setup.draftId,
          expectedVersion: version,
          constraints,
        })
        if (!saved.success) {
          setError(saved.error)
          return
        }
        version = saved.value.version
        currentSetup = { ...setup, version, constraints: saved.value.constraints }
        setSetup(currentSetup)
      }
      if (stage === 'constraints') {
        onContinue?.(currentSetup)
        return
      }
      const response = await onPreview({
        draftId: setup.draftId,
        expectedVersion: version,
        allowedDetailWindow: {
          startDate: start,
          endDate: addHealthDays(start, Number(length) - 1),
        },
        consent,
        ...(consent.athleteReport
          ? {
              background: {
                ...background,
                ...(race.date || race.distance || race.seconds
                  ? {
                      raceOrTestResults: [
                        {
                          date: race.date,
                          distanceMeters: Number(race.distance),
                          elapsedSeconds: Number(race.seconds),
                          kind: race.kind,
                        },
                      ],
                    }
                  : {}),
              },
            }
          : {}),
      })
      if (!response.success) {
        setError(response.error)
        return
      }
      setResult(response.value)
      setNotice('Request saved. Review the exact data below before sharing it with ChatGPT.')
    } catch {
      setError('The preview could not be prepared. Check the date window and try again.')
    } finally {
      setPending(false)
    }
  }
  async function copy() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.prompt)
      setNotice('Prompt copied.')
    } catch {
      setError('Clipboard access is unavailable. Select and copy the prompt below.')
    }
  }
  function download() {
    if (!result) return
    const url = URL.createObjectURL(new Blob([result.json], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `plan-request-${result.requestId}.json`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice('JSON download started.')
  }

  return (
    <Container className={styles.screen}>
      {stage === 'all' && (
        <>
          <ButtonLink href="/app/goals" variant="secondary">
            Back to goals
          </ButtonLink>
          <header>
            <h1>Plan request</h1>
            <p>{goalName}</p>
            <p>
              Prepare a request to take into ChatGPT. Review its suggestions before importing and
              approving a plan. No API key is needed.
            </p>
          </header>
        </>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <p role="status">{notice}</p>
      {!setup || !constraints ? (
        <Card>
          <p>
            Choose what to share before exporting. Garmin data comes only from your saved manual
            syncs.
          </p>
          <Button loading={pending} onClick={() => void open()}>
            Start request
          </Button>
        </Card>
      ) : (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void preview()
            }}
            onChange={invalidate}
          >
            {stage !== 'exchange' && (
              <fieldset disabled={pending} className={styles.group}>
                <legend>Schedule and request window</legend>
                <p>
                  {setup.measurementSystem === 'METRIC' ? 'Metric' : 'Imperial'} display preference
                  · {constraints.timezone}. Exported measurements state their canonical units.
                </p>
                <p>
                  Goal date: {setup.goalDate ?? 'No fixed date'}. The detail window must fit before
                  the goal date.
                </p>
                {keepConstraints && (
                  <p>
                    Saved constraints: {constraints.sessionsPerWeek} sessions per week,{' '}
                    {constraints.maxSessionMinutes ?? 'no maximum'} minutes per session. Available
                    weekdays: {constraints.availableWeekdays.map((day) => weekdays[day]).join(', ')}
                    . The goal, constraints and approved macro strategy are preserved.
                  </p>
                )}
                <div className={styles.grid}>
                  {!keepConstraints && (
                    <>
                      <FormField
                        id="sessions"
                        label="Sessions per week"
                        type="number"
                        min={1}
                        max={7}
                        required
                        value={constraints.sessionsPerWeek}
                        onChange={(e) => {
                          invalidate()
                          setConstraints({
                            ...constraints,
                            sessionsPerWeek: Number(e.target.value),
                          })
                        }}
                      />
                      <FormField
                        id="duration"
                        label="Maximum session minutes"
                        type="number"
                        min={5}
                        max={1440}
                        optional
                        value={constraints.maxSessionMinutes ?? ''}
                        onChange={(e) => {
                          invalidate()
                          setConstraints({
                            ...constraints,
                            maxSessionMinutes: e.target.value ? Number(e.target.value) : null,
                          })
                        }}
                      />
                      <DateField
                        id="plan-start"
                        label="Plan start date"
                        optional
                        value={constraints.startDate ?? ''}
                        onChange={(value) => {
                          invalidate()
                          setConstraints({ ...constraints, startDate: value || null })
                        }}
                      />
                    </>
                  )}
                  <DateField
                    id="detail-start"
                    label="First detailed day"
                    min={addHealthDays(setup.today, 1)}
                    max={setup.goalDate ?? undefined}
                    value={start}
                    onChange={(value) => {
                      invalidate()
                      setStart(value)
                    }}
                  />
                  <Select
                    id="window-length"
                    label="Detailed days"
                    value={length}
                    options={[
                      { value: '14', label: '14 days' },
                      { value: '21', label: '21 days' },
                      { value: '28', label: '28 days' },
                    ]}
                    onChange={(value) => {
                      invalidate()
                      setLength(value)
                    }}
                  />
                </div>
                {!keepConstraints && (
                  <fieldset className={styles.weekdays}>
                    <legend>Available weekdays</legend>
                    {weekdays.map((day, index) => (
                      <label key={day}>
                        <input
                          type="checkbox"
                          checked={constraints.availableWeekdays.includes(index)}
                          onChange={(e) => {
                            invalidate()
                            setConstraints({
                              ...constraints,
                              availableWeekdays: e.target.checked
                                ? [...constraints.availableWeekdays, index].sort()
                                : constraints.availableWeekdays.filter((d) => d !== index),
                            })
                          }}
                        />
                        {day}
                      </label>
                    ))}
                  </fieldset>
                )}
              </fieldset>
            )}
            {stage !== 'constraints' && (
              <>
                <fieldset disabled={pending} className={styles.group}>
                  <legend>Privacy choices</legend>
                  <p>
                    All choices are optional and start off. Only selected data appears in the
                    preview, JSON and prompt. Private account IDs, credentials and GPS files are
                    excluded; review your goal title and any text you choose to share.
                  </p>
                  {Object.entries(consentLabels).map(([key, label]) => {
                    const field = key as keyof ExportConsent
                    const disabled =
                      ((field === 'activityHeartRate' || field === 'recordedLaps') &&
                        !consent.recordedActivityMetrics) ||
                      (field === 'limitationsOrFatigue' && !consent.athleteReport)
                    return (
                      <label key={field} className={styles.choice}>
                        <input
                          type="checkbox"
                          checked={consent[field]}
                          disabled={disabled}
                          onChange={(e) => {
                            invalidate()
                            setConsent({
                              ...consent,
                              [field]: e.target.checked,
                              ...(field === 'recordedActivityMetrics' && !e.target.checked
                                ? { activityHeartRate: false, recordedLaps: false }
                                : {}),
                              ...(field === 'athleteReport' && !e.target.checked
                                ? { limitationsOrFatigue: false }
                                : {}),
                            })
                          }}
                        />
                        {label}
                      </label>
                    )
                  })}
                </fieldset>
                {consent.athleteReport && (
                  <fieldset disabled={pending} className={styles.group}>
                    <legend>Optional training background</legend>
                    <p>
                      Skip anything, or choose Unknown. Your first session in this plan does not
                      imply your first run ever.
                    </p>
                    <div className={styles.grid}>
                      <Select
                        id="experience"
                        label="Current running background"
                        value={background.experience}
                        options={[
                          { value: 'unknown', label: 'Unknown / not sure' },
                          { value: 'new_runner', label: 'New runner' },
                          { value: 'returning_runner', label: 'Returning after a break' },
                          { value: 'currently_training', label: 'Currently training' },
                        ]}
                        onChange={(value) => {
                          invalidate()
                          setBackground({ ...background, experience: value })
                        }}
                      />
                      <Select
                        id="first-ever"
                        label="Will this be your first workout ever?"
                        value={
                          background.firstWorkoutEver === null
                            ? 'unknown'
                            : String(background.firstWorkoutEver)
                        }
                        options={[
                          { value: 'unknown', label: 'Unknown / skip' },
                          { value: 'true', label: 'Yes' },
                          { value: 'false', label: 'No' },
                        ]}
                        onChange={(value) => {
                          invalidate()
                          setBackground({
                            ...background,
                            firstWorkoutEver: value === 'unknown' ? null : value === 'true',
                          })
                        }}
                      />
                      {(
                        [
                          'previousExperience',
                          'easyEffort',
                          'crossTraining',
                          'preferredWorkoutTypes',
                          ...(consent.limitationsOrFatigue
                            ? ['limitationsOrFatigue' as const]
                            : []),
                        ] as const
                      ).map((key) => (
                        <FormField
                          key={key}
                          id={key}
                          label={
                            {
                              previousExperience:
                                'Previous experience, breaks, travel or availability',
                              easyEffort: 'Perceived easy effort or pace (include units)',
                              crossTraining: 'Cross-training and other workload',
                              preferredWorkoutTypes: 'Workout preferences',
                              limitationsOrFatigue: 'Pain, fatigue or recovery limits',
                            }[key]
                          }
                          optional
                          maxLength={1000}
                          value={background[key] ?? ''}
                          onChange={(e) => {
                            invalidate()
                            setBackground({ ...background, [key]: e.target.value })
                          }}
                        />
                      ))}
                    </div>
                    <fieldset className={styles.group}>
                      <legend>Dated race or test result (optional)</legend>
                      <p>
                        Leave all fields blank to skip. Historical personal bests are background,
                        not proof of current form.
                      </p>
                      <div className={styles.grid}>
                        <DateField
                          id="race-date"
                          label="Result date"
                          optional
                          max={setup.today}
                          value={race.date}
                          onChange={(date) => {
                            invalidate()
                            setRace({ ...race, date })
                          }}
                        />
                        <FormField
                          id="race-distance"
                          label="Result distance (meters)"
                          type="number"
                          min={1}
                          optional
                          value={race.distance}
                          onChange={(e) => {
                            invalidate()
                            setRace({ ...race, distance: e.target.value })
                          }}
                        />
                        <FormField
                          id="race-seconds"
                          label="Result time (seconds)"
                          type="number"
                          min={1}
                          optional
                          value={race.seconds}
                          onChange={(e) => {
                            invalidate()
                            setRace({ ...race, seconds: e.target.value })
                          }}
                        />
                        <Select
                          id="result-kind"
                          label="Result type"
                          value={race.kind}
                          options={[
                            { value: 'race', label: 'Race' },
                            { value: 'test', label: 'Test' },
                            { value: 'historical_pb', label: 'Historical personal best' },
                          ]}
                          onChange={(kind) => {
                            invalidate()
                            setRace({ ...race, kind })
                          }}
                        />
                      </div>
                    </fieldset>
                  </fieldset>
                )}
              </>
            )}
            <Button type="submit" loading={pending}>
              {stage === 'constraints' ? 'Save constraints and continue' : 'Prepare export preview'}
            </Button>
            <Button variant="secondary" disabled={pending} onClick={() => void open()}>
              Reopen current draft
            </Button>
          </form>
          {result && stage !== 'constraints' && (
            <Card className={styles.preview}>
              <SectionHeading icon={FileJson} title="Training context and export preview" />
              <p>
                Saved request {result.requestId} · {result.bytes.toLocaleString()} bytes. Null means
                unknown or excluded, never zero training. Missing Garmin records do not prove
                inactivity.
              </p>
              <p>
                The exact request below includes coverage windows, last manual sync, excluded
                duplicates and run/lap truncation counts. Recovery and background appear only when
                selected. Past session outcomes without reliable completion evidence remain unknown.
              </p>
              <p>
                Change a choice above to discard this preview and prepare a new request. Only the
                current preview can be copied or downloaded here.
              </p>
              <ContextPreview json={result.json} />
              <div className={styles.actions}>
                <Button onClick={() => void copy()}>
                  <Copy size={18} strokeWidth={2} aria-hidden="true" />
                  Copy Prompt
                </Button>
                <Button variant="secondary" onClick={download}>
                  <Download size={18} strokeWidth={2} aria-hidden="true" />
                  Download JSON
                </Button>
              </div>
              <details open>
                <summary>Inspect request and training context</summary>
                <pre tabIndex={0}>
                  {JSON.stringify(
                    (JSON.parse(result.json) as { request: unknown }).request,
                    null,
                    2,
                  )}
                </pre>
              </details>
              <label htmlFor="copy-prompt">Copy-ready prompt</label>
              <textarea
                id="copy-prompt"
                className="field"
                readOnly
                value={result.prompt}
                rows={10}
              />
            </Card>
          )}
        </>
      )}
    </Container>
  )
}

function laterStart(setup: ExportSetup) {
  const tomorrow = addHealthDays(setup.today, 1)
  return setup.constraints.startDate && setup.constraints.startDate > tomorrow
    ? setup.constraints.startDate
    : tomorrow
}
