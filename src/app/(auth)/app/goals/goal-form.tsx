'use client'

import { useId, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { CalendarDays, ChartNoAxesColumnIncreasing, Flag, Target } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { DateField } from '@/components/ui/DateField'
import { Dialog } from '@/components/ui/Dialog'
import { FormField } from '@/components/ui/FormField'
import { Select } from '@/components/ui/Select'
import type { GoalFields, GoalSurface, GoalType } from './goal-view'
import { goalInput } from './goal-view'
import styles from './goals.module.scss'

export const goalTypes = [
  {
    value: 'PERFORMANCE',
    label: 'Performance',
    description: 'Reach a target result',
    icon: Target,
  },
  { value: 'COMPLETION', label: 'Completion', description: 'Finish a run or race', icon: Flag },
  {
    value: 'VOLUME',
    label: 'Volume',
    description: 'Reach a distance target',
    icon: ChartNoAxesColumnIncreasing,
  },
  { value: 'CONSISTENCY', label: 'Consistency', description: 'Run regularly', icon: CalendarDays },
] as const satisfies readonly {
  value: GoalType
  label: string
  description: string
  icon: typeof Target
}[]

const surfaces = [
  { value: 'ANY', label: 'Any' },
  { value: 'ROAD', label: 'Road' },
  { value: 'TRACK', label: 'Track' },
  { value: 'TRAIL', label: 'Trail' },
  { value: 'TREADMILL', label: 'Treadmill' },
] as const

const emptyGoal: GoalFields = {
  name: '',
  type: 'PERFORMANCE',
  distanceKm: '',
  targetTime: '',
  targetDate: '',
  surface: 'ANY',
  elevationGainM: '',
  sessionsPerWeek: '',
  measurementWindow: 'WEEK',
}

export function GoalForm({
  initial,
  onSave,
  onClose,
}: {
  initial?: GoalFields
  onSave: (fields: GoalFields) => Promise<void>
  onClose: () => void
}) {
  const id = useId()
  const [fields, setFields] = useState<GoalFields>(initial ?? emptyGoal)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const update = <Key extends keyof GoalFields>(key: Key, value: GoalFields[Key]) => {
    setFields((previous) => ({ ...previous, [key]: value }))
    setError('')
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    if (!fields.name.trim()) {
      setError('Enter a goal name.')
      return
    }
    try {
      goalInput(fields)
    } catch (error) {
      setError(error instanceof z.ZodError ? error.issues[0].message : 'Check the goal fields.')
      return
    }
    setPending(true)
    setError('')
    try {
      await onSave({ ...fields, name: fields.name.trim() })
      onClose()
    } catch {
      setError('Your goal could not be saved. Please try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open
      title={initial ? 'Edit goal' : 'Create goal'}
      size="wide"
      className={styles.goalDialog}
      description="Choose what you want to achieve."
      onClose={onClose}
      pending={pending}
    >
      <form onSubmit={submit} className={styles.form}>
        <fieldset className={styles.typePicker} disabled={pending}>
          <legend className={styles.srOnly}>Goal type</legend>
          {goalTypes.map(({ value, label, description, icon: Icon }) => (
            <label key={value} className={styles.typeOption}>
              <input
                type="radio"
                name={`${id}-type`}
                value={value}
                checked={fields.type === value}
                onChange={() => update('type', value)}
              />
              <span className={styles.typeTitle}>
                <Icon size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
                {label}
              </span>
              <span>{description}</span>
            </label>
          ))}
        </fieldset>
        <FormField
          id={`${id}-name`}
          label="Goal name"
          required
          maxLength={160}
          placeholder="e.g. Run 3000 m under 10 minutes"
          value={fields.name}
          onChange={(event) => update('name', event.target.value)}
          disabled={pending}
        />
        <div className={styles.fieldGrid}>
          {fields.type === 'CONSISTENCY' ? (
            <FormField
              id={`${id}-sessions`}
              label="Target runs"
              type="number"
              min={1}
              max={366}
              step={1}
              required
              value={fields.sessionsPerWeek}
              onChange={(event) => update('sessionsPerWeek', event.target.value)}
              disabled={pending}
            />
          ) : (
            <FormField
              id={`${id}-distance`}
              label="Distance (km)"
              type="number"
              min={0.001}
              step="any"
              required
              placeholder="3"
              value={fields.distanceKm}
              onChange={(event) => update('distanceKm', event.target.value)}
              disabled={pending}
            />
          )}
          {fields.type === 'PERFORMANCE' && (
            <FormField
              id={`${id}-time`}
              label="Target time"
              optional
              placeholder="00:10:00"
              pattern="[0-9]{1,3}:[0-5][0-9]:[0-5][0-9]"
              title="Use hours:minutes:seconds, for example 00:10:00"
              value={fields.targetTime}
              onChange={(event) => update('targetTime', event.target.value)}
              disabled={pending}
            />
          )}
          {(fields.type === 'VOLUME' || fields.type === 'CONSISTENCY') && (
            <Select
              id={`${id}-window`}
              label="Measurement window"
              value={fields.measurementWindow}
              options={[
                { value: 'WEEK', label: 'Per week' },
                { value: 'MONTH', label: 'Per month' },
                { value: 'YEAR', label: 'Per year' },
              ]}
              onChange={(value) => update('measurementWindow', value)}
              disabled={pending}
            />
          )}
          <DateField
            id={`${id}-date`}
            label="Target date"
            optional
            value={fields.targetDate}
            onChange={(value) => update('targetDate', value)}
            disabled={pending}
          />
          <Select<GoalSurface>
            id={`${id}-surface`}
            label="Surface"
            options={surfaces}
            value={fields.surface}
            onChange={(value) => update('surface', value)}
            disabled={pending}
          />
          {fields.type !== 'CONSISTENCY' && (
            <FormField
              id={`${id}-elevation`}
              label="Elevation gain (m)"
              optional
              type="number"
              min={0}
              step={1}
              value={fields.elevationGainM}
              onChange={(event) => update('elevationGainM', event.target.value)}
              disabled={pending}
            />
          )}
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <footer className={styles.actions}>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            {pending ? 'Saving goal…' : 'Save goal'}
          </Button>
        </footer>
      </form>
    </Dialog>
  )
}
